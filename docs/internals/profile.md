# The profile page and the persistence estimate

The only reader of `dead_rooms`, and the in-room chip that guesses whether your work will reach it.

*Split out of `CLAUDE.md` on 2026-07-31. Same rules apply: this is the **why** — measurements,
rejected alternatives, debugging history. The code carries the rule, this carries the rationale,
and a change that contradicts a paragraph here rewrites it rather than appending a correction.*

## The profile page (task 7.4)

`/profile` is the only reader of `dead_rooms`, and the only page in the app that is
protected. Everything under `app/profile/` is a Server Component except `SnapshotActions` and
`error.tsx`; the code view itself ships no JavaScript.

**A `DeadRoom` is never fetched by its id.** Both queries in `web/src/lib/data/deadRooms.ts` start from
`deadRoomMember` keyed on the *viewer's* Clerk user ID and reach the room through the relation,
so a snapshot the viewer holds no membership row for is not hidden by a filter someone
remembered to add — it is unfetchable. §6.1 puts one room on several profiles, so there is no
ownership column that could do this job instead. The detail lookup is `findUnique` on the
composite primary key `(user_id, dead_room_id)`, which makes the authorization check and the
index lookup the same query. Keep it that way: a `deadRoom.findUnique({where:{id}})` with a
membership check bolted on afterwards is one forgotten `if` away from serving a stranger's code.

**The URL carries `dead_rooms.id`, not `room_id`,** so the membership key and the path segment
are the same value. It also keeps a dead snapshot's URL from sharing an id with a live
`/room/<id>`. Because `id` is a Postgres `uuid`, a malformed segment does *not* come back as
"not found" — it reaches the driver and 500s on `invalid input syntax for type uuid`, so
`DEAD_ROOM_ID` rejects it before the query. And `notFound()` answers identically for "no such
row" and "not yours", or the URL becomes an oracle for which snapshots exist.

**There is no `loading.tsx` under `app/profile/`, and adding one breaks the 404.** A Suspense
boundary in the parent segment also wraps `[deadRoomId]`; once a response starts streaming its
status is already sent, and Next then serves the not-found UI under a **200**. The query is a
single indexed lookup, so a spinner is not worth a wrong status code.

**`error.tsx` exists because "the database is unreachable" is not "you have no rooms".** Neon
autosuspends an idle branch, so a cold start is a routine way to fail here, and an empty-looking
profile would be a lie the user cannot check — the same `missing` vs `unreachable` split
`RoomGate` draws for a room. It takes Next 16.2's **`unstable_retry`**, not `reset`: `reset`
was demoted to "clear the error and re-render the children *without re-fetching*", which is the
wrong half for a failed query. Both props are passed; only `unstable_retry` re-runs the server
render. Verified by starting a production build against a dead `DATABASE_URL`.

**No `export const dynamic = "force-dynamic"`, and none is needed.** Clerk's `auth()` reads
`headers()` internally, which opts the route into dynamic rendering on its own — `next build`
lists both profile routes as `ƒ`. Clerk also throws `ClerkUseCacheError` if `auth()` is called
inside a `use cache` scope, which is one more reason `cacheComponents` must stay off: enabling
it would also switch navigation to `<Activity>`-based state preservation, and the room route
depends on a real unmount to tear the Yjs stack down.

**Auth is checked in the page, never in `proxy.ts`.** `clerkMiddleware()` stays callback-free
so `/`, `/room/*` and `/api/execute` remain public, and Clerk's own `createRouteMatcher`
deprecation note says to "move auth checks into each page, layout, API route, or Server
Function that accesses protected data". A signed-out visitor gets an in-page gate with a
`SignInButton mode="modal"` rather than a redirect: this app has no `/sign-in` route, so
`auth.protect()` would eject them to Clerk's hosted Account Portal, and a bare `redirect("/")`
turns a shared `/profile` link into a silent bounce.

**The code view is a `<pre>`, and Monaco must not come back.** An editor is the one widget on
this site that means "you can type here", which is the opposite of what §7.4's last bullet
asks for; and `web/src/lib/editor/monacoLoader.ts`
imports `monaco-editor` at module scope, which is why that import must stay out of this
route's graph. **An earlier version of this paragraph said the regression test was `/profile`
answering 200 while `/room/<id>` answered 500. That contrast no longer exists** — the UI
redesign fixed the room route with a `dynamic(..., { ssr: false })` boundary in `RoomGate`, so
both now answer 200. The replacement check is
`curl -s localhost:3000/room/<id> | grep -c monaco`, which must be **0**; see the
`/room/[roomId]` gotcha above. Line numbers are one string in a `sticky left-0` `<pre>`, not
one element per line: a 256 KB snapshot is ~8000 lines, and 8000 gutter spans is 8000 DOM
nodes for numbers nobody selects.

**The listing does not select `files`.** A snapshot is up to 256 KB, so a hundred of them is
~25 MB pulled out of Neon to render metadata cards. That is also why the cards carry no code
preview — a preview needs `$queryRaw` with a `jsonb` substring, not a wider `select`. The list
is capped at 100 rows (`take: LIST_LIMIT + 1`, so the cap can be *detected*) and says so when
the cap bites.

**What the page has to render around, and these are real values, not placeholders.** There is
**no room name** — `dead_rooms` has no name column, so the original `room_id` is the title, until
§10.6. `is_private` is `false` on every row and is not rendered at all rather than shown as a
meaningless "public"; that becomes meaningful only when §10.3 lands. `participants` is written but
deliberately **unread**: nothing on `/profile` renders a peer name or colour today, and anything
that starts to must go through a sanitizing boundary like `readSnapshotFiles`, never straight
from the column.

**An earlier version of that paragraph also said `language` is null on every row and shows as
"not recorded". §10.1 made that false**: the language is now chosen at room creation and every
new row carries it, so the page renders a real one and shows a file count beside it. "Not
recorded" survives only for rows written before §10.1, which is the honest answer for them — no
migration can invent a language for a room whose peers each had their own.

**The multi-file snapshot needed no change to this page, and that was the point of 7.2's
schema.** `[deadRoomId]/page.tsx` already mapped over `room.files`, and `readSnapshotFiles`
already capped at 50 entries and sanitized every filename — so §10.1's rooms render by running
the same loop more than once. All that was added is a "Download all (`project.zip`)" button,
shown only when there is genuinely more than one file, since for one file it would wrap what the
existing per-file Download already hands over uncompressed.

**Dates are relative on purpose.** "Closed 3 hours ago" and "lasted 12 minutes" are pure
deltas, so the server and the browser agree; a locale- or timezone-formatted absolute date
rendered on the server is a hydration mismatch waiting to happen on a page that otherwise
needs no client JavaScript. The exact instant still travels, in `<time dateTime>` and `title`.

**Deleting is the same rule as reading, one layer down (task 10.7).**
`deleteDeadRoomForUser` lives in `deadRooms.ts` *beside* the two reads precisely so the HARD
RULE covers it: it starts from `deadRoomMember` on the composite key, so a snapshot the viewer
holds no membership row for is **undeletable**, not merely hidden. It deletes the viewer's
membership row and drops the `dead_rooms` row only when that was the last member — §6.1 puts one
room on several profiles with no owner, so deleting the room row directly erases somebody else's
copy. Use `deleteMany`, not `delete`: a missing row is an ordinary `count === 0`, which is also
the answer for "not yours", so the action cannot be used to probe which ids exist.

**A zero-member `dead_rooms` row can be orphaned, and that is accepted.** Under read-committed,
two members deleting concurrently each still see the other's uncommitted row, so neither takes
the last-member branch. The row is unfetchable (every read starts from `dead_room_members`) and
invisible. `Serializable` would replace it with a serialization failure shown to someone who has
already confirmed a delete — a worse trade at this scale.

**`app/profile/actions.ts` is the repo's only `"use server"` module.** It is a thin wrapper:
`await auth()` (a Server Function is a public POST endpoint, and `proxy.ts` deliberately protects
nothing), then the call, then `revalidatePath("/profile")` **before** `redirect("/profile")` —
`redirect` throws for control flow, so revalidation after it never runs and the listing would be
served from the router cache still showing the deleted row. A failure **returns a message rather
than throwing**: a throw lands in `error.tsx`, whose sentence is "Couldn't load your rooms" —
copy about a failed read, shown for a failed write.

**`ConfirmDialog` is the generalised `IdentityDialog` treatment, not a second copy of it.** Its
`aria-labelledby` comes from `useId()` because `IdentityDialog` hardcodes
`"identity-dialog-title"` and two dialogs would collide. Focus lands on **Cancel** — for an
irreversible action the safe choice is the one a stray Enter hits — and Escape is ignored while
the request is in flight, since the request is already gone and closing would hide the result.
The delete control belongs on the detail page and never on `DeadRoomCard`, whose whole surface is
one `<Link>`.

**`TRUNCATION_MARKER` is now the fourth hand-maintained duplication across the workspaces,**
after `rateLimit.js`/`rateLimit.ts`, `CLOSE_ROOM_NOT_FOUND`, and `rooms/state.js`'s copies of
`sanitizeName`/`HEX_COLOR`. `deadRooms.ts` matches it with `endsWith` — never `includes`, since
a user may have typed that sentence themselves — to show the amber "this room grew past the
256 KB cap" notice. The content is still rendered and copied **verbatim**, so what you see is
what you copy.

## The leaving warning and the persistence estimate (task 10.8)

Closing the last tab starts the 10s grace window and then destroys the room forever, so the sole
peer gets a `beforeunload` prompt and a chip that says whether anything survives.
`web/src/hooks/useRoomPersistence.ts` owns both; `web/src/lib/data/persistence.ts` holds the constant and the wording.

**The chip is an estimate and must keep promising less than the server guarantees.** The client
cannot know the verdict: §6.1's threshold is evaluated against a token the *server* verified (a
Clerk outage or a mismatched `CLERK_SECRET_KEY` leaves a perfectly healthy-looking socket and no
membership at all), the server's connected time is refcounted across every socket of an account
while a tab can only see itself, and whether the *room* is saved depends on other participants
whose sign-in status awareness deliberately never carries. **So the chip speaks only about you,
never about the room.** Do not "improve" it into a promise without adding a real server→client
channel — and note that writing user IDs into the shared doc to build one would leak them to
every peer, guests included.

**The local did-edit test filters on `origin instanceof MonacoBinding`, and that filter is
load-bearing.** It is the client mirror of the server taking the WebSocket as the transaction
origin. Without it the starter-file seed — a local transaction with a null origin — marks
every joiner as having edited within milliseconds of arriving, which is exactly the lurker §6.1
exists to exclude. Note this makes the client **stricter** than the server, which counts the
seed. That asymmetry is deliberate: the error must never fall on the side of claiming "saving"
earlier than the server would.

`instanceof`, not identity against one binding: since §10.1 a room has one binding per file and
typing in any of them is typing. The four file actions (create/rename/delete/set-entry) latch
`didEdit` explicitly at their call sites, because they are local transactions with a null origin
— indistinguishable from the seed to this filter, and different from it only in intent.

**`peers.length === 0` is not "alone".** It is the pre-connect and torn-down state, before this
client has published its own awareness — the same distinction `PresenceStack` draws with its
`connected` prop. Being last is `syncStatus === "connected"` **and** exactly one peer **and** it
being you. Getting this wrong registers a `beforeunload` on every room the moment it mounts.

**`MEMBER_MIN_CONNECTED_MS` is the fifth hand-maintained cross-workspace duplication**, after
`rateLimit.js`/`rateLimit.ts`, `CLOSE_ROOM_NOT_FOUND`, `rooms/state.js`'s `sanitizeName`/
`HEX_COLOR`, and `TRUNCATION_MARKER`. It is worse than those in one way: the server's value is
env-overridable, so the two can legitimately disagree at runtime with nothing to detect it.
(§10.1 added a **sixth**: `ROOM_LANGUAGES` plus the shared-document names and filename rules in
`server/src/rooms/state.js`, mirroring `web/src/lib/editor/languages.ts` and `web/src/lib/collab/roomFiles.ts`.)

**The countdown ticks only while it is on screen** and stops the moment the threshold is met —
~60 ticks per session, never a permanent per-second re-render of the room. It is primed with a
`setTimeout(…, 0)` so someone who joins, reads for two minutes and only then types sees the right
number immediately rather than a full 60s that jumps. React 19's `react-hooks/refs` and
`react-hooks/purity` rules reject the shorter version (a `Date.now()` and a `ref.current` read
during render) and are right to — that is a value which changes without a render.

**Two limitations, neither fixable here.** Browsers ignore custom `beforeunload` text and show
their own generic prompt, which is why the real sentence lives in the chip's `title`; and the
prompt needs prior interaction with the page (sticky activation), so a tab nobody touched closes
silently. It also fires on a **reload**, where the room in fact survives — the reconnect lands
inside the grace window. Over-warning there is the accepted trade.

**Testing note that cost a debugging pass:** Playwright's `dialog.dismiss()` on a `beforeunload`
**cancels the close**, so the page stays open and connected. A test that dismisses is then
measuring presence in a tab it believes it closed, and every later "am I alone" assertion is
wrong. Call `accept()`.

