"use client";

// Replaces the root layout when it throws, so the CSS import, the theme script
// and <html>/<body> must all be repeated here — no providers reach this page.

import { THEME_SCRIPT } from "@/lib/theme";
import "@/styles/globals.css";

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
        <main id="main-content" className="flex flex-1 items-center justify-center px-4 py-16">
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
              {/* INVARIANT: a plain anchor, not next/link — a hard reload is the point. */}
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
