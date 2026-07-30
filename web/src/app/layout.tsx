import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import AppProviders from "@/components/layout/AppProviders";
import { THEME_SCRIPT } from "@/lib/theme";
import "@/styles/globals.css";

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
  // Keep in sync with --app in src/styles/globals.css.
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
    // INVARIANT: suppressHydrationWarning is required — the script below writes
    // class="dark" pre-hydration, and React would otherwise undo it.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* INVARIANT: must stay an inline <head> script — React cannot beat first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col bg-app text-fg">
        {/* The first tab stop on every page. Visually hidden until focused, which is the whole
            point — reaching the editor in a room otherwise costs 11 Tab presses, every time
            focus resets. Every page's <main> carries id="main-content". */}
        <a
          href="#main-content"
          className="sr-only rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-contrast focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100]"
        >
          Skip to main content
        </a>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
