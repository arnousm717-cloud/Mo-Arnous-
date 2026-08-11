import type * as Sentry from "@sentry/nextjs";
import { redactDeep } from "./app/api/v1/_shared/redaction";

/**
 * Shared Sentry init options for both the server and Edge runtimes (M1.8).
 * Deliberately minimal, per the approved plan's data-minimization
 * requirements:
 *   - sendDefaultPii is explicitly false — Sentry must not attach cookies,
 *     IP addresses, or other default-PII request context on its own.
 *   - tracesSampleRate is omitted (tracing/APM disabled) — not required by
 *     this milestone, and enabling it would be new scope beyond error
 *     capture.
 *   - No session replay / browser integrations — server and Edge SDKs
 *     don't ship them, and browser-side capture is explicitly out of scope
 *     for M1.8 (Decision F).
 *   - beforeSend/beforeSendTransaction run every outgoing event through the
 *     same shared redaction function the structured logger uses
 *     (_shared/redaction.ts) — one redaction rule set, not two that could
 *     drift. This is the actual point where "before data leaves the
 *     process" is enforced, not just documented.
 */
type InitOptions = Parameters<typeof Sentry.init>[0];
type BeforeSend = NonNullable<NonNullable<InitOptions>["beforeSend"]>;
type BeforeSendTransaction = NonNullable<NonNullable<InitOptions>["beforeSendTransaction"]>;

export const beforeSend: BeforeSend = (event) => redactDeep(event);

export const beforeSendTransaction: BeforeSendTransaction = (event) => redactDeep(event);

export const sharedSentryInit: InitOptions = {
  dsn: process.env.SENTRY_DSN,
  // Vercel's own per-deployment signal (preview/production/development) —
  // without this, the SDK falls back to a hardcoded "production" tag on
  // every event regardless of which Vercel environment actually sent it,
  // which is misleading and can hide events under an unexpected filter.
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  sendDefaultPii: false,
  beforeSend,
  beforeSendTransaction,
};
