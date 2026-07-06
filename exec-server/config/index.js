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

module.exports = {
  PORT,
  PISTON_API_URL,
  WORKER_POOL_SIZE,
  JOB_TIMEOUT_MS,
  MAX_QUEUE_DEPTH,
};
