// Centralized environment configuration for the exec-server.

const DEFAULT_WORKER_POOL_SIZE = 4;

// Per-job execution timeout: how long a single job is allowed to run
// against Piston before it should be killed/rejected. See the TODO in
// worker/workerPool.js processJob() for where this gets enforced.
const DEFAULT_JOB_TIMEOUT_MS = 10000;

// Queue backpressure: max number of jobs allowed to wait in the queue at
// once. See the TODO in index.js's POST /execute handler for where this
// gets enforced.
const DEFAULT_MAX_QUEUE_DEPTH = 100;

// Per-request Piston resource limits (see piston/buildExecuteRequest.js).
// These are sent as `compile_timeout`/`run_timeout` (milliseconds) and
// `compile_memory_limit`/`run_memory_limit` (bytes) on every /api/v2/execute
// call, and always override whatever the client sent for these fields.
//
// Defaults are deliberately conservative for a portfolio demo running small,
// single-file snippets — not tuned for production workloads. Compile timeouts
// are a few seconds rather than a few hundred ms because compiled-language
// toolchains (javac/g++/tsc) need real JVM/toolchain startup time even for a
// trivial file; going much lower would fail legitimate compiles, not just
// abusive ones. See exec-server/README.md's "Resource limits" section for
// the full rationale and how this ties into Piston's isolate/cgroups
// sandboxing.
const DEFAULT_COMPILE_TIMEOUT_MS = 5000;
const DEFAULT_RUN_TIMEOUT_MS = 3000;
const DEFAULT_COMPILE_MEMORY_LIMIT_MB = 256;
const DEFAULT_RUN_MEMORY_LIMIT_MB = 128;

const PORT = process.env.PORT || 4000;
const PISTON_API_URL = process.env.PISTON_API_URL || "http://localhost:2000";

const parsedPoolSize = Number.parseInt(process.env.WORKER_POOL_SIZE, 10);
const WORKER_POOL_SIZE =
  Number.isInteger(parsedPoolSize) && parsedPoolSize > 0 ? parsedPoolSize : DEFAULT_WORKER_POOL_SIZE;

const parsedJobTimeoutMs = Number.parseInt(process.env.JOB_TIMEOUT_MS, 10);
const JOB_TIMEOUT_MS =
  Number.isInteger(parsedJobTimeoutMs) && parsedJobTimeoutMs > 0 ? parsedJobTimeoutMs : DEFAULT_JOB_TIMEOUT_MS;

const parsedMaxQueueDepth = Number.parseInt(process.env.MAX_QUEUE_DEPTH, 10);
const MAX_QUEUE_DEPTH =
  Number.isInteger(parsedMaxQueueDepth) && parsedMaxQueueDepth > 0 ? parsedMaxQueueDepth : DEFAULT_MAX_QUEUE_DEPTH;

const parsedCompileTimeoutMs = Number.parseInt(process.env.COMPILE_TIMEOUT_MS, 10);
const COMPILE_TIMEOUT_MS =
  Number.isInteger(parsedCompileTimeoutMs) && parsedCompileTimeoutMs > 0
    ? parsedCompileTimeoutMs
    : DEFAULT_COMPILE_TIMEOUT_MS;

const parsedRunTimeoutMs = Number.parseInt(process.env.RUN_TIMEOUT_MS, 10);
const RUN_TIMEOUT_MS =
  Number.isInteger(parsedRunTimeoutMs) && parsedRunTimeoutMs > 0 ? parsedRunTimeoutMs : DEFAULT_RUN_TIMEOUT_MS;

const parsedCompileMemoryLimitMb = Number.parseInt(process.env.COMPILE_MEMORY_LIMIT_MB, 10);
const COMPILE_MEMORY_LIMIT_MB =
  Number.isInteger(parsedCompileMemoryLimitMb) && parsedCompileMemoryLimitMb > 0
    ? parsedCompileMemoryLimitMb
    : DEFAULT_COMPILE_MEMORY_LIMIT_MB;

const parsedRunMemoryLimitMb = Number.parseInt(process.env.RUN_MEMORY_LIMIT_MB, 10);
const RUN_MEMORY_LIMIT_MB =
  Number.isInteger(parsedRunMemoryLimitMb) && parsedRunMemoryLimitMb > 0
    ? parsedRunMemoryLimitMb
    : DEFAULT_RUN_MEMORY_LIMIT_MB;

const BYTES_PER_MB = 1024 * 1024;
const COMPILE_MEMORY_LIMIT_BYTES = COMPILE_MEMORY_LIMIT_MB * BYTES_PER_MB;
const RUN_MEMORY_LIMIT_BYTES = RUN_MEMORY_LIMIT_MB * BYTES_PER_MB;

module.exports = {
  PORT,
  PISTON_API_URL,
  WORKER_POOL_SIZE,
  JOB_TIMEOUT_MS,
  MAX_QUEUE_DEPTH,
  COMPILE_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  COMPILE_MEMORY_LIMIT_MB,
  RUN_MEMORY_LIMIT_MB,
  COMPILE_MEMORY_LIMIT_BYTES,
  RUN_MEMORY_LIMIT_BYTES,
};
