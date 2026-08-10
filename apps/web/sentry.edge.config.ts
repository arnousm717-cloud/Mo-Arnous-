import * as Sentry from "@sentry/nextjs";
import { sharedSentryInit } from "./sentry.shared-config";

// TEMPORARY (M1.8 staging diagnosis) — see sentry.server.config.ts for why.
console.log(
  JSON.stringify({
    diagnostic: "sentry-edge-config-init",
    sentryDsnConfigured: Boolean(process.env.SENTRY_DSN),
    sentryDsnLength: process.env.SENTRY_DSN?.length ?? 0,
  }),
);

Sentry.init({ ...sharedSentryInit, debug: true });
