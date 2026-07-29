"use client";

// The last resort: a throw in the root layout itself, which means the normal
// layout never rendered. This component *replaces* it, so it has to supply its
// own <html> and <body> — and it gets none of the providers, which is why there
// is no theme toggle, no Clerk session and no site nav here.
//
// Two consequences worth stating, because both look like omissions:
//
//   * `globals.css` is imported directly. Without it this page has no tokens and
//     no Tailwind at all, and renders as unstyled black-on-white.
//   * The theme script is inlined again. `app/layout.tsx`'s copy never ran —
//     that layout is what failed — so without this the crash page ignores a
//     saved dark preference and flashes white. It is the same constant, so the
//     two cannot drift.
//
// `next/font` is not re-declared: its CSS variable lives on the real layout's
// <html>, which does not exist here, so `body` falls through to the
// `system-ui, sans-serif` already in the `globals.css` font stack.

import { THEME_SCRIPT } from "./lib/theme";
import "./globals.css";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col bg-app text-fg">
        <main className="flex flex-1 items-center justify-center px-4 py-16">
          <div className="flex max-w-sm flex-col items-center gap-4 rounded-2xl border border-edge bg-panel p-8 text-center shadow-xl shadow-[var(--shadow-color)]">
            <span className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-raised text-danger">
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5"
              >
                <path d="M12 4 2.5 20h19z" />
                <path d="M12 10v4M12 17.5h.01" />
              </svg>
            </span>

            <h1 className="text-xl font-semibold text-fg">The app failed to start</h1>
            <p className="text-sm text-fg-muted">
              Something went wrong before the page could load. Reloading usually fixes it.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => unstable_retry()}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-contrast transition-colors hover:bg-accent-strong"
              >
                Try again
              </button>
              {/* A plain anchor, deliberately: `next/link` does a *client-side*
                  navigation, and this page only renders when the React tree
                  above it has already failed to render. A hard reload is the
                  point — it rebuilds the app from scratch rather than asking the
                  broken tree to route somewhere. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/"
                className="rounded-lg border border-edge bg-raised px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-edge-strong hover:bg-edge"
              >
                Back to home
              </a>
            </div>

            {error.digest && (
              <p className="font-mono text-[11px] text-fg-subtle">Reference: {error.digest}</p>
            )}
          </div>
        </main>
      </body>
    </html>
  );
}
