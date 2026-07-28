import { NextResponse } from "next/server";
import { fileExtFor } from "../../lib/languages";
import { MAX_CODE_BYTES, TOO_LARGE_MESSAGE, codeByteLength } from "../../lib/execution";
import { clientKey, createRateLimiter } from "../../lib/rateLimit";

const PISTON_EXECUTE_URL = `${process.env.PISTON_API_URL ?? "http://localhost:2000"}/api/v2/execute`;

// Sandbox-side execution limits, sent with every request. These are what stop a
// runaway program: `while True: pass` is killed by the sandbox at 5s and an
// allocation loop at 256 MB, instead of occupying a Piston worker until some
// outer timeout gives up on it.
//
// Wall time and CPU time are separate ceilings in Piston and both matter — a
// busy loop burns CPU as fast as wall clock, so raising only `run_timeout`
// leaves it dying at the 3s default `run_cpu_time`.
//
// Every one of these is also validated against the ceilings in
// `docker-compose.yml`: Piston rejects the whole request with a 400 if any value
// exceeds its configured limit, so these numbers must never be raised above the
// PISTON_* env vars there.
const RUN_TIMEOUT_MS = 5_000;
const RUN_CPU_TIME_MS = 5_000;
const COMPILE_TIMEOUT_MS = 10_000;
const COMPILE_CPU_TIME_MS = 10_000;
const RUN_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const COMPILE_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

// The result of a run is broadcast room-wide (see CodeEditor.tsx's shared
// `execution` Y.Map), so a hung Piston request would lock every peer's output
// panel rather than just the requester's. This is the outermost net, below the
// client's STALE_RUN_MS watchdog and above the sandbox limits: worst case a
// program compiles for 10s and runs for 5s, so anything at or under 15s here
// would abort legitimate work that the sandbox was about to end cleanly.
const PISTON_TIMEOUT_MS = 18_000;

// 10 runs/minute/IP. Generous for someone iterating on a snippet — a run takes
// seconds of thought — while bounding a script pointed at this endpoint. Note
// the room-wide "running" lock already serialises runs *within* a room; this
// covers a caller who skips the UI entirely.
const runLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

// Ceiling for the cheap pre-parse Content-Length check: MAX_CODE_BYTES of code
// plus room for JSON escaping (worst case roughly doubles it) and the field
// names around it.
const REQUEST_BYTE_CEILING = MAX_CODE_BYTES * 2 + 4 * 1024;

// Pinned against Piston's /runtimes output for the languages in the editor's
// language switcher. Update these if Piston drops support for a version.
// File extensions are not here: they're shared with the client's Save button
// via `app/lib/languages.ts`, so the two lists can't drift apart.
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
  // Only present when the sandbox itself stopped the program (output cap,
  // timeout, killing signal) rather than the program exiting on its own.
  status?: string | null;
  message?: string | null;
};

// Piston kills the sandbox with SIGABRT when a stdio buffer overflows, so the
// program's own stderr ends with a line about a fatal signal that has nothing
// to do with the user's code. We explain the real reason via `notice` instead.
const SANDBOX_KEEPER_NOISE = /^Sandbox keeper received fatal signal \d+\n?/m;

// A program killed for exceeding RUN_MEMORY_LIMIT_BYTES leaves a line from the
// package's own shell wrapper — "/piston/packages/python/3.10.0/run: line 3: 3
// Killed python3.10 ..." — which exposes sandbox internals and says nothing
// about memory. The notice explains it instead.
const OOM_KILL_NOISE = /^\/piston\/packages\/.*\bKilled\b.*\n?/m;

// 128 + SIGKILL(9). What the shell reports when the kernel's OOM killer (or the
// cgroup memory limit) takes the process down.
const SIGKILL_EXIT_CODE = 137;

// A sandbox-side stop is not a normal non-zero exit, and the raw Piston wording
// ("stdout length exceeded") reads as an internal error to someone who just
// clicked Run. Anything unrecognised falls back to Piston's own message.
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
      // "RE" covers every non-zero exit, so most of the time it means the user's
      // own program failed — stderr and the exit code already say that, and an
      // amber banner repeating "Exited with error status 1" is pure noise. The
      // one case worth calling out is the sandbox killing it.
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

  // Checked before the body is read, so an obviously oversized payload is
  // refused without being buffered into memory first. This is deliberately the
  // *loose* check: `Content-Length` measures the JSON envelope, and escaping can
  // nearly double a program made of quotes and newlines, so anything tighter
  // would reject code that is under the cap once decoded. The exact check on
  // `code` below is the one that enforces MAX_CODE_BYTES; the header is absent
  // on a chunked request and is only a claim in any case.
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

  const { language, code } = (body ?? {}) as { language?: unknown; code?: unknown };

  if (typeof language !== "string" || typeof code !== "string") {
    return NextResponse.json(
      { success: false, error: "Request must include 'language' and 'code' strings." },
      { status: 400 }
    );
  }

  // The authoritative size check: measured on the decoded program, so it means
  // the same thing regardless of how the request was framed or escaped.
  if (codeByteLength(code) > MAX_CODE_BYTES) {
    return NextResponse.json({ success: false, error: TOO_LARGE_MESSAGE }, { status: 413 });
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
