// In-memory job queue.
//
// This module is a skeleton. The worker pool (see ../worker/workerPool.js)
// needs a way to enqueue jobs and pull the next one when a worker is free.
// The actual data structure and concurrency safety (multiple workers
// pulling at once) are intentionally left unimplemented for you to design.
//
// Queue backpressure (MAX_QUEUE_DEPTH) is enforced by the caller (see the
// TODO in index.js's POST /execute handler) using isFull()/size() below,
// so a full queue is rejected before enqueue() is ever called.

const { MAX_QUEUE_DEPTH } = require("../config");

/**
 * Add a job to the queue.
 *
 * @param {object} job - Job payload (e.g. an id plus the original execute request).
 * @returns {void}
 */
function enqueue(job) {
  // TODO: Implement queueing logic.
  // - Choose the underlying data structure (array, linked list, etc.) and
  //   make sure ordering matches whatever fairness guarantee you want (FIFO?).
  // - Decide how a newly enqueued job wakes up an idle worker (event
  //   emitter, condition signal, polling loop in the pool, etc.).
  // - Capacity limits / what happens when the queue is "full" are explicitly
  //   out of scope for this pass (see README's "Full queue" note) — don't
  //   worry about that here yet.
  throw new Error("Not implemented");
}

/**
 * Remove and return the next job for a worker to process.
 * Called by the worker pool when a worker becomes free.
 *
 * @returns {object|undefined} The next job, or undefined if the queue is empty.
 */
function dequeue() {
  // TODO: Implement dequeue logic (pop from whatever structure enqueue() uses).
  throw new Error("Not implemented");
}

/**
 * @returns {number} Number of jobs currently waiting in the queue.
 */
function size() {
  // TODO: Return the current queue length.
  throw new Error("Not implemented");
}

/**
 * @returns {boolean} Whether the queue currently has no pending jobs.
 */
function isEmpty() {
  // TODO: Implement, presumably in terms of size().
  throw new Error("Not implemented");
}

/**
 * @returns {boolean} Whether the queue is at MAX_QUEUE_DEPTH capacity.
 */
function isFull() {
  // TODO (queue backpressure — depth check goes here): return whether
  // size() >= MAX_QUEUE_DEPTH. This is what index.js's POST /execute
  // handler calls to decide whether to reject a new request with 429
  // instead of enqueueing it.
  throw new Error("Not implemented");
}

module.exports = {
  enqueue,
  dequeue,
  size,
  isEmpty,
  isFull,
};
