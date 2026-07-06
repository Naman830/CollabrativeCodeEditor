const { WORKER_POOL_SIZE, PISTON_API_URL } = require("../config");
const queue = require("../queue/jobQueue");

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
 * TODO: Implement job lifecycle + result handling:
 * - Call PISTON_API_URL + "/api/v2/execute" with the job's request body
 *   (see the previous passthrough implementation that used to live in
 *   index.js for reference on request/response shape).
 * - Decide how/where the result is delivered back so the original HTTP
 *   request in index.js's POST /execute handler can pick it up. This is
 *   the async response-matching design mentioned there — intentionally
 *   left open (e.g. a jobId -> {resolve, reject} map, an EventEmitter
 *   keyed by job id, etc.).
 * - Handle job failure (Piston unreachable, invalid JSON, thrown errors)
 *   so a failed job resolves/rejects cleanly instead of wedging the worker
 *   or leaving the original request hanging forever.
 *
 * @param {object} job
 * @returns {Promise<void>}
 */
async function processJob(job) {
  // TODO: Implement.
  throw new Error("Not implemented");
}

module.exports = {
  startPool,
  processJob,
};
