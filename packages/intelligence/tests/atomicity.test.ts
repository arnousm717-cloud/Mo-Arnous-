import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withTenantContext, closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, createTrackingSite, grantedAnonymousId, seedAsAdmin } from "./helpers";
import { resolveOrCreateVisitor } from "../src/visitors";
import { resolveOrCreateVisitorSession } from "../src/sessions";
import { appendVisitorEvent } from "../src/events";
import { InvalidSessionRelationshipError } from "../src/errors";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("ingestTrackingEvent: transactional rollback", () => {
  /**
   * Deliberately does NOT use a DDL-based chaos trigger (an earlier
   * version of this test did, mirroring packages/compliance's own
   * contact-erasure.test.ts convention). Found, during real
   * full-monorepo concurrent execution, to cause a genuine Postgres
   * deadlock: DROP TRIGGER/DROP FUNCTION require an ACCESS EXCLUSIVE
   * lock on visitor_events, which can legitimately deadlock against an
   * ordinary concurrent INSERT into that same table from a sibling test
   * file running in parallel (vitest parallelizes files within one
   * package by default, and this repository's own concurrency.test.ts/
   * ingest.test.ts both insert into visitor_events). Verified
   * empirically, not assumed: reproduced "error: deadlock detected" on
   * the cleanup DROP statements under `turbo run test`'s real
   * concurrent load.
   *
   * The safer, equally rigorous alternative used here: force the same
   * "visitor and session already committed inside this transaction, the
   * event step then fails" scenario using a REAL, already-existing
   * constraint violation (a session_id belonging to a different
   * organization, rejected by visitor_events_session_org_fk) instead of
   * a synthetic exception — no DDL, no table-level lock, no deadlock
   * surface at all, and arguably a more representative failure mode
   * than an artificial one.
   */
  it("a real constraint-violation failure on the event step — AFTER visitor and session rows have already been written inside the same transaction — rolls back the entire operation, leaving zero orphaned rows", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const anonymousId = await grantedAnonymousId(organizationId);

    // A session that genuinely exists, but in a DIFFERENT organization —
    // appendVisitorEvent will hit the real visitor_events_session_org_fk
    // violation when this transaction's own organizationId doesn't match.
    const otherOrgId = await createOrg();
    const otherOrgSiteId = await createTrackingSite(otherOrgId);
    const otherOrgAnonymousId = await grantedAnonymousId(otherOrgId);
    const otherOrgVisitor = await resolveOrCreateVisitor({ organizationId: otherOrgId }, otherOrgAnonymousId);
    const otherOrgSession = await resolveOrCreateVisitorSession(
      { organizationId: otherOrgId },
      { trackingSiteId: otherOrgSiteId, visitorId: otherOrgVisitor.id, anonymousSessionId: randomUUID() },
    );

    await expect(
      withTenantContext({ organizationId }, async (client) => {
        // Steps 1-2 (visitor, session) succeed and genuinely commit rows
        // to this same transaction's client.
        const visitor = await resolveOrCreateVisitor({ organizationId }, anonymousId, client);
        const session = await resolveOrCreateVisitorSession(
          { organizationId },
          { trackingSiteId, visitorId: visitor.id, anonymousSessionId: randomUUID() },
          client,
        );
        expect(visitor.id).toBeTruthy();
        expect(session.id).toBeTruthy();

        // Step 3 (event) deliberately targets the OTHER organization's
        // real session id — genuinely rejected by the composite FK, not
        // a synthetic failure.
        await appendVisitorEvent(
          { organizationId },
          { sessionId: otherOrgSession.id, eventType: "pageview" },
          client,
        );
      }),
    ).rejects.toThrow(InvalidSessionRelationshipError);

    // Nothing must have taken effect — the visitor and session that were
    // written earlier IN THE SAME TRANSACTION as the failed event insert
    // must have rolled back together with it.
    const counts = await seedAsAdmin(async (client) => {
      const visitors = await client.query(
        "select count(*)::int as n from public.website_visitors where organization_id = $1 and anonymous_id = $2",
        [organizationId, anonymousId],
      );
      const sessions = await client.query("select count(*)::int as n from public.visitor_sessions where organization_id = $1", [
        organizationId,
      ]);
      const events = await client.query("select count(*)::int as n from public.visitor_events where organization_id = $1", [
        organizationId,
      ]);
      return { visitors: visitors.rows[0].n, sessions: sessions.rows[0].n, events: events.rows[0].n };
    });
    expect(counts).toEqual({ visitors: 0, sessions: 0, events: 0 });
  });
});
