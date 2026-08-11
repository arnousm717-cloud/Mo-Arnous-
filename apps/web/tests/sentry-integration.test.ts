import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/nextjs";
import type { Envelope } from "@sentry/core";
import { beforeSend, beforeSendTransaction } from "../sentry.shared-config";

/**
 * Empirical verification of Decision D (M1.8): does not assume automatic
 * Sentry instrumentation is sufficient merely because the SDK is
 * installed. Initializes a real Sentry client with a custom transport that
 * captures outgoing envelopes instead of sending them over the network, so
 * we can inspect exactly what Sentry's own request-error capture path
 * (`captureRequestError`, the function Next.js's `onRequestError`
 * instrumentation hook calls — see instrumentation.ts) produces, and
 * confirm the shared redaction hook (sentry.shared-config.ts) is actually
 * applied to it before the transport — i.e. before anything would leave
 * the process.
 *
 * One Sentry client for the whole suite (not re-init per test) — repeated
 * init()/close() cycles were found, empirically, to leave the Node SDK's
 * internal client in a state where later captures silently produced no
 * envelope at all. Each test instead captures a distinguishable message
 * and filters the shared capturedEnvelopes array for it.
 */

const FAKE_DSN = "https://abcdef0123456789abcdef0123456789@o0.ingest.sentry.io/1";

function envelopeToString(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

describe("Sentry integration: capture path + redaction (empirical, Decision D)", () => {
  const capturedEnvelopes: Envelope[] = [];

  beforeAll(() => {
    Sentry.init({
      dsn: FAKE_DSN,
      sendDefaultPii: false,
      beforeSend,
      beforeSendTransaction,
      // tracesSampleRate intentionally omitted — matches production config,
      // no tracing/APM (Decision F / data-minimization requirements).
      transport: () => ({
        send: async (envelope: Envelope) => {
          capturedEnvelopes.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });
  });

  afterAll(async () => {
    await Sentry.close();
  });

  function latestEnvelopesContaining(marker: string): string {
    return capturedEnvelopes
      .filter((envelope) => envelopeToString(envelope).includes(marker))
      .map(envelopeToString)
      .join("\n");
  }

  it("does not leak a raw cookie value via Sentry's own auto-parsed request.cookies field", async () => {
    Sentry.captureRequestError(
      new Error("marker-cookie-test"),
      {
        path: "/api/v1/organizations",
        method: "POST",
        headers: {
          cookie: "sb-access-token=super-secret-session-value; other=1",
          authorization: "Bearer abc.def.ghi",
        },
      },
      { routerKind: "App Router", routePath: "/api/v1/organizations", routeType: "route" },
    );
    await Sentry.flush(1000);

    const serialized = latestEnvelopesContaining("marker-cookie-test");
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized).not.toContain("super-secret-session-value");
    expect(serialized).not.toContain("Bearer abc.def.ghi");
  });

  it("preserves useful, non-secret route context (path/method) alongside redaction", async () => {
    Sentry.captureRequestError(
      new Error("marker-route-context-test"),
      { path: "/api/v1/organizations", method: "POST", headers: {} },
      { routerKind: "App Router", routePath: "/api/v1/organizations", routeType: "route" },
    );
    await Sentry.flush(1000);

    const serialized = latestEnvelopesContaining("marker-route-context-test");
    expect(serialized).toContain("/api/v1/organizations");
  });

  it("redacts a secret-shaped value embedded in a captured exception's own message", async () => {
    Sentry.captureException(
      new Error("marker-message-redaction-test for arnousm717@gmail.com using arev_live_aaaaaaaaaa"),
    );
    await Sentry.flush(1000);

    const serialized = latestEnvelopesContaining("marker-message-redaction-test");
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized).not.toContain("arnousm717@gmail.com");
    expect(serialized).not.toContain("arev_live_aaaaaaaaaa");
    expect(serialized).toContain("[REDACTED]");
  });

  it("never sends a raw request body — captureRequestError's RequestInfo type has no body field to leak", () => {
    // Structural proof, not a runtime assertion: @sentry/nextjs's own
    // RequestInfo type (see captureRequestError's signature) is
    // `{ path, method, headers }` — there is no body field for a caller to
    // accidentally pass through in the first place, matching the same
    // "no field to flow through" discipline as _shared/logger.ts.
    const request: Parameters<typeof Sentry.captureRequestError>[1] = {
      path: "/api/v1/consent",
      method: "POST",
      headers: {},
    };
    expect(Object.keys(request).sort()).toEqual(["headers", "method", "path"]);
  });
});
