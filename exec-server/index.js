require("dotenv").config();

const express = require("express");
const { randomUUID } = require("crypto");

const { PORT, PISTON_API_URL } = require("./config");
const queue = require("./queue/jobQueue");
const { startPool } = require("./worker/workerPool");

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/execute", async (req, res) => {
  if (queue.isFull()) {
    return res.status(429).json({ error: "server busy, try again" });
  }

  const job = { id: randomUUID(), request: req.body };

  try {
    const result = await new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      queue.enqueue(job);
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

startPool();

app.listen(PORT, () => {
  console.log(`Execution server listening on port ${PORT}, proxying to ${PISTON_API_URL}`);
});
