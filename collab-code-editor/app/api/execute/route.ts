import { NextResponse } from "next/server";
import { fileExtFor } from "../../lib/languages";

const PISTON_EXECUTE_URL = `${process.env.PISTON_API_URL ?? "http://localhost:2000"}/api/v2/execute`;

// The result of a run is now broadcast room-wide (see CodeEditor.tsx's shared
// `execution` Y.Map), so a hung Piston request would lock every peer's output
// panel indefinitely rather than just the requester's. This bound is a narrow
// fetch-level safety net for that — it is not the broader execution/resource
// timeout policy V1_Tasks.md still tracks separately.
const PISTON_TIMEOUT_MS = 15_000;

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
      return "The program ran too long and was stopped by the sandbox.";
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
      ? (data.run?.stderr ?? "").replace(SANDBOX_KEEPER_NOISE, "")
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
