# Code execution: the Run button, the sandbox limits, and hosting Piston

Everything from a Run click to a Piston response, the ceilings a run may consume, and why execution is a local-only feature.

*Split out of `CLAUDE.md` on 2026-07-31. Same rules apply: this is the **why** — measurements,
rejected alternatives, debugging history. The code carries the rule, this carries the rationale,
and a change that contradicts a paragraph here rewrites it rather than appending a correction.*

## Shared code execution (the Run button)

Clicking Run broadcasts the result to **everyone in the room**, not just the clicker. This
rides entirely on Yjs, not a new server message: `web/src/hooks/useCollabRoom.ts` puts a second shared type,
`yDoc.getMap<ExecutionState>("execution")`, on the *same* `Y.Doc` that already holds the code
(one `Y.Text` per file since §10.1 — `yDoc.getText("file:<id>")`, previously the single
`"monaco"`). y-websocket's sync protocol doesn't distinguish between shared
types — it merges the whole document — so this new map syncs to every peer, including late
joiners, for free. `server/src/sync/connection.js` needed zero changes, and §10.1's file map and entry
pointer rode in on exactly the same property.

**One key, whole-record replacement.** The map has a single key, `"state"`, whose value is
the entire `ExecutionState` object — never separate sub-fields. That way a `.set("state", …)`
is atomic from Yjs's perspective: concurrent writes from two peers resolve to one complete
record, never a mix of fields from two different runs.

**`runId` resolves the one race the room-wide lock can't.** The Run button is disabled for
every peer whenever the shared status is `"running"` — but two peers can still click Run
before either has received the other's write over the WebSocket. Both writes converge on the
same winning record (Yjs's normal conflict resolution); the *loser's* Piston response, when it
eventually arrives, must recognise `executionMap.get("state")?.runId !== runId` and discard
itself rather than clobbering the winner. `useCodeRunner`'s `stale()` check covers this, plus
the case where the effect torn down (room switch/unmount) while the fetch was in flight, via
the `docRef` ref `useCollabRoom` returns (a ref, not state — see the Yjs-lifecycle gotcha below: hoisting the doc into
state is exactly what must not happen, and a ref carries no such risk since it doesn't drive
renders).

**A dead runner can't be allowed to lock the room forever.** Verified while testing this
feature: if the peer who clicked Run closes their tab (or the network drops) before their
fetch to `/api/execute` resolves, the browser cancels that fetch outright — nothing ever
writes a final result, and since every peer's Run button stays disabled while status is
`"running"`, the room would otherwise be stuck showing "Running..." **permanently**, with no
way for anyone to ever click Run again. Fixed with a small watchdog: every connected client
runs a `setInterval` that checks whether the current `"running"` record is older than
`STALE_RUN_MS` and, if so, writes an `"error"` record itself. There is no single "owner" of an
abandoned run once it's shared state, so whichever client's watchdog tick fires first heals it
for everyone; the others' ticks are redundant, idempotent no-ops.

**Three timeouts are nested, and the ordering is the whole point.** Innermost, the sandbox
stops the *program* (10s compile + 5s run at worst). Then the route's `PISTON_TIMEOUT_MS`
(18s `AbortController`) catches a Piston that never answers at all. Outermost,
`STALE_RUN_MS` (25s) decides the *client* is gone. Each layer must sit above the one it
contains or it starts firing on cases the inner layer was about to handle correctly — set
the fetch abort to 15s and a legitimate 10s-compile-plus-5s-run reports "Execution timed
out"; set the watchdog below the fetch abort and a merely-slow run is reported room-wide as
a lost connection. Change one and re-check all three.

**The output panel shows the run's own `language` and `filename`, never anything local to the
viewer.** The caption ("Run by Alice A. · main.py · Python") is sourced entirely from the shared
record. `filename` is the half that still bites since §10.1: Run executes the room's **entry**
file, which need not be the tab the person watching has open, so without it the output belongs to
no visible file. (`language` was the same problem for a different reason before §10.1 — it was a
per-user dropdown, so two peers could watch one run with different languages selected. It is now
a property of the room, but the rule is unchanged: read the record, not local state.)

**The run's `stdin` is on the shared record; the box you type into is not (§10.4).**
`ExecutionState` carries `stdin`, so every peer can see what produced the output they are
looking at — the same reason the caption shows the run's own `language`. The *draft* stays in
`CodeEditor`'s local state and is never synced, which is what stops a remote run overwriting
what someone is halfway through typing; `OutputPanel` renders the local draft in the textarea
and `state.stdin` in the read-only echo, and must never confuse the two. `stdin` is **required**
on the three non-idle variants (unlike `notice`), which is what makes the compiler enumerate all
five write sites — four in `useCodeRunner` plus the stale-run watchdog in `useCollabRoom`, which
has to carry it through when it heals an abandoned run rather than dropping it.

**Code and stdin share one 64 KB budget, and that is why `REQUEST_BYTE_CEILING` did not move.**
`payloadTooLarge(code, stdin)` in `web/src/lib/sandbox/execution.ts` is the single rule, imported by both
the client pre-check and the route's 413 for the same reason `codeByteLength` already lived
there. Because the decoded payload still caps at `MAX_CODE_BYTES`, the route's existing "doubled
for JSON escaping" `Content-Length` headroom still covers the whole envelope. A *separate* stdin
cap would have doubled the worst case and forced that constant up with it — so if a per-field
cap is ever wanted, `REQUEST_BYTE_CEILING` has to be raised in the same change. Verified at the
boundary: 60 KB code + 8 KB stdin is a 413, 60 KB + 3 KB runs.

**Attribution bypasses `readPeers` on purpose.** `startedBy: {name, color}` is written from
the clicking user's own trusted `displayName(user)`/`user.color` (`web/src/lib/collab/user.ts`) at the moment
they click Run — not from remote awareness. `readPeers`/`web/src/lib/collab/awareness.ts` exists to sanitize
*other* peers' self-reported state; a client's own already-validated identity needs no such
gate, and going through `readPeers` here would be pointless indirection.

## Execution limits (what a run may consume)

Sent with every Piston request from `app/api/execute/route.ts`, and mirrored as ceilings in
`docker-compose.yml` (see the Piston gotcha above — Piston 400s a request that exceeds its
configured limit, so the two files are one setting in two places):

| Limit | Value | Why |
| --- | --- | --- |
| `run_timeout` / `run_cpu_time` | 5s each | Wall and CPU are **separate** ceilings in Piston, and both must be raised together. `while True: pass` burns CPU as fast as wall clock, so raising only `run_timeout` leaves it dying at the 3s default `run_cpu_time` — verified: it was killed at 3.1s with `run_timeout: 5000` set. |
| `compile_timeout` / `compile_cpu_time` | 10s each | Piston's own defaults; javac and g++ need the room. |
| `run_memory_limit` | 256 MB | An allocation loop is stopped here rather than by the host running out of memory. |
| `compile_memory_limit` | 512 MB | Verified sufficient for the java and c++ packages; the run stage is the one worth squeezing. |

Piston's untouched defaults do the rest of the work and are worth knowing before adding
another limit: `max_process_count` (64) is what bounds a fork bomb and `max_open_files`
(2048) a descriptor loop.

**A sandbox-killed program must not read as a crash in the user's code.** Piston reports an
out-of-memory kill as exit code 137 with a line from its own shell wrapper
(`/piston/packages/python/3.10.0/run: line 3: 3 Killed …`), which exposes sandbox internals
and says nothing about memory. `noticeFor()` turns it into a plain sentence and
`OOM_KILL_NOISE` strips the line, exactly as `SANDBOX_KEEPER_NOISE` does for the output cap.

**Status `"RE"` means *any* non-zero exit, so it is not by itself notice-worthy.** A normal
`raise ValueError` comes back as `status: "RE", code: 1` — stderr and the exit code already
say that, and an amber "Exited with error status 1" over the top is pure noise. Only
`code === 137` (128 + SIGKILL) earns a notice.

## Production execution path

Piston cannot be deployed alongside the other two services: it needs a **privileged**
container (`isolate`, cgroups, `tmpfs … :exec`), which neither Vercel nor Railway allows.
The public Piston API at `emkc.org` is not a fallback — it went **whitelist-only on
2026-02-15** and now `401`s every request.

**The ngrok tunnel described below has been shut down on purpose, and must not be brought back
in this form.** `ngrok-piston.service` is stopped and `systemctl --user disable`d, and
`docker-compose.yml` now binds Piston to `127.0.0.1:2000` instead of `0.0.0.0:2000`. So
**execution works locally and is simply unavailable on the deployed site** — the Run button
there reports `"Could not reach the code execution service."`, which is now the expected
production behaviour rather than a fault to debug.

Why it was removed, measured rather than assumed: the tunnel exposed
`POST /api/v2/execute` to the public internet with **no authentication at all** (verified by
executing Python on the host from the public hostname with no credential), which also bypassed
`route.ts`'s 10/min/IP limiter entirely, since that limiter lives on Vercel and the tunnel goes
straight to Piston. Worse, the container runs `privileged: true` and therefore holds the **full
capability set** (`CapEff: 000001ffffffffff`, verified inside the container), so `isolate` is
the *only* boundary between a stranger's code and root on the host. Two things that limit the
damage were also verified and are worth knowing before re-enabling anything: the sandbox has
**no network** (`socket.create_connection` → `Errno 101 Network is unreachable`), and a run
executes as an unprivileged throwaway uid with none of the host filesystem mounted.

**If a tunnel is ever needed again, authentication is not optional.** Put a shared secret on it
(an ngrok traffic policy or `--basic-auth`) and have `route.ts` send it, so the endpoint is
reachable by this app and not by anyone who learns the hostname — the old reserved hostname is
in this repo's history and should be treated as public. The durable fix is a host that is not a
personal machine; see the last paragraph of "Not built yet".

Everything below describes how that tunnel was wired, and is kept because it is the design any
replacement has to beat:

So the deployed `/api/execute` talked to a Piston running on a developer machine, reached
through a **reserved ngrok hostname** held in `PISTON_API_URL`. Two facts followed, and both
caused confusion once:

- **Run only works while that machine is online.** This is a property of the deployment, not
  a bug. Piston down → `"Could not reach the code execution service."`
- **Tunnel down reads as a *different* error.** ngrok/Cloudflare answer with an HTML error
  page, which fails `pistonRes.json()` and surfaces as `"Code execution service returned an
  invalid response."` (`route.ts`'s second 502). That string means *the tunnel*, never Piston
  and never the user's code.

The hostname must be **reserved**, not a quick tunnel. A `trycloudflare`/anonymous tunnel
mints a new URL on every restart, and since a Vercel env change only reaches a *new*
deployment, each restart would cost an env edit **plus a redeploy**. The reserved hostname is
set once and then survives reboots.

On the current machine that tunnel was a `systemd --user` unit, `ngrok-piston.service`
(`Restart=always`, so it recovered from network changes). The unit file is still on disk but
stopped and disabled; Piston itself is still `restart: unless-stopped`, so **Piston returns
after a reboot and the tunnel does not**, which is the intended asymmetry.

The five versions pinned in `LANGUAGE_MAP` match a stock `ghcr.io/engineer-man/piston`
image, so pointing `PISTON_API_URL` at any self-hosted instance needs no code change. The
image is **amd64-only** (single-arch manifest) — ARM free tiers cannot host it.

