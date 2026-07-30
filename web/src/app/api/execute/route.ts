import { NextResponse } from "next/server";
import { fileExtFor } from "@/lib/editor/languages";
import { MAX_CODE_BYTES, TOO_LARGE_MESSAGE, payloadTooLarge } from "@/lib/sandbox/execution";
import { clientKey, createRateLimiter } from "@/lib/sandbox/rateLimit";

const PISTON_EXECUTE_URL = `${process.env.PISTON_API_URL ?? "http://localhost:2000"}/api/v2/execute`;

// Sandbox limits, sent with every request. These stop a runaway program:
// `while True: pass` dies at 5s, an allocation loop at 256 MB.
//
// Wall time and CPU time are separate ceilings in Piston and both matter — a
// busy loop burns CPU as fast as wall clock, so raising only `run_timeout`
// leaves it dying at the 3s default `run_cpu_time`.
//
// Piston 400s the whole request if a value exceeds its own configured ceiling,
// so never raise these above the PISTON_* vars in `docker-compose.yml`.
const RUN_TIMEOUT_MS = 5_000;
const RUN_CPU_TIME_MS = 5_000;
const COMPILE_TIMEOUT_MS = 10_000;
const COMPILE_CPU_TIME_MS = 10_000;
const RUN_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const COMPILE_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

// Catches a Piston that never answers, which would otherwise lock the whole
// room's output panel. It sits between the sandbox limits and the client's
// STALE_RUN_MS watchdog: a worst case run is 10s compile + 5s, so anything at
// or under 15s here would abort work the sandbox was about to finish.
const PISTON_TIMEOUT_MS = 18_000;

// 10 runs/minute/IP: generous for someone iterating on a snippet, bounded for a
// script pointed at this endpoint. The room-wide "running" lock already
// serialises runs within a room; this covers callers who skip the UI.
const runLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

// Ceiling for the cheap Content-Length check: the decoded payload plus room for
// JSON escaping, which can roughly double it.
//
// §10.4 added `stdin` to this body and this number did **not** have to move,
// because code and stdin share one `MAX_CODE_BYTES` budget (`payloadTooLarge`).
// A separate per-field cap would have doubled the worst case and forced this up
// with it — which is the main reason the combined reading was chosen.
const REQUEST_BYTE_CEILING = MAX_CODE_BYTES * 2 + 4 * 1024;

// Pinned against Piston's /runtimes output — update after a Piston image
// change. Extensions live in `lib/editor/languages.ts` instead, since the client's
// Save button needs them too.
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
  // Only set when the sandbox stopped the program (output cap, timeout, kill)
  // rather than it exiting on its own.
  status?: string | null;
  message?: string | null;
};

// Piston SIGABRTs the sandbox when a stdio buffer overflows, leaving a fatal
// signal line in stderr that has nothing to do with the user's code. `notice`
// explains the real reason instead.
const SANDBOX_KEEPER_NOISE = /^Sandbox keeper received fatal signal \d+\n?/m;

// An out-of-memory kill leaves a line from Piston's own shell wrapper
// ("/piston/packages/python/3.10.0/run: line 3: 3 Killed ..."), which exposes
// sandbox internals and never mentions memory. The notice explains it instead.
const OOM_KILL_NOISE = /^\/piston\/packages\/.*\bKilled\b.*\n?/m;

// 128 + SIGKILL(9): what the shell reports when the memory limit kills a run.
const SIGKILL_EXIT_CODE = 137;

// Turns a sandbox-side stop into a plain sentence — Piston's own wording
// ("stdout length exceeded") reads as an internal error to whoever clicked Run.
// Anything unrecognised falls back to Piston's message.
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
      // "RE" is every non-zero exit, so it usually just means the program
      // failed — stderr and the exit code already say so. Only a sandbox kill
      // is worth a banner.
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

  // Checked before the body is read, so a huge payload is refused without being
  // buffered. Deliberately loose: Content-Length measures the JSON envelope,
  // which escaping can nearly double. The exact check on `code` below is what
  // actually enforces the cap — this header is only a claim, and may be absent.
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

  // Optional, because a client that never opens the input box sends nothing —
  // but a present-and-wrong value is a bad request, not something to coerce.
  if (stdin !== undefined && typeof stdin !== "string") {
    return NextResponse.json(
      { success: false, error: "'stdin' must be a string when present." },
      { status: 400 }
    );
  }
  const stdinText = stdin ?? "";

  // The authoritative size check: measured on the decoded program *and* its
  // input, so framing and escaping can't change the answer. One combined
  // budget — see `payloadTooLarge` in `lib/sandbox/execution.ts`.
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
          // Piston feeds this to the process's stdin. Without it every program
          // that reads input died on EOF or hung to the run timeout (§10.4).
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
