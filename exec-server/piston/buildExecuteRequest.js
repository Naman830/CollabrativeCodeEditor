// Builds the request body sent to Piston's POST /api/v2/execute, injecting
// server-controlled resource limits on every request.
//
// Piston's documented per-request fields for this are (see
// docs/api-v2.md in engineer-man/piston):
//   - compile_timeout       (ms)    - max time the compile stage may run
//   - run_timeout           (ms)    - max time the run stage may run
//   - compile_memory_limit  (bytes) - max memory the compile stage may use
//   - run_memory_limit      (bytes) - max memory the run stage may use
//
// There is no per-request field for limiting process/fork count — Piston
// only exposes that as PISTON_MAX_PROCESS_COUNT, a config value on the
// Piston server itself (with optional per-language overrides via
// PISTON_LIMIT_OVERRIDES), enforced via `isolate --processes=N`. exec-server
// has no request-body knob to set for it; see exec-server/README.md's
// "Resource limits" section and collab-code-editor/docker-compose.yml for
// where that limit is actually configured.
//
// These four fields are always overwritten with the exec-server-configured
// values, even if the caller's request body already set them — a client
// must not be able to loosen its own execution limits.

const {
  COMPILE_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  COMPILE_MEMORY_LIMIT_BYTES,
  RUN_MEMORY_LIMIT_BYTES,
} = require("../config");

/**
 * @param {object} request - The incoming execute request body (language,
 *   version, files, stdin, args, etc.), as received from the caller.
 * @returns {object} A new request body with resource limit fields set to
 *   the exec-server-configured values, regardless of what the caller sent.
 */
function buildExecuteRequest(request) {
  return {
    ...request,
    compile_timeout: COMPILE_TIMEOUT_MS,
    run_timeout: RUN_TIMEOUT_MS,
    compile_memory_limit: COMPILE_MEMORY_LIMIT_BYTES,
    run_memory_limit: RUN_MEMORY_LIMIT_BYTES,
  };
}

module.exports = { buildExecuteRequest };
