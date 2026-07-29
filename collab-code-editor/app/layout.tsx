import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import AppProviders from "./components/AppProviders";
import { THEME_SCRIPT } from "./lib/theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Collaborative Code Editor",
    template: "%s · Collaborative Code Editor",
  },
  description:
    "Real-time collaborative code editor with multi-cursor editing and sandboxed code execution.",
};

export const viewport: Viewport = {
  // Matches --app in globals.css for each theme, so the mobile browser's own
  // chrome blends with the page instead of framing it in the wrong colour.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0d10" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning covers only this tag's own attributes. It is
    // required rather than cosmetic: the inline script below writes `class="dark"`
    // onto <html> before React hydrates, and without this React would treat that
    // as a mismatch, re-render from the nearest boundary and undo it. It also
    // still silences markers browser extensions add here.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Runs synchronously during HTML parsing, before first paint, so the
            saved theme is applied with no flash of the wrong one. This is the
            pattern Next documents for exactly this problem (see
            `docs/01-app/02-guides/preventing-flash-before-hydration.md`,
            "Themes"). It cannot be done in React: by the time hydration runs the
            browser has already painted the body once. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col bg-app text-fg">
        {/* Providers live inside <body>, per Clerk's instruction. Neither renders
            a DOM element of its own, so the flex column above still applies
            directly to the page. */}
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
