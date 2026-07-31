# The UI: design system, room layout, accessibility, and the local actions

Theming, the resizable split, what accessibility work is load-bearing, and the two features that never leave the browser (Save and the keyboard shortcuts).

*Split out of `CLAUDE.md` on 2026-07-31. Same rules apply: this is the **why** — measurements,
rejected alternatives, debugging history. The code carries the rule, this carries the rationale,
and a change that contradicts a paragraph here rewrites it rather than appending a correction.*

## Design system and theming

`web/src/styles/globals.css` holds the whole system: raw token values on `:root` (light) and `.dark`,
surfaced to Tailwind through **`@theme inline`**. `web/src/lib/ui.ts` holds the class strings
built from them.

**`@theme inline` is load-bearing, not stylistic.** A plain `@theme` copies each value into
the generated utilities at build time, so `bg-panel` would bake in the light hex and the
toggle would do nothing. `inline` makes the utility emit `var(--panel)` instead, so flipping
one class on `<html>` re-resolves every utility at once. This is why the tokens are declared
twice: raw custom properties for the values, `@theme inline` for the Tailwind names.

**Tailwind v4's `dark:` variant follows `prefers-color-scheme` by default, which is wrong for
a manual toggle** — someone who picks light on a dark OS would still get every `dark:` rule.
`@custom-variant dark (&:where(.dark, .dark *))` re-points it at the class. `"system"` is
resolved to a concrete class in JS rather than left to CSS, so there is exactly one source of
truth. There is very little `dark:` in the codebase as a result: components use semantic
tokens (`bg-panel`, `text-fg-muted`) and get both themes for free. Reach for `dark:` only
where a value genuinely is not a token — the modal scrim in `IdentityDialog` is the one case.

**The no-flash script must be an inline `<script>` in `<head>`, and nothing React does can
replace it.** By the time hydration runs the browser has already painted the body once, so a
provider-based fix flashes the wrong theme at everyone who chose the non-default. This is the
pattern Next documents for exactly this problem
(`node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`,
"Themes"). `suppressHydrationWarning` on `<html>` is **required** rather than cosmetic: the
script writes `class="dark"` before React hydrates, and without it React treats that as a
mismatch, re-renders from the nearest boundary and undoes it.

**Theme state is an external store, for the same two reasons identity is** (see "Identity is
read via `useSyncExternalStore`"): the server cannot know what is in `localStorage`, so the
server and client snapshots must legitimately differ; and React 19's
`react-hooks/set-state-in-effect` rule rejects the obvious
`useEffect(() => setTheme(readStoredTheme()))`. The store is module scope, so one
`matchMedia` listener serves every consumer and `"system"` keeps tracking the OS live.

**Monaco is themed by prop, never by remount.** `web/src/lib/editor/monacoThemes.ts` registers
`collab-light`/`collab-dark` in `<Editor beforeMount>`, and `EditorPane` switches the `theme`
prop; `@monaco-editor/react` turns that into `monaco.editor.setTheme()`. The custom themes
exist because the built-in `vs`/`vs-dark` backgrounds (`#ffffff`, `#1e1e1e`) match neither
`--code-bg`, so the editor would sit as a visibly different shade inside its own panel.

**A colour that is *not* a token, on purpose:** the `#141414` avatar text in `PresenceStack`
and `IdentityDialog`. It is dark text on the peer's own pastel from `CURSOR_COLORS`, which
are Material 300/400 mid-tones legible in both themes — so it must not follow the theme.
`web/src/lib/collab/cursorStyles.ts` needs no theme work for the same reason.

## The resizable room layout

`react-resizable-panels` **v4**, which is a different library from the v2/v3 API almost every
recipe online describes: it exports `Group` / `Panel` / `Separator`, not
`PanelGroup` / `Panel` / `PanelResizeHandle`; the prop is `orientation`, not `direction`;
`autoSaveId` **does not exist**; and a layout is `{ [panelId]: number }`, not `number[]`.

**The one invariant that matters: `<Editor>` must never unmount.** `useCollabRoom`'s master
effect is keyed on the Monaco instance, so a remount destroys the `Y.Doc`, the provider, the
awareness handler and the `MonacoBinding` — wiping the room's shared output *for everyone*,
re-firing every join toast, and orphaning y-monaco's cursor decorations. Verified against the
v4.12.2 source: `Group` and `Panel` both render `children` unconditionally, `orientation` only
flips the container's flex-direction, and collapsing a panel changes nothing but inline
`flex-grow`/`flex-basis`. Nothing the library does can unmount the editor. What *would*:

- two `<Group>`s behind a ternary (`orientation === "horizontal" ? <Group…> : <Group…>`),
- any `key` on the path from `CodeEditor` down to `EditorPane`,
- conditionally rendering a pane — which is why the phone layout collapses a panel instead of
  switching tabs.

**Test it by asserting the shared output survives, not by looking at the layout.** Run
something, then drag, flip orientation, collapse and expand. If the output panel resets to
"Output will appear here…" or a join toast re-fires, the editor remounted. Checking a second
tab is what makes it unambiguous.

**`Panel`'s `className` lands on its *inner* div, and that div ships an inline
`overflow: auto`.** No Tailwind class beats an inline style, so suppressing it needs
`style={{ overflow: "hidden" }}` — otherwise the panel grows its own scrollbar next to
Monaco's.

**`min-h-0` twice, for two different reasons.** On the panel root it is what lets the pane
shrink below its content when the split is dragged small. On `OutputPanel`'s scroll body it is
what makes `overflow-auto` engage at all: `flex-1` alone leaves `min-height: auto`, i.e. the
content's height, so a long stack trace pushes the panel open instead of scrolling inside it.

**Sizes are deliberately not React state.** `Group` exposes `onLayoutChange` (every
pointermove) and `onLayoutChanged` (once, on release); only the second is wired up, and it
writes through a ref. A re-render of `CodeEditor` mid-drag would hand `<Editor>` a fresh
element and defeat `Panel`'s child bailout. For the same reason `handleRun` and `handleSave` —
both new functions on every keystroke, since they close over `code` — travel only *up* into
`RoomChrome`, never down into the editor panel.

**Numeric sizes are pixels; bare-string sizes are percentages.** `minSize="25"` is 25%,
`collapsedSize={36}` would be 36px. The output panel collapses to `PANEL_STRIP_HEIGHT`
(`"2.25rem"`) when stacked, so the collapsed panel *is* its own tab strip and keeps its own
restore button. Side by side there is nothing legible to leave in a 36px column, so it
collapses to `"0"` and `CodeEditor` lends it a restore button in the editor's tab strip.
Change `PANEL_STRIP_HEIGHT` and the collapsed height must change with it, or collapsing hides
the only control that undoes it.

**Free from `Separator`, so do not rebuild any of it:** `role="separator"`, `tabIndex=0`, the
full `aria-value*` set, arrow keys (±5%), Home/End, Enter to collapse or expand a collapsible
neighbour, F6 to cycle handles, and double-click to reset. Drag state arrives on the
`data-separator` attribute — `inactive | hover | active | focus | disabled` — which is what
the styling keys off. The library also owns the drag cursor (it injects a global `!important`
rule) and inflates the hit rect via `Group`'s `resizeTargetMinimumSize`, so a 1px divider is
already grabbable on a touchscreen and needs no padding-span trick.

**Do not use the `useDefaultLayout` hook.** Its `storage` parameter defaults to a bare
`localStorage` reference evaluated during render, so it throws outright on the server, and its
`getServerSnapshot` is literally the same function as `getSnapshot`, which guarantees a
hydration mismatch on every panel at once. `useRoomLayout` persists one JSON blob itself.

**Phones get a forced stack, not a tab switcher.** `useRoomLayout` watches
`(max-width: 767px)` and overrides the orientation while leaving the stored *preference*
untouched, so rotating back to landscape restores the real choice; the orientation control is
not rendered at that width. A tab switcher was rejected because it either unmounts the editor
or hides it with `display: none`, which reports 0×0 to `automaticLayout`'s ResizeObserver and
can bring Monaco back blank.

**The room page is `h-dvh`, not `h-screen`.** `100vh` on mobile excludes the URL bar, which
used to clip a corner off a fixed-height output strip and would now hide the collapsed output
bar — the one control that brings the output back.

## Accessibility: what is load-bearing

The audit took this from "announced but not honoured" to zero axe violations in both themes. The
parts a future edit could silently undo:

**The room is the screen that needs a landmark most, and had none.** `<main id="main-content">`
lives in *two* places — `CodeEditor` for the live editor and `RoomGate` for the closed/checking
screens — because the editor never mounts in the latter. Removing either brings back three axe
rules at once (`landmark-one-main`, `page-has-heading-one`, and `region` for every control). The
`sr-only` `<h1>` and the skip link in `layout.tsx` are the other half; every page's `<main>` carries
that exact id, and the skip link is the first tab stop.

**The file strip is deliberately NOT an ARIA tablist.** It used to declare `role="tablist"` with
`role="tab"` children and honour almost none of the contract: no `tabpanel` existed anywhere, no
`aria-controls`, and the tablist owned the per-file kebab and "New file" buttons — which that role
may not own, and which was the app's only *critical* violation. Do not "restore" the roles. There
is no panel per tab (one editor swaps its model and must never be keyed or remounted), and a
compliant tablist cannot contain the kebab. `aria-current` says the same thing honestly. The roving
tabindex and Arrow/Home/End stay regardless — 2 tab stops per file is 41 at `MAX_FILES`.

**Two live regions, and one subtlety that makes or breaks both.** `ActivityToasts` and the output
panel announce join/leave and run results. `ActivityToasts` must stay **always mounted** — it used
to `return null` when empty, and a live region that does not exist until its first message arrives
is the classic case screen readers do not announce. Note the roles are split across two nodes:
`role="log"` is not permitted on a `<ul>`, so the wrapper carries it.

**Colour tokens have a foreground partner, and it flips with the theme.** `--accent` and
`--success` are tuned to be legible as *text on a dark background*, which necessarily makes them
*bright backgrounds*. Pairing them with white gave **2.54:1** on the dark theme's Run button — the
worst ratio on the site. Hence `--success-contrast` and a theme-dependent `--accent-contrast`.
**Never write `text-white` on `bg-accent` or `bg-success`.** When changing any of these, compute the
ratio against every background the token is actually used on, hover states included — not just
against white.

**Known gap, deliberately not fixed:** Monaco is a forward keyboard trap (WCAG 2.1.2). Tab inserts a
tab character; only Shift+Tab or Monaco's undiscoverable `Ctrl+M` escapes. Configuring
`accessibilitySupport` or surfacing the hint is the fix if this is ever revisited.

## Keyboard shortcuts (task 10.5)

Ctrl/Cmd+Enter runs, Ctrl/Cmd+S saves. Both are registered on the Monaco instance in
`web/src/hooks/useEditorShortcuts.ts`.

**They must never become a `window` keydown listener.** The room has other focusable controls,
so a global handler would fire Run while someone is typing in the stdin box, in §10.1's inline
new-file/rename field, or — once §10.2 lands — in the chat box. (That list used to start with the
language select, which §10.1 removed from the room; the filename field replaced it as the reason,
and that field additionally calls `stopPropagation` on its own keydowns.)

**Registered once, handlers read through refs.** `handleRun`/`handleSave` close over `code`, so
they are new functions on every keystroke; an effect depending on them directly would tear down
and re-register the keybindings sixty times a minute. Same latest-value-ref pattern
`useCollabRoom` uses for `onRoomClosed` and the Clerk token. Use `editor.addAction`, not
`addCommand` — it returns an `IDisposable`, and it also lists both actions in Monaco's F1
palette for free.

**Neither action re-checks the room-wide `"running"` lock, deliberately.** `useCodeRunner`
already returns early when the shared map reads `"running"`, so the shortcut inherits exactly
the button's guard instead of keeping a second copy that could drift.

**`KeyMod`/`KeyCode` come from `onMount`'s second argument** (`MonacoApi` in
`web/src/lib/editor/monacoTypes.ts`), never a static `import "monaco-editor"` — that touches `window` at import
time, which is the whole reason that file exists.

**Monaco's `preventDefault` only holds while the editor has focus, and that is a real gap.**
With focus on a button or on the stdin textarea, Ctrl+S still opens the browser's save dialog.
The sanctioned fix is *element-scoped*, not global: the stdin textarea carries its own
`onKeyDown` in `CodeEditor`. Anything else that becomes focusable and deserves these keys gets
the same treatment — not a `window` listener.

**The empty-document guard lives in `handleSave`, not only on the button.** The shortcut does
not consult `disabled`, so before that moved, Ctrl+S downloaded an empty file where the button
was visibly off.

## Saving (the Save button)

Since 7.4 `web/src/lib/editor/download.ts` has a second caller — `/profile`'s Download button, which saves a
dead room's files. That does not change anything below: it is still a Blob and an `<a
download>`, still nothing stored, and it is neither a Run nor a Rejoin, which is what §8
forbids on a dead room.

Save is the mirror image of Run: **entirely local**, and deliberately so. `web/src/lib/editor/download.ts`
builds a `Blob`, clicks a throwaway `<a download>`, and revokes the object URL — no Yjs write,
no request to the server, nothing stored anywhere (v1's core principle: "saving a file means
downloading it to the user's device"). v2 keeps Save local; the only thing that ever reaches
Postgres is the automatic dead-room snapshot, never a Save click.

**§10.1 gave Save two shapes, and neither changes where it goes.** One file downloads directly;
2+ files zip into `project.zip` through `downloadZipFile`, which loads JSZip behind a **dynamic**
`import("jszip")` so ~100 KB of zip library never enters the room route's first chunk. That makes
`downloadZipFile` async where `downloadTextFile` is not — harmless, because a programmatic
`<a download>` click needs no user activation.

**Save reads the shared doc, not Monaco.** A file that has never been opened in this tab has no
Monaco model, so `CodeEditor`'s `code` mirror only ever holds the *active* file; `handleSave`
walks `room.files` and calls `readFile(id)`, which reads each `Y.Text` directly. This is also why
Save's disabled state is now "a single file that is empty" rather than "the document is empty":
with two files there is always an archive worth producing, and `handleSave` still refuses an empty
single file so the Ctrl+S shortcut inherits exactly the button's guard.

**An earlier version of this section said the filename must stay off the shared `Y.Doc` because
the language selector is a per-user editing preference, and that the selector *is* the file tab —
a `<select>` layered invisibly over it, matched in tests on `select[aria-label="Language"]`.
§10.1 made all of that false.** The language is now a property of the room, chosen on the
creation screen and fixed for its lifetime, so every peer downloads the same filenames; the tab
strip holds real file tabs and there is no language `<select>` in the room at all. Tests that
matched that selector must now use the landing page's `#room-language` instead. What survives is
the *reason* the old design existed — one idea in one place: the filename is still derived from
the language, only now at file creation rather than on every render.

**`web/src/lib/editor/languages.ts` is the only place languages are enumerated.** It holds the dropdown
labels, the Monaco/Piston language ids, and the file extensions; the editor components and
`app/api/execute/route.ts` both import from it, and the route keeps only the pinned Piston
*versions* (a property of the sandbox image, not the language). The extension list used to
live solely in the route's `LANGUAGE_MAP`, which the client cannot import — it pulls in
`next/server` — so a Save button would have meant a second, silently-diverging copy.

**Java is the one capitalized filename.** `downloadFileName()` returns `Main.java`, not
`main.java`, because javac requires a public class to live in a file named after it; every
other language gets `main.<ext>`, matching the name the execute route hands Piston. Note the
route deliberately still sends `main.java` — Piston's payload filename is unrelated to the
local download, and changing it risks that runtime.

Save's only disabled state is an empty document. It has no equivalent of Run's room-wide
`"running"` lock, since there is nothing for two clickers to contend over.

