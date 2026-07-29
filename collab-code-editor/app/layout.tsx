import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/ui/themes";
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
            above still applies directly to the page. Clerk's components ship a
            light default that would glare inside a #141414 app, so the dark
            theme is applied here once rather than per component; `colorPrimary`
            is --color-accent from globals.css so Clerk's buttons match ours. */}
        <ClerkProvider appearance={{ theme: dark, variables: { colorPrimary: "#4c8dff" } }}>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
