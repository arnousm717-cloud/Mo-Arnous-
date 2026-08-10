/**
 * Next.js instrumentation hook (App Router). `register()` loads the
 * runtime-appropriate Sentry config; `onRequestError` is Next.js 15's own
 * hook for reporting server-side errors (Route Handlers, Server
 * Components, Server Actions) — re-exporting Sentry's `captureRequestError`
 * here is what wires automatic error capture into it (M1.8).
 *
 * No Supabase Edge Function exists in this codebase yet (verified by
 * direct search) — this instruments only the runtime surfaces that
 * actually exist today (`apps/web`'s Node server runtime and Next.js's own
 * Edge runtime for middleware). Edge Function instrumentation is deferred
 * until one exists; see docs/08-Security.md §7.1 and CHANGELOG.md.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Fail-open by design (M1.8 requirement): Next.js already decided the
 * actual error response before calling this hook — it is a reporting
 * side-channel, not part of the request path. Even so, a failure here must
 * never propagate, regardless of how Next.js's own runtime would otherwise
 * treat a throw from an instrumentation hook.
 */
export const onRequestError = async (
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
): Promise<void> => {
  try {
    const { captureRequestError } = await import("@sentry/nextjs");
    captureRequestError(...args);
  } catch {
    // Deliberately swallowed — see the fail-open note above.
  }
};
