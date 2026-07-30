# Learning from CollabCode

**A guided tour of a real-time collaborative code editor — how it works, why it is built this
way, and the twenty-one things that went wrong on the way there.**

---

## How to read this

This document assumes **nothing**. If you have never heard of a WebSocket, a CRDT, or a
sandboxed container, you are exactly the reader it was written for. Every concept is explained
in plain language before it is used, and every explanation is followed by the actual code it
describes.

It is organised as a ramp:

| Part | What it gives you | Who it is for |
| --- | --- | --- |
| **0** | What this app is, in 60 seconds | Everyone |
| **1** | The vocabulary — every concept, with analogies | Beginners. Skip if you know Yjs |
| **2** | The map — three services and why | Everyone |
| **3** | Six walkthroughs — one user action traced end to end | Everyone |
| **4** | The five big ideas that recur everywhere | Anyone designing something |
| **5** | **The mistakes.** 21 real bugs, each with the lesson | The heart of the document |
| **6** | How the whole thing is tested | Developers |
| **7** | What is *not* built, and why | Everyone |
| **8** | A study path, and exercises | Beginners |
| **9** | The one-page cheat sheet | Everyone |

**A note on honesty.** Every bug in Part 5 actually happened in this repository. None is
invented, none is a hypothetical, and none has been softened. Several of them were found only
because someone went looking with an adversarial mindset — which is itself one of the lessons.

**Where else to look.** `README.md` is the reference manual (what the features are, how to run
it). `CLAUDE.md` is the engineering notebook (every trap, at length). `docs/TESTING.md` is the
audit report (what was tested, what broke, the numbers). This file is the *teacher*. It
deliberately overlaps with all three, because a reference manual and a lesson are different
things even when they describe the same code.

---

# Part 0 — What this thing is, in 60 seconds

CollabCode is a website where **several people can type in the same code file at the same time**,
see each other's cursors, and **run the code** in a safe sandbox — with the output appearing on
everybody's screen at once.

Think Google Docs, but for code, with a Run button.

```
   Alice's browser              Bob's browser              Carol's browser
   ┌───────────────┐            ┌───────────────┐          ┌───────────────┐
   │ def hello():  │            │ def hello():  │          │ def hello():  │
   │   print("hi") │  ◄──────►  │   print("hi") │ ◄──────► │   print("hi") │
   │        ▲Bob   │            │        ▲Bob   │          │        ▲Bob   │
   └───────────────┘            └───────────────┘          └───────────────┘
           │                            │                          │
           └────────────┬───────────────┴──────────────────────────┘
                        ▼
              ┌────────────────────┐
              │  Sync server       │  keeps everyone's copy in agreement
              └────────────────────┘
```

Two things make it unusual, and both are deliberate choices rather than accidents:

**1. Rooms are temporary by default.** When the last person closes their tab, the room is
destroyed ten seconds later and the code is gone. There is no "my documents" list, no
auto-save, no database row. This was the founding constraint of version 1, and it removed an
enormous amount of complexity: no ownership, no permissions, no storage quotas, no
garbage collection.

**2. Version 2 relaxed that in exactly one place.** If you sign in with an account *and* stay in
a room for at least 60 seconds *and* actually type something, then when that room dies its final
files are written **once** to a database, read-only, forever. You can look at them later on a
`/profile` page. You cannot re-open the room, re-run the code, or edit it. It is a photograph,
not a save file.

Everything else — sync, cursors, running code, downloading a file — is unchanged for guests, who
still store nothing at all.

---

# Part 1 — The vocabulary

Skip this part if the words *WebSocket*, *CRDT*, *awareness*, and *sandbox* already mean
something to you. Otherwise, read it. The rest of the document leans on it constantly.

## 1.1 Why collaborative editing is hard

Here is the naive design that everyone invents first, and why it fails.

> "When Alice types a character, send the whole file to the server. The server stores it and
> sends it to Bob. Bob's editor replaces its contents."

Try it with two people typing at once:

```
t=0   Both have:  "hello"
t=1   Alice types "!" at the end   → sends "hello!"
t=1   Bob   types "?" at the end   → sends "hello?"
t=2   Server receives Alice's, stores "hello!", broadcasts it
t=3   Server receives Bob's,   stores "hello?", broadcasts it
t=4   Everyone has "hello?"      ← Alice's "!" is gone forever
```

This is called a **lost update**. The last writer wins and everybody else's work vanishes. Worse,
Alice watched her own character appear and then disappear, which feels like a haunted computer.

The next idea people have is to send *changes* instead of whole files — "insert `!` at position
5". That is better, but it has its own version of the problem:

```
Both have "hello" (5 characters, positions 0-4)

Alice: "insert '!' at position 5"     → her copy is "hello!"
Bob:   "delete position 0"            → his copy is "ello"

Now apply Bob's edit to Alice's copy:  "ello!"     ✓ fine
Now apply Alice's edit to Bob's copy:  "ello" has only 4 characters,
                                        position 5 does not exist    ✗
```

Positions shift. Every edit invalidates the coordinates of every other edit that was in flight at
the same moment. Solving this properly is a genuine computer-science problem with decades of
research behind it, and it has two families of answers: **Operational Transformation** (what
Google Docs uses, complex, needs a central server to order operations) and **CRDTs**.

## 1.2 CRDTs, explained without the maths

**CRDT** stands for *Conflict-free Replicated Data Type*. The name is unhelpful. Here is the
idea.

Instead of storing text as a string with numeric positions, a CRDT stores it as a **list of
characters, each with a permanent unique identity**. Positions are never used. A new character is
inserted "after the character with id `X`", not "at index 5".

```
Not this:                 But this:
  index:  0 1 2 3 4         id:   a1  b7  c2  d9  e4
  char:   h e l l o         char:  h   e   l   l   o
                                   ▲
                            "insert '!' after e4"
                            "delete b7"
```

Now Alice's edit ("insert after `e4`") and Bob's edit ("delete `b7`") are about *different, stable
things*. Neither invalidates the other. Apply them in either order and you get the same answer.
That property — **order doesn't matter, and applying the same change twice is harmless** — is the
whole trick. It means every participant can apply changes as they arrive, in whatever order the
network delivers them, and everybody still converges on the same document.

There is no "server decides the truth" step. The maths guarantees convergence.

**The cost** is that the document carries all this bookkeeping, and it grows even when text is
deleted (a deleted character leaves a tombstone so that a late-arriving "insert after it" still
knows where to go). CRDT documents are bigger than the text they represent. That is the trade.

**Yjs** is the CRDT library this project uses. It is a very good one: fast, small, and it has
ready-made bindings for popular editors.

> **The one CRDT behaviour that surprises people:** if two people type at the same position at
> the same moment, the characters *interleave*. Alice typing `AAAA` and Bob typing `BBBB` at the
> same spot can produce `ABABABAB`. This is correct CRDT behaviour, not a bug. It is listed as a
> known limitation in `docs/TESTING.md` §12 for exactly that reason — the honest thing is to
> document it, not to pretend it cannot happen.

## 1.3 WebSockets: why not just HTTP?

Normal web traffic is HTTP, and HTTP is a **question-and-answer** protocol. Your browser asks for
a page, the server answers, the connection closes. The server has no way to speak first.

That is useless for collaboration. If Bob types, the server needs to tell Alice *immediately*,
without Alice having asked.

A **WebSocket** is a connection that stays open in both directions. It starts life as a normal
HTTP request carrying a special "please upgrade this to a WebSocket" header, and if the server
agrees, the same TCP connection stops being HTTP and becomes a two-way message pipe.

```
HTTP:                              WebSocket:
  browser ──── "GET /page" ──►       browser ═══════════════════ server
  browser ◄─── "here it is" ───         ▲                          ▲
         (connection closes)            └── either side may speak ─┘
                                            at any time, for as long
                                            as the connection lives
```

In this project the sync server runs **both** on one port: it serves a handful of ordinary HTTP
routes (`GET /health`, `POST /rooms`, `GET /rooms/:id`) *and* accepts WebSocket upgrades on the
same listener. That is why there is only one URL to configure.

## 1.4 Two kinds of shared state: the document and "awareness"

Here is a distinction that is easy to miss and expensive to get wrong.

**The document** is the code. It must be durable: if you disconnect and reconnect, your changes
must still be there. It is merged, replayed, and preserved.

**Awareness** is where everyone's cursor is, what their name is, what colour they picked. It
must be *forgotten* the instant someone disconnects. Nobody wants a ghost cursor belonging to
someone who left an hour ago.

```
   ┌─────────────────────────── one WebSocket ────────────────────────────┐
   │                                                                       │
   │   Document updates ──────► durable, merged, survives reconnects       │
   │                            "Alice inserted '!' after character e4"    │
   │                                                                       │
   │   Awareness updates ─────► ephemeral, dropped on disconnect           │
   │                            "Alice's cursor is at line 3, she is blue" │
   │                                                                       │
   └───────────────────────────────────────────────────────────────────────┘
```

They travel over the same socket but they are **different protocols with different lifetimes**.
Merging them would be a disaster: cursor positions would enter the permanent document history,
so the file would grow forever just from people moving their mouse, and reconnecting would
resurrect everybody who ever visited.

This project's rule: *don't merge them.* It sounds obvious written down. It is much less obvious
when you are staring at two similar-looking event streams and thinking "these could share a
handler."

## 1.5 Sandboxed execution: running a stranger's code

A Run button means: *a person you have never met sends you a program, and you execute it on your
computer.* Stated that way, it is obviously terrifying.

What could that program do?

- Read your files (`open("/etc/passwd").read()`)
- Make network requests (exfiltrate anything it found)
- Never terminate (`while True: pass`) and eat 100% CPU forever
- Allocate memory until the machine dies
- Fork itself repeatedly until no process slots remain (a *fork bomb*)
- Fill the disk
- Print gigabytes of output and exhaust your network

A **sandbox** is an environment where the program runs but can do none of those things. This
project uses **Piston**, an open-source execution sandbox, running in a Docker container.
Piston enforces:

| Limit | What it stops |
| --- | --- |
| Wall-clock timeout (5s) | Infinite loops that sleep |
| CPU-time timeout (5s) | Infinite loops that spin |
| Memory ceiling (256 MB) | Allocation bombs |
| Process count (64) | Fork bombs |
| Open file limit (2048) | Descriptor leaks |
| Output size (64 KB) | Output floods |
| **No network at all** | Exfiltration, callbacks home |
| Throwaway unprivileged user, empty filesystem | Reading your files |

> **A verified detail worth knowing:** inside the sandbox,
> `socket.create_connection(...)` fails with `Errno 101 Network is unreachable`. That was
> actually tested, not assumed. Which is the right way to treat a security claim — see Part 4.4.

**Wall-clock and CPU time are separate ceilings, and both matter.** This bit people here:
`while True: pass` burns CPU as fast as it burns wall clock. Raising only the wall-clock limit
left programs dying at the *default* 3-second CPU limit. Measured: killed at 3.1 seconds despite
a 5-second wall-clock setting. Two knobs, both must move.

## 1.6 Ephemeral, and the one exception

The word "ephemeral" here means: **nothing is stored**. Rooms live in the sync server's memory.
When the room dies, that memory is freed and the code is gone.

There is deliberately **no** save-as-you-type, **no** document history, **no** database of live
rooms.

Why would anyone build it that way? Because it removes entire categories of work: no schema for
documents, no ownership model, no permissions, no storage limits, no cleanup jobs, no
"who can see my file" bugs, and — importantly — no legal exposure from storing strangers' code.

The v2 exception is narrow and worth stating precisely:

```
Room dies
    │
    ├── Was anybody in it signed in, connected 60+ seconds, AND did they type?
    │
    ├── No  ────►  nothing is written. Ever. (the common case)
    │
    └── Yes ────►  ONE row in `dead_rooms` with the final file contents,
                   plus one row per qualifying person in `dead_room_members`.
                   Written once. Never updated. Read-only forever.
```

## 1.7 The words this project uses

| Word | Means, here |
| --- | --- |
| **Room** | One shared document plus the people in it. Identified by a random id in the URL |
| **Peer** | Another person connected to the same room |
| **Provider** | The client-side object that owns the WebSocket and speaks the sync protocol |
| **Doc** (`Y.Doc`) | The CRDT document. Holds several *shared types* at once |
| **Shared type** | A named piece of the doc — `Y.Text` for code, `Y.Map` for metadata |
| **Binding** | The glue connecting a `Y.Text` to the Monaco editor so they mirror each other |
| **Awareness** | The ephemeral presence channel (cursors, names, colours) |
| **Snapshot** | The one-time database write when a room dies |
| **Monaco** | The code editor component. It is the editor from VS Code, extracted as a library |
| **Piston** | The execution sandbox |
| **Clerk** | The authentication provider (sign in / sign up) |
| **Prisma** | The tool that talks to Postgres from the web app |
| **Neon** | The hosted Postgres provider |

---

# Part 2 — The map

## 2.1 Three services, and why exactly three

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              YOUR BROWSER                                │
│   Next.js app: landing page, room screen (Monaco), /profile              │
└───────┬──────────────────────────┬───────────────────────────────────────┘
        │                          │
        │ WebSocket (sync)         │ HTTPS POST /api/execute
        │ + a few HTTP routes      │
        ▼                          ▼
┌────────────────────┐    ┌──────────────────────┐
│  SYNC SERVER       │    │  Next.js API route   │
│  (plain Node)      │    │  (part of the web    │
│                    │    │   app, server side)  │
│  • Yjs protocol    │    └───────────┬──────────┘
│  • room lifecycle  │                │ HTTP
│  • snapshot writer │                ▼
└─────────┬──────────┘    ┌──────────────────────┐
          │               │  PISTON SANDBOX      │
          │               │  (privileged Docker  │
          │               │   container)         │
          │               └──────────────────────┘
          │
          ▼
   ┌──────────────┐
   │  POSTGRES    │  ◄──── also read by the web app for /profile
   │  (Neon)      │
   └──────────────┘
```

**Why is the sync server separate from the web app?** Because Next.js is built around
request/response. A WebSocket that stays open for an hour does not fit its serverless deployment
model at all — on Vercel there is no long-lived process to hold the connection.

**Why is execution separate from sync?** This is the most important architectural decision in the
project, so it gets its own section.

## 2.2 Why execution never touches the sync server

The original design sketch — in a feature checklist that has since been deleted, but survives in
git history — drew this:

```
   browser ──► sync server ──► Piston ──► sync server broadcasts result
```

That is **not what was built**, and the checklist was corrected rather than followed.

Consider what the sync server does: it holds every live room's document in memory and forwards
edits between people with millisecond latency. It is a single Node.js process, which means it has
**one event loop**. Everything it does happens in turn, on one thread.

Now consider what an execution request is: an untrusted program, run in a container, that may
take up to 18 seconds to answer, and which the requester might abandon halfway through.

Putting the second thing on the same process as the first means a slow or crashed execution
degrades **live editing for every room on the server**. One person compiling a large Java file
would make everyone else's cursors stutter.

So the two are separate systems by design:

| | Editing sync | Code execution |
| --- | --- | --- |
| Latency | Must be milliseconds | Seconds is fine |
| Frequency | Constant | Bursty |
| Input | Trusted-ish (peers) | Fully untrusted |
| Failure impact | Room-wide | One run |
| Runs on | Sync server | Next.js route → Piston |

**But the result still reaches everybody.** The trick is that the *result* is written into the
shared Yjs document — a `Y.Map` called `execution` living on the same `Y.Doc` as the code. Yjs
merges the whole document, so the result syncs to every peer, including people who join later,
**with zero changes to the server**.

That is worth pausing on. A feature that sounds like it needs a new server message ("broadcast
this run result") needed **no server code at all**, because the sync layer already had a general
mechanism for "everyone agrees on this data". The same trick was later reused twice more: the
file list and the entry-file pointer both ride the same document.

> **General lesson.** When you already have a mechanism that synchronises arbitrary state, the
> answer to "how do I broadcast X" is usually "put X in the state you already synchronise",
> not "add a message type."

## 2.3 What lives on the shared document

```
Y.Doc  (one per room)
 │
 ├── Y.Map  "files"      fileId → { name, createdAt }
 │
 ├── Y.Map  "roomMeta"   "entry" → fileId      (which file Run executes)
 │
 ├── Y.Text "file:main"  the code of one file      ┐
 ├── Y.Text "file:a3f9"  the code of another       ├─ one Y.Text per file
 ├── Y.Text "file:..."                             ┘
 │
 └── Y.Map  "execution"  "state" → the whole run record
```

Note two design decisions embedded in that picture:

**One `Y.Text` per file, on one document — not one document per file.** The checklist originally
said "each file = its own Yjs sub-document." That turned out to be impossible without rewriting
the server: the library that handles the WebSocket syncs exactly one document per connection and
has no support for child documents. Real sub-documents would have needed one WebSocket per open
file, a separate authentication path for each, and child-document handling throughout the
lifecycle code. A `Y.Text` per file on the *same* document gets identical behaviour for free.

**The `execution` map has exactly one key**, `"state"`, whose value is the *entire* run record.
Never separate fields. That way, when two people click Run at the same instant, Yjs resolves the
conflict between two complete records — you can never end up with the status from one run and the
output from another.

## 2.4 Repository layout

There are two independent npm workspaces and **no root `package.json`**. That is deliberate: it
means you install and test each half separately, and CI is two jobs rather than one tangled one.

| Path | What it is |
| --- | --- |
| `web/` | The Next.js frontend, plus the `/api/execute` proxy and the `/profile` pages |
| `server/` | The standalone Node WebSocket sync server |
| `docker-compose.yml` | The Piston sandbox — at the **repo root**, because it is a third service |
| `docs/` | The v2 checklist, the audit report, and this file |
| `web/tests/`, `server/tests/`, `web/e2e/` | Three test locations, one per workspace plus e2e |

Inside `web/src/` there are five structural rules, each closing a specific failure the old flat
layout had:

1. **`app/` holds routes and nothing else.** Anything importable lives in `components/`,
   `hooks/`, `lib/`, or `styles/`. A shared module under `app/` is indistinguishable from a page.
2. **Cross-folder imports use `@/`; same-folder imports stay relative.** Before this rule, all 158
   internal imports were relative and 14 climbed two directory levels — so moving any file was a
   rename storm.
3. **The folder carries the domain, the file carries the role.** `rooms/lifecycle.js`, not
   `rooms/rooms.js`. `lib/sandbox/execution.ts`, not `lib/execution/execution.ts`.
4. **`proxy.ts` must sit level with `app/`,** inside `src/`. Next resolves it at the project root
   or inside `src/` — never inside `src/app/`. Put it in the wrong place and it silently never
   runs.
5. **Tests live inside the workspace they test.**

> **General lesson.** Every one of those five is a rule you would consider bureaucratic *until*
> you have lived through what it prevents. Rule 2 exists because of one painful refactor. Rule 4
> exists because a misplaced file fails *silently*, which is the worst kind of failure.

---

# Part 3 — Six walkthroughs

The fastest way to understand a codebase is to follow one user action all the way through. Here
are six.

## 3.1 Creating a room

You land on the home page, pick a language, click "Create a new room."

```
1. Click "Create a new room"
       ↓
2. The identity dialog opens — your name and a colour.
   (Note: the room does NOT exist yet)
       ↓
3. You submit the dialog
       ↓
4. Browser: POST http://sync-server/rooms?language=python
       ↓
5. Sync server: rate-limit check (10/min per IP), then mint a random id,
   record a *reservation* that expires in 5 minutes if nobody connects
       ↓
6. Response: { roomId: "k3n8x2..." }
       ↓
7. Browser navigates to /room/k3n8x2...
       ↓
8. RoomGate checks the room exists, THEN mounts the editor,
   which opens the WebSocket
```

Three things in that sequence are load-bearing:

**Step 5: the server mints the id, not the browser.** This is the entire basis of "this room ID
doesn't exist." If browsers invented their own ids, then any id would work and connecting to a
dead room would silently recreate it, empty. Because the server issues ids, an id nobody was ever
given is refused at connect time.

**Step 4 sends no body, and the language is a query parameter.** That looks like a stylistic
choice. It is not. A request with a JSON body needs a `Content-Type: application/json` header,
which makes it a "non-simple" cross-origin request, which means the browser sends a *preflight*
`OPTIONS` request first and waits for the answer. That is an extra network round trip before
every single room creation. A query parameter avoids it entirely.

**Step 8: the gate runs before the editor mounts.** Mounting the editor is what opens the
WebSocket, and opening a WebSocket to an unknown room is exactly what the gate exists to
prevent. If the gate rendered the editor while it was still checking, the check would be
pointless.

## 3.2 Joining and typing

```
Browser                                     Sync server
   │                                             │
   │── WebSocket upgrade: /k3n8x2?token=eyJ... ─►│
   │                                             │ Does this room exist?
   │                                             │   No  → close(4404) "room not found"
   │                                             │   Yes → continue
   │                                             │
   │                                             │ Is there a ?token=
   │                                             │   Yes → verify with Clerk (async,
   │                                             │          never blocks, never refuses)
   │                                             │
   │◄──────── sync step 1: "here is my state" ───│
   │───────── sync step 2: "here is the diff" ──►│
   │                                             │
   │  provider fires "sync"                      │
   │       ↓                                     │
   │  Is the files map empty?                    │
   │    Yes → create the starter file            │
   │    No  → do nothing                         │
   │                                             │
   │── awareness: "I am Alice, blue, line 1" ───►│──► broadcast to peers
   │                                             │
   │  ... typing ...                             │
   │── doc update: insert 'x' after id e4 ──────►│──► broadcast to peers
```

**The starter file is seeded only after `sync` fires, and only if the file map is empty.** This
is one of those rules where the reasoning is not obvious but the consequence is severe. If you
seed *before* sync, you insert the boilerplate into a still-empty local document — and then the
CRDT dutifully merges your boilerplate into the room's real document, so everyone gets a second
copy of `print("Hello, World!")` pasted into whatever they were writing.

**The token never gates the socket.** A bad token, an expired token, no token at all, a Clerk
outage, a missing secret key — all mean the same thing: *no membership is recorded, the room is
otherwise untouched.* The reasoning is a cost comparison: a missing token costs you a profile
entry; a refused socket costs you the room.

> **General lesson.** When an optional feature fails, it must fail *optionally*. Wiring an
> add-on into the critical path — even accidentally, by putting its check before the main
> path — converts "the nice-to-have is broken" into "the product is down."

## 3.3 Clicking Run

```
Alice clicks Run
   │
   ├─ Read the ENTRY file out of the shared doc (not the tab you're looking at)
   ├─ Check the payload size (code + stdin ≤ 64 KB)
   ├─ Write {status:"running", runId, startedBy: Alice, ...} to the execution map
   │        └──► syncs to Bob and Carol. Their Run buttons go disabled too.
   │
   ├─ POST /api/execute  { language, code, stdin }
   │        │
   │        ├─ rate limit (10/min/IP)
   │        ├─ content-length pre-check (cheap, loose)
   │        ├─ exact byte check on decoded code + stdin (strict)
   │        ├─ language must be in the allowlist
   │        └─ POST to Piston with all six limits attached
   │                 │
   │                 └─ Piston runs it in an isolated container
   │
   ├─ Response comes back
   ├─ Is executionMap.get("state").runId still MY runId?
   │        No  → discard silently. Somebody else's run won.
   │        Yes → write {status:"success", result, ...}
   │                 └──► syncs to Bob and Carol, output appears for all
```

Three separate protections are visible in that flow, and they solve three different problems.

**The room-wide lock.** While the shared status is `"running"`, everyone's Run button is
disabled. That stops most double-runs.

**The `runId`.** It stops the double-run the lock *cannot* catch: Alice and Bob both click before
either has received the other's write over the network. Both writes converge on one winner
(normal CRDT behaviour). The loser's Piston response then arrives and must recognise that it is
stale and throw itself away. Without this, the loser's result would overwrite the winner's, and
the caption would say "Run by Bob" over Alice's output.

**The stale-run watchdog.** Suppose Alice clicks Run and then closes her tab. The browser cancels
her fetch. Nothing ever writes a final result. The shared status is stuck at `"running"` — and
because everyone's Run button is disabled while it is, **the room is permanently bricked.** No
one can ever run anything again, and reloading does not help, because the stuck record is in the
shared document.

The fix is a small timer that every connected client runs. If the current `"running"` record is
older than 25 seconds, write an error record. There is no "owner" of an abandoned run once it is
shared state, so whichever client's timer fires first heals it for everybody, and the others are
harmless no-ops.

### The three nested timeouts

This is a small design worth studying because the *ordering* is the entire point.

```
  ┌─────────────────────────────────────────────────────── 25s ──┐
  │  STALE_RUN_MS — the client decides the runner is gone         │
  │  ┌──────────────────────────────────────────── 18s ──┐        │
  │  │  PISTON_TIMEOUT_MS — the fetch gives up on Piston  │        │
  │  │  ┌────────────────────────────────── 10s + 5s ──┐  │        │
  │  │  │  Piston stops the PROGRAM                    │  │        │
  │  │  │  (10s compile + 5s run, worst case)          │  │        │
  │  │  └──────────────────────────────────────────────┘  │        │
  │  └────────────────────────────────────────────────────┘        │
  └───────────────────────────────────────────────────────────────┘
```

Each layer must sit **above** the layer it contains. Get it wrong in either direction and you
produce a confidently incorrect error message:

- Set the fetch abort to 15s, and a legitimate 10-second compile plus 5-second run reports
  "Execution timed out" — blaming Piston for finishing on time.
- Set the watchdog below the fetch abort, and a merely-slow run gets reported room-wide as a lost
  connection — blaming the network for a slow compiler.

> **General lesson.** Nested timeouts are a common source of "impossible" bug reports. If you
> have more than one, write them down in order, and re-check all of them whenever you change one.

## 3.4 Clicking Save

Save is the mirror image of Run: **entirely local**. It builds a `Blob`, creates a throwaway
`<a download>` element, clicks it, and revokes the object URL. No Yjs write, no server request,
nothing stored anywhere.

With more than one file, it loads a zip library and produces `project.zip` — and it loads that
library through a **dynamic import**, so ~100 KB of zip code never enters the initial page bundle
for the majority of rooms that only have one file.

One subtlety: **Save reads the shared document, not the editor.** A file you have never opened in
this tab has no Monaco model at all — the component only ever holds the *active* file's text. So
saving walks the file map and reads each `Y.Text` directly.

## 3.5 The last person leaving

```
Alice is alone in the room and closes her tab
   │
   ├─ beforeunload fires → browser shows its own "leave site?" prompt
   │
   ├─ Socket closes. Room has 0 connections.
   │
   ├─ A 10-second grace timer starts   ← a refresh lands inside this window
   │                                      and the room survives
   │
   ├─ Timer fires. Re-check: still 0 connections?
   │     Yes → destroy
   │     No  → cancel, someone came back
   │
   └─ destroyRoom():
        ├─ docs.delete(roomId)     ← SYNCHRONOUS, and first
        ├─ build the snapshot      ← wrapped in try/catch
        ├─ hand it to the queue    ← which decides *when* to write
        ├─ doc.destroy()
        └─ deleteRoomState()
```

The ordering in `destroyRoom` is not arbitrary. `docs.delete()` runs **first and synchronously**,
and nothing may be `await`ed before it. Here is why:

If there were an `await` before the delete, there would be a window in which the room still
answers "yes, I exist" — so a client could reconnect into a room whose snapshot is already
committed. Now you have a live room whose id has been burned by the database's `UNIQUE`
constraint, which means when that room *really* dies, its real snapshot is silently swallowed by
`ON CONFLICT DO NOTHING`. People keep working, and their work is discarded on write.

That same synchronous delete is also what makes the function safe to call twice — which matters,
because the eviction timer and the shutdown flush can race each other.

**And destruction is unconditional; snapshotting is best-effort.** The snapshot build is wrapped
in `try/catch` and the destruction sits in a `finally`. The reason is brutal: an uncaught throw
inside a `setTimeout` callback is an uncaught exception, which kills the Node process, which
takes **every other live room on the server** with it. One malformed room must not be able to end
everyone else's session.

## 3.6 Visiting /profile

```
GET /profile
   │
   ├─ await auth()   ← Clerk. Signed out? Render an in-page sign-in gate,
   │                    NOT a redirect (this app has no /sign-in route)
   │
   ├─ Query: start from dead_room_members WHERE user_id = <viewer>
   │         and reach dead_rooms through the relation
   │
   ├─ Do NOT select the `files` column (each snapshot is up to 256 KB;
   │  a hundred of them is 25 MB pulled out of the database to render cards)
   │
   └─ Render the cards
```

**The authorization model here is the part worth copying.** Every query — the listing, the detail
page, *and the delete* — starts from the membership table keyed on the viewer's own user id, and
reaches the snapshot through the relation. It never fetches a snapshot by its id and then checks
whether you are allowed to see it.

The difference matters enormously:

```
  Fetch-then-check (fragile):        Fetch-through-membership (safe):

    room = findUnique({ id })          member = findUnique({
    if (!isMember(user, room))            user_id, dead_room_id })
       return notFound()               ← a snapshot you hold no
    render(room)                          membership row for is
       ↑                                  UNFETCHABLE, not hidden
    one forgotten `if` away from
    serving a stranger's code
```

The second version makes the authorization check and the database index lookup **the same
query**. There is no separate check to forget.

> **General lesson.** Prefer designs where the wrong thing is *unreachable* over designs where
> the wrong thing is *filtered out*. A filter is code someone can delete; unreachability is
> structural.

---

# Part 4 — The five big ideas

These recur throughout the codebase. If you take nothing else from this document, take these.

## 4.1 Trust boundaries: anything a peer writes is hostile input

Here is the mental shift that took the longest to internalise on this project.

When Alice fills in the name dialog, the app sanitizes her name. It is tempting to conclude: *the
name is now safe.*

It is not. Because a peer does not have to use your form. Anyone can connect to the room with a
raw Yjs client — the protocol is open, the library is on npm — and write whatever they like into
the shared document. Your form is a **suggestion to friendly users**, not a boundary.

So the rule is:

> **Nothing may read a peer-written shared type directly.** Every one of them has exactly one
> sanitizing function, and everything else reads its output.

There are three shared types written by peers, and therefore three boundaries:

| Shared type | Boundary function | Lives in |
| --- | --- | --- |
| awareness (names, colours) | `readPeers()` | `lib/collab/awareness.ts` |
| the `files` map (filenames) | `readRoomFiles()` | `lib/collab/roomFiles.ts` |
| the `execution` map (run records) | `readExecutionState()` | `lib/sandbox/executionState.ts` |

**What happens without one — a real, verified exploit.** Before the colour check existed, a peer
could set their awareness colour to:

```
red } body { display: none } .x {
```

That colour is interpolated into a `<style>` block for the remote-cursor CSS. The result is a
valid stylesheet that makes **every other participant's entire page vanish**. Verified
exploitable before the guard was added. The guard is one regular expression:

```ts
const HEX_COLOR = /^#[0-9a-f]{6}$/i;   // anything else → fall back to grey
```

**Here is the part that makes this a lesson rather than a fact.** An earlier version of this
project's documentation said `readPeers` was *the* single point where peer data is narrowed. That
was true when it was written. Then the `execution` map was added, and it was **the one
peer-supplied shared type with no boundary at all** — and nobody noticed, because the
documentation still confidently described a rule the code no longer followed.

The consequence, found in the audit: any participant could write `{status: "success"}` into the
map with no `startedBy` field. Every *other* participant's output panel would then try to read
`state.startedBy.color`, throw during render, and unwind to the error page. Reloading did not
help — the poisoned record is in the shared document, so you reload straight back into it. **A
one-write, room-wide, permanent denial of service.**

There were three variants of it, and the third is the nastiest: write
`{status: "running"}` with no `startedAt`. Then the watchdog computes
`Date.now() - undefined`, which is `NaN`, and `NaN > 25000` is `false` — so the watchdog
**never fires**, and Run is disabled for the whole room forever.

The fix was to add the third boundary. And the evidence that it was put in the right place is
that the output panel needed **no changes at all** — it was already written assuming its input
was valid, which is exactly what a component downstream of a boundary should assume.

> **General lesson, in three parts.**
> 1. Sanitize at the boundary where data *enters your trust zone*, not where it enters your form.
> 2. When you add a new channel for untrusted data, ask explicitly which boundary covers it. A
>    fourth shared type needs a fourth boundary — that is the pattern, not an exception.
> 3. **A documented rule that the code has quietly outgrown is worse than no rule**, because it
>    stops people looking.

## 4.2 Failing safe, and knowing which direction "safe" is

"Fail safe" is easy to say and surprisingly hard to apply, because *safe* points in different
directions in different places. This project has both directions, deliberately:

**Fail closed** — room creation. If the sync server is unreachable, the landing page refuses to
create a room. It does not drop you into a room that can never sync. A visible failure beats an
invisible one.

**Fail open** — token verification. If Clerk is down, the socket connects anyway with no
membership recorded. Gating the socket on Clerk would mean a Clerk outage takes down the entire
guest product, which has nothing to do with Clerk.

The way to tell which you need is to write out both failure modes and compare their costs:

```
Token verification:
  Fail closed → Clerk hiccup = nobody can join any room       (catastrophic)
  Fail open   → Clerk hiccup = you don't get a profile entry  (annoying)
                                                     → fail open

Room creation:
  Fail closed → server down = "couldn't create a room"        (clear)
  Fail open   → server down = you're in a room that will
                never sync, and you find out after typing
                for ten minutes                               (cruel)
                                                     → fail closed
```

**A related distinction the project draws carefully:** *missing* and *unreachable* are separate
states and must stay separate. A room that does not exist sends you home. A sync server that
cannot be reached gets its own screen with a Retry button, because the room may be perfectly
alive and merely unverifiable right now. Collapsing them would tell people their work was gone
every time their wifi hiccuped.

The same distinction appears on `/profile`: "the database is unreachable" has its own error page,
because an empty-looking profile would be a lie the user has no way to check.

## 4.3 Estimates must promise less than guarantees

There is a small chip in the room UI that tells you whether your work will be saved. Studying why
it is worded so carefully is genuinely instructive.

The rule for saving is: signed in, connected 60 seconds, and you typed. The browser can check all
three of those, roughly. So why not just say "this room will be saved"?

Because the browser **cannot actually know**:

- The 60-second timer is counted by the *server*, refcounted across every tab of your account.
  Your tab can only see itself.
- "Signed in" means *the server verified your token*. A Clerk outage or a mismatched secret key
  leaves a perfectly healthy-looking socket and no membership at all.
- Whether the *room* gets saved depends on other participants' sign-in status, which the presence
  channel deliberately never carries.

So the chip says only what it can actually support, and it speaks **only about you, never about
the room.**

And the client's did-you-type check is deliberately **stricter** than the server's. The server
counts the starter-file seed as an edit; the client does not. That asymmetry is on purpose: the
error must never fall on the side of claiming "saving" earlier than the server would.

> **General lesson.** When you cannot verify something, say less, not more. An estimate that
> over-promises is worse than no estimate, because the user acts on it.

## 4.4 Verify, don't assume — especially about libraries

A recurring pattern in this project's history: something behaves oddly, someone reads the
library's *source code*, and the answer is right there — and it contradicts what everyone
assumed.

Examples you will meet in Part 5:

- `y-websocket` never deletes rooms from its registry, despite appearing to.
- `ws` throws the process down when a WebSocket errors with no listener attached.
- `MonacoBinding.destroy()` does not dispose one of the listeners it created.
- `@monaco-editor/react` fetches Monaco from a CDN with an AMD loader by default, which breaks
  unrelated libraries loaded afterwards.
- `pool.query("BEGIN")` on a connection pool does not start a transaction.
- Prisma's `@default(uuid())` generates nothing in the database.

None of those is documented prominently. All of them are obvious from three minutes of reading
`node_modules`.

> **General lesson.** `node_modules` is not a black box. It is source code, it is on your disk,
> and reading it is often faster than searching for someone else who hit the same thing. When a
> library's behaviour surprises you, the fastest path to the truth is usually the shortest one.

## 4.5 Deliberate duplication, honestly labelled

The two workspaces share no code — no shared package, no build step joining them. That means a
whole list of things exist **twice, by hand**:

1. The rate limiter
2. The "room not found" WebSocket close code
3. Name sanitizing and the colour regex
4. The truncation marker
5. The minimum-connected-time constant
6. The language allowlist and filename rules
7. The Piston limits (in `docker-compose.yml` and in the route)
8. The database column list (hand-written SQL vs. the Prisma schema)
9. The hostile-input test fixtures

That sounds like a smell. It was a considered choice: making a shared package for a handful of
constants would have added a build step, a versioning story, and a publish step to a small
project, to solve a problem that a comment can describe.

**But the honest version of that choice includes admitting what it costs.** Each duplication
carries a `// keep in sync with <path>` comment — and for a long time, that was *all* it carried.
The documentation said plainly, of the most dangerous two, that "nothing in the build compares
the two."

The audit's answer was not to remove the duplication. It was to add a **drift test tier**: 31
assertions that compare the two copies' *behaviour*, since neither side exports what is being
compared. For example:

- Feed one deterministic sequence of keys and timestamps through both rate limiters and assert
  the verdict streams are identical arrays.
- Run the same hostile-filename corpus through both sanitizers, row by row.
- Check that each of `docker-compose.yml`'s six Piston ceilings is greater than or equal to the
  corresponding per-request limit in the route.
- Check that the hand-written `INSERT`'s column list is set-equal to the Prisma schema's.

> **General lesson.** Duplication is sometimes right. What is never right is duplication that
> nothing checks. If you are going to copy something, copy it *and* write the test that fails
> when the copies diverge.

---

# Part 5 — The mistakes

This is the part to read twice.

Twenty-one defects were found in a formal audit of this repository. Four of them could kill the
sync server or silently destroy user data. Eighteen were fixed; three were documented and
deliberately accepted with the argument recorded.

Beyond those twenty-one, there is a longer list of bugs found *during development* — the ones
that cost a debugging session and got written into the notebook. Both kinds are here.

Each entry follows the same shape: **the symptom**, **what we believed**, **what was actually
true**, **the fix**, and **the transferable lesson**.

---

## Theme A — The library did not do what you assumed

### A1. The library that "cleans up rooms" does not clean up rooms

**Symptom:** memory grew forever. A room everyone had left still held its full contents.

**Believed:** the WebSocket helper library deletes a document when the last connection closes.
It certainly looks like it does — there is a `docs.delete(doc.name)` right there in the close
handler.

**Actually true:** that line sits inside an `if`:

```js
if (doc.conns.size === 0 && persistence !== null) {
  docs.delete(doc.name)
}
```

This project deliberately never sets up persistence, so `persistence` is `null`, so the branch
never runs. The registry only ever grows.

**Fix:** own the deletion yourself. `scheduleEviction()` in `rooms/lifecycle.js` deletes it —
and crucially, it **re-checks `conns.size === 0` when the timer fires**, rather than trusting the
cancel path. Someone reconnecting inside the 10-second grace window must not lose their document
to a timer that was already queued.

**Lesson:** *read the condition, not just the statement.* A cleanup call guarded by a config flag
you never set is a cleanup call that never happens. And when you schedule work for later, re-check
your preconditions when it runs — the world changed while you were waiting.

---

### A2. An error event with no listener kills your entire process

**Severity 1.** This one could be triggered by anyone, with no room id, from anywhere on the
internet.

**Symptom:** the sync server died. Reproduced with a single malformed WebSocket frame:

```
UNCAUGHT (this is the crash): Invalid WebSocket frame: invalid opcode 3
```

**Believed:** the WebSocket setup helper registers the handlers a connection needs.

**Actually true:** it registers `'message'`, `'close'`, and `'pong'`. It does **not** register
`'error'`. And in Node's EventEmitter, an `'error'` event with no listener does not get ignored —
**it throws**. The `ws` library emits `'error'` on the socket for every protocol fault.

So: any malformed frame → unhandled `'error'` → uncaught exception → process exit.

**And here is the sharp edge.** `ws` defaults its maximum frame size to 100 MiB. Capping that is
the obvious hardening — you do not want a stranger sending you a 100 MB frame. But **a frame over
the cap raises the same unhandled `'error'`.** So adding the cap *without first adding the
listener* would have converted a memory-pressure problem into a **one-frame remote kill switch**.

They had to land in the same commit, and the code says so.

**Fix:** register `ws.on("error")` before any early return — so it also covers sockets that are
about to be refused — and only then set `maxPayload`.

**Lesson, two-part:**
1. In Node, `'error'` is a special event name. An emitter with no `'error'` listener will throw
   the process down. Every long-lived emitter you create or receive needs one.
2. **A hardening change can make things worse if it lands alone.** Before adding a limit, ask
   what happens when the limit is *hit*. If the answer routes through an unhandled path, you have
   built a trigger, not a guard.

---

### A3. Monaco's default loader silently broke authentication

This is the most interesting bug in the project, because the two systems involved have nothing to
do with each other.

**Symptom:** a signed-in user who opened a room link directly had no session. `window.Clerk`
existed but never finished loading. It happened **only on the room route**, and only sometimes.

**Believed:** the editor and the auth provider are independent.

**Actually true:** the React wrapper for Monaco defaults to fetching the editor from a CDN using
an **AMD loader**. Loading that loader installs a global `define` function carrying `define.amd`.

Now, any UMD bundle loaded *afterwards* checks for exactly that: "is there an AMD loader here? If
so, register myself as an AMD module instead of executing." Clerk's UI bundle is a UMD bundle. So
Clerk registered itself as an AMD module that nobody ever asked for, never executed, and failed
with `failed_to_load_clerk_ui`.

It was a **race between two CDN fetches**, which is why it reproduced intermittently.

**How it was pinned down:** by finding a case where the same route *worked*. Visiting a
**dead** room id shows the closed-room screen and never mounts Monaco — and there, on the very
same route, Clerk resolved perfectly. That contrast turned a flaky mystery into a one-line
hypothesis.

**Fix:** point the loader at the npm `monaco-editor` package instead of the CDN, so no AMD loader
is ever installed. As a bonus, Monaco stops being a runtime CDN dependency.

**Lesson, three-part:**
1. **Globals are a shared namespace, and libraries fight over them.** Two well-behaved libraries
   can be mutually incompatible through a global neither of them documents.
2. **When a bug is intermittent, look for the case that works.** A working control is worth ten
   reproductions of the failure — it tells you what the *difference* is.
3. Prefer bundled dependencies over runtime CDN fetches. You lose a little caching and gain
   determinism, offline development, and freedom from load-order races.

---

### A4. `destroy()` did not destroy everything

**Symptom:** none, yet. This was found by reading source before writing code.

**Believed:** calling `MonacoBinding.destroy()` releases everything the binding created, so
rebuilding bindings whenever the user switches file tabs is free.

**Actually true:** `destroy()` disposes the content-change and dispose handlers — but **not** the
`onDidChangeCursorSelection` listener it registered on the editor. Churning bindings on every tab
switch would strand one listener per switch, for the room's whole life.

**Fix:** don't churn them. Create one binding per file and keep it alive. This turns out to be
free anyway: reading the binding's source shows that every callback guards on
`editor.getModel() === monacoModel`, so every binding except the visible one is already a no-op.

**Lesson:** *`destroy()` is a claim, not a guarantee.* Before building a design that depends on
clean teardown, check what teardown actually does. And notice the shape of the answer here — the
investigation produced **two** independent reasons not to churn bindings, one about leaks and one
about necessity. That is usually a sign you have found the right design.

---

### A5. The panel library everyone documents online is a different library

**Symptom:** every code example found online failed to compile.

**Actually true:** `react-resizable-panels` v4 is a substantially different API from the v2/v3 that
essentially every tutorial describes. It exports `Group`/`Panel`/`Separator`, not
`PanelGroup`/`Panel`/`PanelResizeHandle`. The prop is `orientation`, not `direction`. `autoSaveId`
does not exist. A layout is an object keyed by panel id, not an array.

**Lesson:** *check the version before you trust the tutorial.* Search results are ranked by age
and popularity, not by whether they match your `package.json`. When a well-known library's
examples do not compile, your first hypothesis should be a major-version change, not your own
mistake.

There is a companion trap in the same library, found the hard way: `Panel`'s `className` lands on
its *inner* div, and that div ships an inline `overflow: auto`. **No CSS class beats an inline
style**, so suppressing it requires an inline style of your own. If a utility class seems to be
ignored, open the element inspector and look for an inline style.

---

### A6. `pool.query("BEGIN")` is not a transaction

**Symptom:** none visible. Which is what makes it dangerous.

**Believed:** running `BEGIN`, then some `INSERT`s, then `COMMIT` against a database connection
pool gives you a transaction.

**Actually true:** a *pool* hands out a different connection per query. With a pool size of 3, the
`BEGIN` can land on connection 1, the `INSERT`s on connection 2, and the `COMMIT` on connection 3.
The inserts run entirely outside the transaction, and the `COMMIT` commits nothing.

**It fails silently, because the rows still appear.** Everything looks fine until the day a
partial failure needs to roll back, and nothing does.

**Fix:** check out a specific client with `pool.connect()`, run everything on it, and release it
in a `finally`. The `finally` is mandatory — a leaked client out of a pool of three blocks the
next two writers until their connect timeout, and then fails them.

**Lesson:** *a pool is not a connection.* Any stateful sequence — transactions, temp tables,
session settings, advisory locks — must be pinned to one connection explicitly. And a bug whose
only symptom is "it works" is one you will only find by reasoning, so reason about it.

---

### A7. The framework renamed a file and your old one is silently ignored

**Symptom:** authentication middleware did nothing. No error, no warning.

**Actually true:** Next 16 renamed the `middleware.ts` convention to `proxy.ts`. Every Clerk
recipe written for Next 15 or earlier is correct about the code and wrong about the filename —
and a `middleware.ts` in a Next 16 project is simply never loaded. There is no warning, because
from the framework's perspective it is just an unused file.

**Fix:** rename it, and add a check that it is wired: `ƒ Proxy (Middleware)` must appear in the
build output.

**Lesson:** *convention-based frameworks fail silently by nature.* A file whose meaning comes from
its name and location has no way to tell you that you got the name wrong. Whenever you rely on a
convention, find something observable that proves it is active, and write it down.

---

## Theme B — Concurrency and timing

### B1. Peers who left and would not leave

**Symptom:** close a tab, and that person stays in the participant list forever. Still there after
ten seconds, ten minutes.

**Believed:** presence times out on its own after 30 seconds of silence.

**Actually true:** the WebSocket provider syncs same-origin tabs peer-to-peer over a
`BroadcastChannel` by default, in addition to the server. So:

```
Tab A closes
   ↓
Server broadcasts "remove client 12345"
   ↓
Tab B receives it — but tab B still has A's last known state,
   and immediately re-announces client 12345 with a HIGHER clock
   ↓
The peer is resurrected within milliseconds.
And because each re-announce refreshes its timestamp,
the 30-second timeout NEVER fires.
```

**Fix:** construct the provider with `{ disableBc: true }`. Verified: departures now register in
under 2 seconds.

**The part that makes this a lesson:** departures looked completely fine when testing across two
separate browser windows — because `BroadcastChannel` is same-origin, same-browser only. It only
broke in one browser with two tabs, which is *also the documented way to test multiplayer
locally*. So the bug was invisible in the "realistic" test and obvious in the convenient one.

**Lesson:** *test in the shape your users will actually use, and then test in the other shapes
too.* A feature that works in configuration A and fails in configuration B, where you only ever
test A, is a bug you will ship. Enumerate the configurations explicitly.

---

### B2. Asynchronous verification silently lost the first user's data

This one is a beautiful example of a race that presents as flakiness.

**Symptom:** the first signed-in user after every server restart never got their room saved.
Everyone afterwards was fine. Restart the server and it happens again.

**Believed:** by the time someone types, we know who they are.

**Actually true:** verifying an auth token requires fetching the provider's public keys. The
**first** verification of a process pays that round trip — measured around 200 milliseconds. Every
one after it hits a cache and takes about 1 millisecond.

Meanwhile, a client syncs and starts typing in roughly 50 milliseconds.

```
t=0ms     socket opens, token verification starts (needs to fetch keys)
t=50ms    client syncs, user starts typing
          → edit arrives, we look up "who owns this socket"
          → nobody. This socket has no verified user yet.
          → didEdit stays false
t=200ms   verification finally resolves. The edits already happened.
t=∞       user fails the "did they edit?" check, gets no saved room
```

**Fix:** keep a `pendingEdits` set of sockets that edited before their identity resolved, and
drain it when verification completes. And clear that set for **every** closing socket, verified
or not — otherwise a guest's entry sits there for the room's entire life.

**Lesson, two-part:**
1. **"Works after the first time" is the signature of a cold-cache race.** If a bug reproduces
   consistently on a fresh process and never again, look for something that is slow exactly once.
2. When an identity arrives asynchronously, **buffer the events that arrive before it** rather
   than dropping them. Dropping is the default behaviour of doing nothing, which is why it is so
   easy to ship by accident.

---

### B3. A reference count with three ways to silently corrupt itself

Tracking "how long has this account been connected" sounds trivial. It has three separate traps,
and each one loses data quietly.

**Trap 1 — resetting the clock.** The start time must be set only on the 0→1 transition. Set it
on every connection and a second tab opening at t=90s resets the clock to zero, and the user who
had qualified no longer does.

**Trap 2 — out-of-order resolution.** Because verification resolves out of order (see B2), a
socket opened at t=0 can *register* after one opened at t=100ms. So the start time uses
`Math.min`, never "whatever arrived first."

**Trap 3 — double-decrement.** The end-session call must run at most once per socket. The
tempting guard is `Math.max(0, count - 1)`, which prevents the count going negative — but that
**hides** the bug while still stranding that user's accumulated time for the room's life. The
correct guard is a flag at the call site, so a double call is impossible rather than merely
invisible.

**And a fourth, separate one:** never read the accumulated time directly. At shutdown, every
member is *still connected*, so the accumulated total is missing their entire current session.
Reading it raw fails every member on every deploy — precisely the case the shutdown flush exists
for. There is a helper, `elapsedMs(member, now)`, and it must always be used.

**Lesson:** *a clamp is not a fix.* `Math.max(0, x)` and `?? 0` and `|| default` all make a
symptom disappear while leaving the cause. If you find yourself adding a clamp, ask what would
have to be true for the clamped value to occur — and fix *that*.

---

### B4. Destroying a document fires its handlers one last time

**Symptom:** state for a room that had just been destroyed reappeared, and nothing would ever
delete it again — a slow memory leak.

**Actually true:** the awareness protocol registers `doc.on('destroy', () => this.destroy())`, and
awareness's own `destroy()` calls `setLocalState(null)` — which **emits an update event** —
*before* it removes its listeners.

So `doc.destroy()` synchronously re-fires your awareness handler one final time, after you
believed the room was gone.

**Fix:** two rules. Every handler is **lookup-only** and bails if the room is missing (a
get-or-create in that handler resurrects state for a destroyed room). And the room-state deletion
runs **after** `doc.destroy()`, never before.

**Lesson:** *teardown is not a quiet period.* Destructors run code, and that code can call back
into you. Handlers must tolerate being called during and after teardown — which usually means
they should look things up rather than create them.

---

### B5. Awareness is already empty when you need it

**Symptom:** the snapshot's participant list was always empty.

**Actually true:** the WebSocket library removes a client's awareness state when its socket
closes. By the time the room is evicted, every socket has closed, so `getStates()` returns
nothing. There is no later moment at which "who was here" is recoverable.

**Fix:** accumulate participants as they appear, throughout the room's life.

Two details in that accumulator are worth stealing:

**Dedupe on `name|color`, never on client id.** A refresh inside the grace window creates a brand
new document and therefore a new client id — so one person who refreshed twice would appear three
times in the list.

**Walk only the ids the event carries,** not a full re-scan. Awareness updates fire on *every
cursor move of every peer*, so re-scanning all states would re-walk the participants map on every
keystroke in the room.

**Lesson:** *if you need to know something at the end, record it as it happens.* State that is
correct-by-construction during the event is often unrecoverable afterwards — and "I'll read it
when I need it" quietly becomes "I read nothing."

---

### B6. A frozen URL and a token that lives 60 seconds

**Symptom:** a signed-in user's connected time silently stopped accruing after about a minute.

**Actually true:** the auth token lives roughly 60 seconds. The WebSocket provider serialises
connection parameters into its URL **once, in the constructor** — but re-reads that URL on every
reconnect. So every reconnect after the first minute carried a long-dead token.

**Fix:** rewrite the provider's URL with a fresh token whenever the status goes to
`disconnected`. And derive the base from the provider's own existing URL rather than rebuilding
it from configuration — so it agrees with however the library constructed it, trailing slashes
and all.

**Lesson:** *short-lived credentials plus long-lived connections is a combination that needs
explicit thought.* Ask specifically: what does the reconnect path send? It is almost never the
same code path as the initial connect, and it is almost never tested.

---

## Theme C — Trust and security

### C1. You could choose your own rate-limit bucket

**Severity 2.** Verified live before the fix: twelve requests with a rotating forged header, all
successful, against a limit of ten.

**Believed:** reading the client's IP from the `X-Forwarded-For` header gives you the client's IP.

**Actually true:** that header is a *list*, appended to by each proxy. The **left-most** entry is
whatever the original client claimed — which is the one value a caller fully controls. Reading it
means the caller picks their own rate-limit bucket, and can therefore have as many as they like.

**And it defeated more than the obvious limiter.** That same key becomes the room's creator key,
and then the snapshot queue's pacing key. So a forged header also sidestepped the per-key queue
bound and the snapshot write pacing.

**Fix:** read **right-most minus (hops − 1)**, where hops is a configured number of trusted
proxies. That is correct whether the platform *appends* to the header or *overwrites* it —
left-most is correct under neither. An over-count clamps back to the left-most, degrading to the
old behaviour rather than to a wrong bucket. Junk that is not an IP literal never becomes a key,
and ports are stripped so one client is not many keys.

```
X-Forwarded-For: 1.2.3.4, 5.6.7.8, 9.9.9.9
                 ▲                  ▲
                 │                  └── added by YOUR proxy — trustworthy
                 └── claimed by the caller — completely forgeable
```

**Lesson:** *identify which parts of a request the caller controls.* With one trusted proxy, only
the last entry is trustworthy. This is the single most commonly-wrong line of code in rate
limiting on the internet, and it is wrong in the same way almost everywhere.

**And a second lesson from the blast radius:** the derived key was reused for three different
purposes. When one identifier feeds several systems, a flaw in deriving it is a flaw in all of
them. Trace where your identifiers go.

---

### C2. Two anonymous GET requests that killed the server

**Severity 1**, and the reason this matters more than an ordinary crash is worth reading twice.

**Symptom:**

```
URIError: URI malformed
    at Server.<anonymous> (server/src/index.js:91:20)
```

`GET /rooms/%` was enough. So was `%zz`, and so was any escape decoding to an unpaired surrogate.
Separately, a malformed `Host` header (`Host: a b`) crashed it through
`new URL(req.url, "http://" + host)`.

**Why it mattered so much more than a normal crash:** **a crash is not a graceful shutdown.** The
snapshot-flush function runs on `SIGTERM` and nowhere else. So an uncaught fault took every live
room's unsaved work with the process — and the restart came up with an empty registry, so nothing
could ever retry the write.

**One anonymous request. Everyone's unsaved work in every room. Gone.**

**Fix:**
- A `safeDecode()` that returns null instead of throwing.
- Never build a `URL` from a header at all. The origin was never used — only the path and query —
  so the request target is split by hand and parsed with `URLSearchParams`, which never throws on
  any input.
- A `try/catch` around the whole request listener, so "this handler never throws" is *enforced*
  rather than asserted.
- Process-level handlers for uncaught exceptions and unhandled rejections that **drain snapshots
  before exiting non-zero** — so the next unknown fault is survivable rather than silently lossy.

**A subtle choice inside the fix:** a malformed room id deliberately answers **200
`{"exists": false}`**, not `400`. Because the client reads any non-ok response as *unreachable*,
a 400 would show the "network problem, retry" screen for a room that never existed.

**Lesson, three-part:**
1. **Every parsing function that can throw is a potential availability bug** when it runs on the
   request path of a single-process server. `decodeURIComponent`, `JSON.parse`, `new URL` — all of
   them.
2. **Ask what your crash path costs.** If graceful shutdown is where you do important work, an
   ungraceful exit skips it. Make the important work survive both.
3. Returning the *correct* status code sometimes means thinking about what the client does with
   it, not just what the spec says.

---

### C3. `__proto__` was a valid language

**Symptom:** Piston's internal error text was broadcast into the room's shared output for
everyone.

**Actually true:** the language lookup was a plain object, and
`LANGUAGE_MAP["__proto__"]` returns `Object.prototype` — which is **truthy**. So the guard
"is this a known language?" passed, and the request went through to the sandbox, which returned
its own error text, which was written into the shared record and shown to the whole room.

**Fix:** an explicit `isLanguage()` check against a real allowlist, and Piston's error message is
*logged*, never forwarded.

**Lesson, two-part:**
1. **`{}` is not a dictionary.** It inherits keys. `__proto__`, `constructor`, and `toString` all
   "exist" on every plain object. Use `Map`, `Object.create(null)`, or an explicit allowlist
   check.
2. **Never forward an upstream service's error text to users.** It leaks internals, it is not
   written for your audience, and — as here — it can be attacker-influenced.

---

### C4. The size guard that a chunked request walked straight past

**Symptom:** a 200 KB request was fully buffered into memory before being rejected as too large.

**Actually true:** the guard read the `content-length` header and compared it to a limit. A
chunked request has **no `content-length` header at all**. `Number(null)` is `0`, and `0` is
under any limit, so the guard passed — and then the body was read in full before the real check
rejected it.

**Fix:** read the body through a streaming cap that aborts mid-stream.

**Lesson:** *a missing header is not a zero.* Whenever you coerce a possibly-absent value into a
number for a comparison, check what absence coerces *to*, and whether that value passes your
check. `Number(null) === 0`, `Number(undefined)` is `NaN`, and `NaN` fails every comparison,
which flips your guard's polarity depending on which one you get.

---

### C5. Filenames are attacker-controlled and they reach four different sinks

**Actually true:** a filename in the shared file map is written by a peer, and it then reaches:

1. a tab label in the UI,
2. an `<a download>` attribute,
3. a **zip entry key**,
4. and ultimately a database column rendered on `/profile`.

Three of those *interpret* the name rather than merely displaying it. Path separators matter most
— a zip entry named `../../etc/passwd` is a genuine directory-traversal primitive in some
extraction tools.

**Verified end to end** by putting a hostile name into a real room and reading what landed in the
database. The input was `../../etc/pa sswd` followed by an unpaired surrogate, plus `.py`. What
came out was `....etcpa sswd.py` — separators gone, surrogate gone.

**A tiny detail worth noticing:** an earlier version of the documentation recorded that output as
`....etcpasswd.py`, without the internal space. Off by one character — the whitespace pass
*collapses* runs of spaces, it does not remove them. A test now pins the true value.

That is a small thing, and it is included here on purpose: **documentation drifts from behaviour
in small ways constantly**, and small inaccuracies are how people learn to stop trusting docs.

**Lesson:** *enumerate the sinks.* "Is this string safe?" is not answerable. "Is this string safe
in an HTML text node, in an attribute, in a zip key, in a filesystem path, and in a SQL value?"
is — and the answer is usually different for each. Sanitize for the sinks you actually have.

---

### C6. A token from a different app on the same auth instance counted

**Actually true:** the token verification call was made without constraining the *authorized
party* claim. A token minted for a different application on the same auth instance would verify
fine, and earn a membership row.

**Fix:** an opt-in configuration for allowed origins — and it is **opt-in, failing open**, for a
specific reason: the library fails a token whose authorized-party claim is *absent* just as hard
as one that mismatches. So a wrong value fails every token with the same invisible symptom as a
wrong secret key: rooms work, snapshots never appear. Preview deployments have per-deployment
hostnames and must leave it unset.

**Lesson:** *"the signature is valid" is not "this token is for me."* A signature proves who
issued it. Audience and authorized-party claims are what prove it was issued *for your
application*. Check them — but notice this fix's second half: when a security control's
misconfiguration is invisible, making it opt-in with a loud default can be the safer engineering
choice than making it mandatory and silently wrong.

---

### C7. The tunnel that exposed a privileged container to the internet

Not a code bug — an infrastructure decision that was reconsidered and reversed.

To make the Run button work on the deployed site, code execution was tunnelled from a developer's
machine through a public hostname.

**What that actually meant, verified rather than assumed:**

- `POST /api/v2/execute` was reachable by **anyone on the internet with no authentication at
  all** — confirmed by executing Python on the host from the public hostname with no credential.
- It bypassed the application's rate limiter entirely, since that limiter lives in the web app and
  the tunnel goes straight to the sandbox.
- The container runs `privileged: true` and therefore holds the **full Linux capability set**
  (verified inside the container: `CapEff: 000001ffffffffff`). The sandbox tool was the *only*
  boundary between a stranger's code and root on the host machine.

**Decision:** shut it down. The container is now bound to loopback only. Execution works locally
and is simply unavailable on the deployed site, where the Run button reports "Could not reach the
code execution service" — which is now the **expected behaviour**, not a fault to debug.

Two mitigating facts were also verified, and they are worth knowing before anyone re-enables
anything: the sandbox has no network, and runs as an unprivileged throwaway user with none of the
host filesystem mounted.

**Lesson, three-part:**
1. **A tunnel is a publication.** "It's just for my demo" and "it's on the public internet" are
   the same sentence.
2. **Verify security claims by attacking them.** "It's sandboxed" became a real statement only
   after someone checked the capability set from inside the container and tried to open a socket.
3. **Shipping a feature as unavailable is a legitimate choice.** A visibly missing Run button is
   better than a working one backed by an open door.

---

## Theme D — The database

### D1. The default that generates nothing

**Symptom:** every write from the sync server failed on a null id.

**Believed:** `@default(uuid())` in the schema means the database generates a UUID.

**Actually true:** it is a **client-side** default. The generated migration says plainly
`"id" UUID NOT NULL` with no `DEFAULT` clause — the ORM mints the UUID in JavaScript. The sync
server does not use that ORM (it writes two hand-written `INSERT`s with a plain driver), so
nothing generated an id.

**And the schema looks innocent**, because it does declare a default.

**Fix:** the hand-written statement supplies `gen_random_uuid()` itself. (The alternative, if a
real database-level default is ever wanted, is `@default(dbgenerated("gen_random_uuid()"))`.)

**Lesson:** *know which layer a "default" lives in.* ORM defaults, application defaults, and
database defaults are three different things, and only one of them survives a client that is not
the ORM. The check that catches this is running the real `INSERT` and reading the row back — not
inspecting the table definition, which proves only that the table parses.

---

### D2. Truncating text by byte index can corrupt the whole statement

**Symptom:** a snapshot write rejected the *entire* statement with
`unsupported Unicode escape sequence`.

**Actually true:** two separate hazards, both about characters that JavaScript strings can hold
but a database column cannot.

**Hazard 1 — the NUL character.** It cannot be stored in a Postgres `text` or `jsonb` value at
all. The editor will not let you type one, but a paste can carry it.

**Hazard 2 — unpaired surrogates.** Emoji and many CJK characters are stored in JavaScript as
*two* code units. Slice a string at a byte index and you can cut one in half. `JSON.stringify`
then happily emits a bare `"\ud83d"`, and Postgres rejects the whole statement — so **one bad
character in one participant's name loses the room's code too.**

**Fix:** strip both, on every path, before anything reaches a column. Truncation goes through a
proper UTF-8 decode rather than a string index.

**Two follow-on bugs found in the same area later**, which is itself the lesson:

- The name sanitizer's length cut counted UTF-16 code units and could halve a surrogate pair. It
  now cuts by **code point**.
- The text truncator only repaired the document on its *truncating* branch. A lone surrogate in a
  document **under** the size cap was returned untouched.
- And the truncation itself could **exceed its own cap**: substituting a 3-byte replacement
  character for a 1-2 byte partial made the result longer than the budget. Measured: 262,145 bytes
  for a 262,144-byte cap.

**Lesson, three-part:**
1. **`string.length` is not "number of characters" and not "number of bytes."** It is UTF-16 code
   units, which is the same as neither.
2. **Only reachable with emoji or CJK near a size cap** — that is to say, never in casual
   testing. Test with hostile Unicode deliberately, because your users will supply it
   accidentally.
3. When you fix a class of bug in one place, **go looking for the other places**. The first fix
   here revealed three more instances of the same misunderstanding.

---

### D3. Two connection strings that are not interchangeable

**Symptom:** migrations hang or apply partially.

**Actually true:** the hosted database offers a *pooled* endpoint and a *direct* endpoint.

- The **pooled** one is what the application must use, because many short-lived serverless
  instances would each open their own pool and exhaust the connection ceiling within a few
  requests.
- The **direct** one is what migrations must use, because the pooler runs in transaction mode and
  **cannot hold the session-level advisory lock** a migration takes.

Swap them and you get a confusing partial failure rather than a clear error.

**Lesson:** *when infrastructure hands you two URLs, find out what is different about them
before choosing one.* "They both connect" is not evidence that they are equivalent.

---

### D4. Copy-on-write branches do not track their parent

**Symptom:** a freshly created development database branch arrived carrying 42 rows of a table
that had just been deleted, plus a stale migration record.

**Actually true:** a database branch is a copy-on-write fork **at the moment it is taken**. This
branch was cut from a snapshot that predated the cleanup, so it inherited the pre-cleanup state
and had to be dropped and rebuilt.

**Lesson:** *create the branch before you diverge the two, not after.* And more generally: a
"branch" in infrastructure usually means a point-in-time copy, not a live tracking reference.
Check which one you have.

---

### D5. Deleting one person's copy must not delete everybody's

**Actually true:** one snapshot can appear on several people's profiles, with no owner. So
"delete this snapshot" from one person's profile must delete **their membership row**, and drop
the snapshot itself only when that was the last member.

Two details:

**Use `deleteMany`, not `delete`.** A missing row is then an ordinary count of zero — which is
also the answer for "not yours." So the action cannot be used to probe which ids exist.

**An orphaned zero-member row is possible, and is accepted.** Under the default isolation level,
two members deleting concurrently each still see the other's uncommitted row, so neither takes the
last-member branch and the snapshot row survives with no members. It is unfetchable (every read
starts from the membership table) and invisible. The stricter isolation level would replace it
with a serialization failure shown to someone who has already confirmed a delete — a worse trade
at this scale.

**Lesson, two-part:**
1. **"Delete" in a shared-ownership model is ambiguous.** Decide explicitly whether it means
   "remove my access" or "destroy the object," and make the code say which.
2. **Some races are worth accepting.** The right output is not always a fix; sometimes it is a
   measured decision with the reasoning written down. What is *not* acceptable is an unexamined
   race.

---

### D6. A timeout tuned for a warm database

**Symptom:** snapshot writes failed at shutdown with `Connection terminated due to connection
timeout`.

**Actually true:** the connection pool is *always* cold at shutdown — the process is idle between
room evictions and the pool's idle timeout is 30 seconds — and the hosted database **autosuspends
an idle branch**. Measured: about 750-900ms warm, but **over 5 seconds against a suspended
branch.** A 5-second ceiling was observed failing outright.

**Fix:** 10 seconds, sitting under a 20-second overall shutdown budget. And that relationship is
now checked at boot: a warning fires if the connect timeout is greater than or equal to the flush
deadline.

**Lesson:** *measure your timeouts against the worst case that actually happens, not the case you
are looking at.* And when two timeouts have a required relationship, make something check it —
a comment describing the relationship is not a check.

---

## Theme E — Lifecycle, shutdown, and resource exhaustion

### E1. Ten rooms died at once and seven snapshots were lost

**Symptom:** measured, deliberately: 10 rooms dying simultaneously, **3 saved, 7 lost.** Exactly
the pool size.

**Actually true:** each dying room fired off its database write and forgot about it. With a
connection pool of 3, everything past the third waited in the pool's pending queue until the
connect timeout rejected it — and the room was already gone, so nothing could retry.

**And every redeploy took this path**, because the shutdown flush destroys every room at once.

**Fix:** a queue between "room destroyed" and "write to the database," with a concurrency cap of
exactly the pool size. One less idles a connection for nothing; one more puts a worker back in the
pending queue the cap exists to avoid.

**A design principle inside that queue is worth stealing.** It **defers; it never refuses.** The
rate-limited HTTP endpoint can answer "429, try again" because there is a caller standing there to
retry. A snapshot has no caller — the room is already destroyed and its document freed — so a
refused write destroys the only copy of that work. And the legitimate case that trips a per-IP
limit is a *shared office network* closing thirty rooms at 5pm, not an attacker. So an over-limit
snapshot waits its turn.

**Lesson, two-part:**
1. **Fire-and-forget plus a bounded resource equals silent data loss.** If you `await` nothing,
   nobody handles the rejection. Bound your concurrency to the resource you are actually
   contending for.
2. **"Rate limit" means different things for a request and for a background write.** The right
   response to over-limit is *reject* when there is a client to retry and *defer* when there is
   not. Copying a limiter from one context to the other is how you get a data-loss bug that looks
   like a hardening feature.

---

### E2. The timestamp that recorded the wrong moment

**Symptom:** rooms sorted wrongly on the profile page and claimed longer lifetimes than they had.

**Actually true:** once writes can be *deferred*, letting the database's `now()` fill in the
"died at" column records **when Postgres was reached**, not when the last person left. The
profile page both sorts on that column and renders "lasted 12 minutes" from it.

**Fix:** the writer binds the timestamp at the moment the room actually died. Verified: 10 rooms
paced across ~15 seconds came back with an 8-millisecond spread in their recorded death times.

**Lesson:** *`now()` means "now at write time," and write time is not event time the moment you
introduce any queueing.* If a timestamp describes an event, capture it at the event.

---

### E3. The health check that could never report unhealthy

**Symptom:** during a deploy, the hosting platform kept routing traffic to a shutting-down
instance and users got connection-refused errors.

**Actually true:** the shutdown sequence closed the listening socket *before* setting the flag
that makes the health endpoint report unhealthy. So by the time the endpoint would have answered
"503, stop sending me traffic," it was no longer accepting connections at all — and the platform
saw a refused connection instead of a polite refusal.

**The documentation had stated the 503 behaviour as a fact.** It was unreachable.

**Fix:** set the flag first, close the listener last.

**And one consequence had to land in the same change.** Because the listener now stays open
throughout the drain, room creation must also refuse with 503 while draining — otherwise a room
minted mid-drain would never be flushed, and its creator would meet "this room has closed" right
after the restart.

**Lesson, two-part:**
1. **Shutdown ordering is real code and deserves a real test.** "Stop accepting new work, then
   finish existing work, then exit" has a specific order, and getting it backwards produces
   exactly the outage the sequence exists to prevent.
2. **A behaviour you have documented but never observed is a hypothesis.** This one had been
   written down confidently and was simply false.

---

### E4. A configuration value of zero that meant "never"

**Symptom:** setting the snapshot write limit to `0` silently paused every snapshot forever.

**Actually true:** two problems at once.

First, the parsing idiom `Number(x) || default` cannot distinguish a deliberate `0` from a typo —
both are falsy, both get the default. That is the *lucky* case.

Second, and worse: a limit of `0` makes the internal check `recent.length >= 0` **always true**,
so every snapshot is paced forever and only the emergency drain at shutdown saves any of them.
That is silent data loss dressed up as a tuning knob.

**Fix:** proper environment parsing with **per-variable floors** — and the floors are deliberately
not uniform:

| Variable | Floor | Why |
| --- | --- | --- |
| Snapshot write limit | 1 | `0` means "pace everything forever" |
| Room creation limit | 1 | `0` means no room can ever be created |
| Room reservation time | 1000ms | `0` expires the reservation before its creator can connect |
| Grace period, flush deadline, min connected time, connect timeout | — | a real `0` is meaningful for each |

**Lesson, two-part:**
1. **`||` is the wrong operator for defaults on numbers.** `0`, `""`, and `false` are all
   legitimate values that `||` throws away. Use `??`, or better, parse and validate explicitly.
2. **Ask what each configuration value does at its extremes.** "Just honour zero" would have been
   the wrong fix here — some zeros are meaningful and some are catastrophic, and only per-variable
   thought tells them apart.

---

## Theme F — Rendering, frameworks, and the client

### F1. A route that returned 500 on every request, invisibly

**Symptom:** none, from a browser. Every feature worked.

**Actually true:** the room route imported a module that touched `window` at import time, so the
route threw `ReferenceError: window is not defined` during server rendering — on **every single
request.** React then recovered on the client and rendered everything correctly, so the fault was
completely invisible unless you looked at status codes.

**Fix:** load the editor through a dynamic import marked as client-only, at module scope, inside
a component that is already client-side. (That last part matters: client-only dynamic imports are
illegal in a server component in this framework version, which is why the boundary lives one
level down from the page.)

**Two cheap regression checks came out of it**, and the second exists because the first stopped
being sufficient:

```bash
curl -o /dev/null -w '%{http_code}' localhost:3000/room/<id>   # must be 200
curl -s localhost:3000/room/<id> | grep -c monaco              # must be 0
```

The status code alone stopped proving anything the moment the route started succeeding — so the
second check asserts the editor is *absent from the server-rendered HTML*, which is the actual
property.

**A knock-on effect worth noting:** the no-flash theme script lives in the root layout's `<head>`,
and a route that returns 500 never ships one. Fixing the 500 is what made theming work on that
route.

**Lesson, two-part:**
1. **"It works in the browser" is not "it works."** Client-side recovery can completely mask a
   server-side failure. Check status codes.
2. **When you fix something, ask whether your test still tests it.** A check that passes for the
   wrong reason is worse than no check.

---

### F2. The accessibility roles that promised a contract and broke it

**Symptom:** an accessibility audit flagged a *critical* violation on the file tab strip.

**Actually true:** the strip declared itself a `tablist` with `tab` children — and honoured almost
none of that contract. There was no `tabpanel` anywhere in the app, no `aria-controls`, and the
tablist **owned buttons it is not permitted to own** (a per-file menu button and a "new file"
button).

**Fix — and this is the interesting part — was to *remove* the roles, not to complete the
contract.** A compliant tablist genuinely cannot contain those buttons, and there is no panel per
tab, because there is one editor that swaps its content (and which must never be remounted, for
reasons in Part 5 F3). `aria-current` says the same thing honestly.

The keyboard behaviour stayed regardless — arrow keys, Home/End, and a roving tab index, because
two tab stops per file is 41 tab stops at the twenty-file maximum.

**Lesson:** *an ARIA role is a promise about behaviour.* Declaring `role="tablist"` tells assistive
technology "arrow keys move between tabs, and each tab controls a panel." If that is not true,
the role is a lie that makes things *worse* than no role. Sometimes the right fix for a broken
promise is to stop making it.

Two more accessibility findings from the same pass, both generalisable:

**A live region that does not exist yet is never announced.** The toast container used to render
nothing when there were no messages. A screen reader has to be watching an element *before* it
changes. It must stay mounted and empty.

**Brand colours have a foreground partner, and it flips with the theme.** The accent and success
colours are tuned to be legible as *text on a dark background*, which necessarily makes them
*bright backgrounds*. Pairing them with white text gave **2.54:1** on the dark theme's Run button
— the worst ratio on the site, against a 4.5:1 requirement. The fix was dedicated
contrast-partner tokens. The rule that came out of it: never write `text-white` on those
backgrounds, and when changing a colour, compute the ratio against **every background it is
actually used on, hover states included** — not just against white.

---

### F3. The component that must never unmount

Not a bug that shipped — a constraint discovered while designing, and worth studying as an
example of *documenting a landmine before someone steps on it*.

The editor component owns the entire collaboration stack: the document, the WebSocket provider,
the awareness handler, and the editor bindings. All of it is created and destroyed in effects. So
if the editor component ever **unmounts and remounts**, the room's shared output is wiped for
everyone, every join notification re-fires, and cursor decorations are orphaned.

Things that would cause that, all of which look completely innocent:

```jsx
// ✗ two Groups behind a ternary — remounts everything on orientation flip
orientation === "horizontal" ? <Group>…</Group> : <Group>…</Group>

// ✗ any key on the path down to the editor — remounts on every change
<EditorPane key={activeFileId} … />

// ✗ conditionally rendering a pane — which is why the phone layout
//   COLLAPSES a panel instead of switching tabs
{showEditor && <EditorPane … />}
```

**And the test for it is not what you would expect.** You cannot verify this by looking at the
layout — the layout looks fine either way. The test is: **run something, then drag the divider,
flip the orientation, collapse and expand.** If the output panel resets to "Output will appear
here…" or a join notification re-fires, the editor remounted. Checking a second browser tab makes
it unambiguous.

**Lesson, two-part:**
1. **When a component owns expensive, stateful, shared resources, its identity is a load-bearing
   part of your architecture** — and React's identity rules (position in the tree, plus `key`) are
   subtle enough that this needs writing down next to the component.
2. **Test the invariant, not the appearance.** The visible symptom of a remount is not visual, so
   a visual check proves nothing.

---

### F4. Small client-side traps worth collecting

Each of these cost a debugging session. They generalise less than the ones above, but they
generalise.

**Two tabs must be two people.** Identity is stored in `sessionStorage`, which is per-tab, and
only the *name* is mirrored to `localStorage` as a form prefill. Consolidating both into
`localStorage` looks like an obvious simplification and silently breaks the only way to test
multiplayer locally without an incognito window — both tabs become one person with one cursor.

**Reading `localStorage` during render is a hydration mismatch by construction.** The server
cannot know what is in the browser's storage, so the server and client snapshots legitimately
differ. Both theme and identity are read through `useSyncExternalStore` with a deliberately
different server snapshot — and identity's is a three-valued
`unknown / absent / present` specifically so the name prompt is **never in the server-rendered
output**, which would otherwise flash at everyone who already has a name.

**Preventing a theme flash cannot be done in React.** By the time hydration runs, the browser has
already painted once. It requires an inline `<script>` in `<head>`, plus telling React to expect
the resulting mismatch — otherwise React re-renders from the nearest boundary and undoes it.

**Keyboard shortcuts must be registered on the editor, never on `window`.** A global handler
fires Run while someone is typing in the standard-input box, or in the inline rename field. And
handlers must be registered *once* with values read through refs, because a handler that closes
over the current code text is a new function on every keystroke — an effect depending on it
directly would tear down and re-register the keybindings sixty times a minute.

**A guard on a button is not a guard.** The empty-document check lived only on the Save button's
`disabled` prop. The keyboard shortcut does not consult `disabled`, so Ctrl+S downloaded an empty
file while the button was visibly off. The guard belongs in the handler, so every path inherits
it.

---

## Theme G — When the tests and tools lie to you

### G1. The corruption guard that could never detect corruption

**Symptom:** the documented check for corrupted source files reported nothing — while two files
in the repository were genuinely corrupted.

**Actually true:** the check was `grep -P '\x00'`. `grep` classifies a file containing NUL bytes
as **binary** and reports nothing at all unless you pass `-a`. So the guard was silent precisely
when it mattered.

**How the corruption happened is itself a lesson.** Some source files contain regular expressions
with Unicode escape sequences in them. Tool-call arguments are JSON, and JSON decodes those
escapes — so rewriting one of those lines through an editing tool can silently write *real* NUL
and unpaired-surrogate bytes into the file and turn it binary.

And there is a wrinkle: **NUL gets decoded into a real byte, but a lone surrogate does not**,
because JSON cannot encode one, so it passes through as literal text. That is why one escape two
lines away from another survived while its neighbour did not.

**Fix:** two things. A check using a tool that reports NUL-bearing files as `data` rather than
silently skipping them, and — the real guard — a test that scans the whole tree at the byte level
on every test run. **It caught itself on its first execution.**

**Lesson, two-part:**
1. **A guard you have never seen fire is not a guard.** Deliberately break the thing and confirm
   the check goes red. This one had been documented for a long time and had never worked.
2. `grep` has behaviours (binary detection, locale-dependent matching) that make it a poor
   foundation for a correctness check. Prefer a check that operates on bytes.

---

### G2. A test retry that hides the bug you wrote the test for

The end-to-end test configuration sets `retries: 0`, deliberately.

**Why:** a retry that goes green hides exactly the CRDT and presence races the suite exists to
catch. **Two flakes surfaced this way and both were real bugs.**

**Lesson:** *retries convert "sometimes broken" into "apparently fine."* For a suite testing
concurrent, distributed behaviour, that is the opposite of what you want. Retries are appropriate
for genuinely external flakiness (a network fetch to a third party); they are actively harmful for
races in your own code.

---

### G3. Tests that measured the wrong thing

Four traps, each of which produced a test that passed while proving nothing:

**A visible editor is not a ready room.** The starter file lands only after the sync handshake
completes. Before that, a Run click is silently swallowed. A test that waits for the editor to
appear and then clicks Run is measuring a race it will usually lose. Measured 10/10 rooms seed
correctly, so this is a *test timing* trap, not a product bug — which is exactly why it is
dangerous.

**Never read the document from the page's full text.** The editor keeps a hidden accessibility
mirror of its contents, so the whole document appears **twice**. That looks precisely like a
double-seeding bug, and is not.

**Click the visible lines, never the hidden textarea.** Clicking the editor's hidden textarea
appears to work — select-all even takes effect — but keystrokes never reach the model.

**Dismissing a "leave site?" dialog cancels the navigation.** A test that dismisses the prompt is
then measuring presence in a tab it believes it closed, and every subsequent "am I alone?"
assertion is wrong. Call accept.

**Lesson:** *a passing test proves your assertion ran, not that it meant anything.* For any test
touching a complex third-party widget, verify at least once — by deliberately breaking the
product — that the test actually goes red.

---

### G4. The suite that tripped the product's own rate limit

**Symptom:** an unrelated end-to-end spec timed out during room creation.

**Actually true:** the suite legitimately creates about 20 rooms in two minutes, against a limit of
10 per minute. The symptom appears deep inside a spec that has nothing to do with room creation,
and is indistinguishable from a product bug.

**Fix:** make the limit configurable, default unchanged, and raise it for the test run.

**Lesson:** *your own defences will fight your test suite, and the resulting failure will point
somewhere else.* When adding a limit, ask how a legitimate automated client will experience it.

---

### G5. The environment variable that was declared twice

**Severity 1**, and it silently switched off the entire feature set of version 2.

**Symptom:** none. Rooms worked, presence worked, editing worked. Snapshots simply never appeared.

**Actually true:** the server's environment file declared the authentication secret **twice, with
different values**. The parsing library takes the *last* occurrence, and that one did not match
the frontend's key.

Per this project's own documentation, a mismatched key fails every token **with no visible
symptom at all**. So the whole persistence feature was inert in that environment, and nothing in
the product would have told anyone.

**How it was found:** by comparing the two lines' *text*, never their values.

**Lesson, two-part:**
1. **Duplicate keys in configuration files are silent.** Nothing warns. Add a check that scans for
   them, and be aware that different parsers pick different winners.
2. **"No visible symptom" is a property you should treat as a defect in itself.** Because the
   failure mode was documented as invisible, the code now emits a one-time warning at startup —
   which is what will surface it next time.

---

## Theme H — Documentation, and lying to yourself

The last theme is the most uncomfortable, because the mistakes are not in the code.

### H1. Documentation that was true when written

Several confident paragraphs in this project's own notes were found to be false during the audit:

| The claim | The reality |
| --- | --- |
| "`readPeers` is the single point where peer data is narrowed" | True when written. A third shared type was added later with no boundary — and the stale sentence stopped people looking |
| "The sync server's rate limiter is exact — one process, one counter" | Exact per *key*, and the key was forgeable |
| "`/health` answers 503 while draining" | Unreachable, because of the shutdown ordering |
| "The corruption guard is `grep -P '\x00'`" | That check has never worked |
| "Missing auth keys 500 the whole site" | Measured false — the site serves 200 with no keys at all |
| "The sanitizer produces `....etcpasswd.py`" | The internal space is collapsed, not removed |
| "The language column is null on every row" | True until a later feature made it false |

**None of these was written carelessly.** Every one was accurate on the day it was written. They
became false because the code moved and the prose did not.

**The rule this project adopted:** when a change contradicts a paragraph, **rewrite that
paragraph** rather than appending a correction next to it. A document with corrections stacked on
corrections is a document nobody trusts.

And there is a second, sharper rule underneath it: **documentation whose claims are never
executed will rot.** The claims that stayed true are the ones with tests attached. That is the
entire reason the drift test tier exists.

**Lesson:** *the half-life of a comment is shorter than you think.* Prefer, in order:
1. Make it impossible (structure, types, unreachability)
2. Make it tested (an assertion that fails when the claim stops being true)
3. Make it documented (and accept that it will drift)

### H2. The comments that were deleted, and the ones that were not

At one point this codebase carried about 3,100 lines of explanatory comments. It now carries about
650, and the reduction is considered an improvement.

The reasoning: an explanatory essay inside a source file is in the wrong place. It makes the code
harder to scan, it drifts silently, and it is invisible to anyone reading the architecture rather
than the file.

So the division became: **the code carries the rule, the notebook carries the reason.**

- In code: at most one or two lines, only where the logic is genuinely non-obvious, and prefixed
  `// INVARIANT:` when it is a rule a future edit could break silently. There are about 175 such
  lines and they are load-bearing — **deleting one to tidy up is a real regression**, and the
  audit's sign-off explicitly lists it as grounds for revoking the verdict.
- In the notebook: the measurements, the rejected alternatives, the debugging history.

One deliberate exception: a documentation block describing the shape of the snapshot object stayed
in full, because that workspace is plain JavaScript with no type system, so **that block is the
only declaration of the contract between two modules.** It is a type signature, not prose.
Deleting it is closer to deleting code than to tidying a comment.

**Lesson:** *"add more comments" and "add fewer comments" are both bad advice.* The useful question
is *which reader is this for, and where will they be standing when they need it?* A rule someone
might break while editing this line belongs on this line. A three-paragraph justification belongs
somewhere someone can find it without reading the file.

### H3. Saying what you did not check

The audit report opens its scope section with a table titled **"What was deliberately NOT
audited,"** and the reason is stated plainly: *a green suite invites the assumption that
everything was checked.*

"295 tests, all green" is a sentence that means far less than it sounds like. It does not mean the
product works. It means 295 specific assertions hold.

**Lesson:** *state your coverage boundary as prominently as your coverage.* The most misleading
artefacts in software are the ones that are entirely accurate and quietly incomplete.

---

# Part 6 — How this is tested

## 6.1 Four tiers

```
┌─ web/tests/unit ──────── pure functions, sanitizers, limiters ─┐
│  hermetic: no database, no auth service, no network            │  fast
├─ web/tests/unit/drift ── the hand-copied pairs compared        │  ↑
│  hermetic                                                      │  │
├─ server/tests/unit ───── lifecycle, state, snapshot building   │  │
│  hermetic                                                      │  │
├─ server/tests/integration  spawns the REAL server, raw sockets │  │
│  no database, no auth service                                  │  ↓
└─ web/e2e ─────────────── Playwright, all three services live ──┘  slow
```

The first three tiers are **hermetic**: no database, no authentication service, no network. That
matters, because it means a contributor can run the vast majority of the suite with nothing
installed and no credentials.

## 6.2 The habits worth stealing

**Every test title begins with a case id.** `SEC-05d`, `DRIFT-15a`, `EC-06c`. So any claim
anywhere in the documentation is traceable to its proof with one command:

```bash
grep -rn "SEC-05d" web/tests server/tests web/e2e
```

That is a small convention with a large effect. It makes "is this actually true?" a five-second
question instead of an afternoon.

**The audit was phased, and each phase gated the next.** Availability was fixed before anything
was measured, because *a measurement taken on a process that an earlier test crashed is
worthless*. Performance was measured after hardening, so the numbers describe the code that
actually shipped.

**The drift tier compares behaviour, not text.** Neither side of a duplication exports what is
being compared, so the tests feed identical inputs through both copies and assert the outputs
match, row by row.

**CI has a job that states what CI cannot cover.** It cannot run a privileged container, a real
authentication service, or a cold database start. Rather than letting a green tick imply
otherwise, there is a job that says so out loud.

> **General lesson.** The most valuable thing a test suite gives you is not confidence — it is
> *calibrated* confidence. A suite that tells you exactly what it does not know is worth more than
> a bigger one that does not.

---

# Part 7 — What is not built, and why

This section exists because the previous one could otherwise be read as "everything works."

## 7.1 Features that simply are not there

| Not built | Consequence you can see |
| --- | --- |
| **In-room chat** | You collaborate on code with no way to talk about it |
| **Room passwords** | Anyone with the link is in. There is no private room |
| **Room names** | The profile page titles every saved room with its raw random id |

All three are on the checklist and none is started. They are scope, not defects.

## 7.2 Code execution does not work on the deployed site

This is the largest gap, and it is a deliberate decision (see Part 5 C7).

The sandbox needs a **privileged** container — it requires `isolate`, cgroups, and an executable
tmpfs. Neither of the two platforms this project deploys to permits that. The public hosted
instance of the sandbox went whitelist-only and now rejects every request.

So the Run button on the deployed site reports "Could not reach the code execution service,"
which is the **expected behaviour** rather than a fault to debug.

**The honest fix is a host that is not a personal machine** — a virtual server that permits
privileged containers. And if any tunnel is ever used again, authentication is not optional:
put a shared secret on it and have the execute route send it. The old public hostname is in this
repository's git history and should be treated as public knowledge.

## 7.3 Gaps in verification

| Gap | Why it exists |
| --- | --- |
| **No signed-in end-to-end tier** | The full journey — sign in → snapshot → profile → delete — needs test users created through the auth provider's backend API. The membership *arithmetic* is covered by ten hermetic cases; the **browser journey** is not |
| **The content-security policy ships report-only** | It needs a signed-in browser pass — sign-in, snapshot download, the delete action, the error page — before being enforced. Enforcing it early would take sync or auth down with no report phase to catch it |
| **No real screen-reader pass** | Automated accessibility checks and keyboard traversal are genuinely not the same thing as NVDA or VoiceOver |
| **One shutdown behaviour is not observed end to end** | The 503-while-draining fix is verified by source ordering and a unit test, not by watching a platform's load balancer react |

## 7.4 Known limitations that are accepted, not hidden

**The editor is a forward keyboard trap.** Tab inserts a tab character; only Shift+Tab or an
undiscoverable shortcut escapes. This is a real accessibility failure against WCAG 2.1.2. The fix
is known — configure the editor's accessibility support, or surface the hint — and has not been
done.

**A room's document has no size ceiling.** Every non-destructive fix needs a byte budget nobody
has measured, and every quickly-measurable fix destroys the room's only copy of everyone's work.
The per-frame case is bounded; a per-socket update budget is designed but not built.

**Concurrent typing at one position interleaves per character.** Correct CRDT behaviour, but it
means "A typed AAAA" is not a guarantee that the four characters stay adjacent.

**The frontend rate limiter counts per serverless instance.** With no shared store, a caller
spread across N warm instances gets up to N times the nominal limit. It converts an unbounded
flood into a bounded one; it is **not a security boundary**, and the code says so. Adding a
database round trip to the hot execution path was judged a worse trade.

**A crashed sync server still loses whatever was open.** Snapshots are written when a room dies
normally — and, since the audit, also on an uncaught fault. But a hard kill loses live rooms.

**Horizontal scaling is out of scope entirely.** One sync server process holds all rooms in its
memory. Running two would mean two people in "the same" room on different processes never seeing
each other.

**A multi-file snapshot overshoots its cap by about 0.4%.** Each truncated file carries a full
truncation marker, so twenty files exceed the nominal budget by roughly 1.1 KB. Not fixed, and the
reasoning is instructive: dropping the marker would hide the truncation from the user, which is
worse; reserving space for twenty markers up front costs real content in every room, including the
overwhelming majority that never truncate. So the test pins the *true* bound instead — an honest
assertion beat a cosmetic fix.

---

# Part 8 — A study path

## 8.1 If you are new to all of this

Read in this order, with the code open beside you:

1. **Part 1 of this document**, until the words stop being unfamiliar.
2. **`lib/editor/languages.ts`** — the simplest real file in the project. One list, a few
   lookups. It shows you the naming conventions and the import style with no concepts attached.
3. **`lib/collab/awareness.ts`** — a *complete* trust boundary in about a hundred lines. Read it
   next to Part 4.1 and Part 5 C1. This is the single best file in the repository for
   understanding the project's philosophy.
4. **`lib/sandbox/executionState.ts`** — the shape of shared state, plus the boundary that was
   missing and had to be added. Note how the type union forces every writer to supply every field.
5. **`hooks/useCodeRunner.ts`** — one complete user action, start to finish: read shared state,
   check limits, write "running", fetch, check for staleness, write the result.
6. **`server/src/rooms/lifecycle.js`** — the room state machine. Read Part 3.5 first.
7. **`hooks/useCollabRoom.ts`** — the hardest file in the project, and the one that repays study
   most. Read Part 5 F3 first so you understand why it is one hook and not five.

## 8.2 Exercises

Nothing teaches like breaking something on purpose.

**Beginner:**
- Open the same room in two tabs of one browser. Type in both. Watch the cursors.
- Now open it in two different browsers and compare — notice presence behaves the same, which is
  the point of Part 5 B1.
- Open a room, note the id, close every tab, wait 15 seconds, then navigate back to that URL.
  Watch the closed-room screen. Now do the same but reload within 5 seconds. The room survives.

**Intermediate:**
- Run a program that prints 100,000 characters. Read the notice that appears, then find where in
  the code that notice text is produced.
- Add a language to `lib/editor/languages.ts` and follow every place it needs to appear. Count
  them. (There is more than one workspace involved — see Part 4.5.)
- Change `STALE_RUN_MS` to 2 seconds and run a slow program. Watch the watchdog misfire, and
  re-read Part 3.3's diagram to understand why.

**Advanced:**
- Write a script that connects to a room as a raw Yjs client — no browser, no UI — and writes a
  hostile colour into awareness. Confirm the boundary catches it. Now comment the boundary out
  and confirm the exploit works. This is the single most instructive thing you can do in this
  codebase.
- Read `y-websocket`'s `bin/utils.js` and find the `docs.delete` call from Part 5 A1 yourself.
- Deliberately introduce a divergence between the two rate limiter copies and watch the drift
  test fail.

## 8.3 If you are evaluating this project

The three things most worth looking at:

1. **`docs/TESTING.md` §5** — 21 defects, each with a symptom, a root cause, and a validating test
   case id. Including the three that were *not* fixed, with the argument recorded.
2. **The three sanitizing boundaries** and the story of the fourth that was missing (Part 4.1).
   Adding a trust boundary is easy; noticing a missing one is the skill.
3. **`CLAUDE.md`** — an engineering notebook where the entries that turned out to be *wrong* were
   rewritten rather than quietly deleted, and several of them say so explicitly.

---

# Part 9 — The cheat sheet

Every lesson from Part 5, in one place.

### On untrusted input

- Anything a peer can write is hostile input, no matter how friendly your form is.
- Sanitize at the boundary where data enters your trust zone, not where it enters your UI.
- A new channel for untrusted data needs a new boundary. Ask explicitly which one covers it.
- Enumerate the *sinks*. "Is this string safe" is unanswerable; "is it safe in a zip key" is.
- `{}` inherits keys. `__proto__` is truthy. Use an allowlist check.
- Never forward an upstream service's error text to users.
- A signature being valid is not the same as a token being *for you*.
- Only the proxy-appended end of `X-Forwarded-For` is trustworthy.

### On failure and availability

- Every function that can throw on the request path of a single process is an availability bug.
- A crash is not a graceful shutdown. Anything important that happens at SIGTERM must survive a
  crash too.
- Decide which direction "safe" points, per feature, by writing out both failure costs.
- "Missing" and "unreachable" are different states and must stay different.
- An optional feature must fail optionally. Never wire an add-on into the critical path.
- A hardening change can create the bug it was meant to prevent. Ask what happens when the limit
  is *hit*.
- In Node, an emitter with no `'error'` listener throws the process down.

### On concurrency and time

- "Works after the first time" is the signature of a cold-cache race.
- Buffer events that arrive before the identity they need, rather than dropping them.
- A clamp is not a fix. `Math.max(0, x)` hides a bug and keeps the cause.
- Teardown runs code. Handlers must tolerate being called during and after it.
- If you need to know something at the end, record it as it happens.
- Nested timeouts must be ordered deliberately; re-check all of them when you change one.
- Short-lived credentials plus long-lived connections needs explicit thought about the reconnect
  path.
- When you schedule work for later, re-check your preconditions when it runs.

### On data

- Know which layer a "default" lives in. ORM, application, and database defaults are different.
- `string.length` is UTF-16 code units — neither characters nor bytes.
- Test with hostile Unicode deliberately. Users supply it accidentally.
- A pool is not a connection. Pin stateful sequences explicitly.
- `now()` is write time, not event time, the moment you introduce queueing.
- Fire-and-forget plus a bounded resource equals silent data loss.
- "Rate limit" means reject when there is a caller and defer when there is not.
- "Delete" under shared ownership is ambiguous. Say which one you mean.
- Prefer designs where the wrong thing is *unreachable* over designs where it is *filtered out*.

### On libraries and frameworks

- `node_modules` is source code on your disk. Read it.
- Read the *condition*, not just the statement. A guarded cleanup may never run.
- `destroy()` is a claim, not a guarantee.
- Check the major version before trusting a tutorial.
- Globals are a shared namespace and libraries fight over them.
- Convention-based frameworks fail silently. Find something observable that proves it is wired.
- No CSS class beats an inline style.

### On tests and verification

- A guard you have never seen fire is not a guard. Break it on purpose.
- Retries convert "sometimes broken" into "apparently fine." For race tests, that is backwards.
- A passing test proves your assertion ran, not that it meant anything.
- When you fix something, ask whether your test still tests it.
- Your own defences will fight your test suite, and the failure will point somewhere else.
- Test the invariant, not the appearance.
- Test in the shape your users use, *and* in the shapes you use.
- When a bug is intermittent, look for the case that *works*.

### On documentation

- A documented rule the code has outgrown is worse than no rule — it stops people looking.
- Prefer: impossible > tested > documented.
- Rewrite the paragraph that became false. Do not append a correction beside it.
- State your coverage boundary as prominently as your coverage.
- The code carries the rule; the notebook carries the reason.
- Duplication is sometimes right. Duplication that nothing checks never is.

---

## A closing thought

The most useful thing in this repository is not the code. It is the fact that somebody wrote down
what went wrong, including the parts that were embarrassing: the guard that never worked, the
documentation that was confidently false, the security claim that had never been tested, the
feature that was silently switched off by a duplicated line in a config file.

Every one of those was found by someone deciding to check something they already believed.

That is the transferable skill. Not knowing about CRDTs, or Yjs, or Piston — those are details you
can look up. The skill is the reflex that says *I have asserted this; have I observed it?*

---

*Companion documents: `README.md` (reference), `CLAUDE.md` (engineering notebook),
`docs/TESTING.md` (audit report), `docs/DEPLOYMENT.md` (hosting runbook).*
