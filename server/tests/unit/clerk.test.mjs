import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const SRC = join(import.meta.dirname, "../../src");
const CLERK_PATH = require.resolve(join(SRC, "auth/clerk.js"));
const BACKEND_PATH = require.resolve("@clerk/backend");

/**
 * verifyToken is destructured at module load, so it cannot be spied afterwards. Pre-seeding
 * require.cache with a fake module is the only way to control it.
 */
function loadClerk({ secret = "sk_test_fake", verifyToken, authorizedParties } = {}) {
  if (secret === null) delete process.env.CLERK_SECRET_KEY;
  else process.env.CLERK_SECRET_KEY = secret;

  if (authorizedParties === undefined) delete process.env.CLERK_AUTHORIZED_PARTIES;
  else process.env.CLERK_AUTHORIZED_PARTIES = authorizedParties;

  const calls = [];
  delete require.cache[CLERK_PATH];
  require.cache[BACKEND_PATH] = {
    id: BACKEND_PATH,
    filename: BACKEND_PATH,
    loaded: true,
    exports: {
      verifyToken: (token, options) => {
        calls.push({ token, options });
        return verifyToken ? verifyToken(token, options) : Promise.resolve({ sub: "user_ok" });
      },
    },
  };
  return { clerk: require(CLERK_PATH), calls };
}

afterEach(() => {
  delete require.cache[CLERK_PATH];
  delete require.cache[BACKEND_PATH];
  delete process.env.CLERK_AUTHORIZED_PARTIES;
  delete process.env.CLERK_SECRET_KEY;
  vi.restoreAllMocks();
});

describe("AUTH-01 a token becomes a user id, and nothing else does", () => {
  it("AUTH-01a the id is the JWT `sub`, never any client-supplied field", async () => {
    const { clerk } = loadClerk({ verifyToken: () => Promise.resolve({ sub: "user_42", email: "x@y.z" }) });
    expect(await clerk.verifyClerkToken("tok")).toBe("user_42");
  });

  it("AUTH-01b a payload with no string sub yields null", async () => {
    for (const payload of [{}, { sub: 42 }, { sub: null }, null, undefined]) {
      const { clerk } = loadClerk({ verifyToken: () => Promise.resolve(payload) });
      expect(await clerk.verifyClerkToken("tok")).toBeNull();
    }
  });
});

describe("AUTH-02 verification never refuses the socket", () => {
  it("AUTH-02a an unset secret means no members, and costs zero network calls", async () => {
    const { clerk, calls } = loadClerk({ secret: null });
    expect(clerk.isEnabled()).toBe(false);
    expect(await clerk.verifyClerkToken("tok")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("AUTH-02b a missing or empty token short-circuits", async () => {
    const { clerk, calls } = loadClerk();
    for (const t of [null, undefined, ""]) expect(await clerk.verifyClerkToken(t)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("AUTH-02c a rejecting verifyToken resolves null rather than throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { clerk } = loadClerk({
      verifyToken: () => Promise.reject(Object.assign(new Error("bad"), { reason: "token-expired" })),
    });
    // A Clerk outage must cost a profile entry, never the room.
    await expect(clerk.verifyClerkToken("tok")).resolves.toBeNull();
  });

  it("AUTH-02d it warns exactly once per process, and never logs the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { clerk } = loadClerk({
      verifyToken: () => Promise.reject(Object.assign(new Error("nope"), { reason: "token-invalid" })),
    });
    const SECRET_TOKEN = "eyJhbGciOi.SUPERSECRET.sig";
    await clerk.verifyClerkToken(SECRET_TOKEN);
    await clerk.verifyClerkToken(SECRET_TOKEN);
    await clerk.verifyClerkToken(SECRET_TOKEN);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).not.toContain("SUPERSECRET");
    expect(warn.mock.calls[0][0]).toContain("token-invalid");
  });

  it("AUTH-02e a verifyToken that never settles resolves null on the timeout", async () => {
    vi.useFakeTimers();
    const { clerk } = loadClerk({ verifyToken: () => new Promise(() => {}) });
    const promise = clerk.verifyClerkToken("tok");
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(promise).resolves.toBeNull();
    vi.useRealTimers();
  });
});

describe("AUTH-03 authorizedParties is opt-in", () => {
  it("AUTH-03a unset means the azp claim is not constrained", async () => {
    const { clerk, calls } = loadClerk();
    await clerk.verifyClerkToken("tok");
    expect(calls[0].options).not.toHaveProperty("authorizedParties");
  });

  it("AUTH-03b set means it is passed through verbatim", async () => {
    const { clerk, calls } = loadClerk({
      authorizedParties: "https://app.example.com, http://localhost:3000",
    });
    await clerk.verifyClerkToken("tok");
    expect(calls[0].options.authorizedParties).toEqual([
      "https://app.example.com",
      "http://localhost:3000",
    ]);
  });

  it("AUTH-03c an azp rejection is reported with its message, since the reason alone is opaque", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { clerk } = loadClerk({
      authorizedParties: "https://app.example.com",
      verifyToken: () =>
        Promise.reject(
          Object.assign(new Error("azp 'https://evil.test' is not allowed"), {
            reason: "token-invalid-authorized-parties",
          })
        ),
    });
    expect(await clerk.verifyClerkToken("tok")).toBeNull();
    // "token-invalid-authorized-parties" on its own does not say WHICH origin was refused.
    expect(warn.mock.calls[0][0]).toContain("evil.test");
  });
});
