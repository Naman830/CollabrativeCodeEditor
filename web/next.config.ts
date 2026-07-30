import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// The sync server is a different origin on a different port, so `'self'` does not cover it and
// omitting these breaks sync outright — the loudest way to get a CSP wrong here. Derived from the
// one env var the client already uses, so there is no second value to drift.
const syncOrigins = (() => {
  try {
    const { host, protocol } = new URL(process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080");
    const secure = protocol === "wss:";
    return [`${secure ? "wss" : "ws"}://${host}`, `${secure ? "https" : "http"}://${host}`];
  } catch {
    return [];
  }
})();

// pk_(test|live)_<base64("<frontendApi>$")> — the same derivation @clerk/shared performs. The
// wildcard stays for keyless mode, whose throwaway instance host is unknown at build time.
const clerkOrigins = (() => {
  const wildcard = ["https://*.clerk.accounts.dev"];
  const encoded = (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "").split("_")[2];
  if (!encoded) return wildcard;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const host = decoded.endsWith("$") ? decoded.slice(0, -1) : decoded;
    return host ? [...wildcard, `https://${host}`] : wildcard;
  } catch {
    return wildcard;
  }
})();

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // 'unsafe-inline' is load-bearing, not laziness: the App Router streams its RSC payload as
  // inline <script> tags, and the no-flash theme script in layout.tsx (and global-error.tsx,
  // which can never receive a nonce) must run before first paint. A nonce would fix this but
  // forces every route into dynamic rendering and must be threaded to <ClerkProvider nonce>
  // or clerk-js is silently blocked. Recorded as future scope.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} ${clerkOrigins.join(" ")}`,
  // Unavoidable, three times over: cursorStyles.ts writes a dynamic <style>, Monaco injects its
  // own at runtime, and inline `style` attributes (which no nonce can cover) are required to beat
  // react-resizable-panels' own inline overflow. The peer-colour vector is closed by readPeers
  // and readExecutionState, not by CSP.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://img.clerk.com",
  "font-src 'self' data:",
  `connect-src 'self' ${syncOrigins.join(" ")} ${clerkOrigins.join(" ")} https://clerk-telemetry.com https://*.clerk-telemetry.com`,
  // Monaco configures no worker today (verified: no MonacoEnvironment anywhere), so this is
  // headroom rather than a requirement — but it keeps a future worker from being a mystery.
  "worker-src 'self' blob:",
  // Turnstile guards Clerk sign-up.
  "frame-src 'self' https://challenges.cloudflare.com",
  // Production only: it would upgrade ws://<lan-ip>:8080 and break the documented
  // "test multiplayer from a phone on the LAN" workflow.
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Origin-only cross-origin, so a room ID — which is a capability, since holding one is what
  // lets you join — never leaves in a Referer to clerk.accounts.dev or anywhere else.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=(), payment=()" },
  // INVARIANT: allow-popups, NOT 'same-origin'. Clerk's OAuth providers open a popup and
  // postMessage back through window.opener; plain 'same-origin' severs that and sign-in hangs
  // with no error banner — the same silent Clerk failure mode as the old AMD-loader bug.
  // Deliberately no Cross-Origin-Embedder-Policy: it would need CORP headers on clerk-js,
  // which Clerk does not send, and would break auth.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // Report-only first, on purpose. Enforcing before a full manual pass risks a missed
  // connect-src entry taking sync or auth down with no report phase to catch it. Flip the key to
  // "Content-Security-Policy" once the console is clean across every flow.
  { key: "Content-Security-Policy-Report-Only", value: csp },
  // No includeSubDomains and no preload: both are effectively irreversible and need every
  // subdomain of the production domain confirmed HTTPS-only first.
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
