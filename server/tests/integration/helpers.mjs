import { spawn } from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const WebSocket = require("ws");
export const Y = require("yjs");

const SERVER_DIR = join(import.meta.dirname, "../..");

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boots the real src/index.js on a free port with tuned timers. DATABASE_URL and
 * CLERK_SECRET_KEY are cleared by default, so this tier needs neither Postgres nor Clerk — the
 * guest flow is the whole of v1 and must work without either.
 */
export async function startServer(env = {}) {
  const port = await freePort();
  const child = spawn("node", ["src/index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: "",
      CLERK_SECRET_KEY: "",
      ROOM_GRACE_MS: "1000",
      ROOM_RESERVATION_MS: "1500",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }

  return {
    port,
    base,
    wsBase,
    child,
    log: () => log,
    async stop(signal = "SIGKILL") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 8_000);
      });
    },
  };
}

export async function createRoom(base, language = "python") {
  const res = await fetch(`${base}/rooms?language=${language}`, { method: "POST" });
  const body = await res.json();
  return { status: res.status, ...body, retryAfter: res.headers.get("retry-after") };
}

/** Opens a socket and reports how it closed, without speaking the Yjs protocol. */
export function probeSocket(wsBase, roomId, { timeout = 6_000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/${roomId}`);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    ws.on("open", () => setTimeout(() => done({ outcome: "stayed-open" }), 700));
    ws.on("close", (code, reason) => done({ outcome: "closed", code, reason: String(reason) }));
    ws.on("error", (err) => done({ outcome: "error", message: err.message }));
    setTimeout(() => done({ outcome: "timeout" }), timeout);
  });
}

/**
 * A real Yjs peer over a raw ws, using y-websocket's own provider with a ws polyfill — the
 * documented way to simulate a peer (hostile or otherwise) headlessly.
 */
export function connectPeer(wsBase, roomId) {
  const { WebsocketProvider } = require("y-websocket");
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(wsBase, roomId, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
  return {
    doc,
    provider,
    synced: new Promise((resolve) => {
      provider.once("sync", () => resolve(true));
      setTimeout(() => resolve(false), 8_000);
    }),
    closeCode: new Promise((resolve) => {
      provider.on("connection-close", (event) => resolve(event?.code));
      setTimeout(() => resolve(null), 8_000);
    }),
    destroy() {
      try {
        provider.destroy();
      } catch {
        /* ignore */
      }
      try {
        doc.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}
