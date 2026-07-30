# Testing and audit report

An end-to-end audit of this repository: what was tested, what was broken, what was fixed, and what
is still true afterwards.

The short version: the app had **no automated tests at all** — none, in its entire git history — and
every one of its ~35 `INVARIANT:` comments was enforced by prose. It now has **281 committed tests
across four tiers plus CI**, and the audit found **20 defects**, four of which could kill the sync
server or silently destroy user data. All four are fixed.

- **Verdict:** production-ready for its documented scope. [§13](#13-production-readiness)
- **In a hurry?** The four severity-1 defects are [§5.2](#52-severity-1-the-four-that-mattered).
- **Want to run it?** [§3](#3-running-the-suite).
- **Contributing?** [§2](#2-the-four-tiers) for where a test belongs, and
  [§11](#11-traps-that-cost-a-debugging-pass) for the traps that will otherwise cost you an hour.

---

## 1. Scope and method

### 1.1 What was audited

The whole shipped product, as three services running locally:

| Service | What it is |
| --- | --- |
| `web/` | Next.js 16 (App Router) + React 19, Clerk auth, Prisma 7 → Neon Postgres, Monaco editor |
| `server/` | Node WebSocket server speaking the Yjs sync protocol, room lifecycle, dead-room snapshot writer |
| Piston | A **privileged** container providing the sandboxed multi-language execution |

Dimensions covered: features, user flows, edge cases, HTTP APIs, authentication, authorization,
input validation, data integrity, performance, responsiveness, accessibility, and security —
including deliberate attack simulation against every trust boundary.

### 1.2 What was deliberately NOT audited

Stated up front, because a green suite invites the assumption that everything was checked.

| Not covered | Why |
| --- | --- |
| `docs/tasks.md` §10.2 in-room chat, §10.3 room passwords, §10.6 room names | Unbuilt. Scope, not defects. |
| Code execution on the deployed site | Piston needs a privileged container, which neither Vercel nor Railway permits. Execution is local-only **by design** — see [§12](#12-remaining-limitations). |
| Enforced CSP | Ships as report-only pending a signed-in browser pass. [§8.4](#84-security-headers-and-csp) |
| A real screen-reader pass | axe-core and keyboard traversal are not the same as NVDA/VoiceOver. [§10](#10-accessibility) |
| Horizontal scaling | `docs/tasks.md` §8 rules it out of v2. |
| Load testing at scale | Single-instance app; the numbers in [§9](#9-performance) are single-node. |

### 1.3 Method

Phased, and each phase gated the next. The ordering is not cosmetic: **a measurement taken on a
process that an earlier test crashed is worthless**, so availability was fixed before anything was
measured, and performance was measured *after* hardening so the numbers describe the code that
actually shipped.

| Phase | Focus | Gate before moving on |
| --- | --- | --- |
| 0 | Baseline | `lint`, `tsc`, `next build` green on the untouched tree |
| 1 | Availability | No unauthenticated input can kill a process |
| 2 | Trust boundaries | No peer-supplied value reaches a sink unnarrowed |
| 3 | Correctness | Authorization, data integrity, config |
| 4 | Headers + CSP | Observed via report-only before enforcing |
| 5 | The suite + CI | Four tiers green twice |
| 6 | Measure, then a11y | Numbers recorded with method; a11y last, because its fixes change markup earlier phases assert on |
| 7 | Documentation | This file, plus the three-doc obligation |

**The loop rule:** failing test first → fix → that test green → tier green → full gate green. A bug
is not marked `Fixed` unless a named, passing test validates it. Where that was not achievable, the
row says so rather than claiming coverage — see `BUG-14`.

---

## 2. The four tiers

| Tier | Location | Runner | Needs | Wall clock |
| --- | --- | --- | --- | --- |
| **T1 unit** | `web/tests/unit/`, `server/tests/unit/` | vitest | nothing | ~2 s |
| **T2 drift** | `web/tests/unit/drift/` | vitest (forked) | nothing | ~0.3 s |
| **T3 integration** | `server/tests/integration/` | vitest + raw `ws` | nothing | ~8 s |
| **T4 e2e** | `web/e2e/` | Playwright + system Chrome | all three services | ~2 min |

Design decisions, each with its reason:

- **No root `package.json`.** `CLAUDE.md` treats its absence as load-bearing, so the gate is two
  commands rather than one. CI runs a two-job matrix.
- **Tests live inside the workspace they test.** `web/e2e/` is the only cross-service tier, and it
  owns starting nothing — the services are started by hand (Piston needs Docker on a specific
  context).
- **T1 and T2 are hermetic by construction.** `web/tests/setup/no-ambient-secrets.ts` deletes every
  secret and every `*_MS` knob from `process.env` and stubs `fetch` to throw. A contributor with no
  credentials runs exactly what CI runs. A unit test that reaches the network is a bug in the test.
- **T3 needs neither Postgres nor Clerk.** Both are optional by design in `server/`, and the guest
  flow is the whole of v1 — so the integration tier spawns the real `src/index.js` with
  `DATABASE_URL` and `CLERK_SECRET_KEY` cleared and drives it over the real Yjs wire protocol.
- **`retries: 0` in Playwright, deliberately.** A retry that goes green hides exactly the CRDT and
  presence races this suite exists to catch. A flaky spec is a finding. Two flakes surfaced this way
  and both were real — see `BUG-20` and [§11.5](#115-concurrent-crdt-edits-interleave-per-character).
- **`pool: "forks"` for server tests.** Every server module holds module-level mutable state (the
  `docs` registry, the limiter map, the room-state map, the snapshot queue) and several read
  `process.env` at *load*. One fresh process per file is the only clean isolation.

### 2.1 The ID contract

Every test's title begins with its case ID, so the report and the suite cross-reference mechanically
rather than by hand:

```
it("SEC-05d a running record with no startedAt is healed by the watchdog", …)
test("UF-07a the document survives a refresh by the sole peer", …)
```

So any claim in this document can be traced to its executable proof:

```bash
grep -rn "SEC-05d" web/tests server/tests web/e2e
```

Prefixes: `SEC` security · `VAL` input validation · `DI` data integrity · `LC` room lifecycle ·
`API` HTTP contract · `AUTH` auth/authz · `EC` edge cases · `UF` user flows · `SYNC` CRDT sync ·
`CFG` configuration · `DRIFT` cross-workspace duplication · `GUARD` source hygiene ·
`PERF` performance · `RSP` responsiveness · `A11Y` accessibility.

### 2.2 Severity

| | Meaning |
| --- | --- |
| **S1** | Data loss, remote code execution, or whole-service outage |
| **S2** | Cross-user exposure, or a room-wide denial of service |
| **S3** | Single-user wrong behaviour or wrong data |
| **S4** | Polish, accessibility, documentation, testability |

---

## 3. Running the suite

```bash
# Terminal 1 — Piston. From the REPO ROOT, and note the docker context gotcha below.
docker compose up -d

# Terminal 2 — sync server.
cd server && npm install && cp .env.example .env && npm run dev

# Terminal 3 — frontend.
cd web && npm install && npm run dev
```

Then:

```bash
# web: lint, types, unit + dom + drift            (hermetic, ~2s)
cd web && npm run lint && npm run typecheck && npm test

# server: lint, unit, integration                 (hermetic, ~10s)
cd server && npm run lint && npm run test:unit && npm run test:integration

# end-to-end                                      (needs all three services)
cd web && npm run test:e2e
```

**Two things the e2e tier requires, and both fail confusingly otherwise:**

1. **Start the sync server with `ROOM_CREATE_LIMIT=300`.** The suite creates ~20 rooms in two
   minutes, which trips the production default of 10/min/IP. The symptom is a room-creation timeout
   deep inside an unrelated spec, which reads exactly like a product bug. (`BUG-20`)
2. **Drive the app at `http://localhost`, never `127.0.0.1`.** They are the same server but not the
   same origin, and Clerk's dev instance only allows the former. The failure is silent:
   `window.Clerk` exists with `loaded: false` forever and the landing page simply renders without
   its Sign in / Sign up buttons.

**Docker context.** The Piston container may live on the `default` docker context while
`desktop-linux` is *current*, in which case plain `docker compose ps` reports an empty table and
exits 0. Confirm Piston is actually up by asking it, not Docker:

```bash
curl -s localhost:2000/api/v2/runtimes | head -c 200
```

---

## 4. Test cases executed

346 named assertions across 74 case groups. The full index is generated by the grep in
[§2.1](#21-the-id-contract); this section summarises coverage by dimension and calls out the cases
that carry the most weight.

### 4.1 Security (`SEC-*`)

| Case | What it proves |
| --- | --- |
| `SEC-01` | `readPeers` neutralises every hostile awareness value: a CSS-breakout colour becomes grey, names are re-sanitized, a peer with no usable `user` object is skipped |
| `SEC-02` | Name and colour collisions resolve **deterministically by clientID**, so every viewer independently computes the same winner |
| `SEC-03` | The remote-cursor stylesheet escapes names; backslashes are escaped *before* quotes; `</style>` cannot break out because `textContent` is used. `SEC-03i` deliberately proves a raw colour DOES reach the sheet, which is why `readPeers` is load-bearing rather than decorative |
| `SEC-05`, `SEC-06` | The `execution` map boundary. `SEC-06a` drives a genuinely hostile write through a real `Y.Map` |
| `SEC-07`, `SEC-10` | A forged `X-Forwarded-For` can no longer choose its own rate-limit bucket, in both workspaces |
| `SEC-11` | The room creator's IP never reaches stdout or `stats()` |
| `SEC-20` | Six malformed percent-escapes, a malformed `Host`, a binary `Host`, and an absolute-form request target all answer normally **and the process survives** |
| `SEC-21` | `POST /rooms` rate limiting, including that a rotating forged prefix buys nothing |
| `SEC-22` | A 5 MiB frame closes 1009, a malformed frame closes the socket, and a 600 KB paste still syncs — all with the server alive |
| `SEC-30` | The room route ships no Monaco from the server, and the security headers are present |

### 4.2 Input validation (`VAL-*`)

Every sanitizer is driven against one shared adversarial corpus
(`web/tests/fixtures/hostile.ts`, mirrored in `server/tests/fixtures/hostile.mjs`): NUL, both lone
surrogates, a valid surrogate pair straddling each byte cap, `../../etc/passwd`, backslash paths,
`.`/`..`/`...`, 200-character names, the CSS breakout `red } body { display: none } .x {`,
`</style>`, control characters, RTL overrides, zero-width and exotic whitespace, and non-string
inputs.

Two assertions in there are ordering guards rather than value checks:

- `VAL-01a` — NUL must be stripped **before** control characters are collapsed to spaces. Reverse
  the two passes and `\0Nam\0an` becomes `"Nam an"` instead of `"Naman"`.
- `VAL-01c` — the cut is by **code point**, so a surrogate pair at the 24-character boundary
  survives whole. A UTF-16 slice here is what `BUG-09` was.

`VAL-01f` records that RTL overrides and zero-width spaces **do** survive sanitizing. That is
current behaviour, asserted so it cannot change unnoticed, and listed in
[§12](#12-remaining-limitations) as a known gap rather than dressed up as a guarantee.

### 4.3 Data integrity (`DI-*`)

The membership rules are the product's only durable artifact, so they get the most cases. `DI-03`
alone has ten:

| Case | The rule |
| --- | --- |
| `DI-03a` | A lurker who never edited earns nothing, however long they stayed |
| `DI-03b` | A drive-by who edited but left immediately earns nothing |
| `DI-03c` | Connected long enough **and** edited earns a row |
| `DI-03d` | The starter-file seed is a null-origin transaction and must **not** count as editing |
| `DI-03e` | An edit that lands *before* Clerk verification resolves is still attributed — the JWKS race that used to lose the first signed-in user's snapshot after every restart |
| `DI-03f` | `forgetConn` clears a guest's parked edit so it cannot be adopted later |
| `DI-03g` | Two tabs are two collaborators but **one** member, refcounted |
| `DI-03h` | Verification resolving out of socket order uses the **earliest** start |
| `DI-03i` | Elapsed time counts the still-open session — the SIGTERM case, where reading `connectedMs` raw would fail every member on every deploy |
| `DI-03j` | A closed session still accrues its time |

`DI-05`/`DI-06` cover the snapshot queue: pacing **defers and never drops**, `releasePacing()` pumps
*synchronously* (a flag-only implementation would let Node exit at SIGTERM with the snapshots still
in memory), and the memory bounds are the only thing that discards — loudly.

### 4.4 Everything else

- **`LC-*`** — reservations, the global ceiling (`LC-05`), grace-window reconnect and expiry,
  `destroyRoom` being synchronous and idempotent, and shutdown ordering.
- **`API-*`** — every HTTP surface, including the contract that **`GET /rooms/:roomId` always
  answers 200** with existence in the body (`API-03b`). Anything asserting on the status code reads
  every dead room as alive.
- **`AUTH-*`** — a token becomes a user id via the JWT `sub` and nothing else; verification never
  refuses a socket; `DEAD_ROOM_ID` is anchored at both ends.
- **`EC-*`** — boundaries at N and N+1: the 64 KB combined code+stdin budget, the documented
  60 KB + 3 KB runs / 60 KB + 8 KB refuses pair, the 256 KB snapshot cap, 20-file ceiling.
- **`DRIFT-*`** — see [§6](#6-the-drift-tier).
- **`UF-*`, `SYNC-*`, `RSP-*`** — the browser tier: [§4.5](#45-user-flows-verified-in-a-browser).

### 4.5 User flows verified in a browser

| Flow | Load-bearing assertion |
| --- | --- |
| Guest solo, per language | The room's language is fixed at creation; python gets `main.py` and python starter code, java gets `Main.java` and `public class Main` |
| Guest + guest, **two tabs in one context** | Distinct colours; an edit reaches the other tab; concurrent edits converge; a departure ages out in under 15 s (the `disableBc` regression) |
| Shared execution | A run by peer A appears in peer B's output pane, attributed `Ada L. · main.py`, through the shared Yjs map — no new server message |
| Dead room | The closed screen appears and **no socket to the sync server is opened at all** |
| Reload mid-session | The document survives the grace window; `beforeunload` is accepted, never dismissed |
| Resizable layout | The shared output **survives** collapse, expand, an orientation flip and a divider drag — which is what proves Monaco never remounted |
| Oversized document | 70 KB of code is refused before it crosses the wire |

---

## 5. Bugs found

20 defects. 18 fixed, 2 documented-and-accepted with the argument recorded.

### 5.1 The ledger

| ID | Sev | Component | Symptom an operator or user sees | Found by | Status |
| --- | --- | --- | --- | --- | --- |
| `BUG-01` | S1 | `server/http` | One anonymous GET kills the sync server | manual probe → `SEC-20a` | Fixed |
| `BUG-02` | S1 | `server/http` | A malformed `Host` header kills the sync server | `SEC-20b`/`c` | Fixed |
| `BUG-03` | S1 | `server/sync` | Any malformed WebSocket frame kills the sync server | design review + counterfactual | Fixed |
| `BUG-04` | S1 | config | Dead-room snapshots silently never written | env coherence check | Fixed (env) |
| `BUG-05` | S2 | `web/room` | One peer permanently replaces every other participant's room with the error page | code trace → `SEC-05`/`SEC-06` | Fixed |
| `BUG-06` | S2 | `web/lib`, `server/http` | Rate limits can be bypassed by choosing your own bucket | live probe → `SEC-07`, `SEC-10` | Fixed |
| `BUG-07` | S3 | `web/api` | A chunked POST is fully buffered before being refused | `SEC-08a` (live) | Fixed |
| `BUG-08` | S3 | `web/room` | `/room/%25` is a 500; `/room/%2541` opens a *different* room | `UF-06b` | Fixed |
| `BUG-09` | S3 | `web/profile` | A snapshot filename reaches a download with half a surrogate pair | `VAL-05d`, `DRIFT-13` | Fixed |
| `BUG-10` | S3 | `web/profile` | "Couldn't reach the database" while your row is still there | code trace | Fixed |
| `BUG-11` | S3 | `web/api` | Piston's internal error text is broadcast to the whole room | live probe | Fixed |
| `BUG-12` | S3 | `server/storage` | A snapshot exceeds its own 256 KB cap | `EC-06c` | Fixed |
| `BUG-13` | S4 | `server/*` | `SNAPSHOT_WRITE_LIMIT=0` silently pauses every snapshot forever | `CFG-01c` | Fixed |
| `BUG-14` | S3 | `server/http` | The platform keeps routing traffic to a draining instance | code trace | Fixed ⚠ |
| `BUG-15` | S4 | `server/auth` | A token from another app on the same Clerk instance earns a membership row | code review | Fixed |
| `BUG-16` | S4 | `web/*` | No CSP, no HSTS, no framing policy; the framework is advertised | header inspection | Fixed |
| `BUG-17` | S4 | docs | The documented corruption guard never detected corruption | `GUARD-01` | Fixed |
| `BUG-18` | S4 | `server/storage` | A multi-file snapshot overshoots the nominal cap by ~0.4% | `EC-06e` | Documented |
| `BUG-19` | S4 | docs | A documented sanitizer output is wrong in one character | `VAL-04e` | Fixed |
| `BUG-20` | S4 | testability | An e2e suite trips the app's own room-creation limit | e2e flake | Fixed |

`Fixed ⚠` on `BUG-14` means behaviour-changing **and** not observable end to end yet — see
[§7.2](#72-what-is-not-yet-proven-end-to-end).

### 5.2 Severity 1: the four that mattered

#### `BUG-01` / `BUG-02` — two unauthenticated ways to kill the sync server

`GET /rooms/%` reached `decodeURIComponent` with no guard. Reproduced directly:

```
URIError: URI malformed
    at Server.<anonymous> (server/src/index.js:91:20)
```

Process exit 1, `/health` connection-refused. A malformed `Host` header did the same through
`new URL(req.url, "http://" + host)` — the origin was never used, only the path and query.

**Why it mattered more than an ordinary crash:** a crash is not `SIGTERM`, so
`flushAndDestroyAll()` never ran. Every live room's snapshot died with the process, and the restart
came up with an empty registry — so nothing could ever retry the write. One anonymous request, and
everyone's unsaved work in every room was gone.

**Fixed** by `safeDecode()` returning null, and by never building a `URL` from a header at all
(`requestTarget()` splits the target by hand; `URLSearchParams` never throws). Plus a listener-level
`try/catch`, so "this handler never throws" is enforced rather than asserted.

A malformed id deliberately answers **200 `{"exists":false}`**, not 400: `checkRoom()` reads any
non-ok response as *unreachable*, which would show the retry screen for a room that never existed.

#### `BUG-03` — any malformed frame killed the server, and the obvious hardening made it worse

`y-websocket`'s `setupWSConnection` registers `conn.on('message')`, `'close'` and `'pong'` — and no
`'error'`. `ws` emits `'error'` on the WebSocket for every protocol fault, and **an `'error'` event
with no listener throws.** Reachable before the room gate, so no room id was even needed.

Proved standalone against this repo's own `ws`:

```
UNCAUGHT (this is the crash): Invalid WebSocket frame: invalid opcode 3
```

**The sharp part:** `ws` defaults `maxPayload` to 100 MiB, and capping it is the obvious hardening.
But a frame over the cap raises *the same* unhandled `'error'` — so setting `maxPayload` **before**
adding the listener would have converted a memory-pressure problem into a **one-frame remote kill
switch**. They landed in the same commit, and the code says why.

#### `BUG-04` — v2's persistence was silently switched off

`server/.env` declared `CLERK_SECRET_KEY` twice, with **different values**. `dotenv` 16.6.1's
`parse()` takes the last occurrence (verified empirically), and that one did not match
`web/.env.local`.

Per this repo's own documentation, a mismatched key fails every token *with no visible symptom*:
rooms work, presence works, editing works — snapshots simply never appear. So the entire v2 feature
set was inert in this environment, and nothing in the product would have told anyone.

Found by comparing the two lines' text, never their values. Fixed by deleting the duplicate. Not
committed, because `.env` is correctly gitignored — but `CFG-02b` and `DRIFT-11` now pin the
surrounding contract, and the once-per-process warning in `auth/clerk.js` is what surfaces it next
time.

### 5.3 Severity 2

#### `BUG-05` — one peer could permanently break every other participant's room

The `execution` `Y.Map` was **the one peer-supplied shared type with no sanitizing boundary** —
unlike awareness (`readPeers`) and files (`readRoomFiles`). Any participant could write
`{status:"success"}` and every *other* participant's `OutputPanel` would destructure
`state.startedBy.color`, throw during render, and unwind to `app/error.tsx`.

Not recoverable by reloading: the poisoned record is in the shared document, so they reload straight
back into it. A one-write, room-wide, persistent denial of service. Three variants:

- an arbitrary colour into an inline `style`,
- arbitrary attacker text into every participant's output pane,
- `{status:"running"}` with no `startedAt` → `Date.now() - undefined` is `NaN`, `NaN > STALE_RUN_MS`
  is `false` → the watchdog **never fires** and Run is disabled for the whole room forever.

**Fixed** with `readExecutionState()`, the third member of that family, plus `readExecution` /
`writeExecution` as the only accessors so a raw `.get()` cannot come back. `startedAt` falls back to
**0, never `Date.now()`**, so a forged `"running"` heals on the next watchdog tick.

`OutputPanel` and `isFailedRun` needed **no change** — which is the evidence the boundary is in the
right place, and the same property `PresenceStack` has relative to `readPeers`.

#### `BUG-06` — you could choose your own rate-limit bucket

`clientKey` read the **left-most** `X-Forwarded-For` entry, which is the one value a caller fully
controls. Verified live before the fix: twelve requests with a rotating forged prefix all succeeded.

It defeated more than the obvious limiter. `clientKey` becomes the room's `creatorKey` and then the
snapshot queue's **pacing key**, so a forged header also sidestepped `MAX_QUEUED_PER_KEY` and
`SNAPSHOT_WRITE_LIMIT`.

**Fixed** to right-most-minus-(hops−1) via `TRUSTED_PROXY_HOPS`, which is correct whether the
platform appends to the header or overwrites it — left-most is correct under neither. Both copies
changed in one commit, because they are a documented hand-maintained pair, and `DRIFT-15` now
compares their behaviour directly.

### 5.4 Severity 3 and 4

| ID | Root cause | Fix | Validated by |
| --- | --- | --- | --- |
| `BUG-07` | The `content-length` guard used `Number(null) === 0`, so a chunked POST passed it and `request.json()` buffered everything before the 413 | Read the body through a streaming cap | live: chunked 200 KB → 413 |
| `BUG-08` | The room page decoded a param the App Router already delivered decoded | Delete the call | `UF-06b` |
| `BUG-09` | A second filename sanitizer whose comment claimed it was in sync; a UTF-16 `.slice(0,64)` halved a surrogate pair | Delete it, import the shared one | `VAL-05d`, `DRIFT-13a` |
| `BUG-10` | `tx.deadRoom.delete` throws `P2025` when a concurrent deleter wins, aborting the caller's own membership deletion | `deleteMany` with `members: { none: {} }`, so last-member-ness is re-checked *at* delete time | code review; the accepted orphan race is unchanged |
| `BUG-11` | `LANGUAGE_MAP["__proto__"]` is `Object.prototype` — truthy — so the request reached Piston, which returned its own error text into the room's shared record | `isLanguage()` guard; Piston's message logged, not forwarded | live: now a 400 |
| `BUG-12` | `subarray(0, room).toString("utf8")` substitutes a **3-byte** `U+FFFD` for a 1–2 byte partial, so truncation could exceed the budget. Measured **262145 for a 262144 cap** | `utf8CutEnd` backs off to a character boundary — honest cap, and no replacement character at all | `EC-06c` |
| `BUG-13` | `Number(x) \|\| default` cannot distinguish a deliberate `0` from a typo | `server/src/env.js` with **per-var floors** | `CFG-01` |
| `BUG-14` | `server.close()` ran *before* the shutting-down flag was set, so the platform got `ECONNREFUSED` instead of the 503 | Flag first, listener last; `POST /rooms` also refuses while draining | `LC-04a` + source order — see [§7.2](#72-what-is-not-yet-proven-end-to-end) |
| `BUG-15` | `verifyToken` was called without `authorizedParties`, leaving `azp` unconstrained | Opt-in `CLERK_AUTHORIZED_PARTIES`, fail-open | `AUTH-03` |
| `BUG-16` | `next.config.ts` was empty | Headers + report-only CSP | `SEC-30b` |
| `BUG-17` | The documented guard was `grep -P '\x00'`, which reports nothing on a binary file without `-a` | `GUARD-01`, byte-level | `GUARD-01b`/`c` |
| `BUG-19` | Documentation recorded a sanitized filename as `....etcpasswd.py`; the internal space is *collapsed*, not removed | Corrected to `....etcpa sswd.py` | `VAL-04e` |
| `BUG-20` | `POST /rooms`' limit was hardcoded at 10/min | `ROOM_CREATE_LIMIT` / `ROOM_CREATE_WINDOW_MS`, default unchanged | the e2e suite now runs clean |

**`BUG-13` deserves a note**, because "just honour 0" would have been wrong. The floors are not
uniform: `SNAPSHOT_WRITE_LIMIT=0` makes `recent.length >= 0` always true, so **every** snapshot is
paced forever and only `releasePacing()` at SIGTERM saves any of them. That is silent data loss
dressed as a tuning knob, so its floor is 1. `ROOM_RESERVATION_MS` gets a floor of 1000 because 0
expires a reservation before its creator can connect. `ROOM_GRACE_MS`, `SNAPSHOT_FLUSH_MS`,
`MEMBER_MIN_CONNECTED_MS` and `DB_CONNECT_TIMEOUT_MS` all honour a real 0.

### 5.5 Documented and not fixed

**`BUG-18` — the multi-file snapshot total exceeds its nominal cap.** Each starved file still
carries a full `TRUNCATION_MARKER`, so the real total is 256 KB + (files − 1) × ~56 B — about
1.1 KB over at twenty files, or 0.4%.

Not fixed, and the reasoning matters more than the number. Dropping the marker would hide the
truncation from the user, which is worse than the overshoot. Reserving `MAX_FILES × marker` up front
costs ~1.1 KB of real content in every room, including the overwhelming majority that never
truncate. The cap is an internal budget, not a database limit — `jsonb` is unbothered.

So `EC-06e` pins the **true** bound instead, because the previous documentation claimed a cap that
was not the one enforced. An honest assertion is worth more here than a cosmetic fix.

---

## 6. The drift tier

Worth its own section, because it closes a gap the codebase documented and then lived with.

`CLAUDE.md` names **eight hand-maintained cross-workspace duplications** and says plainly, of the
most dangerous two, that *"nothing in the build compares the two"*. The two workspaces genuinely
share no code, so the duplication is deliberate — but nothing detected divergence.

31 assertions now do. The two it named:

- **`DRIFT-17`** — each of `docker-compose.yml`'s six `PISTON_*` ceilings is `>=` the corresponding
  per-request limit in `web/src/app/api/execute/route.ts`. Piston **400s the whole request** if one
  exceeds its configured ceiling, so those two files are one setting in two places. Also checked:
  `PISTON_OUTPUT_MAX_SIZE` is above Piston's 1 KB default (at which it `SIGABRT`s the sandbox
  instead of truncating, which reads to the user as a crash in their own code), and Piston is still
  bound to loopback.
- **`DRIFT-18`** — `server/src/storage/db.js`'s hand-written INSERT columns are **set-equal** to
  `web/prisma/schema.prisma`'s, for both tables. Also: `gen_random_uuid()` is still in the statement
  (Prisma's `@default(uuid())` is client-side only, and this process has no Prisma client, so
  dropping it fails every write on a null id), `ON CONFLICT (room_id)` still rests on the `@unique`,
  and `creator_key` is still absent from the column list.

The rest compare behaviour rather than text, since neither side exports what is being compared:

| Case | Compared how |
| --- | --- |
| `DRIFT-12` | A 300 KB document goes through the server's `buildSnapshot`, and the **web** reader's `isTruncated` must match its marker — proving they agree byte for byte |
| `DRIFT-13` | The hostile filename corpus through both sanitizers, row by row |
| `DRIFT-14` | Awareness written into a real `Awareness` instance, then the server's participant name compared against the client's `sanitizeName`, and both colour fallbacks against each other |
| `DRIFT-15` | One deterministic key/time sequence through **both** rate limiters; the verdict streams must be identical arrays |
| `DRIFT-11b` | Executable proof of a *hazard*: overriding `MEMBER_MIN_CONNECTED_MS` moves the server's copy and leaves the frontend's hardcoded one untouched, with nothing detecting it at runtime |

Where the two sides legitimately differ — the dots-only fallback extension, where the client knows
the room language and returns `untitled.py` while the server returns `untitled.txt` — the divergence
is **enumerated** in `DRIFT-13b`, so it stays a decision rather than becoming a surprise.

---

## 7. Validation and regression testing

### 7.1 Before and after

| ID | Before (observed) | After (observed) | Validating test |
| --- | --- | --- | --- |
| `BUG-01` | `URIError`, exit 1, `/health` refused | `200 {"exists":false,"language":null}`, process alive, 6 escape forms | `SEC-20a` |
| `BUG-02` | `TypeError: Invalid URL` | `HTTP/1.1 200`, process alive | `SEC-20b`/`c`/`d` |
| `BUG-03` | `UNCAUGHT: Invalid WebSocket frame` | socket closed, `Socket error in <room>` logged, server alive | `SEC-22a`/`b` |
| `BUG-05` | room replaced by the error page for every peer | renders as "Anonymous" in grey with "(no output)"; editor live; Run re-enabled by the watchdog | `SEC-05`, `SEC-06a` |
| `BUG-06` | 12 rotating forged prefixes → 12 × 201 | 10 × 201 then 429 with `Retry-After`; a different real hop keeps its own budget | `SEC-07b`, `SEC-10b`, `SEC-21` |
| `BUG-07` | 200 KB chunked body buffered, then refused | 413 from the stream cap, body never buffered | live curl |
| `BUG-08` | `/room/%25` → 500 | → 200 | `UF-06b` |
| `BUG-11` | `{"error":"language is required as a string"}` (Piston's own text, via 502) | `400 {"error":"That language isn't supported."}` | live curl |
| `BUG-12` | 262145 bytes for a 262144 cap | ≤ 262144, and no `U+FFFD` emitted | `EC-06c` |

### 7.2 What is **not** yet proven end to end

Stated plainly rather than glossed.

**`BUG-14` — the `/health` 503 while draining.** The fix is verified by `LC-04a` (the flag flips
without closing anything) and by source ordering (`beginShutdown()` at `index.js:192`, the flush at
`:195`, `server.close()` at `:200`). It is **not** observed in a live drain, because with no queued
snapshot writes the drain completes in the same tick — there is no window to catch. Observing it
requires a Clerk-verified member producing a real pending write, which needs the signed-in tier in
[§12](#12-remaining-limitations). I would rather flag this than claim coverage I do not have.

### 7.3 Regression discipline

- The full gate ran green at the end of every phase, not just at the end.
- Two standing regression checks from this repo's own history are asserted every run:
  `/room/<id>` answers **200** (it used to 500 whenever anything dragged Monaco into a server
  graph), and `curl -s /room/<id> | grep -c monaco` is **0** — the status code alone stopped being
  sufficient once the route started succeeding.
- `next build` succeeds and still lists `ƒ Proxy (Middleware)`, which is the only confirmation
  Clerk's request hook is wired. Next 16 renamed `middleware.ts` to `proxy.ts`, and a misplaced file
  fails **silently**.
- `GUARD-01` scans every source file for NUL bytes and lone surrogates at the byte level, on every
  run. It caught itself on its first execution.
- **`API-09f` was mutation-tested.** Breaking the limiter's `delete`+`set` re-insertion makes it
  fail; restoring it makes it pass. A test that cannot fail is not evidence, and eviction order is
  exactly the kind of property that silently stops holding.

---

## 8. Security checks

### 8.1 Attack simulation

Every trust boundary was attacked, not just reviewed.

| Vector | Result |
| --- | --- |
| Unauthenticated crash via malformed URL escape | **Was fatal.** Fixed; 6 forms asserted |
| Unauthenticated crash via malformed `Host` | **Was fatal.** Fixed |
| Malformed WebSocket frame | **Was fatal.** Fixed; socket closes, server lives |
| 5 MiB WebSocket frame | Closes 1009; a 600 KB paste still syncs |
| Hostile awareness (CSS breakout colour, `</style>`, NUL, lone surrogates, 200-char names) | Neutralised at `readPeers`; the cursor stylesheet escapes and uses `textContent` |
| Hostile filename (`../../etc/passwd`, `.`, `..`, NUL, surrogate at the cap) | Separators stripped on both sides; verified end to end into Postgres |
| Hostile execution record | **Was a room-wide persistent DoS.** Fixed at `readExecutionState` |
| Forged `X-Forwarded-For` | **Was a full bypass.** Fixed in both workspaces |
| `__proto__` as a language | **Reached Piston.** Now a 400 |
| Chunked body with no `Content-Length` | **Was fully buffered.** Now capped mid-stream |
| Cross-user snapshot read | Unfetchable by construction — every query starts from `dead_room_members` on the viewer's own Clerk id |
| Malformed snapshot uuid | Rejected by `DEAD_ROOM_ID` before it can reach the driver and 500 on the uuid cast |
| Server Action POSTed directly | Self-gated with `await auth()`; `proxy.ts` deliberately protects nothing |
| Token from a different Clerk app | Constrainable via opt-in `authorizedParties` |

### 8.2 Authorization model

The strongest property in the codebase, and it survived the audit unchanged: **a `DeadRoom` is never
fetched by its id.** Both reads and the delete start from `deadRoomMember` keyed on the viewer's own
Clerk user id and reach the room through the relation. A snapshot the viewer holds no membership row
for is not *hidden by a filter someone remembered to add* — it is unfetchable.

`notFound()` answers identically for "no such row" and "not yours", so the URL is not an existence
oracle. The delete returns `false` for both, for the same reason.

### 8.3 What CSP does and does not buy here

`script-src` keeps `'unsafe-inline'`, and that is a deliberate decision rather than laziness: the App
Router streams its RSC payload as inline `<script>` tags, the no-flash theme script must run before
first paint, and `global-error.tsx` can never receive a nonce because it renders its own `<html>`
when the layout itself has failed. A nonce would additionally force **every route into dynamic
rendering** and must be threaded manually to `<ClerkProvider nonce>` or clerk-js is silently blocked.

`style-src` keeps `'unsafe-inline'` for three independent reasons: `cursorStyles.ts` writes a
dynamic `<style>`, Monaco injects its own at runtime, and inline `style` attributes are required to
beat `react-resizable-panels`' own inline `overflow` — and no nonce covers style *attributes* at all.

**So CSP is explicitly not the XSS backstop in this app.** `readPeers`, `readRoomFiles` and
`readExecutionState` are. This is worth stating plainly, because a policy that *looks* strict invites
the assumption that those boundaries matter less. What the policy does buy is real: `script-src` is
an explicit host allowlist with no `https:`, so no third-party script host can be injected;
`connect-src` is an allowlist, so an injected script cannot exfiltrate a room's code, a Clerk token
or a snapshot to an attacker host; `base-uri`, `object-src` and `frame-ancestors` are locked down.

### 8.4 Security headers and CSP

Present on every route, verified by `SEC-30b`:

| Header | Value | Note |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | |
| `X-Frame-Options` | `DENY` | with `frame-ancestors 'none'` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | a room id is a capability — holding one is what lets you join — so it must not leave in a `Referer` |
| `Permissions-Policy` | camera, microphone, geolocation, usb, payment all `()` | |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | **not** `same-origin`: Clerk's OAuth providers `postMessage` back through `window.opener`, and severing that hangs sign-in with no error banner |
| `Strict-Transport-Security` | `max-age=31536000` | production only; no `includeSubDomains`, no `preload` — both are effectively irreversible |
| `Content-Security-Policy-Report-Only` | see [§8.3](#83-what-csp-does-and-does-not-buy-here) | |

Deliberately absent: **`Cross-Origin-Embedder-Policy`**, which would require CORP headers on
clerk-js that Clerk does not send, and would break auth.

The CSP produced **zero violations** across landing, guest room creation, the editor, a code run, a
second tab in the same context, and the signed-out `/profile` gate — with `window.Clerk.loaded`
true, which is the assertion that matters, since a wrong `script-src` breaks auth silently rather
than loudly. It stays report-only until the signed-in flows are exercised too.

### 8.5 Accepted risks

Argued, not skipped.

| Risk | Why it is accepted |
| --- | --- |
| `GET /rooms/:roomId` is unauthenticated and unmetered | Two `Map` lookups and a ~60-byte body. Room ids are UUIDv4, so it only answers about an id you already hold — and if you hold one, the WebSocket gate tells you the same. Worse, a 429 here renders as *"Couldn't reach the sync server"*, because `checkRoom` maps every non-ok response to `unreachable`; metering it would mean either a knowingly-wrong message or a third `RoomCheck` state |
| Wildcard CORS on `POST /rooms` | CSRF needs an ambient credential. These routes set no cookies, read no cookies, and never set `Allow-Credentials`, so a cross-origin POST is authenticated as nobody and mints a room belonging to nobody. The only effect is spending a stranger's rate-limit slot, which an attacker can spend directly and more cheaply. An `Origin` allowlist would fail closed on Vercel preview deployments, whose hostnames are per-deployment |
| Unbounded `Y.Doc` growth | Every non-destructive fix needs a byte budget nobody has measured, and every quickly-measurable fix destroys the room's only copy of everyone's work. `maxPayload` bounds the per-frame case; a per-socket update budget is designed but not built |
| The frontend rate limiter is per-instance | No Redis is a v2 scope constraint. A Postgres round trip on the hot execute path is a worse trade than the documented approximation. The **sync server's** limiter, by contrast, is now a real per-address bound: one process, one counter, and a key the caller can no longer choose |

---

## 11. Traps that cost a debugging pass

Recorded because each produced a *misleading* symptom, and the next person deserves better.

### 11.1 A visible Monaco is not a ready room

The starter file is created only after the provider fires `sync`. Between "editor visible" and
"seeded" there is a window in which `files` is empty and `entryFile` is null — and `useCodeRunner`
returns early on a null `entryFile` **without writing anything**, so a Run click in that window is
silently swallowed and the output pane still reads "Output will appear here…".

This produced a test that passed alone in 3.6 s and failed in sequence. Before concluding anything, I
measured it: **10/10 rooms seed correctly**. It was the test acting too early, not a seeding bug.
`waitForRoomReady()` now polls for actual editor content.

### 11.2 Never read room text from `document.body.innerText`

Monaco keeps a hidden accessibility mirror, so `innerText` shows the document **twice**. This looked
exactly like a double-seed bug — three line numbers and `print("Hello, world!")` appearing twice — and
was not: an independent raw Yjs client confirmed the CRDT held it exactly once. Read the Monaco model
or the CRDT.

### 11.3 Focus Monaco by clicking `.view-lines`, never its hidden `textarea`

Clicking the textarea *appears* to work — select-all even takes effect — but the subsequent
keystrokes never reach the model. The document ends up empty and the only symptoms are a disabled
Save button and a Run that does nothing.

### 11.4 Scope the identity dialog to `role="dialog"`

Its submit label is a `submitLabel` prop, so text matching is wrong in principle. Worse, the landing
page has its own "Join" button *behind the modal scrim*: a text match picks that one, the scrim
intercepts every click, and the test retries until it times out with no useful error.

### 11.5 Concurrent CRDT edits interleave per character

Two peers typing at the same position produced `"BABBBAAA"`. That is a perfectly correct outcome.
The invariant is **convergence plus character counts**, not contiguous substrings — asserting
`toContain("AAAA")` encodes an ordering guarantee a CRDT never promised.

### 11.6 `\u0000` in a tool argument becomes a real NUL byte

Tool-call arguments JSON-decode `\uXXXX`, so writing that escape into a source file produces an
actual NUL and git flags the file as binary. It corrupted two files while this suite was being
written. Lone surrogates like `\uD800` pass through as text, because JSON cannot encode them — which
is why `executionState.ts` survived and the others did not.

The corpus therefore builds every dangerous character with `String.fromCharCode`, and `GUARD-01`
checks the tree at the byte level. **The guard this repo previously documented — `grep -P '\x00'` —
never worked**: grep classifies the file as binary and reports nothing without `-a`.

### 11.7 `pkill -f` kills its own shell

A script that both greps for a pattern and contains that pattern as literal text matches *itself*.
This killed three of my own commands, once producing a phantom HTTP 308 that sent me looking for a
redirect bug that did not exist. Kill by PID from `ss -ltnp`.

### 11.8 Piping a long-running command to `tail` buffers everything

`npx playwright test | tail -60` produces **no output at all** until it finishes, which reads exactly
like a hang. Redirect to a file and read the file.

---

## Appendix A — environment of record

| | |
| --- | --- |
| OS | Linux 7.0.0-28-generic |
| Node | v22.23.1, npm 10.9.8 |
| Browser | Google Chrome 150.0.7871.114 (system Chrome, via Playwright's `channel: "chrome"`) |
| Playwright | 1.61.1 |
| vitest | 4.1.10 |
| Next.js | 16.2.10 · React 19.2.4 · TypeScript 5 |
| Prisma | 7.9.1 (`prisma-client` generator, `@prisma/adapter-pg`) |
| Postgres | Neon, `dev` branch, `ap-southeast-1` |
| Piston | `ghcr.io/engineer-man/piston`, loopback-bound on `127.0.0.1:2000` |
| Clerk | dev instance (`pk_test`) |

**Why Playwright uses system Chrome:** `~/.cache/ms-playwright` holds chromium builds 1140 and 1228,
neither of which matches what this Playwright version wants, and the failure is a bare
"Executable doesn't exist". `channel: "chrome"` sidesteps the mismatch entirely.
