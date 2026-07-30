// Next 16 renamed the `middleware` file convention to `proxy`; the code is identical.
import { clerkMiddleware } from "@clerk/nextjs/server";

// INVARIANT: no callback — this attaches the session and protects nothing. `/`,
// `/room/*` and `/api/execute` stay public; page-level `auth()` guards /profile.
export default clerkMiddleware();

export const config = {
  // INVARIANT: keep the matcher — without it an auth hop lands in front of _next/static.
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
