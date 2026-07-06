const {
  WORKER_POOL_SIZE,
  PISTON_API_URL,
  JOB_TIMEOUT_MS,
  COMPILE_MEMORY_LIMIT_BYTES,
  RUN_MEMORY_LIMIT_BYTES,
} = require("../config");
const queue = require("../queue/jobQueue");
const { buildExecuteRequest } = require("../piston/buildExecuteRequest");
const { classifyResult } = require("../piston/classifyResult");

// Fixed-size worker pool that pulls jobs from the in-memory queue and runs
// them against Piston.
//
// Concurrency control (how many jobs run at once, how workers wait for /
// get notified of new jobs, and job lifecycle/error handling) is
// intentionally left unimplemented — see the TODOs below. WORKER_POOL_SIZE
// is already wired up via config/index.js (WORKER_POOL_SIZE env var).

/**
 * Start the worker pool.
 *
 * TODO: Implement pool startup and concurrency control:
 * - Spawn WORKER_POOL_SIZE concurrent workers (loops, promises, whatever
 *   model you choose), each pulling jobs via queue.dequeue() and calling
 *   processJob() on them.
 * - Decide how a worker waits when the queue is empty (polling interval?
 *   subscribing to an event the queue fires on enqueue()? something else?).
 * - Decide whether workers run jobs fully in parallel (up to
 *   WORKER_POOL_SIZE at once) or some other scheduling model.
 * - Handle pool shutdown/draining if the process needs to exit cleanly.
 *
 * @returns {void}
 */
function startPool() {
  // TODO: Implement. `queue` and WORKER_POOL_SIZE are already in scope.
  throw new Error("Not implemented");
}

/**
 * Process a single job: run it against Piston and deliver its result to
 * whatever is waiting on it.
 *
 * The Piston call itself is implemented below: every request has resource
 * limits injected via buildExecuteRequest() (see piston/buildExecuteRequest.js)
 * and every response is labeled via classifyResult() (see
 * piston/classifyResult.js) so a timeout, an OOM-kill, and a clean non-zero
 * exit are distinguishable instead of being lumped into one generic error.
 *
 * TODO: Job lifecycle + result delivery is still open:
 * - Decide how/where the result is delivered back so the original HTTP
 *   request in index.js's POST /execute handler can pick it up. This is
 *   the async response-matching design mentioned there — intentionally
 *   left open (e.g. a jobId -> {resolve, reject} map, an EventEmitter
 *   keyed by job id, etc.).
 * - Handle job failure (Piston unreachable, invalid JSON, thrown errors)
 *   so a failed job resolves/rejects cleanly instead of wedging the worker
 *   or leaving the original request hanging forever.
 *
 * TODO (per-job execution timeout — kill logic goes here): the fetch call
 * below must be raced against JOB_TIMEOUT_MS (this is exec-server's own
 * dead-man switch on the whole HTTP call, separate from the compile_timeout/
 * run_timeout fields Piston enforces internally). If JOB_TIMEOUT_MS elapses
 * first, the in-flight request needs to be aborted (e.g. an AbortController
 * passed to fetch) and the job resolved/rejected with a timeout error rather
 * than left to finish on its own. Make sure whichever finishes second (the
 * late Piston response vs. the timeout) is a no-op — the job must be settled
 * exactly once, and the worker must be freed to pick up its next job either
 * way.
 *
 * @param {object} job
 * @returns {Promise<void>}
 */
async function processJob(job) {
  const pistonRequest = buildExecuteRequest(job.request);

  let pistonRes;
  try {
    pistonRes = await fetch(`${PISTON_API_URL}/api/v2/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pistonRequest),
    });
  } catch (err) {
    throw new Error(`Could not reach Piston: ${err.message}`);
  }

  let data;
  try {
    data = await pistonRes.json();
  } catch (err) {
    throw new Error(`Piston returned an invalid response: ${err.message}`);
  }

  const result = classifyResult(data, {
    compileMemoryLimitBytes: COMPILE_MEMORY_LIMIT_BYTES,
    runMemoryLimitBytes: RUN_MEMORY_LIMIT_BYTES,
  });

  // TODO: deliver `{ pistonStatus: pistonRes.status, data, result }` back to
  // whatever is waiting on this job — see the lifecycle TODO above. Nothing
  // is listening for a job's result yet, so there's nowhere to send it.
  throw new Error("Not implemented: job result delivery");
}

module.exports = {
  startPool,
  processJob,
};
