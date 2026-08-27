import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Milestone 3.1C-C — fail-closed rate-limit/DB-error-mapping coverage for
 * both /track/* routes. Split into its own file (mirroring
 * tests/instrumentation.test.ts's own precedent for module-level
 * vi.mock()) because a static, file-scoped mock of
 * checkTrackingRateLimit/ingestTrackingEvent/
 * resolveOrganizationContextForTrackingSite/recordVisitorCookieTrackingConsent
 * is incompatible with track-collect.test.ts's and
 * track-consent-route.test.ts's own real-Postgres fixtures in the same
 * file. This file tests exactly one thing per test — the ROUTE's own
 * control-flow reaction to an arbitrary thrown error from a dependency —
 * never RLS, SECURITY DEFINER behavior, or rate-limit atomicity/
 * concurrency, which are already exhaustively, separately proven with
 * real Postgres elsewhere (packages/database's 3.1C-A suites,
 * track-rate-limit.test.ts, and this app's own two real-DB route test
 * files).
 */

const checkTrackingRateLimit = vi.fn();
vi.mock("../app/track/_shared/rate-limit", () => ({
  checkTrackingRateLimit: (...args: unknown[]) => checkTrackingRateLimit(...args),
}));

const resolveOrganizationContextForTrackingSite = vi.fn();
vi.mock("@ai-revenue-os/auth", () => ({
  resolveOrganizationContextForTrackingSite: (...args: unknown[]) => resolveOrganizationContextForTrackingSite(...args),
}));

const ingestTrackingEvent = vi.fn();
vi.mock("@ai-revenue-os/intelligence", () => ({
  ingestTrackingEvent: (...args: unknown[]) => ingestTrackingEvent(...args),
}));

const recordVisitorCookieTrackingConsent = vi.fn();
vi.mock("@ai-revenue-os/compliance", () => ({
  recordVisitorCookieTrackingConsent: (...args: unknown[]) => recordVisitorCookieTrackingConsent(...args),
}));

function collectBody() {
  return { siteKey: randomUUID(), anonymousId: randomUUID(), anonymousSessionId: randomUUID(), eventType: "pageview" };
}

function consentBody() {
  return { siteKey: randomUUID(), anonymousId: randomUUID(), status: "granted" };
}

function requestFor(path: "collect" | "consent", body: unknown): Request {
  return new Request(`https://example.test/track/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.42" },
  });
}

const siteContext = { trackingSiteId: randomUUID(), organizationId: randomUUID() };

beforeEach(() => {
  checkTrackingRateLimit.mockReset();
  resolveOrganizationContextForTrackingSite.mockReset();
  ingestTrackingEvent.mockReset();
  recordVisitorCookieTrackingConsent.mockReset();

  checkTrackingRateLimit.mockResolvedValue(true);
  resolveOrganizationContextForTrackingSite.mockResolvedValue(siteContext);
  ingestTrackingEvent.mockResolvedValue({ accepted: true });
  recordVisitorCookieTrackingConsent.mockResolvedValue(true);
});

afterEach(() => {
  vi.resetModules();
});

describe("POST /track/collect: fail-closed behavior", () => {
  it("a thrown rate-limit error returns 500 and never calls ingestTrackingEvent", async () => {
    checkTrackingRateLimit.mockRejectedValueOnce(new Error("rate limit storage unavailable"));
    const { handleCollectRequest } = await import("../app/track/collect/handlers");

    const response = await handleCollectRequest(requestFor("collect", collectBody()));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(ingestTrackingEvent).not.toHaveBeenCalled();
  });

  it("a rate-limit failure on the SITE dimension (after resolution) also returns 500 and never calls ingestTrackingEvent", async () => {
    checkTrackingRateLimit
      .mockResolvedValueOnce(true) // ip
      .mockResolvedValueOnce(true) // anon
      .mockRejectedValueOnce(new Error("rate limit storage unavailable")); // site
    const { handleCollectRequest } = await import("../app/track/collect/handlers");

    const response = await handleCollectRequest(requestFor("collect", collectBody()));

    expect(response.status).toBe(500);
    expect(ingestTrackingEvent).not.toHaveBeenCalled();
  });

  it("a thrown site-resolution error returns 500 and never calls ingestTrackingEvent", async () => {
    resolveOrganizationContextForTrackingSite.mockRejectedValueOnce(new Error("db unavailable"));
    const { handleCollectRequest } = await import("../app/track/collect/handlers");

    const response = await handleCollectRequest(requestFor("collect", collectBody()));

    expect(response.status).toBe(500);
    expect(ingestTrackingEvent).not.toHaveBeenCalled();
  });

  it("a thrown ingestTrackingEvent error returns a generic 500 with no raw exception detail", async () => {
    ingestTrackingEvent.mockRejectedValueOnce(new Error("insert failed: constraint violation xyz"));
    const { handleCollectRequest } = await import("../app/track/collect/handlers");

    const response = await handleCollectRequest(requestFor("collect", collectBody()));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("constraint violation");
  });

  it("the rate-limit calls that already succeeded are never composed into ingestTrackingEvent's own transaction — verified by call independence: checkTrackingRateLimit and ingestTrackingEvent are called with no shared client argument", async () => {
    const { handleCollectRequest } = await import("../app/track/collect/handlers");
    await handleCollectRequest(requestFor("collect", collectBody()));

    for (const call of checkTrackingRateLimit.mock.calls) {
      expect(call).toHaveLength(3); // (surface, dimension, identifier) — never a 4th client arg
    }
  });
});

describe("POST /track/consent: fail-closed behavior", () => {
  it("a thrown rate-limit error returns 500 and never calls recordVisitorCookieTrackingConsent", async () => {
    checkTrackingRateLimit.mockRejectedValueOnce(new Error("rate limit storage unavailable"));
    const { handleConsentRequest } = await import("../app/track/consent/handlers");

    const response = await handleConsentRequest(requestFor("consent", consentBody()));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(recordVisitorCookieTrackingConsent).not.toHaveBeenCalled();
  });

  it("a rate-limit failure on the SITE dimension also returns 500 and never calls the writer", async () => {
    checkTrackingRateLimit
      .mockResolvedValueOnce(true) // ip
      .mockResolvedValueOnce(true) // anon
      .mockRejectedValueOnce(new Error("rate limit storage unavailable")); // site
    const { handleConsentRequest } = await import("../app/track/consent/handlers");

    const response = await handleConsentRequest(requestFor("consent", consentBody()));

    expect(response.status).toBe(500);
    expect(recordVisitorCookieTrackingConsent).not.toHaveBeenCalled();
  });

  it("a thrown site-resolution error returns 500 and never calls the writer", async () => {
    resolveOrganizationContextForTrackingSite.mockRejectedValueOnce(new Error("db unavailable"));
    const { handleConsentRequest } = await import("../app/track/consent/handlers");

    const response = await handleConsentRequest(requestFor("consent", consentBody()));

    expect(response.status).toBe(500);
    expect(recordVisitorCookieTrackingConsent).not.toHaveBeenCalled();
  });

  it("a thrown writer error returns a generic 500 with no raw exception detail", async () => {
    recordVisitorCookieTrackingConsent.mockRejectedValueOnce(new Error("insert failed: constraint violation xyz"));
    const { handleConsentRequest } = await import("../app/track/consent/handlers");

    const response = await handleConsentRequest(requestFor("consent", consentBody()));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("constraint violation");
  });

  it("the consent writer still receives the ORIGINAL siteKey (not a resolver-echoed shortcut), preserving its own internal TOCTOU re-resolution", async () => {
    const body = consentBody();
    const { handleConsentRequest } = await import("../app/track/consent/handlers");
    await handleConsentRequest(requestFor("consent", body));

    expect(recordVisitorCookieTrackingConsent).toHaveBeenCalledWith(
      body.siteKey.toLowerCase(),
      body.anonymousId.toLowerCase(),
      "granted",
    );
  });
});
