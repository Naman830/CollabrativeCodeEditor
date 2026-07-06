# Execution Server

A standalone Express server that owns code execution as its own service boundary. `POST /execute` no longer calls Piston directly — it hands the request off to an in-memory job queue, which a fixed-size worker pool drains to run jobs against Piston. The queueing and worker-pool logic is currently scaffolded but not implemented (see "Queue design" below and the `TODO` comments in `queue/jobQueue.js` and `worker/workerPool.js`).

## Endpoints

- `GET /health` — returns `{ "status": "ok" }`, for platform health checks.
- `POST /execute` — enqueues the request body as a job. Currently returns `501` because the queue isn't implemented yet, and because the async response-handling design (how this handler gets the job's result back once a worker finishes it) hasn't been decided yet either.

## Project layout

```
exec-server/
  config/index.js        # env-derived config (PORT, PISTON_API_URL, WORKER_POOL_SIZE)
  queue/jobQueue.js       # enqueue/dequeue/size/isEmpty — data structure & concurrency TODO
  worker/workerPool.js    # startPool/processJob — pool concurrency & job lifecycle TODO
  index.js                # HTTP layer; wires POST /execute to enqueue()
```

## Running locally

```bash
cd exec-server
npm install
cp .env.example .env
npm run dev
```

Listens on `PORT` from `.env` (defaults to `4000`), proxies to `PISTON_API_URL` (defaults to `http://localhost:2000`, matching the local Docker Compose Piston container), and reads `WORKER_POOL_SIZE` for the worker pool (defaults to `4`).

## Queue design

**Concurrency limit.** The worker pool size is fixed and configured via the `WORKER_POOL_SIZE` environment variable (default: `4`, see `config/index.js`). It's fixed rather than elastic because the pool exists to bound how many concurrent executions this service sends to Piston at once — Piston runs untrusted user code in sandboxes with real CPU/memory cost, so the number of simultaneous jobs needs an explicit ceiling rather than growing with request volume. `4` is a conservative starting default for local/small deployments; it should be tuned based on how many concurrent sandboxed executions the Piston instance(s) behind `PISTON_API_URL` can actually handle.

**Conceptual queue states** (the underlying data structure and capacity handling are still TODOs — this describes intended behavior, not what's implemented yet):

- **Empty** — no jobs waiting. An idle worker has nothing to dequeue and should wait (poll, subscribe to an event, etc. — left as a TODO) until `enqueue()` adds a job.
- **Has pending jobs** — one or more jobs are waiting because all `WORKER_POOL_SIZE` workers are currently busy. New jobs from `POST /execute` are appended and wait their turn in order; as workers finish their current job, they dequeue the next one.
- **Full** — the queue has reached some maximum capacity. What "full" means (a max length? memory-based?) and what happens when a new job arrives at that point (reject with an error? block the request? drop the oldest job?) is explicitly **not implemented in this pass** — that's the next step, once the core queueing and worker-pool logic above is in place.
