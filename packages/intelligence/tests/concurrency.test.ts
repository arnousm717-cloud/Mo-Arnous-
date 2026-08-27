import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, createTrackingSite, grantedAnonymousId, seedAsAdmin } from "./helpers";
import { ingestTrackingEvent } from "../src/ingest";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("ingestTrackingEvent: real concurrency (Promise.all over independent transactions, not sequential awaits)", () => {
  it("two simultaneous first-ingest calls for the same anonymous_id result in exactly one website_visitors row", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const anonymousId = await grantedAnonymousId(organizationId);

    const [resultA, resultB] = await Promise.all([
      ingestTrackingEvent(
        { organizationId },
        { trackingSiteId, anonymousId, anonymousSessionId: randomUUID(), eventType: "pageview" },
      ),
      ingestTrackingEvent(
        { organizationId },
        { trackingSiteId, anonymousId, anonymousSessionId: randomUUID(), eventType: "pageview" },
      ),
    ]);

    expect(resultA.accepted).toBe(true);
    expect(resultB.accepted).toBe(true);
    if (resultA.accepted && resultB.accepted) {
      expect(resultA.visitor.id).toBe(resultB.visitor.id);
      // Different anonymousSessionId per call, so distinct sessions and
      // distinct events are correctly expected here — only the visitor
      // is the shared resource under test in this case.
      expect(resultA.event.id).not.toBe(resultB.event.id);
    }

    const visitorCount = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select count(*)::int as n from public.website_visitors where organization_id = $1 and anonymous_id = $2",
        [organizationId, anonymousId],
      );
      return r.rows[0].n;
    });
    expect(visitorCount).toBe(1);
  });

  it("two simultaneous first-ingest calls for the identical session 4-tuple result in exactly one visitor_sessions row, and both events still land as distinct rows against it", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const anonymousId = await grantedAnonymousId(organizationId);
    const anonymousSessionId = randomUUID();

    const [resultA, resultB] = await Promise.all([
      ingestTrackingEvent(
        { organizationId },
        { trackingSiteId, anonymousId, anonymousSessionId, eventType: "pageview" },
      ),
      ingestTrackingEvent(
        { organizationId },
        { trackingSiteId, anonymousId, anonymousSessionId, eventType: "click" },
      ),
    ]);

    expect(resultA.accepted).toBe(true);
    expect(resultB.accepted).toBe(true);
    if (resultA.accepted && resultB.accepted) {
      expect(resultA.session.id).toBe(resultB.session.id);
      expect(resultA.event.id).not.toBe(resultB.event.id);
    }

    const sessionCount = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select count(*)::int as n from public.visitor_sessions where organization_id = $1 and anonymous_session_id = $2",
        [organizationId, anonymousSessionId],
      );
      return r.rows[0].n;
    });
    expect(sessionCount).toBe(1);

    const eventCount = await seedAsAdmin(async (client) => {
      const r = await client.query("select count(*)::int as n from public.visitor_events where organization_id = $1", [
        organizationId,
      ]);
      return r.rows[0].n;
    });
    expect(eventCount).toBe(2);
  });
});
