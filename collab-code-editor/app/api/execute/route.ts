import { NextResponse } from "next/server";

const EXEC_SERVER_EXECUTE_URL = `${process.env.EXEC_SERVER_API_URL ?? "http://localhost:4000"}/execute`;

// Pinned against Piston's /runtimes output for the languages in the editor's
// language switcher. Update these if Piston drops support for a version.
const LANGUAGE_MAP: Record<string, { language: string; version: string; fileExt: string }> = {
  javascript: { language: "javascript", version: "18.15.0", fileExt: "js" },
  typescript: { language: "typescript", version: "5.0.3", fileExt: "ts" },
  python: { language: "python", version: "3.10.0", fileExt: "py" },
  java: { language: "java", version: "15.0.2", fileExt: "java" },
  cpp: { language: "c++", version: "10.2.0", fileExt: "cpp" },
};

type PistonStage = {
  stdout: string;
  stderr: string;
  output: string;
  code: number | null;
  signal: string | null;
};

// exec-server's own execution outcomes (see exec-server/piston/classifyResult.js's
// STATUS enum) — distinguishes a timeout / memory-limit kill / signal kill from a
// plain non-zero exit instead of collapsing them into one generic failure.
type ExecuteStatus =
  | "success"
  | "timeout"
  | "memory_limit_exceeded"
  | "killed"
  | "output_limit_exceeded"
  | "runtime_error"
  | "internal_error";

type PistonResponse = {
  language: string;
  version: string;
  run: PistonStage;
  compile?: PistonStage;
  message?: string;
  error?: string;
  // Optional until exec-server's job-result delivery is wired up (see its
  // README's "Queue design" TODO) — when present, these are forwarded as-is
  // instead of re-derived from exit codes.
  status?: ExecuteStatus;
  stage?: "compile" | "run";
  detail?: string;
};

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, kind: "error", error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const { language, code } = (body ?? {}) as { language?: unknown; code?: unknown };

  if (typeof language !== "string" || typeof code !== "string") {
    return NextResponse.json(
      { success: false, kind: "error", error: "Request must include 'language' and 'code' strings." },
      { status: 400 }
    );
  }

  const mapping = LANGUAGE_MAP[language];
  if (!mapping) {
    return NextResponse.json(
      { success: false, kind: "error", error: `Unsupported language: ${language}` },
      { status: 400 }
    );
  }

  let execRes: Response;
  try {
    execRes = await fetch(EXEC_SERVER_EXECUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: mapping.language,
        version: mapping.version,
        files: [{ name: `main.${mapping.fileExt}`, content: code }],
      }),
    });
  } catch {
    return NextResponse.json(
      { success: false, kind: "error", error: "Could not reach the code execution service. Please try again." },
      { status: 502 }
    );
  }

  let data: PistonResponse;
  try {
    data = await execRes.json();
  } catch {
    return NextResponse.json(
      { success: false, kind: "error", error: "Code execution service returned an invalid response." },
      { status: 502 }
    );
  }

  // Queue backpressure: exec-server rejects outright with 429 when it's at
  // MAX_QUEUE_DEPTH (see exec-server/README.md's "Queue backpressure"). This
  // is distinct from every other failure mode — it means the job was never
  // run at all, so the frontend needs a dedicated "rejected" branch instead
  // of lumping it in with real execution errors.
  if (execRes.status === 429) {
    return NextResponse.json(
      { success: false, kind: "rejected", error: data.error ?? data.message ?? "Server is busy. Please try again." },
      { status: 429 }
    );
  }

  if (!execRes.ok) {
    return NextResponse.json(
      { success: false, kind: "error", error: data.error ?? data.message ?? "Code execution service returned an error." },
      { status: 502 }
    );
  }

  const exitCode = data.run?.code ?? null;
  const compileExitCode = data.compile?.code ?? null;

  // Prefer exec-server's own classification once it forwards one; fall back
  // to a plain exit-code check so this still works against a bare Piston
  // passthrough (today's actual behavior).
  const status: ExecuteStatus =
    data.status ?? ((compileExitCode ?? 0) !== 0 || (exitCode ?? 0) !== 0 ? "runtime_error" : "success");

  return NextResponse.json({
    success: true,
    status,
    stage: data.stage ?? null,
    detail: data.detail ?? null,
    stdout: data.run?.stdout ?? "",
    stderr: data.run?.stderr ?? "",
    exitCode,
    compile: data.compile
      ? {
          stdout: data.compile.stdout ?? "",
          stderr: data.compile.stderr ?? "",
          exitCode: compileExitCode,
        }
      : null,
  });
}
