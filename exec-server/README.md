# Execution Server

A standalone Express server that owns code execution as its own service boundary. Right now it's a bare passthrough: `POST /execute` forwards the request body straight to Piston's `/api/v2/execute` and relays back whatever Piston returns (status code included) — no queueing, retries, or request shaping yet. That comes next, on top of this boundary.

## Endpoints

- `GET /health` — returns `{ "status": "ok" }`, for platform health checks.
- `POST /execute` — proxies the request body to `${PISTON_API_URL}/api/v2/execute` and returns Piston's response verbatim.

## Running locally

```bash
cd exec-server
npm install
cp .env.example .env
npm run dev
```

Listens on `PORT` from `.env` (defaults to `4000`), and proxies to `PISTON_API_URL` (defaults to `http://localhost:2000`, matching the local Docker Compose Piston container).
