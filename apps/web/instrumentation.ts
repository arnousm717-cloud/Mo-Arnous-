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
 *
 * The explicit `flush()` below is required, not optional, on a Vercel
 * Node.js Serverless Function (as opposed to Vercel Edge Runtime). Root
 * cause (confirmed by reading @sentry/core's own source, not assumed):
 * `@sentry/nextjs`'s automatic route-handler wrapping schedules its
 * post-response flush via `vercelWaitUntil()`
 * (@sentry/core/build/cjs/utils/vercelWaitUntil.js), which only calls
 * `ctx.waitUntil(...)` when `typeof EdgeRuntime === "string"` — true for
 * Vercel Edge Runtime, always false for a plain Node.js Serverless
 * Function. For every route in this app (none opt into `export const
 * runtime = "edge"`), that check silently no-ops: the automatic capture
 * still marks and queues the event (hence "Captured error event" in the
 * logs), but nothing keeps the function alive long enough for the queued
 * envelope to actually finish sending before Vercel freezes the
 * invocation — the event is captured but never delivered. Awaiting
 * `flush()` here, inside a hook Next.js itself awaits before the request
 * lifecycle ends, blocks exactly long enough for delivery regardless of
 * that upstream gap.
 */
export const onRequestError = async (
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
): Promise<void> => {
  try {
    const { captureRequestError, flush } = await import("@sentry/nextjs");
    captureRequestError(...args);
    await flush(2000);
  } catch {
    // Deliberately swallowed — see the fail-open note above.
  }
};
