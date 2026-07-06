require("dotenv").config();

const express = require("express");

const PORT = process.env.PORT || 4000;
const PISTON_API_URL = process.env.PISTON_API_URL || "http://localhost:2000";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/execute", async (req, res) => {
  let pistonRes;
  try {
    pistonRes = await fetch(`${PISTON_API_URL}/api/v2/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
  } catch {
    res.status(502).json({ error: "Could not reach the code execution service." });
    return;
  }

  let data;
  try {
    data = await pistonRes.json();
  } catch {
    res.status(502).json({ error: "Code execution service returned an invalid response." });
    return;
  }

  res.status(pistonRes.status).json(data);
});

app.listen(PORT, () => {
  console.log(`Execution server listening on port ${PORT}, proxying to ${PISTON_API_URL}`);
});
