# Accounts (Clerk)

Optional sign-in, how a Clerk token reaches the sync server, and every way that pairing fails silently.

*Split out of `CLAUDE.md` on 2026-07-31. Same rules apply: this is the **why** — measurements,
rejected alternatives, debugging history. The code carries the rule, this carries the rationale,
and a change that contradicts a paragraph here rewrites it rather than appending a correction.*

## Accounts (Clerk)

Signing in is **optional and additive**: every guest path from v1 works untouched. Since 7.3 an
account also buys persistence — a room you worked in is snapshotted to `dead_rooms` when it
dies (see "Dead-room snapshots"). Guests still store nothing at all.

**It is `proxy.ts`, not `middleware.ts`.** Next 16 renamed the convention
(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`: *"the
`middleware` file convention is deprecated and has been renamed to `proxy`"*). The contents
are identical, so every Clerk recipe written for Next ≤15 is right about the code and wrong
about the filename — and a `middleware.ts` here is simply never loaded, silently. Confirm it
is wired by looking for `ƒ Proxy (Middleware)` in `next build` output, or the `proxy.ts: Nms`
segment in a dev request log.

**`clerkMiddleware()` is called with no callback, and must stay that way.** It attaches the
session and protects nothing. `/`, `/room/*` and `/api/execute` are all public by design —
`/api/execute` especially, since adding `auth.protect()` there would break the Run button for
every guest. Route protection belongs in the resource (`await auth()` in the page), which is
also what replaced the now-deprecated `createRouteMatcher`.

**`clerkUserId` is client-only and must never enter awareness.** It rides inside `CollabUser`
to sessionStorage via `setActiveUser`, and stops there. The awareness payload in
`web/src/hooks/useCollabRoom.ts` lists its fields one by one and must never become `{...user}`: awareness is
peer-controlled, so a broadcast account ID is a claim anyone can forge, and 7.3 keys saved
room snapshots on an account. Sourcing that from awareness would let a passing guest write a
room's code into a stranger's profile — the same class of hole as the CSS-colour injection
`readPeers` guards, but the blast radius is another user's stored data.

**7.3 resolved this with `verifyToken` from `@clerk/backend` on the socket.** The client appends
`?token=` (built by `useClerkToken()` in `web/src/lib/collab/clerkIdentity.ts`), and `server/src/auth/clerk.js`
verifies it. `server/src/sync/connection.js` already discarded the query string
(`req.url.slice(1).split("?")[0]`), which is the same derivation `setupWSConnection` uses by
default, so the doc name was unaffected. Two rules hold that design up:

- **Verification never refuses the socket.** A bad, expired or missing token, an unset
  `CLERK_SECRET_KEY`, and a Clerk outage all mean the same thing: no membership recorded, room
  otherwise untouched. Gating the socket on Clerk would repeat, one layer down, the bug this
  section already documents — a deep-linked room that could not be joined at all. A missing
  token costs a profile entry; a missing socket costs the room.
- **Verification starts only after the room gate passes**, so a probe loop against dead room
  IDs cannot force a JWKS round trip per attempt. The WebSocket path is not covered by
  `POST /rooms`' rate limiter.

**Never log `req.url`.** Since 7.3 it carries a Clerk session token. Log `docName` instead, and
log verification failures as `err.reason ?? err.message` — never the input.

**A Clerk session token lives ~60s, and y-websocket freezes the URL at construction.**
`params` are serialised into `this.url` once, in the constructor, but `setupWS` re-reads
`provider.url` on every dial. So `useCollabRoom` rewrites `provider.url` with a fresh token on
`status === "disconnected"`; without that, every reconnect after the first minute carries a
dead token and that user's connected time silently stops accruing mid-session. The base is
taken from `provider.url.split("?")[0]` rather than rebuilt from `WS_URL`, so it agrees with
y-websocket's own construction (trailing-slash stripping included).

**Signing in prefills the identity dialog; it does not replace it.** The Clerk session is a
cookie (browser-wide) while `CollabUser` is sessionStorage (per-tab) — different scopes on
purpose. Deriving the collaborator from Clerk and skipping the prompt looks like the obvious
win and breaks two things: Clerk's `lastName` is nullable while `isValidUser` requires both
names, and two tabs would become one collaborator, which is exactly the local-multiplayer
test story the storage split exists to protect. Verified: two tabs signed into one account
still show as two people with two colours.

**The dialog must never wait on Clerk.** `useUser()` reports `isLoaded: false` first, and the
dialog reads its prefill in lazy `useState` initializers that run once — so the tempting fix
is to hold the dialog until Clerk resolves. Don't: verified by deep-linking into a room from
a fresh browser profile, where the prompt never rendered and **the room could not be joined
at all**. Instead the dialog renders immediately and a `key` remounts it once if a signed-in
session arrives late. A guest's key never changes, so the common path never remounts and
nothing typed is lost. `signedInUser()` in `web/src/lib/collab/clerkIdentity.ts` collapses "guest" and "not
loaded yet" into one `null` precisely so no caller can reintroduce that gate.

**Automated sign-in needs two things the UI does not tell you.** The dev instance has
Cloudflare Turnstile on **sign-up**, so a driven browser can never complete one — create the
user through Clerk's Backend API (`POST https://api.clerk.com/v1/users` with
`CLERK_SECRET_KEY`) instead, which bypasses it and marks the email verified. Then sign-*in*
from a fresh browser profile still stops at `signIn.status === "needs_client_trust"` ("You're
signing in from a new device"), which wants an emailed code — a `+clerk_test@example.com`
address accepts the fixed code `424242` and sends no mail. Clerk's OTP control is a row of
**unnamed** single-character inputs, so match it on `input[inputmode="numeric"]`, not a name.

**Clerk loads on `localhost` and silently does not on `127.0.0.1`.** They are the same server
but not the same origin, and the dev instance only allows the former. The failure has no error
banner: `window.Clerk` exists with `loaded: false` forever, `useClerkIdentity()` stays
`{ready: false}`, and the landing page simply renders without its Sign in / Sign up buttons —
which reads as a broken page rather than a hostname problem. Always drive the app at
`http://localhost:<port>`.

**Clerk session tokens can be minted server-side, which makes the sync server testable without
a browser at all.** `POST /v1/sessions` with `{user_id}` then
`POST /v1/sessions/{id}/tokens` yields a real JWT that `verifyToken` accepts. That is how 7.3's
membership rules were verified headlessly; the browser pass then only had to confirm the client
actually sends one.

**The identity dialog opens *before* the room exists.** "Create a new room" opens the dialog,
and `createRoom()` only runs when it is submitted, so the navigation to `/room/<id>` comes after
"Create & Enter" — not before. **Its inputs now carry an `id`** (added by the accessibility pass so
the validation hint can be referenced via `aria-describedby`), but the ids are `useId()`-generated
and therefore unstable — so `autocomplete="given-name"` / `"family-name"` remains the matcher to
use, and the committed helper additionally scopes to `role="dialog"`. That scoping is not
decoration: the landing page has its own "Join" button *behind the modal scrim*, so a text match
picks that one and the scrim then swallows every click until the test times out. And Monaco renders spaces as non-breaking
spaces, so assertions against editor text must normalise ` ` first.

**Monaco's AMD loader broke Clerk, and this is why `web/src/lib/editor/monacoLoader.ts` exists.**
`@monaco-editor/react` defaults to fetching Monaco from a CDN with an AMD loader, which
installs a global `define` carrying `define.amd`. Any UMD bundle loaded afterwards then
registers itself as an AMD module instead of executing — and Clerk's UI bundle is one, so it
failed with `failed_to_load_clerk_ui` and Clerk never finished loading **on the room route
only**. The symptom was a signed-in user deep-linking into a room silently having no session
and no `clerkUserId`. It is a race between two CDN fetches, so it reproduced intermittently;
the controlled experiment that pinned it was visiting a *dead* room ID, where `RoomGate` shows
the closed screen and never mounts Monaco — there Clerk resolved fine on the very same route.
The fix points the loader at the `monaco-editor` package (now a direct dependency), so no AMD
loader is ever installed and Monaco stops being a runtime CDN dependency too. `loader.config`
runs at module scope in `CodeEditor.tsx`, because it must happen before the first `<Editor>`
mounts.

**Clerk components are themed with `appearance.variables`, deliberately not `@clerk/ui`.**
The `dark` theme lives in a separate `@clerk/ui` package whose bundle Clerk fetches at
runtime — the very bundle the AMD conflict above breaks. The variables ship inside clerk-js
itself, need no second bundle, and reproduce the palette from `globals.css`. (Also worth
knowing: `Show` exported from `@clerk/nextjs` is an **async server component**, so it cannot
be used in the `"use client"` landing page — branch on `useClerkIdentity()` instead. And
`SignedIn`/`SignedOut` no longer exist in v7 at all.)

**`ClerkProvider` lives in `web/src/components/layout/AppProviders.tsx` (a Client Component), not in
`app/layout.tsx`, and `appearance.variables` must be literal hex strings.** Both halves of
that are forced by the light/dark theme. Clerk *parses* these colours at runtime to derive
its own shades and alpha variants (`@clerk/shared/dist/color.mjs` exports
`stringToHslaColor` / `hexStringToRgbaColor`), so a `var(--panel)` reference is not a
parseable colour and Clerk falls back to broken defaults — which means the values have to
change with the theme, which means only the client can supply them.

**Moving the provider client-side costs nothing here, and that is measured rather than
assumed.** `@clerk/nextjs`'s *server* `ClerkProvider`
(`dist/esm/app-router/server/ClerkProvider.js`) computes `initialState` **only when passed a
`dynamic` prop**, which this app has never done — so `initialState` was already `undefined`
and the server provider already delegated straight to `ClientClerkProvider`. There is no SSR
auth state to lose. Keyless mode is handled on the client path too
(`LazyCreateKeylessApplication`). `app/layout.tsx` stays a Server Component and just renders
`<AppProviders>`. Keep `CLERK_DARK`/`CLERK_LIGHT` in that file in step with `globals.css`.

