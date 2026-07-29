import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
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
  title: "Collaborative Code Editor",
  description:
    "Real-time collaborative code editor with multi-cursor editing and sandboxed code execution.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning covers only this tag's own attributes, so it
    // silences markers browser extensions add to <html> without hiding a real
    // mismatch anywhere else. We set no attributes here ourselves.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Inside <body>, not wrapping <html> — Clerk's explicit instruction.
            ClerkProvider renders no DOM element of its own, so the flex column
            above still applies directly to the page.

            Themed with `variables` only, and deliberately NOT with the `dark`
            theme from `@clerk/ui`: that theme is a separate runtime bundle
            Clerk fetches from its CDN, and on the room route Monaco's AMD
            loader has already installed a global `define.amd`, which makes that
            UMD bundle register itself as an AMD module instead of executing.
            Clerk then fails with `failed_to_load_clerk_ui` and never finishes
            loading — so a signed-in user deep-linking into a room silently got
            no Clerk session at all. It is a race (Monaco vs the CDN), so it
            reproduced only sometimes, which is what made it worth this comment.
            These variables ship inside clerk-js itself and need no extra
            bundle. Values are --color-app/panel/edge/accent from globals.css. */}
        <ClerkProvider
          appearance={{
            variables: {
              colorPrimary: "#4c8dff",
              colorBackground: "#1b1b1b",
              colorForeground: "#fafafa",
              colorInput: "#232323",
              colorInputForeground: "#fafafa",
              colorNeutral: "#ffffff",
              colorBorder: "#2e2e2e",
            },
          }}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
