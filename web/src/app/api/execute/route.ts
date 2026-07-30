import { NextResponse } from "next/server";
import { fileExtFor, isLanguage } from "@/lib/editor/languages";
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

type BodyRead = { ok: true; text: string } | { ok: false; reason: "too-large" | "unreadable" };

// INVARIANT: the body is read through this, never `request.json()`. A chunked POST carries no
// Content-Length, so the cheap header check cannot see it and `request.json()` buffers the whole
// thing before a 413 can fire. Next route handlers apply no cap of their own, and this route is
// unauthenticated — it is the front door to a privileged container.
async function readCappedText(request: Request, maxBytes: number): Promise<BodyRead> {
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

export async function POST(request: Request) {
  const limit = runLimiter(clientKey(request));
  if (!limit.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many runs. Wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  // Deliberately loose, and only when the header is actually present: `Number(null)` is 0 and
  // `Number("abc")` is NaN, so the old form silently passed every chunked request straight
  // through to a full buffer. The exact `payloadTooLarge` check below still enforces the cap.
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > REQUEST_BYTE_CEILING) {
    return NextResponse.json({ success: false, error: TOO_LARGE_MESSAGE }, { status: 413 });
  }

  const read = await readCappedText(request, REQUEST_BYTE_CEILING);
  if (!read.ok) {
    return read.reason === "too-large"
      ? NextResponse.json({ success: false, error: TOO_LARGE_MESSAGE }, { status: 413 })
      : NextResponse.json(
          { success: false, error: "Request body could not be read." },
          { status: 400 }
        );
  }

  let body: unknown;
  try {
    body = JSON.parse(read.text);
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

  // INVARIANT: isLanguage, not a truthiness check on LANGUAGE_MAP[language] — the map is a plain
  // object, so LANGUAGE_MAP["__proto__"] is Object.prototype, which is truthy and yields
  // {language: undefined, version: undefined}. Verified live before this guard: the request
  // reached Piston and came back as a 502 carrying Piston's own message.
  // The value is also not echoed back: it is caller-controlled, and this string is written into
  // the room's shared execution record, i.e. broadcast to every participant.
  if (!isLanguage(language)) {
    return NextResponse.json(
      { success: false, error: "That language isn't supported." },
      { status: 400 }
    );
  }
  const mapping = LANGUAGE_MAP[language];

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
    // Never forwarded: Piston's message carries sandbox package paths, versions and configured
    // limit values, and this string is broadcast to the whole room via the shared execution map.
    // `noticeFor`'s fallback to run.message is a different path — a 200 with an unrecognised
    // sandbox status — and must stay, or a new Piston status becomes illegible.
    console.warn(`Piston rejected a run (${pistonRes.status}): ${data.message ?? "no message"}`);
    return NextResponse.json(
      { success: false, error: "The code execution service rejected this run." },
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
