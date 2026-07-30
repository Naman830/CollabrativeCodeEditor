import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Its own file on purpose: reservations live in module state with a 5-minute unref'd timer and
// nothing exported clears them, so filling the ceiling would starve every other test in the file
// — and `reserveRoom` returning null makes those tests pass vacuously. `pool: "forks"` gives one
// fresh process per file, which is the isolation this needs.
const require = createRequire(import.meta.url);
delete process.env.DATABASE_URL;
const { MAX_RESERVATIONS, reserveRoom, roomExists } = require(
  join(import.meta.dirname, "../../src/rooms/lifecycle.js")
);

describe("LC-05 the global reservation ceiling", () => {
  it("LC-05a hands out exactly MAX_RESERVATIONS, then null so the caller can answer 429", () => {
    const ids = [];
    let next;
    while ((next = reserveRoom("1.2.3.4", "python")) !== null) {
      ids.push(next);
      if (ids.length > MAX_RESERVATIONS) break;
    }
    expect(MAX_RESERVATIONS).toBe(1000);
    expect(ids).toHaveLength(MAX_RESERVATIONS);
    expect(next).toBeNull();
    // Every one of them is a real, distinct room.
    expect(new Set(ids).size).toBe(MAX_RESERVATIONS);
    expect(roomExists(ids[0])).toBe(true);
  });

  it("LC-05b the ceiling bounds unclaimed rooms globally, not per caller", () => {
    // A different caller key does not buy more room: this is the global ceiling, and the per-IP
    // limiter on POST /rooms is the separate bound.
    expect(reserveRoom("9.9.9.9", "python")).toBeNull();
  });
});
