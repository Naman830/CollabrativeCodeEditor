# CollabCode — Version 2 Build Checklist

> This file is written for **Claude Code**. It explains what already exists (v1), what needs to be added (v2), and shows the architecture in simple diagrams so anyone — recruiter, reviewer, or developer — can understand it quickly.

---

## 1. What v1 already does

- No accounts. Anyone can create or join a room.
- Rooms live only in server memory (Node.js + Yjs).
- Code runs through Piston.
- File is saved by downloading it — nothing stored server-side.
- Room and all its data disappear the moment everyone leaves.

**v1 has zero persistence. That is the main thing v2 changes.**

---

## 2. What v2 adds (in plain words)

1. **Login with Clerk.** Users can sign in with a real account, or continue as a guest like before.
2. **A PostgreSQL database.** Only Postgres — no Redis, no other data stores.
3. **"Dead rooms."** When everyone leaves a room, the room's final code is saved to the database and linked to the signed-in user who created it (or was in it). The live room is destroyed exactly like in v1 — but a **read-only snapshot** now survives in the user's profile.
4. **A profile page** where a logged-in user can see all their past rooms, open a snapshot, and copy the code — but **cannot** run it or rejoin it as a live room. It's dead: viewable and copyable only.
5. Guests (not logged in) behave exactly like in v1 — no history, nothing saved for them.

---

## 3. Tech stack for v2

| Layer | v1 | v2 (new/changed) |
|---|---|---|
| Frontend | Next.js | Next.js (unchanged) |
| Auth | None | **Clerk** (full auth + guest mode) |
| Real-time sync | Yjs (in-memory) | Yjs (in-memory) — unchanged |
| Backend | Node.js + WebSocket | Node.js + WebSocket — unchanged |
| Code execution | Piston (Docker) | Piston (Docker) — unchanged |
| Database | None | **PostgreSQL** (new) |
| ORM | — | Prisma or Drizzle (pick one) |
| Hosting | Vercel + Railway | Vercel + Railway (DB on Railway/Neon/Supabase) |
| File download | Single file | **JSZip** (client-side) for multi-file "Save as .zip" |

**No Redis. No other databases. Postgres only.**

---

## 4. Simple architecture diagram (high level)

```mermaid
flowchart LR
    U[User's Browser] -- login / guest --> C[Clerk Auth]
    U -- create / join room --> F[Next.js Frontend]
    F <--> W[WebSocket Server<br/>+ Yjs in-memory rooms]
    F -- run code --> P[Piston<br/>Code Execution]
    W -- when room dies --> D[(PostgreSQL<br/>Dead Room Snapshots)]
    U -- view profile --> D
```

**In one sentence:** live rooms still work exactly like v1 in memory, but the moment a room dies, its final snapshot is written once to Postgres so a logged-in user can find it later in their profile.

---

## 5. Detailed architecture diagram (with data flow)

```mermaid
sequenceDiagram
    participant User
    participant Clerk as Clerk (Auth)
    participant FE as Next.js Frontend
    participant WS as WebSocket Server
    participant Yjs as In-Memory Yjs Room
    participant Piston
    participant DB as PostgreSQL

    User->>Clerk: Sign in (or continue as guest)
    Clerk-->>FE: User session / user ID
    User->>FE: Create or Join Room
    FE->>WS: Connect to room
    WS->>Yjs: Create/attach Yjs doc (in memory)
    Note over WS,Yjs: Same as v1 — live editing,<br/>cursors, presence, all in memory

    User->>FE: Click "Run"
    FE->>WS: Send code + language
    WS->>Piston: Execute code
    Piston-->>WS: stdout / stderr
    WS-->>FE: Broadcast result to room

    User->>FE: Last user leaves room
    WS->>Yjs: Read final code snapshot
    WS->>DB: Save snapshot (if room was created<br/>or joined by a logged-in user)
    WS->>Yjs: Destroy Yjs doc
    Note over WS,Yjs: Room is now fully gone from memory<br/>— exactly like v1

    User->>FE: Open Profile page
    FE->>DB: Fetch this user's dead room snapshots
    DB-->>FE: List of past rooms (read-only)
    User->>FE: Open a snapshot / copy code
    Note over FE: Cannot "Run" or "Rejoin" a dead room —<br/>view + copy only
```

---

## 6. Database schema (Postgres)

Keep it minimal — two tables: the snapshot itself, and who may read it.

```
dead_rooms
├── id              (uuid, primary key)
├── room_id         (text, UNIQUE — the original ephemeral room ID)
├── files           (jsonb — array of { filename, content }, supports multi-file rooms)
├── language        (text, NULLABLE — the room's single language; non-null since §10.1)
├── is_private      (boolean — was this room password-protected)
├── participants    (jsonb — names/colors of everyone who was in the room, optional)
├── created_at      (timestamptz — when the room was first created)
└── died_at         (timestamptz — when the last person left)

dead_room_members            -- who can see this snapshot on /profile
├── dead_room_id    (uuid, FK -> dead_rooms.id, ON DELETE CASCADE)
├── user_id         (text — a *verified* Clerk user ID, never a self-reported one)
└── PRIMARY KEY (user_id, dead_room_id)
```

> Note: `code` (single string) from earlier drafts is replaced by `files` (an array) so multi-file rooms save cleanly. A single-file room is just a `files` array with one entry.

> **`owner_user_id` and its `(owner_user_id, died_at DESC)` index are gone**, replaced by
> `dead_room_members`. See Section 6.1 for why. 7.2 had already migrated the old shape, so this
> cost a **second migration** — `20260729122125_dead_room_members`, applied to both Neon
> branches during 7.3, while `dead_rooms` was still empty and nothing read it.

> The `/profile` listing is `dead_room_members` joined to `dead_rooms`, ordered by `died_at`.
> The composite primary key `(user_id, dead_room_id)` is the index that serves it — `user_id`
> leading, so one user's rows are contiguous. Sorting happens after the join, which is fine at
> v2's scale; if it ever isn't, copy `died_at` onto the member row and index
> `(user_id, died_at DESC)`.

---

### 6.1 Who a dead room belongs to

**The rule, in one line: every signed-in person who really took part gets to keep a copy;
guests keep nothing; the room itself still dies exactly like v1.**

Longer, as four rules:

1. **One snapshot per room, written once**, at the moment the room is destroyed (last socket
   closed, grace window elapsed, nobody reconnected). Never updated afterwards.
2. **A snapshot is written only if at least one participant was a verified Clerk user.** All
   guests → nothing is written at all, exactly like v1.
3. **Every verified signed-in participant who met the contribution threshold gets a
   `dead_room_members` row**, and therefore sees the room on their `/profile`. Not just the
   creator, and not just whoever left last.
4. **"Verified" means a Clerk token the *server* checked.** Never awareness state and never a
   client-supplied ID — see CLAUDE.md, "Accounts (Clerk)": a forged ID would write a
   stranger's code into someone else's profile.

**Why not "the creator owns it"** (the original draft of this section):

- The creator is frequently a guest who made the room and shared the link, which leaves the
  row with no owner at all and forces a fallback rule anyway.
- Ownership is wrong exactly when it matters most: A creates a room, leaves after two minutes,
  B works in it for an hour. A gets the snapshot; B — the person who wrote the code and will
  go looking for it — gets nothing.
- There is no such thing as an owner in `server/src/rooms/lifecycle.js` today; it records nothing about a
  room but timers. Inventing one, plus a transfer rule for when the owner leaves, is real
  complexity for behaviour no user can see or predict.

**Why not "whoever left last owns it":** it makes keeping your own work depend on tab-close
order. Close your laptop first and an hour of work silently goes to somebody else.

Membership costs nothing extra to compute: 7.3 has to verify a Clerk token per connection
regardless, which yields a *set* of signed-in users per room. Collapsing that set to one person
is the thing that would take extra work, not keeping it.

**The contribution threshold, and the trade it exists to blunt.** Under this rule, a signed-in
stranger who clicks a shared link, lurks for thirty seconds and leaves keeps a permanent
private copy of the code. So a participant earns a `dead_room_members` row only if they
**stayed more than a trivial moment** *and* **actually edited the document** — 60s of
accumulated connected time (`MEMBER_MIN_CONNECTED_MS`) plus at least one document update sent
over one of their sockets. Section 10.3's room passwords carry the rest of the weight: a
password-protected room is the "this is not public" signal, so an unprotected room being
copyable by the people who worked in it is the expected behaviour.

> **Both halves of this were rewritten during 7.3, against the original draft.**
>
> The draft said "connected **while the document was non-empty**". That cannot work:
> `useCollabRoom` seeds `DEFAULT_CODE` on the provider's `sync` event, so a room is non-empty
> within milliseconds of the *first* client connecting, and the clause filters nothing at all.
> What it was reaching for is "did this person contribute", which is directly answerable —
> y-websocket passes the WebSocket as the Yjs transaction origin, so the server knows which
> socket sent each edit. **Edits alone are what exclude the lurker**; the timer does not, since
> anyone who leaves a tab open passes it.
>
> The draft also suggested a threshold "on the order of the grace window" (10s), which
> contradicts the scenario table below — 10s cannot make a 30s lurker get nothing. 60s does.

**Deleting.** Because several accounts can hold one snapshot, "delete this from my profile"
means deleting that user's `dead_room_members` row, not the `dead_rooms` row. (Not a v2
checklist item; recorded so it isn't designed wrong later.)

#### Every scenario, in a table

A creates the room, B joins later.

| Situation | What happens |
| --- | --- |
| A signed in, B guest | A sees it on `/profile`. B gets nothing. |
| A guest, B signed in | B sees it. The guest creator needs no special case. |
| Both guests | Nothing written. Room vanishes exactly like v1. |
| Both signed in, A leaves early, B works on | **Both** see it. This is the case creator-owns gets wrong. |
| Both signed in, both leave together | Both see it. |
| B joins as a guest, signs in mid-session | B sees it, provided the server verified them before the room died. |
| Signed-in stranger lurks 30s and leaves | Nothing for them — blocked by the contribution threshold. |
| Signed-in stranger leaves a tab open for an hour but never types | Nothing for them. The 60s timer alone would not catch this; the "actually edited" half does. |
| Someone reloads the page | Nothing happens. A reload reconnects inside the grace window, so the room never died. |
| Everyone leaves, someone returns 40s later | Room is gone; `/room/<id>` sends them home. The snapshot is on `/profile` instead, read-only. |
| Room evicted twice (retry, restart) | Only the first write lands — `ON CONFLICT (room_id) DO NOTHING`, already built in 7.2. |
| Server restarts / Railway redeploys mid-room | **Saved.** 7.3's shutdown flush destroys every remaining room — live ones included — and awaits the writes, because the `unref()`'d eviction timer would otherwise never fire on SIGTERM. |

> **Corrected during 7.2, against the draft above.** `room_id` is `UNIQUE` so the database
> enforces the write-once rule below rather than trusting the writer (it also backs 7.5's
> "can never be reused"). 7.2 also added a `(owner_user_id, died_at DESC)` index for 7.4's
> listing; **7.3 dropped both that index and the column**, because §6.1 replaced creator-owns
> with `dead_room_members`, whose composite primary key `(user_id, dead_room_id)` is now the
> index that serves /profile. `language` is **nullable** because the language dropdown is a per-user editing
> preference kept deliberately off the shared Yjs doc — the server has nothing to record until
> §10.1 moves the selector to room creation, so `NOT NULL` would make 7.3 unbuildable before
> then. **§10.1 has since landed and every new row carries a real language**; the column stays
> nullable for the rows written before it, which no migration can invent a language for.

Rules:
- Only written to **once**, when the last user disconnects.
- Never updated again after that — a dead room snapshot is final and read-only.
- Only saved if at least one participant was logged in via Clerk. Fully-guest rooms behave exactly like v1 (nothing saved).
- Who may read it afterwards is Section 6.1's rule, not "the creator".

---

## 7. Feature checklist for Claude Code

### 7.1 Auth (Clerk)
- [x] Install and configure Clerk in the Next.js app
- [x] Add "Sign in" / "Sign up" options on the landing page
- [x] Keep a visible "Continue as guest" option (v1 flow, unchanged)
- [x] Store Clerk user ID on the client when a room is created or joined by a logged-in user

Shipped alongside 7.1, not originally listed here:

- [x] `web/src/lib/collab/clerkIdentity.ts` — the single boundary between Clerk and the app.
      Nothing else imports `useUser`, so Clerk's nullable `firstName`/`lastName` get
      sanitized exactly once, through the same `sanitizeName` guest names use.
- [x] Signing in **prefills** the name dialog rather than replacing it. A Clerk session is
      one cookie shared by every tab; a `CollabUser` is per-tab sessionStorage. Skipping
      the prompt would collapse two tabs into one collaborator and break the documented
      way to test multiplayer locally.
- [x] The dialog is never gated on Clerk having loaded. Verified: gating it left a
      deep-linked room with no prompt at all and therefore unjoinable.
- [x] Monaco is loaded from the `monaco-editor` package instead of its CDN AMD loader,
      because that loader's global `define.amd` broke Clerk's UI bundle on the room route
      (see CLAUDE.md, "Accounts (Clerk)"). Adds `monaco-editor` as a direct dependency and
      removes a runtime CDN dependency.
- [x] Clerk's components are themed with `appearance.variables` only — no `@clerk/ui`
      dependency — so the sign-in modal matches the dark app without a second bundle.

### 7.2 Database (PostgreSQL)
- [x] Provision a Postgres instance (Railway, Neon, or Supabase)
      — **Neon**, database `neondb` on `ap-southeast-1`. See the reset note below: the
      instance existed but was not empty.
- [x] Set up Prisma or Drizzle ORM with the `dead_rooms` schema above
      — **Prisma 7**, in `web/`: `prisma/schema.prisma` (the `DeadRoom` model)
      plus `prisma.config.ts` for the CLI.
- [x] Add environment variables for the DB connection
      — `DATABASE_URL` (pooled) and `DIRECT_URL` (unpooled, migrations only), documented in
      both `.env.example` files and CLAUDE.md's env table **and actually present** in
      `web/.env.local` + `server/.env`. They had been documented but never
      set, so `prisma migrate` failed on a missing datasource URL rather than on anything
      to do with the database.
- [x] Write a migration for the `dead_rooms` table
      — `prisma/migrations/20260729084725_init_dead_rooms/`. Verified applied: the table,
      the `room_id` UNIQUE index and the `(owner_user_id, died_at DESC)` index all exist,
      and `EXPLAIN` shows 7.4's profile query using that second index rather than scanning.
      (**Superseded by 7.3**: the second migration dropped that column and index — see §6.)

Shipped alongside 7.2, not originally listed here:

- [x] **The sync server does not use Prisma.** `server/src/storage/db.js` is a plain `pg` pool and one
      hand-written INSERT, because that process writes one row per room in its whole life and
      never reads or updates one. Prisma there would mean a second schema copy, a
      `prisma generate` step and the query engine in the Railway image to serve a single
      statement. Same deliberate duplication as `rateLimit.js` / `rateLimit.ts`.
- [x] `DATABASE_URL` is **optional in `server/`**: unset, no pool is opened and
      `saveDeadRoom()` is a logged no-op, so the sync server still boots and serves rooms
      exactly as in v1. The guest flow stores nothing, so it must not depend on a database.
- [x] `pool.on("error", …)` in `server/src/storage/db.js` — mandatory, not defensive. An idle connection
      dropped by Neon's pooler emits an `error` on the pool; unhandled it is an uncaught
      exception that would kill the sync server and every live room with it, over a database
      it was not using.
- [x] `ON CONFLICT (room_id) DO NOTHING` on the INSERT, so a retry or a restart that
      re-evicts an already-saved room cannot violate the write-once rule.
- [x] `build` is `prisma generate && next build`, not just a `postinstall` hook — Vercel
      restores a cached `node_modules` and can skip `postinstall`, producing a build that
      fails on a missing client while working locally.
- [x] `web/src/lib/data/db.ts` — the one place the app learns about Postgres, server-only, with the
      client cached on `globalThis` so Next's dev HMR does not open a new pool per edit.
- [x] Schema hardening beyond §6's draft: `UNIQUE` on `room_id` and an index on
      `(owner_user_id, died_at DESC)`. See the note in Section 6. (The index and column were
      dropped again by 7.3's migration; the `room_id` UNIQUE survives and is load-bearing.)
- [x] **The Neon database had to be reset before it could be migrated.** It already held a
      `Room` table (42 rows of `ydocState bytea`) and a `_prisma_migrations` row
      `20260706083131_init`, left over from an abandoned experiment that persisted live Yjs
      docs to Postgres — the exact thing §8 puts out of scope. Its commits are dangling
      (reachable from no branch), so the rows were orphaned. Both tables were dumped to a
      backup and dropped, giving `dead_rooms` a single clean migration history that replays
      from an empty database.
- [x] Connection strings pinned to `?sslmode=verify-full`. Neon hands out
      `?sslmode=require&channel_binding=require`, and `server/.env` had been left that way —
      node-postgres warns on every connect that pg v9 will make `require` stop verifying the
      certificate at all.
- [x] A Neon **`dev`** branch for local work, with `main` left for the deployed site.
      `web/.env.local` and `server/.env` point at `dev`, so local testing can
      never write rows the deployed `/profile` would read. Note a branch is a copy-on-write
      fork of its parent *at the moment it is taken*: `dev` was cut from a pre-cleanup
      snapshot and arrived carrying the same `Room` table, so it needed the same drop and a
      `prisma migrate deploy` of its own.
- [x] Acceptance test for the schema/INSERT duplication: `saveDeadRoom()` is called directly,
      the row is read back column by column, a repeat call proves `ON CONFLICT DO NOTHING`
      returns `false` instead of throwing, a snapshot with no language/participants proves the
      nullable columns, and a `DATABASE_URL`-unset process proves the no-op path. Nothing in
      the build compares `server/src/storage/db.js`'s hand-written INSERT to `schema.prisma`, so this is
      the only thing that would catch a rename.

### 7.3 Dead room snapshot logic

Implements Section 6.1. Read it first — the ownership rule is the design work here; the
columns are the easy part.

- [x] **Verify a Clerk token on connect** and record the resulting user ID on the in-memory
      room. Chose `verifyToken` from `@clerk/backend` on the socket: the client sends
      `?token=`, and `server/src/sync/connection.js` already discarded the query string so the
      doc-name derivation needed no change. **Never take the ID from awareness or any
      client-supplied field** — CLAUDE.md, "Accounts (Clerk)". `server/src/auth/clerk.js` is the one
      place a token becomes a user ID.
- [x] **Track a member set, not an owner**, on the room object: verified user ID → connect
      time, accumulated connected time, and whether they edited. `server/src/rooms/state.js`.
      A room has no owner and needs no ownership transfer.
- [x] **Apply the contribution threshold** from 6.1 — 60s of accumulated connected time **and**
      at least one document update sent over one of that user's sockets. See the correction
      below: the "document was non-empty" half of the original wording could not work.
- [x] **Record `created_at`.** `reserveRoom()` now calls `createRoomState()`, which stamps it;
      it is the only thing in the process that knows when a room was created.
- [x] On last-user-disconnect (same trigger point as v1's room cleanup), write **one**
      `dead_rooms` row plus **one `dead_room_members` row per qualifying user**, in a single
      transaction. (`language` stayed null until §10.1, which now supplies it from the room
      state — see Section 6's note.)
- [x] If the member set is empty (all guests, or nobody cleared the threshold): skip the DB
      write entirely — behave exactly like v1. `buildSnapshot()` returns null *before* reading
      the `Y.Text`, so the common guest case never materialises the document at all.
- [x] **Cap the snapshot size.** 256 KB of UTF-8, truncated with a visible marker rather than
      dropped — losing a large room silently is worse than keeping most of it.
- [x] **Flush on shutdown.** `flushAndDestroyAll()` on SIGTERM/SIGINT destroys **every** room,
      live ones included, and awaits the writes. A live room at SIGTERM *is* a dead room that
      has not noticed: the registry dies with the process, so flushing only in-grace rooms
      would save the rooms nobody was using and lose every room someone was working in.
- [x] Destroy the in-memory Yjs doc exactly as v1 already does, regardless of whether a
      snapshot was saved — snapshot building is wrapped in `try/catch` and the destroy is in a
      `finally`, because an uncaught throw inside the eviction `setTimeout` would kill the
      process and every other live room.
- [x] **Second migration**: `20260729122125_dead_room_members` drops `dead_rooms.owner_user_id`
      and its `(owner_user_id, died_at DESC)` index and creates `dead_room_members`.
      `server/src/storage/db.js`'s hand-written INSERT was updated to match — nothing in the build compares
      it to `schema.prisma` (see 7.2's acceptance-test note), so it was re-verified by running
      it and reading both tables back.

**Corrected while building 7.3 — the checklist above was wrong twice:**

- [x] **The contribution threshold's "document was non-empty" clause was unimplementable.**
      `useCollabRoom` seeds `DEFAULT_CODE` on the provider's `sync` event, so every room is
      non-empty within milliseconds of the *first* client connecting. The clause therefore
      filtered nothing — and what it was filtering on was boilerplate nobody wrote. Replaced
      with "actually edited", which is what it was reaching for and which is what genuinely
      excludes the lurker: y-websocket passes the WebSocket as the Yjs transaction origin
      (`readSyncMessage(decoder, encoder, doc, conn)`), so `doc.on("update")` identifies who
      sent each edit. Section 6.1's prose was updated to match.
- [x] **§6.1's threshold prose contradicted its own scenario table.** The prose suggested "on
      the order of the grace window" (10s) while the table requires a 30s lurker to get
      nothing. 60s (`MEMBER_MIN_CONNECTED_MS`) satisfies the table; the prose was rewritten.

Shipped alongside 7.3, not originally listed here:

- [x] **Verification never refuses a socket.** A bad, expired or missing token, an unset
      `CLERK_SECRET_KEY` and a Clerk outage all mean the same thing: no membership recorded,
      room otherwise untouched. CLAUDE.md already documents what gating on Clerk costs — a
      deep-linked room that could not be joined at all — and gating the *socket* would be the
      same bug one layer down. A missing token costs a profile entry; a missing socket costs
      the room.
- [x] **`CLERK_SECRET_KEY` is optional in `server/`**, exactly like `DATABASE_URL`: unset, no
      token is verified, no room has members, nothing is written, and the guest flow — which
      is the whole of v1 — runs without auth infrastructure it never touches.
- [x] **A `pendingEdits` set, to close a race that silently lost snapshots.** Verification is
      asynchronous and the first call of a process fetches Clerk's JWKS (~200ms measured),
      while a client syncs and starts typing in ~50ms. Every edit in that window was
      attributed to nobody, so the user failed the `didEdit` half of the threshold and lost
      their snapshot. It reproduced consistently for the **first signed-in user after every
      restart** and vanished for everyone after, because the JWKS cache then wins the race.
- [x] **Shutdown closes sockets with 1012 (Service Restart), not 4404.** The client treats 4404
      as permanent — it calls `provider.disconnect()` and shows the closed screen forever —
      which is exactly wrong for a redeploy. Every other close code keeps y-websocket retrying.
      No client change was needed.
- [x] **`GET /health` answers 503 once shutting down**, so Railway stops routing to a draining
      container (`railway.json` already points its healthcheck there).
- [x] **The token is refreshed on reconnect.** y-websocket serialises `params` into
      `this.url` **once, in its constructor**, but `setupWS` re-reads `provider.url` on every
      dial. A Clerk session token lives ~60s, so without rewriting that url every reconnect
      after the first minute would carry a dead token and the user's connected time would
      silently stop accruing mid-session.
- [x] **`participants` is populated**, accumulated from awareness over the room's life and
      sanitized server-side. It cannot be read at eviction: y-websocket's `closeConn` strips
      awareness state per socket, so a dying room's awareness is already empty.
- [x] **`server/src/storage/db.js`'s write is a real transaction.** `pool.query("BEGIN")` is *not* one —
      with `max: 3` the BEGIN, the INSERTs and the COMMIT can land on three different pooled
      connections, so the inserts run outside the transaction and the COMMIT commits nothing.
      It fails silently, because the rows still appear.
- [x] **End-to-end verification**, 40 assertions headless plus a real-browser pass: guest-only
      rooms store nothing; a signed-in editor gets a row and a member row; a lurker is excluded
      while the editor is still saved; a sub-threshold session is excluded; two tabs on one
      account produce one member row; a refresh inside the grace window writes nothing and
      keeps membership; a 300 KB document with emoji at the cut truncates without corrupting
      jsonb; SIGTERM flushes a live room in ~500ms; both degraded configs still serve rooms;
      and the 4404 path, the always-200 `GET /rooms/:id` and the no-socket `RoomGate` invariant
      all still hold. The browser pass drove a real Clerk sign-in and confirmed the socket URL
      carries a token and the resulting member row is the verified Clerk user ID.
- [x] **An unpaired surrogate anywhere in a snapshot silently lost the whole room** — found
      while building 7.4, fixed there, recorded here because it is 7.3's write path. A lone
      surrogate cannot be stored: `JSON.stringify` emits a bare `\ud83d` and Postgres rejects
      the *entire* INSERT with `unsupported Unicode escape sequence`, so `saveDeadRoom`
      returned `"failed"` and the code went with it. Two ways in, both reachable by a peer:
      `sanitizeName`'s `.slice(0, 24)` counted UTF-16 code units and could halve a surrogate
      pair, so one participant's emoji name destroyed everyone's snapshot; and `snapshotText`
      only repaired the document on its *truncating* branch (`Buffer.toString("utf8")`
      substitutes U+FFFD), so a lone surrogate in a document **under** 256 KB was returned
      untouched. Both now go through one `stripUnstorable`, and the name cut is by code point.
      `web/src/lib/collab/user.ts`'s copy of `sanitizeName` got the identical change so the two do not
      drift.

### 7.4 Profile page
- [x] New route: `/profile` — `app/profile/page.tsx`, an async Server Component. Plus
      `app/profile/[deadRoomId]/page.tsx` for one snapshot, with its own `not-found.tsx`
      and a shared `error.tsx`.
- [x] Protected — only accessible to logged-in users. `await auth()` **in the page**, not in
      `proxy.ts`: `clerkMiddleware()` stays callback-free so the guest flow keeps reaching
      `/`, `/room/*` and `/api/execute`, and Clerk deprecates `createRouteMatcher` in favour
      of exactly this. A signed-out visitor gets an in-page gate with a `SignInButton`, not a
      redirect — see the correction below.
- [x] List every `dead_rooms` row the current user has a `dead_room_members` row for,
      newest `died_at` first (Section 6.1 — a room can legitimately appear on more than one
      person's profile). It is a join from `dead_room_members`, never a filter on
      `dead_rooms`; see the security note below.
- [x] Show room name/date/language for each — **as far as the schema allows**. See the
      correction below: there is no room name, and `language` is null on every row.
- [x] Clicking a room opens a **read-only** code view — a static `<pre>` with a sticky
      line-number gutter, not a read-only Monaco. See the correction below.
- [x] Add a "Copy code" button — `web/src/components/profile/SnapshotActions.tsx`, reusing
      `web/src/hooks/useCopyToClipboard.ts` and the copied-tick + `aria-live` pattern from
      `EditorToolbar`'s room-ID chip.
- [x] Explicitly disable/hide any "Run" or "Rejoin" button on dead rooms — make it visually
      clear the room is closed. Both are rendered **disabled**, not hidden: a control that is
      visibly off with a reason in its `title` says "this room is dead", where an absent one
      is indistinguishable from a feature nobody built. Reinforced by a "Closed room ·
      read-only snapshot" badge and a padlock on every card.

**Corrected while building 7.4 — three of the bullets above could not be built as written:**

- [x] **There is no room name to show.** `dead_rooms` has no name column and never had one:
      a room is minted by `POST /rooms` as a bare UUID and nobody ever titles it. The
      original `room_id` is therefore the name, rendered in mono so it is recognisable
      against a link someone still has open. Naming rooms is not a v2 item; if it becomes
      one, §10 is where it belongs.
- [x] **`language` was null on 100% of rows, so the listing said "not recorded".** Not a
      placeholder to backfill — the language dropdown was a per-user editing preference kept
      deliberately off the shared `Y.Doc`, so the server had no single answer.
      **§10.1 has since moved the selector to room creation and the column now carries a real
      value**; "not recorded" survives only for rows written before it, which is the honest
      answer for them. `is_private` is still `false` on every row until §10.3, and is still not
      rendered at all rather than shown as a meaningless "public".
- [x] **The read-only view is a `<pre>`, not a read-only Monaco.** Three reasons, in order:
      an editor is the one widget on this site that means "you can type here", which is the
      opposite of what the last bullet above asks for; there is nothing to highlight while
      `language` is null, so Monaco would load ~5 MB to render plaintext; and
      `web/src/lib/editor/monacoLoader.ts` imports `monaco-editor` at module scope, which is why
      `/room/[roomId]` returns HTTP 500 from the server on every request — keeping it out of
      this route's import graph is what lets `/profile` actually server-render. Verified:
      `/profile` answers 200 where `/room/<id>` answers 500.

Shipped alongside 7.4, not originally listed here:

- [x] **`web/src/lib/data/deadRooms.ts` — the read boundary, with one hard rule: a `DeadRoom` is never
      fetched by its id.** Both queries start from `deadRoomMember` keyed on the *viewer's*
      Clerk user ID and reach the room through the relation, so a snapshot the viewer holds
      no membership row for is not "hidden by a filter we remembered to add" — it is
      unfetchable. §6.1 puts one room on several profiles, so there is no ownership column
      that could do this job instead. The detail lookup is `findUnique` on the composite
      primary key `(user_id, dead_room_id)`, which makes the authorization check and the
      index lookup the same query.
- [x] **`readSnapshotFiles()` narrows the `files` column**, the same way `web/src/lib/collab/awareness.ts`'s
      `readPeers` narrows peer state. Prisma types `files` as `JsonValue` and guarantees
      nothing; filenames are additionally reduced to a safe basename because one is handed to
      an `<a download>`.
- [x] **The detail URL carries `dead_rooms.id`, not `room_id`** — it makes the membership key
      and the URL the same value, and a `/profile/<id>` sharing its id with a live
      `/room/<id>` would invite exactly the confusion the page exists to prevent. A malformed
      UUID is rejected by a regex *before* the query, because `id` is a Postgres `uuid` and
      would otherwise 500 on `invalid input syntax for type uuid`.
- [x] **"No such saved room" is one answer for two causes** — no such row, and not yours — so
      the URL cannot be used to probe which snapshot ids exist.
- [x] **A "My rooms" link on the landing page**, shown next to `<UserButton>` when signed in.
      Without it `/profile` is reachable only by typing the URL.
- [x] **A Download button** beside Copy, reusing `web/src/lib/editor/download.ts`. It is the same promise v1
      made about Save — "saving a file means downloading it to your device" — and is neither
      a Run nor a Rejoin, so it fits §8's read-only rule.
- [x] **A truncation notice.** A snapshot cut at the 256 KB cap ends with a C-style marker
      that would otherwise appear as a mystery comment in someone's Python. The content is
      still rendered and copied *verbatim*, so what you see is what you copy.
- [x] **`error.tsx` distinguishes "database unreachable" from "you have no rooms"** — the
      same `missing` vs `unreachable` split `RoomGate` draws for a room, and a live case
      because Neon autosuspends an idle branch. It uses Next 16.2's **`unstable_retry`**, not
      `reset`, which was demoted to "re-render without re-fetching".
- [x] **No `loading.tsx`, deliberately.** A Suspense boundary in `app/profile/` would also
      wrap `[deadRoomId]`, and once a response starts streaming its status is already sent —
      `notFound()` would then render the 404 UI under a 200. Verified: the not-found route
      answers a real 404.
- [x] **The listing is capped at 100 rows and says so when the cap bites**, and it does not
      select `files`: a snapshot is up to 256 KB, so a full page of them would pull ~25 MB out
      of Neon to render metadata cards. That is also why the cards carry no code preview.
- [x] **End-to-end verification**: 15 browser assertions through a real Clerk sign-in
      (listing contents and order, another account's room absent and its snapshot URL a 404,
      code byte-identical, clipboard contents, downloaded file name and bytes, both dead
      controls disabled with no enabled Run/Rejoin anywhere, the truncation notice); 4 more
      driving a **real room to death** at the real 60s threshold and 10s grace, confirming it
      lands at the top of `/profile` with the text that was actually typed while a
      simultaneous guest room stored nothing; 5 more forcing an unreachable database to prove
      `error.tsx` renders and retries; plus `/profile` 200 vs `/room/<id>` 500, a malformed
      UUID 404, and `lint`/`tsc`/`build` clean.

### 7.5 Guardrails
- [x] A dead room's original `room_id` can never be reused to rejoin a live session
      — **already true since v1; ticked on verification, not on new code.** Three
      independent things enforce it and none was added here: IDs are minted as
      `crypto.randomUUID()` (`server/src/rooms/lifecycle.js`), so one is never handed out twice;
      `roomExists()` is a pure in-memory lookup over `docs` + `reservations`, so a
      destroyed ID is unknown forever and a restart makes *every* old ID unknown;
      and `room_id` is `UNIQUE` with `ON CONFLICT DO NOTHING`, so even a repeat
      write cannot revive one. Verified rather than assumed — see the note below.
- [x] If someone visits `/room/<old-dead-id>`, redirect home (same as v1's "room doesn't exist" behavior)
      — **also already true; verified in a real browser.** `checkRoom` →
      `{"exists": false}` → `RoomGate`'s `missing` state → a "This room has
      closed" screen, a 3-second countdown, and `router.replace("/")`. `replace`,
      not `push`, so Back cannot land in the dead room again.
- [x] Rate-limit DB writes the same way v1 rate-limits room creation
      — **the only bullet that needed building.** `server/src/storage/snapshotQueue.js`: the
      same sliding window from `rateLimit.js` that `POST /rooms` uses, keyed on
      the room creator's IP, plus a concurrency cap at `db.POOL_MAX`. It **defers
      rather than refuses** — see the correction below.

**Corrected while building 7.5 — the first two bullets could not be built as written:**

- [x] **There was nothing to implement for bullets 1 and 2.** Both describe
      behaviour v1 already had, and CLAUDE.md explicitly says not to tick 7.5 on
      that basis alone. So they were driven end to end instead: a room was taken
      through its real lifecycle to death, then `GET /rooms/:id` was confirmed to
      answer `{"exists": false}`, a raw WebSocket to that ID was closed with
      **4404**, `GET` was re-checked afterwards to prove the probe had not
      resurrected it, an ID the server never issued was refused identically, and a
      browser visiting the dead URL was watched being sent home. Building anything
      new here would have been a second, weaker copy of a gate that already works.
- [x] **"Rate-limit DB writes" cannot mean "refuse them".** `POST /rooms` answers
      429 and the caller retries; a snapshot has no caller left to retry — the room
      is already destroyed and its document freed, so a refused write destroys the
      only copy of that work. Worse, the legitimate case that trips a per-IP limit
      is a **shared NAT**: one office or classroom egress IP closing thirty rooms
      at 5pm, not an attacker. So the limiter paces and defers, and the only thing
      that ever discards is the queue's own memory bound.

Shipped alongside 7.5, not originally listed here:

- [x] **A concurrency cap, which fixed a real bug 7.5 never mentioned.**
      `destroyRoom()` fired `saveDeadRoom()` and forgot it, so N rooms dying at
      once meant N concurrent `pool.connect()` calls against a pool of 3.
      Everything past the third waits in pg-pool's pending queue, where
      `connectionTimeoutMillis` eventually rejects it — and the room is gone, so
      there is nothing to retry from. **Measured before the fix: 10 rooms dying
      together, 3 saved, 7 lost**, exactly the pool size, with
      `timeout exceeded when trying to connect` in the log. **Same experiment
      after: 10 of 10 saved.** Every Railway redeploy took this path, because the
      shutdown flush destroys every room at once.
- [x] **`died_at` is now bound by the writer instead of defaulting to `now()`.**
      Once a write can be paced, `now()` records when Postgres was reached rather
      than when the last person left — and `/profile` both **sorts** the listing on
      `died_at` and renders `died_at - created_at` as each room's lifetime, so a
      deferred room would sort below a later one and claim a longer life. Verified:
      10 rooms whose writes were paced across ~15s came back with an **8ms**
      `died_at` spread and identical lifetimes.
- [x] **`saveDeadRoom`'s "never throws" is now actually true.** `pool.connect()`
      sat on the line *above* the `try`, so all three of its rejection paths
      escaped — survivable only because the old call site attached a `.catch`.
      Under a queue whose worker chain has no other catcher, that would have become
      an unhandled rejection, which is fatal by default and would take every live
      room with it.
- [x] **The shutdown flush releases pacing before it destroys anything.** A room
      that died earlier can be sitting behind a pacing timer when SIGTERM arrives.
      By then `server.close()` has released the listening handle, signal handles
      never anchored the event loop, and the timer is `unref()`'d — so Node would
      exit with those snapshots still in memory. Verified: 8 rooms parked behind a
      60-second timer, SIGTERM, **all 8 written and the process exited in 6.8s**.
- [x] **Every terminal path in the queue resolves, including a dropped one.** An
      entry whose promise never settles sits in `pendingWrites` forever, which
      would make `flushAndDestroyAll`'s `Promise.race` always resolve via its
      deadline branch — turning every shutdown, healthy or not, into a full
      20-second wait.
- [x] **A per-key occupancy cap on the queue.** With only a global bound, one
      caller's deferred entries could fill it and every *other* room's snapshot
      would then be dropped at the door — the limiter would have converted abuse
      into a queue and the queue into somebody else's data loss. Same argument as
      `MAX_RESERVATIONS` vs. the per-IP limiter: a global ceiling and a per-caller
      bound do different jobs.
- [x] **The queue is bounded in bytes, not just entries.** A snapshot is up to
      256 KB, so "64 entries" is 0.1 MB of ordinary rooms or 16 MB of capped ones.
      Tens of MB competes with the Y.Docs of *live* rooms on a Railway container,
      and an OOM there loses the queue **and** every live room — strictly worse
      than the unbounded writes it replaced.
- [x] **The pacing default is 60/min, not the 10 `POST /rooms` uses.** Room
      creation is already capped at 10/min/IP and a snapshot additionally requires
      a signed-in member who stayed 60s *and* edited, so 10 here would essentially
      never bind on abuse while binding constantly on the shared-NAT case.
      `SNAPSHOT_WRITE_LIMIT` / `SNAPSHOT_WRITE_WINDOW_MS` make it tunable, and
      lowering them is how the deferral path is exercised in seconds.
- [x] **The creator's IP never leaves memory.** It is recorded once, at
      `POST /rooms` — the only moment a room and an address are ever in the same
      place, since `destroyRoom` has no request and no socket — carried on the
      in-memory room state, and used solely as the pacing key. It is not a column,
      the INSERT lists its columns explicitly, and the queue's logs print room IDs
      and depths only. Verified: no address appears in the server log, and
      `dead_rooms` still has exactly its eight columns.
- [x] **The exit backstop is armed before `db.close()`, not after.** `pool.end()`
      waits for every checked-out client and the pool sets no `statement_timeout`,
      so a query wedged against an unresponsive Neon hung that await forever — and
      a backstop created afterwards was never reached, leaving only the platform's
      SIGKILL.
- [x] **End-to-end verification**: 12 headless assertions (a guest-only room still
      stores nothing; a dead room's ID answers `exists:false`, closes a raw socket
      with 4404 and is not resurrected by the probe; an unissued ID is refused
      identically; `GET /rooms/:id` still never 404s; `POST /rooms` still 429s with
      `Retry-After` and its own wording; no client address in the log; the schema
      still has nowhere to put one), 11 browser assertions through real Chrome (the
      closed-room screen, the countdown, the redirect home, Back not returning, and
      a two-tab room still syncing, showing presence and broadcasting a Run with
      its attribution), and seven write-path scenarios: the before/after burst,
      40 rooms at default settings, deferral under a deliberately tiny window,
      writes parked behind a 60s timer through a SIGTERM, `died_at` fidelity, and
      the real 60-second membership threshold. Plus `lint`, `tsc` and `build`
      clean, `/room/<id>` 200 with zero Monaco in the server-rendered HTML,
      `/profile` 200 and `/nosuchpage` a real 404.

### 7.6 Housekeeping (not originally listed; recorded because it shipped)

- [x] **Full end-to-end verification pass** driven through a real browser (Playwright against
      system Chrome; nothing was added to either workspace's dependencies, and the scripts are
      deliberately not committed — this repo has no test harness and 7.x did not ask for one).
      77 assertions, all passing: landing and Clerk chrome; room create/join; Yjs sync both
      ways and concurrent-edit merge; presence, remote-cursor styling and <300 ms departure
      (the `disableBc` regression); Run in all five languages against live Piston; the output
      cap, OOM and timeout notices, and the deliberate *absence* of a notice on a plain
      non-zero exit; per-user Save filenames (`main.cpp` vs `Main.java` from one document);
      copy; room eviction measured at 10.2 s against a 10 s `ROOM_GRACE_MS`; `missing` vs
      `unreachable` vs rate-limited kept distinct; the `RoomGate` no-socket invariant;
      hostile-peer CSS injection and a 10 000-character name; name/colour collision resolved
      identically for two viewers; the 413 payload cap; both rate limiters; the 25 s stale-run
      watchdog healing an abandoned run at 24.3 s; and the full signed-in flow including the
      invariant that `clerkUserId` never appears in awareness (read off the wire by a raw Yjs
      client, not from the UI).
- [x] Corrected two claims in `CLAUDE.md` that testing disproved: missing Clerk keys do **not**
      500 a production start, and `GET /rooms/:roomId` never returns 404 — it always answers
      200 with `{"exists": …}`.
- [x] Split the 810-line `CodeEditor.tsx` into composable parts before v2 adds multi-file,
      chat and passwords to the same screen: the Yjs stack moved to `web/src/hooks/useCollabRoom.ts`,
      Run to `web/src/hooks/useCodeRunner.ts`, and the chrome to `EditorToolbar` / `OutputPanel` /
      `JoinRoomPrompt`. Behaviour unchanged — verified with a two-tab browser run of sync,
      presence, join/leave toasts, shared Run, error output, copy and Save.

### 7.7 UI/UX redesign (not originally listed; recorded because it shipped)

A full visual and interaction pass over every screen, requested directly rather than from this
checklist. **No behavioural change to sync, presence, execution, auth or persistence** — the
whole point was that the room keeps working exactly as 7.1–7.4 left it.

- [x] **A real design system.** `web/src/styles/globals.css` went from six dark-only colours to semantic
      light *and* dark tokens (`--app`/`--panel`/`--raised`/`--edge`/`--fg`/`--accent`/
      `--success`/`--danger`/`--warning`/`--code-bg`), surfaced to Tailwind with
      `@theme inline` so one class on `<html>` re-resolves every utility. The ~200 literal
      `zinc-*`/`emerald-*`/`amber-*`/`red-*` classes and the hardcoded `#2c2c2c`, `#101010`
      and `#1f1414` hexes were swept onto tokens.
- [x] **Light/dark theme with a three-way Light/System/Dark toggle**, defaulting to the OS
      preference and persisted in `localStorage`. Includes the no-flash inline `<head>` script,
      Monaco themes matching `--code-bg`, and Clerk's `appearance` following the theme — which
      is why `ClerkProvider` moved into a client `AppProviders`.
- [x] **A freely resizable editor/output split** via `react-resizable-panels` v4: drag to
      resize, a button to switch between side-by-side and stacked, collapse/expand, sizes and
      orientation persisted. Keyboard-resizable and double-click-to-reset come from the
      library's `Separator`.
- [x] **The two chrome rows became one.** `EditorToolbar.tsx` and `UserBar.tsx` were deleted
      and replaced by `RoomChrome.tsx` + `PresenceStack.tsx`, roughly halving the vertical
      space above the editor. Nothing was dropped: room id, sync state, presence, language,
      Run and Save are all still there, plus the theme toggle.
- [x] **Responsive across the whole app**, where before there was exactly one breakpoint in
      the codebase. Phones get a forced stack, a wrapping chrome bar (no controls hidden), word
      wrap in Monaco, and `h-dvh` so the URL bar stops clipping the output panel.
- [x] **Designed failure screens**: root `not-found.tsx`, `error.tsx` and `global-error.tsx`.
      Still no `loading.tsx` anywhere — a Suspense boundary would start streaming and turn
      every real 404 into a soft 200.
- [x] **Fixed the long-standing `/room/[roomId]` HTTP 500.** `RoomGate` now loads the editor
      through `dynamic(..., { ssr: false })`, so the route server-renders for the first time.
      This was not cosmetic: the no-flash theme script lives in the root layout's `<head>`, and
      a route that 500s never ships one.
- [x] **Deduplicated the copy-pasted button styles** into `web/src/lib/ui.ts`. `primaryButton` and
      `secondaryButton` had been declared byte-for-byte in both `ProfileShell.tsx` and
      `RoomGate.tsx`.
- [x] **Accessibility and polish**: a focus trap in `IdentityDialog` (it is `aria-modal` but
      Tab used to walk straight out of it), the first/last-name row stacking on narrow screens,
      the full eight-colour cursor palette instead of a Shuffle-only button, a consistent
      `focus-visible` ring, toasts clear of the mobile browser chrome, and a favicon
      (`app/icon.svg`) where the app previously 404'd on every page load.
- [x] **Verified end to end in a real browser**, two tabs: presence, sync, shared Run with
      attribution, and — the load-bearing one — that dragging, flipping orientation, collapsing
      and expanding, and switching theme all leave the shared output and editor contents intact
      in *both* tabs. That is the assertion that proves `<Editor>` never remounted and the Yjs
      stack was never torn down. Plus `/room/<id>` and `/profile` both answering 200,
      `/nosuchpage` a real 404, and no Monaco in any server-rendered HTML.

---

### 7.8 Shut down the public Piston tunnel (not originally listed; recorded because it shipped)

Asked directly, not from this checklist: whether exposing a local Piston through ngrok risked
the host machine. It did, more than expected, so the exposure was removed rather than patched.

- [x] Established the actual risk by measurement, not reasoning. Arbitrary Python was executed
      on the host **from the public ngrok hostname with no credential of any kind**, which also
      proved the tunnel bypassed `route.ts`'s 10/min/IP limiter (that limiter runs on Vercel;
      the tunnel reaches Piston directly). The container was confirmed to hold the **full Linux
      capability set** (`CapEff: 000001ffffffffff`) from `privileged: true`, so `isolate` is the
      sole boundary against root on the host. Two mitigations were confirmed present: the
      sandbox has **no network** (`Errno 101 Network is unreachable`) and runs as an
      unprivileged uid with none of the host filesystem mounted.
- [x] Stopped and `systemctl --user disable`d `ngrok-piston.service`, so it does not return on
      reboot. Verified: no `ngrok` process, and the public hostname now answers ngrok's own 404.
- [x] Bound Piston to loopback — `127.0.0.1:2000:2000` in `docker-compose.yml`, replacing a bare
      `2000:2000` that listened on `0.0.0.0` and so was reachable by every device on the same
      wifi. Verified with `ss -tlnp`, and a local run still returns `4`.
- [x] Rewrote `CLAUDE.md`'s "Production execution path" and the `PISTON_API_URL` row: execution
      is now a **local-only** feature, the deployed Run button reporting `"Could not reach the
      code execution service."` is expected rather than a fault, and any future tunnel must
      carry a shared secret.

### 7.9 Repository reorganization (not originally listed; recorded because it shipped)

Asked directly, not from this checklist: reorganize the whole project into a structure a developer
or a recruiter can read, without changing behaviour. No feature was added or removed.

- [x] Renamed `collab-code-editor/` to `web/`, so the two workspaces read as `web/` + `server/`.
      **The Vercel project's Root Directory is dashboard-only config and must be repointed to
      `web/`** — nothing in the repo errors if it is missed, the deploy just breaks. Railway's
      root directory is unaffected (`server/` did not move).
- [x] Moved the frontend to the `src/` layout: `web/src/app/` now holds **routes only**, with
      `components/`, `hooks/`, `lib/`, `styles/` and `proxy.ts` beside it. Verified `proxy.ts`
      still resolves by finding `ƒ Proxy (Middleware)` in `next build` output — Next accepts it at
      the project root or inside `src/`, never inside `src/app/`.
- [x] Grouped the 26 components into `editor/` · `profile/` · `layout/` · `ui/`, and the 20 `lib`
      modules into `collab/` · `editor/` · `sandbox/` · `data/`, leaving `ui.ts`, `theme.ts`,
      `platform.ts` and `sound.ts` at the `lib/` root. No file was renamed, so nothing gained a
      new name to track.
- [x] Grouped the server's 8 flat files into `server/src/` as `sync/` · `rooms/` · `storage/` ·
      `auth/` · `http/`. Four files were renamed to kill the stutter the folders created:
      `rooms.js`→`rooms/lifecycle.js`, `roomState.js`→`rooms/state.js`,
      `yjsConnection.js`→`sync/connection.js`, `clerkAuth.js`→`auth/clerk.js`. `package.json`'s
      `main` and both scripts now point at `src/index.js`; `railway.json` needed no change because
      `npm start` is cwd-relative.
- [x] Adopted a hybrid import convention: `@/` (mapped to `web/src/`) for anything crossing a
      folder, relative for same-folder siblings. 133 specifiers rewritten. The one exception is
      `lib/data/db.ts`, whose Prisma client sits outside `src/` and so has no alias.
- [x] Moved `docker-compose.yml` to the repo root — it is a third service, not part of the
      frontend — and **pinned `name: collab-code-editor` inside it.** Compose derives its project
      name from the directory, which names the volume and labels the container, so without the pin
      the rename would have orphaned `collab-code-editor_piston_data` and every installed language
      package with it, then collided with the running `piston_api`. Verified the moved file still
      adopts the pre-existing container.
- [x] Moved `tasks.md` to `docs/tasks.md`; `README.md` and `CLAUDE.md` stay at the root by
      convention. Rewrote the README's repo-layout tree (which was already stale — it still listed
      the deleted `UserBar.tsx`) and its dead `V1_Tasks.md` link, replaced the stock
      create-next-app `web/README.md` with a real one, and corrected `server/README.md`, which
      still claimed the server had "no persistence and no auth" — untrue since 7.1 and 7.3.
- [x] Reduced comments repo-wide, keeping only what a future editor cannot safely lose: ordering
      constraints, trust boundaries, "keep in sync with" markers for the seven hand-maintained
      cross-workspace duplications, and the coupled numeric ceilings — each as a single
      `// INVARIANT:` line, with the long rationale left where it already lives, in `CLAUDE.md`.
- [x] Verified behaviour was unchanged rather than assumed: `next build` and `eslint` clean, every
      route's status code unchanged, `grep -c monaco` still 0 on the room and profile HTML, all
      four sync-server HTTP routes byte-identical, Python and Java still executing through
      `/api/execute` with stdin, and two Yjs clients still converging on one document with
      awareness, the `files` map, the `execution` map and the 4404 dead-room refusal all intact.

## 8. Explicitly out of scope for v2

- Redis or any cache/session store beyond Postgres
- Re-running or re-joining a dead room
- Editing a dead room's saved code in place
- Real-time collaboration on dead rooms (they are static, read-only)
- Horizontal scaling across multiple server instances (still a v3+ concern)

---

## 9. Suggested build order for v2

1. Add Clerk auth to the existing Next.js app (guest mode still default)
2. Set up PostgreSQL + ORM + `dead_rooms` table
3. Hook the existing "last user disconnects" cleanup logic to write a snapshot before destroying the Yjs doc
4. Build the `/profile` page (list + read-only view + copy button)
5. Add guardrails so dead rooms can never be rejoined or re-run
6. Test: guest-only room (nothing saved) vs logged-in room (snapshot saved and visible in profile)

---

## 10. Extra features for v2

### 10.1 Multi-file support

**How it works:** Language is chosen once, at room creation (dropdown just moves here instead of living inside the editor). Every new file in that room automatically gets the right extension for that language. One file is marked as the **entry file** (a small star on its tab) — that's the one "Run" executes. Saving works two ways:
- Only 1 file in the room → downloads that file directly, like v1.
- 2+ files → "Save" zips everything into `project.zip` (via JSZip). Each file tab also has its own "download this file only" option.

- [x] Move language selector from editor toolbar to room-creation screen — it is a `<select>`
      on the landing card, directly above "Create a new room", and travels to the sync server as
      `POST /rooms?language=…`. A **query parameter, not a JSON body**, because a body would add
      a `Content-Type` and turn room creation into a non-simple CORS request, buying a preflight
      round trip before every room. The server holds it in the in-memory room state and hands it
      back from `GET /rooms/:roomId`, which is how someone who was *sent a link* gets the right
      language rather than a guess. Read-only in the room (a chip in the chrome bar): changing it
      mid-room would make every existing file's extension a lie.
- [x] Add "+ New file" button; auto-suggest correct extension based on room language —
      `newFileName()` in `web/src/lib/editor/languages.ts`, which also numbers around a collision
      (`file1.py`, `file2.py`). The name is typed into an inline field in the tab strip rather
      than a modal; Enter on an untouched field just takes the suggestion.
- [x] ~~Each file = its own Yjs sub-document~~, **shown as tabs** — one `Y.Text` per file
      (`file:<id>`) plus a `Y.Map` of metadata, all on the room's existing `Y.Doc`.
      **The sub-document wording was wrong and could not be built as written**: y-websocket's
      `setupWSConnection` syncs exactly one doc per socket and never handles `doc.on('subdocs')`,
      so real subdocs would need a provider and a separately-gated WebSocket per open file, plus
      child-doc handling in `server/src/rooms/lifecycle.js` and `server/src/rooms/state.js`. A second shared type on
      the same doc is the trick the `execution` map already uses (Section 5's note): y-websocket
      merges the whole document, so files reach every peer including late joiners with **zero**
      server protocol change. See `web/src/lib/collab/roomFiles.ts`, which is the only description of the
      shape.
- [x] Right-click a tab → "Set as entry file" (starred, visible to everyone in room) — a filled
      star on the tab, driven by `roomMeta.entry` on the shared doc. Right-click *and* a kebab
      button open the same menu, because a right-click alone is unreachable by keyboard and by
      touch.
- [x] "Run" always executes the entry file — `useCodeRunner` reads the entry file's `Y.Text` at
      click time, so it runs the right file even when you are looking at a different tab, and
      even if that file has never been opened in this tab and so has no Monaco model.
- [x] Save: single file → direct download; multiple files → zip via JSZip — `downloadZipFile` in
      `web/src/lib/editor/download.ts`, behind a **dynamic** `import("jszip")` so the zip library never
      enters the room route's first chunk.
- [x] Per-file "download this file only" option in each tab's menu
- [x] `dead_rooms.files` stores the full file array on snapshot (see Section 6) — and
      `dead_rooms.language` is finally non-null, which was the standing consequence recorded in
      Section 6's note and on `/profile`. **No migration**: `files` has been a `jsonb` array
      since 7.2 for exactly this, and `language` was already nullable.

Shipped alongside 10.1, not originally listed here:

- [x] **Rename and delete a file**, in the same tab menu. A room you can add files to but never
      remove them from is a trap, and rename is nearly free once the new-file inline input
      exists. Deleting the *last* file is refused — an editor with no model is a blank pane with
      no way back — and deleting the entry file re-points `roomMeta.entry` at the first survivor
      in the same transaction.
- [x] **`web/src/lib/collab/roomFiles.ts`'s `readRoomFiles()` is a sanitizing boundary**, in the same
      category as `readPeers()` in `web/src/lib/collab/awareness.ts`. Filenames are peer-supplied: a raw Yjs
      client can write anything into the `files` map, and the name then reaches a tab label, an
      `<a download>`, a zip entry key and ultimately `dead_rooms.files`. It strips control
      characters, path separators and unpaired surrogates, caps the length by **code point**,
      rejects `.`/`..`, and numbers duplicate names. `server/src/rooms/state.js` repeats the check on
      its own side, because that client code never runs for a hostile peer. Verified: a file
      named `../../etc/pa sswd<lone surrogate>.py` reached the database as `....etcpasswd.py`.
- [x] **The first file's id is the fixed string `"main"`, never a random one.** Two peers can
      sync into an empty room at the same instant and both run the seed; with random ids they
      would create two identical `main.py` tabs that CRDT-merge rather than collide. A fixed key
      makes them converge on one file, and the seed's text insert becomes the same benign
      duplicate-insert v1 already had.
- [x] **Tab order is derived, never stored** (`createdAt`, tiebroken by id), so no shared
      ordering type has to survive two peers reordering concurrently — and the server derives the
      identical order when it writes the snapshot.
- [x] **Per-language starter code** (`starterCode()` in `web/src/lib/editor/languages.ts`). Before this, a
      new room was seeded with the same hardcoded `console.log` regardless of the language
      chosen, so every non-JavaScript room opened on a program that could not run.
- [x] **`ExecutionState.filename`**, required on all three non-idle variants for the same reason
      `stdin` is (§10.4): Run executes the entry file, which need not be the tab the person
      watching has open, so without it the output belongs to no visible file. The output panel's
      caption now reads `Run by Ada L. · main.py · Python`.
- [x] **A room's file count is capped at 20** (`MAX_FILES`), which bounds the tab strip, the
      number of live Monaco models and `MonacoBinding`s, and the snapshot's entry count.
- [x] **The 256 KB snapshot cap became a budget shared across files**, spent in tab order, so
      twenty 100 KB files cannot defeat the one bound v2 places on an unbounded write. The entry
      file is created first and is therefore the last thing to be lost.
- [x] **"Download all (`project.zip`)" on `/profile`** for a multi-file snapshot, reusing the
      same `downloadZipFile`.
- [x] **End-to-end verification.** 22 browser assertions across two tabs in one context, all
      passing — including the one that matters: run something, then switch files, flip the split,
      collapse and expand, and the room's shared output is still there **in both tabs**, proving
      `<Editor>` never remounted and the `Y.Doc` was never destroyed. Plus: Run executes the entry
      file while another tab is open; the star, renames and deletes all propagate; Save yields
      `project.zip` for two files and `utils.py` for one. Headlessly, a real room was driven to
      death with a server-minted Clerk token and came back from Postgres with
      `language="python"` and three files under their real names, then rendered on `/profile`
      with zero Monaco references.

### 10.2 In-room chat

**How it works:** A small chat sidebar next to the editor, sent over the **same WebSocket connection** already used for Yjs — no new server or database needed. Messages are not saved anywhere; they disappear with the room, same as everything else in v1's philosophy.

- [ ] Add a chat panel/sidebar to the room page
- [ ] Broadcast chat messages over the existing WebSocket connection (new message type, not Yjs)
- [ ] Show sender name + assigned color on each message
- [ ] Do **not** persist chat history — it dies with the room, even for logged-in users

### 10.3 Room password / private rooms

**How it works:** An optional password field at room creation. If set, joining that room requires entering the same password first. The password itself is never stored in plaintext or in Postgres long-term — it only lives in the server's in-memory room object (same lifetime as the room itself), so it disappears automatically when the room dies.

- [ ] Optional "Set a password" field on room creation
- [ ] Store the password hash in the in-memory room object only (not the database)
- [ ] Join flow: if room has a password, prompt for it before connecting to the WebSocket/Yjs doc
- [ ] Wrong password → clear error, no connection made
- [ ] `dead_rooms.is_private` flag records whether the snapshot came from a password-protected room (for display purposes only — the password itself is never saved)

### 10.4 Stdin for runs

**How it works:** `/api/execute` currently sends Piston no `stdin` at all, so any program that
reads input — `input()`, `Scanner`, `cin >>` — either hangs until the run timeout or dies on
EOF. That rules out most beginner and interview programs, which is a large hole for an app
whose headline feature is running code. Piston's `/api/v2/execute` already accepts a `stdin`
string in the payload, so this is a text field, one more field on the request, and one more key
on the shared execution record.

The input belongs on the **shared** `execution` record, not in local component state: the run
is broadcast to the whole room (see CLAUDE.md, "Shared code execution"), so a peer watching the
output has to be able to see what was fed in, or the output is unexplainable. It is part of the
run, not part of the editor — it must not go on the `Y.Text` and must not become a second
shared type.

- [x] Collapsible "Input (stdin)" field in the output panel, above the output
- [x] Send it as `stdin` in the Piston payload from `app/api/execute/route.ts`
- [x] Carry the stdin used on the shared `ExecutionState` record, so every peer sees the input
      that produced the output they are looking at
- [x] Cap its size and count it against the same UTF-8 byte budget as the code
      (`MAX_CODE_BYTES` in `web/src/lib/sandbox/execution.ts`) — checked client-side *and* in the route,
      like the code payload already is
- [x] Strip nothing and trust nothing: stdin is user input on a path that already has a
      documented double-check, so the loose `Content-Length` pre-check must account for it too

Shipped alongside 10.4, not originally listed here:

- [x] **`payloadTooLarge(code, stdin)` in `web/src/lib/sandbox/execution.ts` is the one budget rule**, so
      the client pre-check and the route's 413 cannot drift — the same reason `codeByteLength`
      already lived there rather than in the route. It also picks the wording: the old
      code-only sentence when stdin is empty, a combined one when it is not.
- [x] **The budget is combined, not per-field**, which is what let `REQUEST_BYTE_CEILING` stay
      untouched. The decoded payload still caps at `MAX_CODE_BYTES`, so the existing "doubled
      for JSON escaping" headroom still covers the whole envelope; a separate stdin cap would
      have doubled the worst case and forced that constant up with it. Verified at the
      boundary: 60 KB of code + 8 KB of stdin is a 413, 60 KB + 3 KB runs.
- [x] **`stdin` is required on the `ExecutionState` variants, not optional** (unlike `notice`),
      so the compiler enumerates all five sites that write a record — four in `useCodeRunner`
      and the stale-run watchdog in `useCollabRoom`, which must carry it through rather than
      drop it when it heals an abandoned run. The output panel still guards before rendering,
      for the mixed-bundle window.
- [x] **The draft box is local; only the value a run used is shared.** A remote run therefore
      never overwrites what someone is halfway through typing, and the echo is rendered from
      the shared record — the same rule the output caption already follows for `language`.
- [x] **A line-count badge on the collapsed field.** A closed box with content in it is
      otherwise invisible, which makes a run that consumed input look like it invented it.
- [x] **`stdin !== undefined && typeof stdin !== "string"` is a 400, not a coercion.** Absent
      is legitimate (a client that never opens the box sends nothing); present-and-wrong is a
      bad request.
- [x] **End-to-end verification**: Python `input()`, Java `Scanner` and C++ `cin >>` all run
      correctly with stdin and — the point of the feature — the same Python program without
      stdin still dies on `ValueError: invalid literal for int() with base 10: ''`, which is
      the hole this closed. Plus a two-tab browser pass: the peer sees the same output *and*
      the same echoed input while its own draft box stays empty.

### 10.5 Keyboard shortcuts

**How it works:** Two bindings registered on the Monaco instance. Ctrl/Cmd+S is the important
one — inside a code editor it currently opens the *browser's* "save page" dialog, which is
actively wrong, not merely missing.

Register them with `editor.addCommand` / `addAction` on the instance `CodeEditor` already
holds. They must not be a `window` keydown listener: the room page has other focusable controls
and a global handler would fire Run while someone is typing in the language select or (once
10.2 lands) the chat box.

- [x] Ctrl/Cmd+Enter runs the code — respecting the same room-wide `"running"` lock that
      disables the Run button, so a shortcut cannot start a second concurrent run
- [x] Ctrl/Cmd+S saves (downloads) and calls `preventDefault`, so the browser's save dialog
      never appears
- [x] Both shortcuts are discoverable: show the binding in the Run and Save buttons' `title`
- [x] Bindings live with the editor instance, not on `window`

Shipped alongside 10.5, not originally listed here:

- [x] **`web/src/hooks/useEditorShortcuts.ts` reads its handlers through refs and registers once.**
      `handleRun`/`handleSave` close over `code`, so they are new functions on every keystroke;
      an effect depending on them would tear down and re-register the keybindings sixty times a
      minute. Same latest-value-ref pattern `useCollabRoom` already uses for `onRoomClosed` and
      the Clerk token.
- [x] **`editor.addAction`, not `addCommand`** — it returns an `IDisposable` for a clean
      teardown, and it lists both actions in Monaco's F1 command palette for free.
- [x] **Neither action re-checks the running lock, deliberately.** `useCodeRunner` already
      returns early when the shared map reads `"running"`, so the shortcut inherits the same
      guard rather than keeping a second copy that could drift from it.
- [x] **`KeyMod`/`KeyCode` come from `onMount`'s second argument**, added to `web/src/lib/editor/monacoTypes.ts`
      as `MonacoApi`. A static `import "monaco-editor"` touches `window` at import time, which
      is the whole reason that file exists.
- [x] **The empty-document guard moved into `handleSave`.** It used to live only on the button's
      `disabled`, which the shortcut does not consult — Ctrl+S would otherwise have downloaded
      an empty file where the button was visibly off.
- [x] **An honest limitation, and the one thing done about it.** Monaco `preventDefault`s a
      binding it owns *only while the editor has focus*; with focus on a button or on §10.4's
      new stdin textarea, Ctrl+S still opens the browser dialog. §10.5 forbids a `window`
      listener (it would fire Run while someone types in the language select or, after §10.2,
      the chat box), so the stdin textarea carries its own **element-scoped** `onKeyDown`
      instead — which respects the rule while closing the one gap §10.4 opened.
- [x] **`web/src/lib/platform.ts`** picks the ⌘/Ctrl label for the tooltips. Reading `navigator` at
      render is safe here because `RoomGate` loads `CodeEditor` through
      `dynamic(..., { ssr: false })`, so this tree never server-renders.
- [x] **End-to-end verification** in a real browser: both bindings advertised in their `title`s;
      Ctrl+Enter in the editor runs the code *with the current stdin*; Ctrl+Enter from inside
      the stdin box does the same; Ctrl+S downloads `main.js` with no browser dialog. Asserting
      on the resulting output rather than on the transient "Running…" caption is what makes the
      first two reliable — a warm JS run finishes in well under a second.

### 10.6 Room names

**How it works:** An optional name given at room creation, held on the in-memory room object
and written to a new `dead_rooms.name` column at snapshot time. This is what makes `/profile`
usable past a handful of rooms: today the listing's title is the raw `room_id`, which is
meaningless three days later, and there is nothing else on the card to tell two rooms apart.

The name is set once at creation and is **not** editable afterwards and **not** in the `Y.Doc` —
a room-wide field that peers can rewrite is a second class of shared mutable state, and one
that would then need the same sanitizing boundary `readPeers` provides. It travels with
`POST /rooms`, the same request that already mints the ID.

- [ ] Optional "Room name" field on the create-room flow
- [ ] Sanitize and length-cap it server-side, through the same rules as a participant name
      (`sanitizeName` in `server/src/rooms/state.js`) — it is user text that `/profile` will render
- [ ] Hold it on the in-memory room state, alongside `created_at`
- [ ] Third migration: add a nullable `name` column to `dead_rooms`
- [ ] Add it to `server/src/storage/db.js`'s hand-written INSERT **and** `prisma/schema.prisma` — nothing
      in the build compares the two (see 7.2's acceptance-test note), so verify by writing a
      row and reading it back
- [ ] `/profile` shows the name as the card title, falling back to the `room_id` for every row
      written before this shipped — the column is null on all of them and always will be,
      snapshots are never updated
- [ ] Show it in the room's chrome bar too, so the name is visible to the people in the room

### 10.7 Delete a snapshot from `/profile`

**How it works:** A signed-in user can remove a dead room from their own profile. This is the
one gap in v2's data story: the app stores your code without asking at the moment a room dies,
and currently offers no way to remove it.

The subtlety is §6.1's shared ownership — a room can sit on several profiles, and there is no
owner. Deleting must therefore remove **the viewer's `dead_room_members` row**, never the
`dead_rooms` row directly, or one member erases another member's copy. The snapshot row is
garbage once its last member is gone, so it is deleted only in that case, in the same
transaction.

- [x] Delete control on the snapshot detail page, behind a confirmation — it is irreversible
      and there is no second copy anywhere
- [x] It deletes the viewer's membership row, keyed on the composite primary key
      `(user_id, dead_room_id)`, exactly like the read path — so a snapshot the viewer holds no
      membership row for is *unfetchable and undeletable*, not merely hidden
- [x] Delete the `dead_rooms` row too, in the same transaction, **only** when that was its last
      remaining member
- [x] A Server Function, not an API route — `/profile` is otherwise entirely server-rendered
      and this must not become the page's second reason to ship client JavaScript beyond the
      confirm dialog
- [x] Deleting the last snapshot returns the empty-profile state, which must stay visually
      distinct from `error.tsx`'s "the database is unreachable" (see CLAUDE.md, "The profile
      page")

Shipped alongside 10.7, not originally listed here:

- [x] **`deleteDeadRoomForUser` lives in `web/src/lib/data/deadRooms.ts`, beside the two reads**, so the
      file's HARD RULE — a `DeadRoom` is never reached except through the viewer's membership
      row — governs the write as well. `app/profile/actions.ts` is a thin auth + revalidate +
      redirect wrapper over it.
- [x] **`deleteMany`, not `delete`.** A row that isn't there is an ordinary "no" (`count === 0`),
      not an exception to catch and translate — and it is the same answer as "no such snapshot",
      so the action cannot be used to probe which ids exist.
- [x] **A failed delete returns a message instead of throwing.** A throw would land in
      `app/profile/error.tsx`, whose sentence is "Couldn't load your rooms" — copy about a
      failed *read*, shown for a failed *write*. The dialog renders it in place instead.
- [x] **`revalidatePath("/profile")` before `redirect("/profile")`.** `redirect` throws for
      control flow, so revalidation after it never runs and the listing would be served from
      the client router cache still showing the deleted row.
- [x] **A known and accepted race, recorded rather than engineered around.** Under Postgres'
      default read-committed isolation, two members deleting concurrently each still see the
      other's uncommitted row, so neither takes the "last member" branch and a zero-member
      `dead_rooms` row is orphaned. It is unfetchable and invisible; `Serializable` would trade
      that for a serialization failure shown to a user who already confirmed a delete.
- [x] **`web/src/components/ui/ConfirmDialog.tsx`** — the scrim, `role="dialog"`/`aria-modal`, Escape and
      the Tab focus trap generalised out of `IdentityDialog` rather than copied a second time,
      with `useId()` for `aria-labelledby` (IdentityDialog hardcodes the id, so two dialogs
      would have collided). Focus lands on **Cancel**: for an irreversible action the safe
      choice is the one a stray Enter hits. Escape is ignored while the request is in flight.
- [x] **`dangerButton` in `web/src/lib/ui.ts` and a `TrashIcon`** — the product's first destructive
      style, deliberately its only red button.
- [x] **The control is on the detail page, never on `DeadRoomCard`**, whose entire surface is
      one `<Link>`; a button nested in an anchor is invalid markup.
- [x] **End-to-end verification**: a real room was driven to death and deleted through the UI,
      then SQL confirmed **both** its `dead_rooms` and `dead_room_members` rows were gone. The
      shared case was then seeded directly — one snapshot, two members — and deleting it as one
      member left `roomStillThere: true`, `myMembershipGone: true`,
      `otherMembershipKept: true`, i.e. one member cannot erase another's copy. Plus: the
      confirmation dialog names the room, Escape cancels without deleting, a snapshot the
      viewer holds no membership for 404s, a malformed uuid 404s rather than 500ing, and the
      emptied profile shows the empty state rather than `error.tsx`.

### 10.8 Last-person-leaving warning

**How it works:** A `beforeunload` prompt shown only when you are the **last** connected peer,
because closing that tab starts the 10s grace window and then destroys the room permanently.
Everything a guest room contains is gone at that point, and even a signed-in room is only saved
if that user cleared the 60s + did-edit threshold — so the moment of loss is invisible today.

Awareness already knows the peer count, so this needs no new server state: register the handler
only while `readPeers()` reports exactly one peer, and remove it the instant a second arrives —
an always-on `beforeunload` is a prompt on every navigation, which is worse than the problem.

- [x] `beforeunload` handler registered only when the local user is the sole peer in the room
- [x] Removed again as soon as another peer joins, and on unmount
- [x] Pair it with the in-room persistence indicator: whether this room is on track to be saved
      is exactly what makes the warning actionable
- [x] Verified with two tabs: the second tab open means no prompt in either; closing it puts
      the prompt back on the remaining one

Shipped alongside 10.8, not originally listed here:

- [x] **The indicator is an estimate, and `web/src/lib/data/persistence.ts` says so at length.** The
      client cannot know the server's verdict: §6.1's threshold is evaluated against a token the
      *server* verified (an outage or a mismatched `CLERK_SECRET_KEY` leaves a healthy-looking
      socket and no membership at all), the server's connected time is refcounted across every
      socket of an account while a tab can only see itself, and whether the *room* is saved
      depends on other people whose sign-in status awareness deliberately never carries. So the
      chip speaks only about **you**, never about the room.
- [x] **The client's did-edit test is deliberately stricter than the server's.** It filters
      `doc.on("update")` on `transaction.origin === binding` — the client-side mirror of the
      server taking the WebSocket as the transaction origin. Without that filter the
      `DEFAULT_CODE` seed (a local transaction with a null origin) would mark every joiner as
      having edited within milliseconds of arriving, which is exactly the lurker §6.1 excludes.
      The server counts the seed; this does not. Erring that way is the point — the chip must
      never claim "saving" earlier than the server would.
- [x] **`MEMBER_MIN_CONNECTED_MS` is now the fifth hand-maintained cross-workspace
      duplication**, after `rateLimit.js`/`rateLimit.ts`, `CLOSE_ROOM_NOT_FOUND`,
      `rooms/state.js`'s `sanitizeName`/`HEX_COLOR`, and `TRUNCATION_MARKER`. It is worse than
      those in one way: the server's value is env-overridable, so the two can legitimately
      disagree at runtime with nothing to detect it. One more reason for the estimate framing.
- [x] **`peers.length === 0` is not "alone".** It is the pre-connect and torn-down state, before
      this client has published its own awareness — the same distinction `PresenceStack` draws
      with its `connected` prop. Being last is `syncStatus === "connected"`, one peer, and it
      being you.
- [x] **The countdown ticks only while it is on screen and stops the moment the threshold is
      met** — ~60 ticks per session, never a permanent once-a-second re-render of the room. It
      is primed with a `setTimeout(…, 0)` so someone who joins, reads for two minutes and only
      then types sees the right number immediately instead of a full 60s that jumps.
      React 19's `react-hooks/refs` and `react-hooks/purity` rules reject the shorter version of
      this (a `Date.now()` and a `ref.current` read during render), and are right to.
- [x] **The warning's actual sentence lives in the chip's tooltip**, because browsers ignore
      custom `beforeunload` text and show their own generic prompt.
- [x] **Two limitations recorded rather than papered over**: the prompt needs prior interaction
      with the page (sticky activation), so a tab nobody touched closes silently; and it fires
      on a **reload**, where the room in fact survives because the reconnect lands inside the
      10s grace window. Over-warning there is the accepted trade — the alternative is failing to
      warn on the case that actually destroys work.
- [x] **End-to-end verification** in a real browser. Guest: the chip reads "Guest · nothing is
      saved", the sole peer gets a `beforeunload` prompt, a second tab joining removes the
      last-peer warning from both and no prompt fires on close, and closing it puts the warning
      back on the survivor. Signed in: "Not saved yet" before editing → a live countdown after
      → "Saving to your profile" past the real 60s threshold — and then the room was allowed to
      die and **did** appear on `/profile`, i.e. the chip told the truth. (Note `dialog.dismiss()`
      *cancels* a `beforeunload` close, so a test that dismisses is measuring a tab it believes
      it closed; accept it.)

---

### Suggested order for section 10

Independent of each other except where noted, so this is by payoff, not dependency:

1. ~~**10.4 stdin**~~ — done
2. ~~**10.5 keyboard shortcuts**~~ — done
3. **10.2 chat** — designed already, no schema, no new connection
4. ~~**10.1 multi-file**~~ — done. It was indeed the most invasive, and it did give
   `dead_rooms.language` a value and `files` more than one entry. It needed **no** migration,
   because 7.2 shaped both columns for it in advance.
5. **10.6 room names** — small, but it needs a migration, and it is now the *only* remaining
   item that does
6. ~~**10.7 delete**~~ — done
7. ~~**10.8 leaving warning**~~ — done
8. **10.3 room passwords** — real, but narrow while room URLs are unguessable and short-lived

What is left of section 10: **10.2 chat, 10.3 room passwords, 10.6 room names.**
