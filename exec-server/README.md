# Execution Server

A standalone Express server that owns code execution as its own service boundary. `POST /execute` no longer calls Piston directly — it hands the request off to an in-memory job queue, which a fixed-size worker pool drains to run jobs against Piston. The queueing and worker-pool logic is currently scaffolded but not implemented (see "Queue design" below and the `TODO` comments in `queue/jobQueue.js` and `worker/workerPool.js`).

## Endpoints

- `GET /health` — returns `{ "status": "ok" }`, for platform health checks.
- `POST /execute` — enqueues the request body as a job. Currently returns `501` because the queue isn't implemented yet, and because the async response-handling design (how this handler gets the job's result back once a worker finishes it) hasn't been decided yet either.

## Project layout

```
exec-server/
  config/index.js        # env-derived config (PORT, PISTON_API_URL, WORKER_POOL_SIZE, JOB_TIMEOUT_MS, MAX_QUEUE_DEPTH)
  queue/jobQueue.js       # enqueue/dequeue/size/isEmpty/isFull — data structure, concurrency & depth-check TODO
  worker/workerPool.js    # startPool/processJob — pool concurrency, job lifecycle & timeout-kill TODO
  index.js                # HTTP layer; wires POST /execute to enqueue(), rejects with 429 when the queue is full
```

## Running locally

```bash
cd exec-server
npm install
cp .env.example .env
npm run dev
```

Listens on `PORT` from `.env` (defaults to `4000`), proxies to `PISTON_API_URL` (defaults to `http://localhost:2000`, matching the local Docker Compose Piston container), reads `WORKER_POOL_SIZE` for the worker pool (defaults to `4`), `JOB_TIMEOUT_MS` for the per-job execution timeout (defaults to `10000`), and `MAX_QUEUE_DEPTH` for queue backpressure (defaults to `100`).

## Queue design

**Concurrency limit.** The worker pool size is fixed and configured via the `WORKER_POOL_SIZE` environment variable (default: `4`, see `config/index.js`). It's fixed rather than elastic because the pool exists to bound how many concurrent executions this service sends to Piston at once — Piston runs untrusted user code in sandboxes with real CPU/memory cost, so the number of simultaneous jobs needs an explicit ceiling rather than growing with request volume. `4` is a conservative starting default for local/small deployments; it should be tuned based on how many concurrent sandboxed executions the Piston instance(s) behind `PISTON_API_URL` can actually handle.

**Conceptual queue states** (the underlying data structure and concurrency-safe dequeue logic are still TODOs — this describes intended behavior, not what's fully implemented yet):

- **Empty** — no jobs waiting. An idle worker has nothing to dequeue and should wait (poll, subscribe to an event, etc. — left as a TODO) until `enqueue()` adds a job.
- **Has pending jobs** — one or more jobs are waiting because all `WORKER_POOL_SIZE` workers are currently busy. New jobs from `POST /execute` are appended and wait their turn in order; as workers finish their current job, they dequeue the next one.
- **Full** — the queue has reached `MAX_QUEUE_DEPTH` (see below). New jobs are rejected outright rather than queued.

## Per-job execution timeout

Each job is allowed to run for at most `JOB_TIMEOUT_MS` (env var, default **10000ms / 10s**) before it must be killed and the request failed, rather than left to hang indefinitely if Piston never responds. The enforcement point is scaffolded as a `TODO` in `worker/workerPool.js`'s `processJob()`, where the Piston call needs to be raced against the timeout (e.g. via `AbortController`) — not implemented yet.

## Queue backpressure

`MAX_QUEUE_DEPTH` (env var, default **100**) caps how many jobs may wait in the queue at once. When the queue is at capacity, a new `POST /execute` request is rejected **immediately** with:

- **Status:** `429 Too Many Requests`
- **Body:** `{ "error": "server busy, try again" }`

The depth check is scaffolded as a `TODO` in `index.js`'s `POST /execute` handler (checking `queue.isFull()` before enqueueing) and in `queue/jobQueue.js`'s `isFull()` — not implemented yet.

**Why reject instead of block.** A held-open HTTP connection waiting for queue space still consumes a client connection, a request thread/socket, and (client-side) a hung UI with no feedback — it just moves the unbounded growth from "queue array" to "in-flight open connections," which is not actually bounded. Rejecting immediately with `429` gives the caller a fast, explicit signal it can act on (retry with backoff, surface an error, shed load) instead of an indefinite hang, and it keeps the server's own resource usage (queue memory, open sockets) bounded and predictable under load — which matters here because jobs run untrusted user code against a shared Piston capacity that can already be saturated.
