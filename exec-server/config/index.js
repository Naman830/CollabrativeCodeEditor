// Centralized environment configuration for the exec-server.

const DEFAULT_WORKER_POOL_SIZE = 4;

const PORT = process.env.PORT || 4000;
const PISTON_API_URL = process.env.PISTON_API_URL || "http://localhost:2000";

const parsedPoolSize = Number.parseInt(process.env.WORKER_POOL_SIZE, 10);
const WORKER_POOL_SIZE =
  Number.isInteger(parsedPoolSize) && parsedPoolSize > 0 ? parsedPoolSize : DEFAULT_WORKER_POOL_SIZE;

module.exports = {
  PORT,
  PISTON_API_URL,
  WORKER_POOL_SIZE,
};
