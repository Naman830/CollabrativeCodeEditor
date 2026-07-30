// INVARIANT: `Number(x) || fallback` silently swallows a deliberate 0 and a typo alike, so a
// misconfigured knob looks exactly like an unset one. Every numeric env var in this workspace
// goes through this instead, with its own floor — the floors are not uniform, because 0 is
// meaningful for some (ROOM_GRACE_MS) and data loss for others (SNAPSHOT_WRITE_LIMIT).

function intFromEnv(raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, name = "env" } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;

  const parsed = Number(String(raw).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    console.warn(
      `${name}: ignoring ${JSON.stringify(String(raw))} (want an integer in [${min}, ${max}]); using ${fallback}`
    );
    return fallback;
  }
  return parsed;
}

module.exports = { intFromEnv };
