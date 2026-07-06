# Execution Server

A standalone Express server that owns code execution as its own service boundary. `POST /execute` no longer calls Piston directly — it hands the request off to an in-memory job queue, which a fixed-size worker pool drains to run jobs against Piston.

## Endpoints

- `GET /health` — returns `{ "status": "ok" }`, for platform health checks.
- `POST /execute` — enqueues the request body as a job and holds the HTTP request open until a worker finishes it (or it times out / the queue is full). Returns `200` with `{ pistonStatus, data, result }` on success, `429` if the queue is full, `504` if the job hits `JOB_TIMEOUT_MS`, or `502` if Piston is unreachable or returns an invalid response.

## Project layout

```
exec-server/
  config/index.js               # env-derived config (PORT, PISTON_API_URL, WORKER_POOL_SIZE, JOB_TIMEOUT_MS, MAX_QUEUE_DEPTH, resource limits)
  piston/buildExecuteRequest.js # injects compile/run timeout & memory limits into every Piston request
  piston/classifyResult.js      # labels a Piston response as success/timeout/memory_limit_exceeded/killed/runtime_error/internal_error
  queue/jobQueue.js              # FIFO array-backed queue; enqueue/dequeue/size/isEmpty/isFull plus waitForJob() for idle workers
  worker/workerPool.js           # startPool spawns WORKER_POOL_SIZE pull-loop workers; processJob races Piston against JOB_TIMEOUT_MS and settles the job's own resolve/reject
  index.js                       # HTTP layer; builds a job with resolve/reject, enqueues it, awaits the result, rejects with 429 when the queue is full
```

## Running locally

```bash
cd exec-server
npm install
cp .env.example .env
npm run dev
```

Listens on `PORT` from `.env` (defaults to `4000`), proxies to `PISTON_API_URL` (defaults to `http://localhost:2000`, matching the local Docker Compose Piston container), reads `WORKER_POOL_SIZE` for the worker pool (defaults to `4`), `JOB_TIMEOUT_MS` for the per-job execution timeout (defaults to `10000`), `MAX_QUEUE_DEPTH` for queue backpressure (defaults to `100`), and `COMPILE_TIMEOUT_MS`/`RUN_TIMEOUT_MS`/`COMPILE_MEMORY_LIMIT_MB`/`RUN_MEMORY_LIMIT_MB` for the per-request Piston resource limits (see "Resource limits" below).

## Queue design

**Concurrency limit.** The worker pool size is fixed and configured via the `WORKER_POOL_SIZE` environment variable (default: `4`, see `config/index.js`). It's fixed rather than elastic because the pool exists to bound how many concurrent executions this service sends to Piston at once — Piston runs untrusted user code in sandboxes with real CPU/memory cost, so the number of simultaneous jobs needs an explicit ceiling rather than growing with request volume. `4` is a conservative starting default for local/small deployments; it should be tuned based on how many concurrent sandboxed executions the Piston instance(s) behind `PISTON_API_URL` can actually handle.

**Queue states.** `queue/jobQueue.js` is a plain array used as a FIFO, plus a private `EventEmitter` ("job-added") that lets idle workers block on `waitForJob()` instead of polling:

- **Empty** — no jobs waiting. Each worker in `worker/workerPool.js` calls `queue.waitForJob()`, which resolves immediately if a job is already there, or waits for the next `enqueue()` otherwise.
- **Has pending jobs** — one or more jobs are waiting because all `WORKER_POOL_SIZE` workers are currently busy. New jobs from `POST /execute` are appended and wait their turn in order; as workers finish their current job, they loop back and dequeue the next one. Since Node is single-threaded, multiple workers waking on the same event and racing `dequeue()` is safe — at most one gets each job.
- **Full** — the queue has reached `MAX_QUEUE_DEPTH` (see below). New jobs are rejected outright rather than queued.

Each job carries its own `resolve`/`reject` (attached by `index.js` when it enqueues the job), so `processJob()` delivers a result by settling that job's promise directly — no separate id-keyed lookup table needed.

## Per-job execution timeout

Each job is allowed to run for at most `JOB_TIMEOUT_MS` (env var, default **10000ms / 10s**) before it must be killed and the request failed, rather than left to hang indefinitely if Piston never responds. `worker/workerPool.js`'s `processJob()` races the Piston `fetch` against an `AbortController` armed by a `setTimeout(JOB_TIMEOUT_MS)`; whichever settles first wins, and the timer is cleared as soon as the fetch settles so a late abort is a no-op. A timeout rejects the request with `504` and `{ "error": "Job timed out after <ms>ms" }`.

## Queue backpressure

`MAX_QUEUE_DEPTH` (env var, default **100**) caps how many jobs may wait in the queue at once. When the queue is at capacity, a new `POST /execute` request is rejected **immediately** with:

- **Status:** `429 Too Many Requests`
- **Body:** `{ "error": "server busy, try again" }`

The depth check lives in `index.js`'s `POST /execute` handler (`queue.isFull()`, checked before a job is built or enqueued) backed by `queue/jobQueue.js`'s `isFull()` (`size() >= MAX_QUEUE_DEPTH`).

## Resource limits

Every request to Piston's `/api/v2/execute` has explicit resource limits injected server-side by `piston/buildExecuteRequest.js`, which always overwrites these fields with exec-server's own configured values — a caller cannot loosen its own limits by sending different values. These are Piston's own documented per-request fields (see `engineer-man/piston`'s `docs/api-v2.md`), not something exec-server invents:

| Env var | Piston request field | Unit | Default | Rationale |
|---|---|---|---|---|
| `COMPILE_TIMEOUT_MS` | `compile_timeout` | ms | **5000** (5s) | Under Piston server's own 10s ceiling. A few hundred ms isn't viable here — `javac`/`g++`/`tsc` need real toolchain/JVM startup time even for a one-line file, so too low a value would fail legitimate compiles, not just abusive ones. |
| `RUN_TIMEOUT_MS` | `run_timeout` | ms | **3000** (3s) | Matches Piston's own server-side default; enough for small snippets to run and print output without leaving a runaway loop alive for long. |
| `COMPILE_MEMORY_LIMIT_MB` | `compile_memory_limit` (bytes) | MB | **256** | Generous enough to cover JVM/`g++`/TypeScript-compiler baseline memory for a trivial single file, while still bounding a pathological compile. |
| `RUN_MEMORY_LIMIT_MB` | `run_memory_limit` (bytes) | MB | **128** | Small-snippet-appropriate; a demo has no business running programs that need more than this. |

These are deliberately conservative, portfolio-demo defaults (small snippets, not production workloads) — tune them per deployment via env vars if a supported language's toolchain needs more headroom.

**Process/fork count is the one limit that has no per-request field.** Piston's public API doesn't accept a per-request process-count override; it's only configurable as `PISTON_MAX_PROCESS_COUNT` (default `64`), an environment variable on the Piston server/container itself (with optional per-language overrides via `PISTON_LIMIT_OVERRIDES`), enforced via `isolate --processes=N`. This repo sets it to a more conservative `32` on the `piston` service in `collab-code-editor/docker-compose.yml` — exec-server has nothing to add per request here, since there's no such request field to set.

**How these tie into Piston's sandboxing.** Piston runs every job inside `isolate`, the sandboxing mechanism this project adopted when Piston was first self-hosted (v0.2) instead of building custom container isolation. Each job gets its own Linux namespaces (process/mount isolation from the host and other jobs) plus a cgroup that `isolate` uses to account for and cap that job's CPU time, wall-clock time, memory, and process count. The four request fields above and `PISTON_MAX_PROCESS_COUNT` aren't a separate enforcement layer — they're exec-server (and the Piston container's config) setting parameters on that same cgroups mechanism, per job, rather than Piston/`isolate` inventing a new limiting mechanism for each one.

## Distinguishing failure modes

A Piston response's exit code alone can't tell a timeout, a memory-limit kill, and a program that legitimately ran and exited non-zero apart — they can look identical (`code: null` or some non-zero value) unless you look at the sandbox's own status. `piston/classifyResult.js` reads the raw `status`/`signal`/`memory` fields Piston forwards from `isolate`'s job metadata for both the `compile` and `run` stages, and labels the outcome as one of:

- `success` — completed, exit code 0.
- `timeout` — the stage hit its configured `compile_timeout`/`run_timeout`.
- `memory_limit_exceeded` — the stage was killed by a signal *and* its reported memory usage was at or near the configured limit. Piston doesn't expose a dedicated "OOM" flag distinct from "killed by signal" in its response, so this is a best-effort heuristic (≥90% of the configured limit), not a guarantee — document this if you rely on it downstream.
- `killed` — the stage was killed by a signal that doesn't look memory-related (e.g. a crash).
- `output_limit_exceeded` — stdout/stderr exceeded Piston's output size limit.
- `internal_error` — `isolate` itself failed, independent of the user's code.
- `runtime_error` — the process ran to completion and exited with a non-zero code — a normal program failure, not a sandbox-imposed kill.

`worker/workerPool.js`'s `processJob()` calls this after every Piston response and returns it as `result` in the `POST /execute` response body, so callers get one of these distinct labels instead of a single generic "execution failed."

**Why reject instead of block.** A held-open HTTP connection waiting for queue space still consumes a client connection, a request thread/socket, and (client-side) a hung UI with no feedback — it just moves the unbounded growth from "queue array" to "in-flight open connections," which is not actually bounded. Rejecting immediately with `429` gives the caller a fast, explicit signal it can act on (retry with backoff, surface an error, shed load) instead of an indefinite hang, and it keeps the server's own resource usage (queue memory, open sockets) bounded and predictable under load — which matters here because jobs run untrusted user code against a shared Piston capacity that can already be saturated.
