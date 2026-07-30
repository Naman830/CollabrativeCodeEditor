"use client";

import { useState, type SubmitEventHandler } from "react";
import { useRouter } from "next/navigation";
import IdentityDialog from "@/components/ui/IdentityDialog";
import SiteNav from "@/components/layout/SiteNav";
import { BoltIcon, CursorIcon, ShieldIcon } from "@/components/ui/icons";
import { signedInUser, useClerkIdentity } from "@/lib/collab/clerkIdentity";
import { DEFAULT_LANGUAGE, LANGUAGES, type LanguageValue } from "@/lib/editor/languages";
import { RoomCreateError, createRoom } from "@/lib/collab/rooms";
import { cn, inputField, primaryButton, secondaryButton } from "@/lib/ui";
import { setActiveUser, type CollabUser } from "@/lib/collab/user";

const FEATURES = [
  {
    Icon: CursorIcon,
    title: "Live cursors",
    body: "Every caret and selection, in that person's colour, as they type.",
  },
  {
    Icon: ShieldIcon,
    title: "Sandboxed runs",
    body: "Five languages, executed in an isolated container with hard resource limits.",
  },
  {
    Icon: BoltIcon,
    title: "Sign-in optional",
    body: "Join as a guest in one click. Sign in only if you want your rooms kept.",
  },
];

function EditorPreview() {
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl shadow-[var(--shadow-color)]"
    >
      <div className="flex h-10 items-center gap-2 border-b border-edge px-3">
        <span className="h-2.5 w-2.5 rounded-full bg-danger/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
        <span className="ml-2 truncate font-mono text-[11px] text-fg-subtle">room-a4f2c1</span>
        <span className="ml-auto flex -space-x-2">
          {["#64b5f6", "#81c784", "#ba68c8"].map((color) => (
            <span
              key={color}
              className="h-5 w-5 rounded-full ring-2 ring-panel"
              style={{ backgroundColor: color }}
            />
          ))}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1.4fr_1fr]">
        <pre className="overflow-hidden bg-code px-4 py-3 font-mono text-[11px] leading-relaxed text-fg sm:border-r sm:border-edge">
          <span className="text-fg-subtle">1 </span>
          <span className="text-accent">def</span> solve(n):{"\n"}
          <span className="text-fg-subtle">2 </span>
          {"    "}
          <span className="text-accent">return</span> sum(range(n)){"\n"}
          <span className="text-fg-subtle">3 </span>
          {"\n"}
          <span className="text-fg-subtle">4 </span>print(solve(
          <span className="text-success">10</span>))
        </pre>

        <div className="bg-code px-4 py-3 font-mono text-[11px] leading-relaxed">
          <p className="text-fg-subtle">Output</p>
          <p className="mt-1 text-fg">45</p>
          <p className="mt-2 text-success">✓ exit 0 · 0.4s</p>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  // INVARIANT: Clerk's `Show` is an async Server Component — unusable here; branch on the hook.
  const clerk = useClerkIdentity();
  const clerkUser = signedInUser(clerk);
  const [roomId, setRoomId] = useState("");
  // Fixed for the room's lifetime, so deliberately not remembered between visits.
  const [language, setLanguage] = useState<LanguageValue>(DEFAULT_LANGUAGE);
  // INVARIANT: the room ID is minted by the server on submit, never before.
  const [creating, setCreating] = useState(false);
  const [reserving, setReserving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const goToRoom = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    router.push(`/room/${encodeURIComponent(trimmed)}`);
  };

  const handleJoin: SubmitEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    goToRoom(roomId);
  };

  // Creating asks who you are first; joining lets the room itself prompt.
  const handleCreate = () => {
    setCreateError(null);
    setCreating(true);
  };

  const handleIdentitySubmit = async (user: CollabUser) => {
    setActiveUser(user);
    setReserving(true);
    try {
      // Fails closed: an error here beats entering a room that can never sync.
      const newRoomId = await createRoom(language);
      goToRoom(newRoomId);
    } catch (err) {
      setCreating(false);
      // A server that answered and refused said why; only silence is unreachability.
      setCreateError(
        err instanceof RoomCreateError
          ? err.message
          : "Couldn't reach the sync server. Please try again."
      );
    } finally {
      setReserving(false);
    }
  };

  return (
    <>
      <SiteNav />

      <main className="wash relative flex-1 px-4 py-12 sm:py-20">
        <div className="mx-auto grid w-full max-w-5xl items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
              <h1 className="text-4xl font-semibold tracking-tight text-balance text-fg sm:text-5xl">
                Code together, run it together.
              </h1>
              <p className="max-w-md text-base text-pretty text-fg-muted">
                A shared editor with live cursors and sandboxed execution. Spin up a room, send
                the link, and everyone sees the same code and the same results.
              </p>
            </div>

            <div className={cn("flex flex-col gap-4 rounded-2xl border border-edge bg-panel p-5 shadow-xl shadow-[var(--shadow-color)]")}>
              <div className="flex flex-col gap-2">
                <label htmlFor="room-language" className="text-xs font-medium text-fg-muted">
                  Language for this room
                </label>
                <select
                  id="room-language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as LanguageValue)}
                  className={cn(inputField, "cursor-pointer")}
                >
                  {LANGUAGES.map((lang) => (
                    <option key={lang.value} value={lang.value}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>

              <button type="button" onClick={handleCreate} className={cn(primaryButton, "w-full py-2.5")}>
                Create a new room
              </button>

              <div className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-widest text-fg-subtle">
                <span className="h-px flex-1 bg-edge" />
                or
                <span className="h-px flex-1 bg-edge" />
              </div>

              <form onSubmit={handleJoin} className="flex flex-col gap-2">
                <label htmlFor="room-id" className="text-xs font-medium text-fg-muted">
                  Have a room ID?
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id="room-id"
                    type="text"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    placeholder="Paste or type a room ID"
                    className={cn(inputField, "font-mono placeholder:font-sans sm:flex-1")}
                  />
                  <button type="submit" className={cn(secondaryButton, "sm:w-auto")}>
                    Join
                  </button>
                </div>
              </form>

              {/* Static on purpose: equally true signed in or out, and must not shift the card. */}
              <p className="text-center text-xs text-fg-subtle">
                Both work as a <span className="text-fg-muted">guest</span> — no account needed.
              </p>

              {createError && (
                <p
                  role="alert"
                  className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger"
                >
                  {createError}
                </p>
              )}
            </div>
          </div>

          <div className="hidden lg:block">
            <EditorPreview />
          </div>
        </div>

        <ul className="mx-auto mt-16 grid w-full max-w-5xl gap-4 sm:grid-cols-3">
          {FEATURES.map(({ Icon, title, body }) => (
            <li
              key={title}
              className="flex flex-col gap-2 rounded-xl border border-edge bg-panel/60 p-4"
            >
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-soft text-accent">
                <Icon className="h-4 w-4" />
              </span>
              <h2 className="text-sm font-medium text-fg">{title}</h2>
              <p className="text-xs text-pretty text-fg-muted">{body}</p>
            </li>
          ))}
        </ul>
      </main>

      <footer className="border-t border-edge px-4 py-6">
        <p className="mx-auto max-w-5xl text-xs text-fg-subtle">
          Rooms live only while someone is in them. Sign in to keep a snapshot when one closes.
        </p>
      </footer>

      {/* INVARIANT: never gate the dialog on Clerk loading. The `key` remounts it
          once if a signed-in session resolves late; a guest's key never changes. */}
      {creating && (
        <IdentityDialog
          key={clerkUser ? "clerk" : "guest"}
          title="Create a room"
          description="Pick a name so everyone can tell your cursor apart."
          submitLabel="Create & Enter"
          onSubmit={handleIdentitySubmit}
          onCancel={reserving ? undefined : () => setCreating(false)}
          busy={reserving}
          clerkUserId={clerkUser?.clerkUserId}
          clerkPrefill={
            clerkUser
              ? { firstName: clerkUser.firstName, lastName: clerkUser.lastName }
              : null
          }
          signedInAs={clerkUser?.label}
        />
      )}
    </>
  );
}
