const { withSentryConfig } = require("@sentry/nextjs");

// Server-side error capture only for M1.8 (Decision F) — a global-error.js
// file would add browser-side React render error reporting, which is
// deliberately out of scope, not an oversight. Suppresses Sentry's build
// warning suggesting one.
process.env.SENTRY_SUPPRESS_GLOBAL_ERROR_HANDLER_FILE_WARNING = "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship raw TypeScript source (no build step, per
  // packages/database and packages/auth's "exports": "./src/index.ts") —
  // this tells Next.js's own compiler to transpile them directly rather
  // than expecting pre-built JS.
  transpilePackages: ["@ai-revenue-os/auth", "@ai-revenue-os/tenancy", "@ai-revenue-os/database"],
};

module.exports = withSentryConfig(nextConfig, {
  silent: true,
  // Source-map upload requires a Sentry auth token this environment
  // doesn't have configured yet (M1.8 is server-side error capture only —
  // readable stack traces are a separate, later concern). Disabled rather
  // than left to fail/warn on every build.
  sourcemaps: { disable: true },
  // autoInstrumentServerFunctions/autoInstrumentAppDirectory/
  // autoInstrumentMiddleware all default to true — left at their defaults
  // deliberately, then verified empirically (not assumed) against a real
  // build; see the M1.8 closeout report for what was actually confirmed.
});
