// Imported from the dedicated Edge-safe path, not the package's main barrel
// — the barrel pulls in pg (via resolveRequestContext), which doesn't
// bundle for the Edge runtime this middleware actually runs on.
import { refreshSession } from "@ai-revenue-os/auth/middleware";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  return refreshSession(request);
}

export const config = {
  matcher: [
    // Runs on every route except static assets — session refresh needs to
    // happen on every navigable page/action, not just API routes.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
