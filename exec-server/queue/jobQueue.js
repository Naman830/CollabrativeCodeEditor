// In-memory FIFO job queue.
//
// Backed by a plain array used as a queue (push to enqueue, shift to
// dequeue). Node is single-threaded, so there's no real concurrent-access
// race between enqueue()/dequeue() calls themselves — the only coordination
// problem is letting idle workers know when a job becomes available, which
// is handled via a small EventEmitter ("job-added") kept private to this
// module.
//
// Queue backpressure (MAX_QUEUE_DEPTH) is enforced by the caller (see
// index.js's POST /execute handler) using isFull()/size() below, so a full
// queue is rejected before enqueue() is ever called.

const EventEmitter = require("events");
const { MAX_QUEUE_DEPTH } = require("../config");

const jobs = [];
const emitter = new EventEmitter();
const JOB_ADDED_EVENT = "job-added";

/**
 * Add a job to the queue and wake up any worker waiting via waitForJob().
 *
 * @param {object} job - Job payload (e.g. an id plus the original execute request).
 * @returns {void}
 */
function enqueue(job) {
  jobs.push(job);
  emitter.emit(JOB_ADDED_EVENT);
}

/**
 * Remove and return the next job for a worker to process.
 * Called by the worker pool when a worker becomes free.
 *
 * @returns {object|undefined} The next job, or undefined if the queue is empty.
 */
function dequeue() {
  return jobs.shift();
}

/**
 * @returns {number} Number of jobs currently waiting in the queue.
 */
function size() {
  return jobs.length;
}

/**
 * @returns {boolean} Whether the queue currently has no pending jobs.
 */
function isEmpty() {
  return size() === 0;
}

/**
 * @returns {boolean} Whether the queue is at MAX_QUEUE_DEPTH capacity.
 */
function isFull() {
  return size() >= MAX_QUEUE_DEPTH;
}

/**
 * Resolve once a job is available to dequeue. Resolves immediately if the
 * queue is already non-empty. There's no await between the isEmpty() check
 * and registering the listener, so (single-threaded JS) nothing can sneak a
 * job in between and get missed.
 *
 * @returns {Promise<void>}
 */
function waitForJob() {
  if (!isEmpty()) return Promise.resolve();
  return new Promise((resolve) => emitter.once(JOB_ADDED_EVENT, resolve));
}

module.exports = {
  enqueue,
  dequeue,
  size,
  isEmpty,
  isFull,
  waitForJob,
};
