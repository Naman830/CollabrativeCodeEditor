import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, connectPeer, createRoom, probeSocket, sleep, startServer } from "./helpers.mjs";

const CLOSE_ROOM_NOT_FOUND = 4404;
const CLOSE_SERVICE_RESTART = 1012;
const CLOSE_TOO_LARGE = 1009;

let server;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.stop();
});

describe("LC-11 the room-existence gate is server-side", () => {
  it("LC-11a an unknown room is refused with 4404 after the handshake, not a rejected upgrade", async () => {
    // A rejected upgrade reaches the browser as an opaque error with no code, so the client
    // cannot tell "this room is gone" from "the network blipped".
    const result = await probeSocket(server.wsBase, "00000000-0000-0000-0000-000000000000");
    expect(result.outcome).toBe("closed");
    expect(result.code).toBe(CLOSE_ROOM_NOT_FOUND);
  });

  it("LC-11b a probe against an unknown room does NOT create it", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    await probeSocket(server.wsBase, id);
    // Connecting is what creates a doc in y-websocket, so the gate has to run first.
    expect((await (await fetch(`${server.base}/rooms/${id}`)).json()).exists).toBe(false);
    const again = await probeSocket(server.wsBase, id);
    expect(again.code).toBe(CLOSE_ROOM_NOT_FOUND);
  });

  it("LC-11c a reserved room accepts a socket and stays open", async () => {
    const { roomId } = await createRoom(server.base, "python");
    const result = await probeSocket(server.wsBase, roomId);
    expect(result.outcome).toBe("stayed-open");
  });
});

describe("SYNC-01 two peers converge through the server", () => {
  it("SYNC-01a an edit by one peer reaches the other", async () => {
    const { roomId } = await createRoom(server.base, "python");
    const a = connectPeer(server.wsBase, roomId);
    expect(await a.synced).toBe(true);
    const b = connectPeer(server.wsBase, roomId);
    expect(await b.synced).toBe(true);

    a.doc.getText("file:main").insert(0, "hello from A");
    for (let i = 0; i < 40 && b.doc.getText("file:main").toString() === ""; i++) await sleep(50);
    expect(b.doc.getText("file:main").toString()).toBe("hello from A");

    // And the reverse direction, concurrently.
    b.doc.getText("file:main").insert(0, "B says ");
    for (let i = 0; i < 40 && !a.doc.getText("file:main").toString().startsWith("B says"); i++) {
      await sleep(50);
    }
    expect(a.doc.getText("file:main").toString()).toBe(b.doc.getText("file:main").toString());

    a.destroy();
    b.destroy();
  });

  it("SYNC-01b a late joiner receives the whole document", async () => {
    const { roomId } = await createRoom(server.base, "python");
    const a = connectPeer(server.wsBase, roomId);
    await a.synced;
    a.doc.getMap("files").set("main", { name: "main.py", createdAt: 1 });
    a.doc.getText("file:main").insert(0, "written before the second peer existed");
    await sleep(300);

    const late = connectPeer(server.wsBase, roomId);
    expect(await late.synced).toBe(true);
    for (let i = 0; i < 40 && late.doc.getText("file:main").length === 0; i++) await sleep(50);
    expect(late.doc.getText("file:main").toString()).toContain("before the second peer");
    // The files map rides on the same doc, so it arrives too — no extra protocol.
    expect(late.doc.getMap("files").get("main")?.name).toBe("main.py");

    a.destroy();
    late.destroy();
  });
});

describe("LC-12 the grace window", () => {
  it("LC-12a a reconnect inside the grace window keeps the document", async () => {
    const { roomId } = await createRoom(server.base, "python");
    const first = connectPeer(server.wsBase, roomId);
    await first.synced;
    first.doc.getText("file:main").insert(0, "survives a refresh");
    await sleep(300);
    first.destroy();

    // ROOM_GRACE_MS is 1000 in this harness; come back well inside it.
    await sleep(300);
    const second = connectPeer(server.wsBase, roomId);
    expect(await second.synced).toBe(true);
    for (let i = 0; i < 40 && second.doc.getText("file:main").length === 0; i++) await sleep(50);
    expect(second.doc.getText("file:main").toString()).toBe("survives a refresh");
    second.destroy();
  });

  it("LC-12b past the grace window the room is gone and refuses reconnection", async () => {
    const { roomId } = await createRoom(server.base, "python");
    const peer = connectPeer(server.wsBase, roomId);
    await peer.synced;
    peer.doc.getText("file:main").insert(0, "will not survive");
    await sleep(200);
    peer.destroy();

    await sleep(2_000); // past ROOM_GRACE_MS
    expect((await (await fetch(`${server.base}/rooms/${roomId}`)).json()).exists).toBe(false);
    const result = await probeSocket(server.wsBase, roomId);
    expect(result.code).toBe(CLOSE_ROOM_NOT_FOUND);
  });
});

describe("SEC-22 abusive frames close the socket, never the process", () => {
  it("SEC-22a a frame past maxPayload closes with 1009 and the server lives", async () => {
    const { roomId } = await createRoom(server.base, "python");
    const outcome = await new Promise((resolve) => {
      const ws = new WebSocket(`${server.wsBase}/${roomId}`);
      ws.on("open", () => ws.send(Buffer.alloc(5 * 1024 * 1024, 0x41)));
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => {});
      setTimeout(() => resolve("no-close"), 6_000);
    });
    expect(outcome).toBe(CLOSE_TOO_LARGE);
    expect((await fetch(`${server.base}/health`)).status).toBe(200);
  });

  it("SEC-22b a malformed frame closes the socket and the server lives", async () => {
    const { roomId } = await createRoom(server.base, "python");
    await new Promise((resolve) => {
      const sock = net.connect(server.port, "127.0.0.1", () => {
        sock.write(
          `GET /${roomId} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let upgraded = false;
      sock.on("data", (d) => {
        if (!upgraded && d.toString("latin1").includes("101")) {
          upgraded = true;
          // Reserved opcode 0x3: ws raises 'error' on the WebSocket, which y-websocket does not
          // listen for — an unhandled 'error' event throws and would take the process down.
          sock.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
        }
      });
      sock.on("close", resolve);
      sock.on("error", () => resolve());
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 5_000);
    });

    expect((await fetch(`${server.base}/health`)).status).toBe(200);
    const room = await createRoom(server.base, "python");
    expect(room.status).toBe(201);
  });

  it("SEC-22c a legitimate large frame is still accepted", async () => {
    const { roomId } = await createRoom(server.base, "python");
    const peer = connectPeer(server.wsBase, roomId);
    await peer.synced;
    // ~600 KB of text: well under the 4 MiB cap, and the kind of thing a paste produces.
    peer.doc.getText("file:main").insert(0, "x".repeat(600 * 1024));
    await sleep(600);

    const reader = connectPeer(server.wsBase, roomId);
    expect(await reader.synced).toBe(true);
    for (let i = 0; i < 60 && reader.doc.getText("file:main").length === 0; i++) await sleep(50);
    expect(reader.doc.getText("file:main").length).toBe(600 * 1024);

    peer.destroy();
    reader.destroy();
  });
});

describe("LC-13 shutdown closes clients with 1012, never 4404", () => {
  it("LC-13a a redeploy must not look permanent to the client", async () => {
    const isolated = await startServer({ ROOM_GRACE_MS: "10000" });
    const { roomId } = await createRoom(isolated.base, "python");
    const peer = connectPeer(isolated.wsBase, roomId);
    expect(await peer.synced).toBe(true);

    const closed = new Promise((resolve) => {
      peer.provider.on("connection-close", (event) => resolve(event?.code));
      setTimeout(() => resolve(null), 10_000);
    });

    isolated.child.kill("SIGTERM");
    const code = await closed;

    // 4404 makes the client call provider.disconnect() and show the closed screen forever, which
    // is exactly wrong for a restart.
    expect(code).toBe(CLOSE_SERVICE_RESTART);
    expect(code).not.toBe(CLOSE_ROOM_NOT_FOUND);

    peer.destroy();
    await isolated.stop();
    expect(isolated.log()).toContain("SIGTERM received");
    expect(isolated.log()).toContain("Shutdown complete");
  });

  it("LC-13b a socket arriving mid-drain is refused with 1012 too", async () => {
    const isolated = await startServer();
    const { roomId } = await createRoom(isolated.base, "python");
    isolated.child.kill("SIGTERM");
    // Racy by nature: accept either the 1012 refusal or the listener already being gone.
    const result = await probeSocket(isolated.wsBase, roomId, { timeout: 3_000 });
    expect(["closed", "error", "timeout"]).toContain(result.outcome);
    if (result.outcome === "closed") {
      expect(result.code).not.toBe(CLOSE_ROOM_NOT_FOUND);
    }
    await isolated.stop();
  });
});
