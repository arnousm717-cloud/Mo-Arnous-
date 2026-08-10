import * as Sentry from "@sentry/nextjs";
import { sharedSentryInit } from "./sentry.shared-config";

// TEMPORARY (M1.8 staging diagnosis): debug:true plus a startup line
// confirming SENTRY_DSN's *presence* (never its value) — the fastest way
// to distinguish "DSN never reached the runtime" from "DSN reached the
// runtime but something else is wrong" via Vercel Runtime Logs, without
// guessing. Revert together with removing debug-throw-temp once the
// Preview verification is conclusively resolved.
console.log(
  JSON.stringify({
    diagnostic: "sentry-server-config-init",
    sentryDsnConfigured: Boolean(process.env.SENTRY_DSN),
    sentryDsnLength: process.env.SENTRY_DSN?.length ?? 0,
  }),
);

Sentry.init({ ...sharedSentryInit, debug: true });
