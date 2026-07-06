require("dotenv").config();

const express = require("express");

const { PORT, PISTON_API_URL } = require("./config");
const { enqueue } = require("./queue/jobQueue");
const { startPool } = require("./worker/workerPool");

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/execute", async (req, res) => {
  // TODO: Build a job object from req.body (e.g. { id: <generate>, request:
  // req.body }) and enqueue it for the worker pool instead of calling
  // Piston directly here.
  //
  // TODO (async response handling — design this yourself): enqueue() just
  // hands the job off; something needs to hold this request open until the
  // worker pool finishes the job, then send `res` with the result. Options
  // to consider: an in-memory map of jobId -> {resolve, reject} that
  // workerPool.processJob() resolves and this handler awaits; an
  // EventEmitter keyed by job id; or decoupling this into a
  // submit-then-poll/webhook model. Whatever you pick, make sure `res` is
  // sent exactly once and that a failed job still responds instead of
  // leaving the connection hanging.
  try {
    enqueue(req.body);
  } catch (err) {
    // queue/jobQueue.js isn't implemented yet — respond instead of letting
    // the request hang or crashing the process on an unhandled rejection.
    res.status(501).json({ error: `Job queue not implemented yet: ${err.message}` });
    return;
  }

  res.status(501).json({
    error: "Job queueing is wired up, but async response handling is not implemented yet.",
  });
});

try {
  startPool();
} catch (err) {
  // Worker pool isn't implemented yet — log and keep the server up so
  // /health still works while you build out queue/jobQueue.js and
  // worker/workerPool.js.
  console.warn(`Worker pool not started: ${err.message}`);
}

app.listen(PORT, () => {
  console.log(`Execution server listening on port ${PORT}, proxying to ${PISTON_API_URL}`);
});
