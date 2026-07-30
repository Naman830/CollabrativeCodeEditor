import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRoom, sleep, startServer } from "./helpers.mjs";

let server;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.stop();
});

/** A raw HTTP request, because curl and fetch both refuse to send a malformed Host. */
function rawRequest(port, lines) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(lines));
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("close", () => resolve(data));
    sock.on("error", (err) => resolve(`ERROR ${err.code}`));
    setTimeout(() => {
      sock.destroy();
      resolve(data || "TIMEOUT");
    }, 4_000);
  });
}

describe("API-01 GET /health", () => {
  it("API-01a answers 200 with ok:true while serving", async () => {
    const res = await fetch(`${server.base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("API-02 POST /rooms", () => {
  it("API-02a mints a room with the requested language", async () => {
    const room = await createRoom(server.base, "python");
    expect(room.status).toBe(201);
    expect(room.roomId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(room.language).toBe("python");
  });

  it("API-02b an unknown language falls back rather than failing the creation", async () => {
    // A stale client must never lose the ability to create a room.
    const room = await createRoom(server.base, "rust");
    expect(room.status).toBe(201);
    expect(room.language).toBe("javascript");
  });

  it("API-02c a body is never required, and no preflight is provoked", async () => {
    const res = await fetch(`${server.base}/rooms`, { method: "POST" });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("API-03 GET /rooms/:roomId always answers 200", () => {
  it("API-03a a live room reports exists:true with its language", async () => {
    const { roomId } = await createRoom(server.base, "cpp");
    const res = await fetch(`${server.base}/rooms/${roomId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: true, language: "cpp" });
  });

  it("API-03b an unknown room is 200 with exists:false, NOT a 404", async () => {
    // checkRoom() reads any non-ok response as *unreachable*, which shows the retry screen for a
    // room that never existed. Anything asserting on the status code reads every dead room alive.
    const res = await fetch(`${server.base}/rooms/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: false, language: null });
  });

  it("API-03c an empty id is exists:false, not a crash", async () => {
    const res = await fetch(`${server.base}/rooms/`);
    expect(res.status).toBe(200);
    expect((await res.json()).exists).toBe(false);
  });
});

describe("SEC-20 malformed input cannot kill the process", () => {
  const escapes = ["%", "%zz", "%ED%A0%80", "%C0%80", "a%", "%2F%2E%2E%2F"];

  it.each(escapes)("SEC-20a GET /rooms/%s answers 200 and the server survives", async (escape) => {
    const res = await fetch(`${server.base}/rooms/${escape}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: false, language: null });
    // Regression guard for the URIError that used to be a one-request kill switch.
    expect((await fetch(`${server.base}/health`)).status).toBe(200);
  });

  it("SEC-20b a malformed Host header is handled, not fatal", async () => {
    const response = await rawRequest(
      server.port,
      "GET /health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n"
    );
    expect(response).toContain("200");
    expect((await fetch(`${server.base}/health`)).status).toBe(200);
  });

  it("SEC-20c an absolute-form request target is handled, not fatal", async () => {
    const response = await rawRequest(
      server.port,
      "GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
    );
    expect(response).toMatch(/HTTP\/1\.1 \d{3}/);
    expect((await fetch(`${server.base}/health`)).status).toBe(200);
  });

  it("SEC-20d a binary Host header is handled, not fatal", async () => {
    await rawRequest(
      server.port,
      Buffer.from("GET /health HTTP/1.1\r\nHost: \xff\xfe\r\nConnection: close\r\n\r\n", "latin1")
    );
    expect((await fetch(`${server.base}/health`)).status).toBe(200);
  });

  it("SEC-20e the fallback is a 404, and unknown methods do not crash", async () => {
    expect((await fetch(`${server.base}/nope`)).status).toBe(404);
    expect((await fetch(`${server.base}/rooms`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${server.base}/health`)).status).toBe(200);
  });

  it("SEC-20f OPTIONS is answered 204 with CORS headers", async () => {
    const res = await fetch(`${server.base}/anything`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("SEC-21 POST /rooms is rate limited per caller", () => {
  it("SEC-21a the eleventh request in a minute is refused with Retry-After", async () => {
    // Its own server so the shared limiter map starts clean.
    const isolated = await startServer();
    try {
      const results = [];
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`${isolated.base}/rooms?language=python`, {
          method: "POST",
          headers: { "x-forwarded-for": `10.9.9.${i}, 198.51.100.55` },
        });
        results.push({ status: res.status, retryAfter: res.headers.get("retry-after") });
      }
      expect(results.slice(0, 10).every((r) => r.status === 201)).toBe(true);
      // A rotating forged prefix must not buy a fresh bucket.
      expect(results[10].status).toBe(429);
      expect(Number(results[10].retryAfter)).toBeGreaterThan(0);

      const body = await (
        await fetch(`${isolated.base}/rooms`, {
          method: "POST",
          headers: { "x-forwarded-for": "10.9.9.99, 198.51.100.55" },
        })
      ).json();
      // A 429 must read as "slow down", never as "couldn't reach the sync server".
      expect(body.error).toMatch(/too quickly/i);
    } finally {
      await isolated.stop();
    }
  });

  it("SEC-21b a different trusted hop keeps its own budget", async () => {
    const isolated = await startServer();
    try {
      for (let i = 0; i < 11; i++) {
        await fetch(`${isolated.base}/rooms`, {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.1" },
        });
      }
      const other = await fetch(`${isolated.base}/rooms`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.2" },
      });
      expect(other.status).toBe(201);
    } finally {
      await isolated.stop();
    }
  });
});

describe("LC-10 reservations expire", () => {
  it("LC-10a an unclaimed room stops existing after ROOM_RESERVATION_MS", async () => {
    const { roomId } = await createRoom(server.base, "python");
    expect((await (await fetch(`${server.base}/rooms/${roomId}`)).json()).exists).toBe(true);

    await sleep(2_200); // ROOM_RESERVATION_MS is 1500 in this harness
    expect((await (await fetch(`${server.base}/rooms/${roomId}`)).json()).exists).toBe(false);
  });
});
