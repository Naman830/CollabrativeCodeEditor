// Next 16 renamed the `middleware` file convention to `proxy` (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// Every `middleware.ts` Clerk recipe online predates that rename; the code inside
// is identical, only the filename and exported function name changed.
import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Called with no callback on purpose: this attaches the Clerk session to the
 * request and protects *nothing*. Guests must keep reaching `/`, `/room/*` and
 * `/api/execute` exactly as they did in v1 — adding a guard here is what would
 * break the guest flow that task 7.1 exists to preserve.
 *
 * The one protected surface v2 plans is `/profile` (task 7.4), and Clerk now
 * wants that checked in the page itself — `createRouteMatcher` is deprecated in
 * favour of resource-based checks.
 */
export default clerkMiddleware();

export const config = {
  // Clerk's own matcher: everything except Next internals and static assets,
  // plus API routes and Clerk's `/__clerk` handshake endpoints. Without a
  // matcher, proxy runs on every request including `_next/static`, which would
  // put an auth hop in front of the CSS and JS.
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
