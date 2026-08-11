import * as Sentry from "@sentry/nextjs";
import { sharedSentryInit } from "./sentry.shared-config";

// TEMPORARY (M1.8 staging diagnosis): debug:true plus a startup line
// confirming SENTRY_DSN's *presence* (never its value) — the fastest way
// to distinguish "DSN never reached the runtime" from "DSN reached the
// runtime but something else is wrong" via Vercel Runtime Logs, without
// guessing. Revert together with removing debug-throw-temp once the
// Preview verification is conclusively resolved.
//
// BUILD_MARKER proves this exact deployment is running the code from
// commit 0461948 (the flush() fix) — if this string is absent from the
// logs, the Preview isn't running the code we think it is.
const BUILD_MARKER = "diag-0461948-transport-debug";

// The transport's request URL carries the DSN's public key as a
// `sentry_key` query parameter — strip it before ever logging the URL.
// Host/path (project id) are the only routing info we actually need.
function redactTransportUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("sentry_key");
    return parsed.toString();
  } catch {
    return "PARSE_ERROR";
  }
}

let dsnHost: string | null = null;
let dsnProjectId: string | null = null;
if (process.env.SENTRY_DSN) {
  try {
    const parsed = new URL(process.env.SENTRY_DSN);
    dsnHost = parsed.hostname;
    dsnProjectId = parsed.pathname.replace(/^\//, "");
  } catch {
    dsnHost = "PARSE_ERROR";
  }
}

console.log(
  JSON.stringify({
    diagnostic: "sentry-server-config-init",
    buildMarker: BUILD_MARKER,
    sentryDsnConfigured: Boolean(process.env.SENTRY_DSN),
    sentryDsnLength: process.env.SENTRY_DSN?.length ?? 0,
    // Host and project id are routing info, not the DSN's secret/public
    // key component (that's the URL's userinfo segment, never logged).
    dsnHost,
    dsnProjectId,
    expectedProjectId: "4511886719189080",
    projectIdMatches: dsnProjectId === "4511886719189080",
  }),
);

Sentry.init({
  ...sharedSentryInit,
  debug: true,
  // Wraps the SDK's own real Node transport — delivery still happens via
  // the identical underlying mechanism, this only observes it. Proves (a)
  // an envelope send is actually attempted, (b) what Sentry's ingest
  // server actually responded with (status code — 200 means accepted,
  // 4xx/429 means rejected/rate-limited, a thrown error means the request
  // never completed), which the SDK's own "No outcomes to send" debug line
  // does not surface on its own.
  transport: (options: Parameters<typeof Sentry.makeNodeTransport>[0]) => {
    const realTransport = Sentry.makeNodeTransport(options);
    return {
      send: async (envelope: Parameters<typeof realTransport.send>[0]) => {
        console.log(
          JSON.stringify({ diagnostic: "sentry-transport-send-attempt", url: redactTransportUrl(options.url) }),
        );
        try {
          const result = await realTransport.send(envelope);
          console.log(JSON.stringify({ diagnostic: "sentry-transport-send-result", result }));
          return result;
        } catch (error) {
          console.log(
            JSON.stringify({
              diagnostic: "sentry-transport-send-error",
              error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
            }),
          );
          throw error;
        }
      },
      flush: (timeout?: number) => realTransport.flush(timeout),
    };
  },
});
