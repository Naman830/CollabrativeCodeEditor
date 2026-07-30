import { NextResponse } from "next/server";
import { fileExtFor } from "@/lib/editor/languages";
import { MAX_CODE_BYTES, TOO_LARGE_MESSAGE, payloadTooLarge } from "@/lib/sandbox/execution";
import { clientKey, createRateLimiter } from "@/lib/sandbox/rateLimit";

const PISTON_EXECUTE_URL = `${process.env.PISTON_API_URL ?? "http://localhost:2000"}/api/v2/execute`;

// INVARIANT: never raise these above the PISTON_* ceilings in docker-compose.yml
// (Piston 400s the request); wall and CPU time are separate limits — raise both.
const RUN_TIMEOUT_MS = 5_000;
const RUN_CPU_TIME_MS = 5_000;
const COMPILE_TIMEOUT_MS = 10_000;
const COMPILE_CPU_TIME_MS = 10_000;
const RUN_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const COMPILE_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

// INVARIANT: must stay above the sandbox limits (10s compile + 5s run) and below
// the client's STALE_RUN_MS watchdog.
const PISTON_TIMEOUT_MS = 18_000;

const runLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

// INVARIANT: covers code and stdin together — a per-field cap would force this up.
const REQUEST_BYTE_CEILING = MAX_CODE_BYTES * 2 + 4 * 1024;

// Pinned against Piston's /runtimes output — recheck after a Piston image change.
const LANGUAGE_MAP: Record<string, { language: string; version: string }> = {
  javascript: { language: "javascript", version: "18.15.0" },
  typescript: { language: "typescript", version: "5.0.3" },
  python: { language: "python", version: "3.10.0" },
  java: { language: "java", version: "15.0.2" },
  cpp: { language: "c++", version: "10.2.0" },
};

type PistonStage = {
  stdout: string;
  stderr: string;
  output: string;
  code: number | null;
  signal: string | null;
  // Only set when the sandbox stopped the program, not when it exited on its own.
  status?: string | null;
  message?: string | null;
};

// Sandbox-internal stderr lines stripped in favour of `notice`: an output-cap
// SIGABRT, and an OOM kill logged by Piston's own shell wrapper.
const SANDBOX_KEEPER_NOISE = /^Sandbox keeper received fatal signal \d+\n?/m;

const OOM_KILL_NOISE = /^\/piston\/packages\/.*\bKilled\b.*\n?/m;

// 128 + SIGKILL(9): what the shell reports when the memory limit kills a run.
const SIGKILL_EXIT_CODE = 137;

// Turns a sandbox-side stop into a plain sentence; unrecognised falls back to Piston's.
function noticeFor(run: PistonStage | undefined): string | null {
  if (!run?.status) return null;
  switch (run.status) {
    case "OL":
      return "Output limit reached — the program printed too much and was stopped. Trim what you print and run again.";
    case "EL":
      return "Error-output limit reached — the program wrote too much to stderr and was stopped.";
    case "TO":
      return `The program ran longer than ${
        RUN_TIMEOUT_MS / 1000
      }s and was stopped by the sandbox.`;
    case "RE":
      // "RE" is every non-zero exit; only a sandbox kill is worth a banner.
      return run.code === SIGKILL_EXIT_CODE
        ? `The program was stopped — it most likely exceeded the ${
            RUN_MEMORY_LIMIT_BYTES / (1024 * 1024)
          } MB memory limit.`
        : null;
    default:
      return run.message ?? null;
  }
}

type PistonResponse = {
  language: string;
  version: string;
  run: PistonStage;
  compile?: PistonStage;
  message?: string;
};

export async function POST(request: Request) {
  const limit = runLimiter(clientKey(request));
  if (!limit.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many runs. Wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  // Deliberately loose pre-read check on an absent-or-lying header; the exact
  // `payloadTooLarge` check below is what enforces the cap.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > REQUEST_BYTE_CEILING) {
    return NextResponse.json({ success: false, error: TOO_LARGE_MESSAGE }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const { language, code, stdin } = (body ?? {}) as {
    language?: unknown;
    code?: unknown;
    stdin?: unknown;
  };

  if (typeof language !== "string" || typeof code !== "string") {
    return NextResponse.json(
      { success: false, error: "Request must include 'language' and 'code' strings." },
      { status: 400 }
    );
  }

  // Optional, but a present-and-wrong value is a bad request, not something to coerce.
  if (stdin !== undefined && typeof stdin !== "string") {
    return NextResponse.json(
      { success: false, error: "'stdin' must be a string when present." },
      { status: 400 }
    );
  }
  const stdinText = stdin ?? "";

  // The authoritative size check: one combined budget for code and stdin.
  const oversize = payloadTooLarge(code, stdinText);
  if (oversize) {
    return NextResponse.json({ success: false, error: oversize }, { status: 413 });
  }

  const mapping = LANGUAGE_MAP[language];
  if (!mapping) {
    return NextResponse.json(
      { success: false, error: `Unsupported language: ${language}` },
      { status: 400 }
    );
  }

  let pistonRes: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PISTON_TIMEOUT_MS);
    try {
      pistonRes = await fetch(PISTON_EXECUTE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: mapping.language,
          version: mapping.version,
          files: [{ name: `main.${fileExtFor(language)}`, content: code }],
          stdin: stdinText,
          run_timeout: RUN_TIMEOUT_MS,
          run_cpu_time: RUN_CPU_TIME_MS,
          compile_timeout: COMPILE_TIMEOUT_MS,
          compile_cpu_time: COMPILE_CPU_TIME_MS,
          run_memory_limit: RUN_MEMORY_LIMIT_BYTES,
          compile_memory_limit: COMPILE_MEMORY_LIMIT_BYTES,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return NextResponse.json(
        { success: false, error: "Execution timed out." },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { success: false, error: "Could not reach the code execution service. Please try again." },
      { status: 502 }
    );
  }

  let data: PistonResponse;
  try {
    data = await pistonRes.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Code execution service returned an invalid response." },
      { status: 502 }
    );
  }

  if (!pistonRes.ok) {
    return NextResponse.json(
      { success: false, error: data.message ?? "Code execution service returned an error." },
      { status: 502 }
    );
  }

  const notice = noticeFor(data.run);

  return NextResponse.json({
    success: true,
    stdout: data.run?.stdout ?? "",
    stderr: notice
      ? (data.run?.stderr ?? "").replace(SANDBOX_KEEPER_NOISE, "").replace(OOM_KILL_NOISE, "")
      : (data.run?.stderr ?? ""),
    exitCode: data.run?.code ?? null,
    notice,
    compile: data.compile
      ? {
          stdout: data.compile.stdout ?? "",
          stderr: data.compile.stderr ?? "",
          exitCode: data.compile.code ?? null,
        }
      : null,
  });
}
