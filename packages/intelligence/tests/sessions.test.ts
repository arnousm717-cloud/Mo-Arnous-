import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, createTrackingSite } from "./helpers";
import { resolveOrCreateVisitor } from "../src/visitors";
import { resolveOrCreateVisitorSession } from "../src/sessions";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function fixture() {
  const organizationId = await createOrg();
  const trackingSiteId = await createTrackingSite(organizationId);
  const visitor = await resolveOrCreateVisitor({ organizationId }, randomUUID());
  return { organizationId, trackingSiteId, visitorId: visitor.id };
}

describe("resolveOrCreateVisitorSession", () => {
  it("creates a new session on the first call for a given 4-tuple", async () => {
    const { organizationId, trackingSiteId, visitorId } = await fixture();
    const anonymousSessionId = randomUUID();
    const session = await resolveOrCreateVisitorSession(
      { organizationId },
      { trackingSiteId, visitorId, anonymousSessionId, referrer: "https://example.com/first" },
    );
    expect(session.organizationId).toBe(organizationId);
    expect(session.trackingSiteId).toBe(trackingSiteId);
    expect(session.visitorId).toBe(visitorId);
    expect(session.anonymousSessionId).toBe(anonymousSessionId);
    expect(session.referrer).toBe("https://example.com/first");
    expect(session.endedAt).toBeNull();
  });

  it("a repeat call with the identical 4-tuple returns the same session id", async () => {
    const { organizationId, trackingSiteId, visitorId } = await fixture();
    const anonymousSessionId = randomUUID();
    const first = await resolveOrCreateVisitorSession({ organizationId }, { trackingSiteId, visitorId, anonymousSessionId });
    const second = await resolveOrCreateVisitorSession({ organizationId }, { trackingSiteId, visitorId, anonymousSessionId });
    expect(second.id).toBe(first.id);
  });

  it("session-start attribution fields are NOT overwritten on a repeat call", async () => {
    const { organizationId, trackingSiteId, visitorId } = await fixture();
    const anonymousSessionId = randomUUID();
    const first = await resolveOrCreateVisitorSession(
      { organizationId },
      {
        trackingSiteId,
        visitorId,
        anonymousSessionId,
        referrer: "https://original-referrer.example",
        utmSource: "original-source",
        landingPage: "/original-landing",
      },
    );
    const second = await resolveOrCreateVisitorSession(
      { organizationId },
      {
        trackingSiteId,
        visitorId,
        anonymousSessionId,
        referrer: "https://SHOULD-NOT-APPEAR.example",
        utmSource: "should-not-appear",
        landingPage: "/should-not-appear",
      },
    );
    expect(second.id).toBe(first.id);
    expect(second.referrer).toBe("https://original-referrer.example");
    expect(second.utmSource).toBe("original-source");
    expect(second.landingPage).toBe("/original-landing");
  });

  it("the same anonymous_session_id in a different organization resolves independently", async () => {
    const fxA = await fixture();
    const fxB = await fixture();
    const sharedSessionId = randomUUID();
    const sessionA = await resolveOrCreateVisitorSession(
      { organizationId: fxA.organizationId },
      { trackingSiteId: fxA.trackingSiteId, visitorId: fxA.visitorId, anonymousSessionId: sharedSessionId },
    );
    const sessionB = await resolveOrCreateVisitorSession(
      { organizationId: fxB.organizationId },
      { trackingSiteId: fxB.trackingSiteId, visitorId: fxB.visitorId, anonymousSessionId: sharedSessionId },
    );
    expect(sessionA.id).not.toBe(sessionB.id);
  });

  it("the same anonymous_session_id on a different tracking site (same org/visitor) resolves independently", async () => {
    const { organizationId, trackingSiteId: siteA, visitorId } = await fixture();
    const siteB = await createTrackingSite(organizationId);
    const sharedSessionId = randomUUID();
    const sessionA = await resolveOrCreateVisitorSession(
      { organizationId },
      { trackingSiteId: siteA, visitorId, anonymousSessionId: sharedSessionId },
    );
    const sessionB = await resolveOrCreateVisitorSession(
      { organizationId },
      { trackingSiteId: siteB, visitorId, anonymousSessionId: sharedSessionId },
    );
    expect(sessionA.id).not.toBe(sessionB.id);
  });

  it("the same anonymous_session_id for a different visitor (same org/site) resolves independently", async () => {
    const { organizationId, trackingSiteId } = await fixture();
    const visitor1 = await resolveOrCreateVisitor({ organizationId }, randomUUID());
    const visitor2 = await resolveOrCreateVisitor({ organizationId }, randomUUID());
    const sharedSessionId = randomUUID();
    const session1 = await resolveOrCreateVisitorSession(
      { organizationId },
      { trackingSiteId, visitorId: visitor1.id, anonymousSessionId: sharedSessionId },
    );
    const session2 = await resolveOrCreateVisitorSession(
      { organizationId },
      { trackingSiteId, visitorId: visitor2.id, anonymousSessionId: sharedSessionId },
    );
    expect(session1.id).not.toBe(session2.id);
  });

  it("ended_at is never set by 3.1B — remains null even across repeat calls", async () => {
    const { organizationId, trackingSiteId, visitorId } = await fixture();
    const anonymousSessionId = randomUUID();
    await resolveOrCreateVisitorSession({ organizationId }, { trackingSiteId, visitorId, anonymousSessionId });
    const second = await resolveOrCreateVisitorSession({ organizationId }, { trackingSiteId, visitorId, anonymousSessionId });
    expect(second.endedAt).toBeNull();
  });
});
