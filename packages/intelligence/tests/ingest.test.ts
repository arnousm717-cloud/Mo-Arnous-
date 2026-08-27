import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, createTrackingSite, grantedAnonymousId, recordConsent, seedAsAdmin } from "./helpers";
import { ingestTrackingEvent } from "../src/ingest";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function rowCounts(organizationId: string) {
  return seedAsAdmin(async (client) => {
    const visitors = await client.query("select count(*)::int as n from public.website_visitors where organization_id = $1", [
      organizationId,
    ]);
    const sessions = await client.query("select count(*)::int as n from public.visitor_sessions where organization_id = $1", [
      organizationId,
    ]);
    const events = await client.query("select count(*)::int as n from public.visitor_events where organization_id = $1", [
      organizationId,
    ]);
    return { visitors: visitors.rows[0].n, sessions: sessions.rows[0].n, events: events.rows[0].n };
  });
}

describe("ingestTrackingEvent: consent gating", () => {
  it("no consent recorded => accepted=false, reason=consent_not_granted, zero writes", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const result = await ingestTrackingEvent(
      { organizationId },
      { trackingSiteId, anonymousId: randomUUID(), anonymousSessionId: randomUUID(), eventType: "pageview" },
    );
    expect(result).toEqual({ accepted: false, reason: "consent_not_granted" });
    expect(await rowCounts(organizationId)).toEqual({ visitors: 0, sessions: 0, events: 0 });
  });

  it("withdrawn latest consent => rejected, zero writes", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const anonymousId = randomUUID();
    await recordConsent({ organizationId, anonymousId, status: "withdrawn" });
    const result = await ingestTrackingEvent(
      { organizationId },
      { trackingSiteId, anonymousId, anonymousSessionId: randomUUID(), eventType: "pageview" },
    );
    expect(result).toEqual({ accepted: false, reason: "consent_not_granted" });
    expect(await rowCounts(organizationId)).toEqual({ visitors: 0, sessions: 0, events: 0 });
  });

  it("granted latest consent => accepted, full ingest succeeds", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await ingestTrackingEvent(
      { organizationId },
      { trackingSiteId, anonymousId, anonymousSessionId: randomUUID(), eventType: "pageview" },
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.visitor.anonymousId).toBe(anonymousId);
      expect(result.session.trackingSiteId).toBe(trackingSiteId);
      expect(result.event.eventType).toBe("pageview");
    }
    expect(await rowCounts(organizationId)).toEqual({ visitors: 1, sessions: 1, events: 1 });
  });

  it("no client-suppliable field in the input can force acceptance — the input type has no consent field at all (structural, not just behavioral)", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const result = await ingestTrackingEvent(
      { organizationId },
      {
        trackingSiteId,
        anonymousId: randomUUID(),
        anonymousSessionId: randomUUID(),
        eventType: "pageview",
        // @ts-expect-error -- consent is not part of IngestTrackingEventInput; this line exists to prove the type system itself rejects it.
        consent: true,
      },
    );
    expect(result).toEqual({ accepted: false, reason: "consent_not_granted" });
  });
});

describe("ingestTrackingEvent: tracking-site TOCTOU / tenancy", () => {
  it("a revoked tracking site => accepted=false, reason=tracking_site_revoked, zero writes", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId, { revoked: true });
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await ingestTrackingEvent(
      { organizationId },
      { trackingSiteId, anonymousId, anonymousSessionId: randomUUID(), eventType: "pageview" },
    );
    expect(result).toEqual({ accepted: false, reason: "tracking_site_revoked" });
    expect(await rowCounts(organizationId)).toEqual({ visitors: 0, sessions: 0, events: 0 });
  });

  it("a tracking site belonging to a different organization => the identical safe rejection, never disclosing which case it was", async () => {
    const organizationId = await createOrg();
    const otherOrgId = await createOrg();
    const otherOrgSiteId = await createTrackingSite(otherOrgId);
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await ingestTrackingEvent(
      { organizationId },
      { trackingSiteId: otherOrgSiteId, anonymousId, anonymousSessionId: randomUUID(), eventType: "pageview" },
    );
    expect(result).toEqual({ accepted: false, reason: "tracking_site_revoked" });
    expect(await rowCounts(organizationId)).toEqual({ visitors: 0, sessions: 0, events: 0 });
  });

  it("a nonexistent tracking site id => the identical safe rejection", async () => {
    const organizationId = await createOrg();
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await ingestTrackingEvent(
      { organizationId },
      { trackingSiteId: randomUUID(), anonymousId, anonymousSessionId: randomUUID(), eventType: "pageview" },
    );
    expect(result).toEqual({ accepted: false, reason: "tracking_site_revoked" });
  });

  it("no resolve_tracking_site() call exists anywhere in packages/intelligence — grepped directly against code, not prose comments explaining its absence", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const srcDir = path.join(__dirname, "..", "src");
    const files = await fs.readdir(srcDir);
    for (const file of files) {
      const content = await fs.readFile(path.join(srcDir, file), "utf8");
      // Strip /* ... */ block comments (this file's own JSDoc headers
      // reference "resolve_tracking_site()" in prose, explaining why it
      // is deliberately NOT called here — that mention must not trip
      // this check) and // line comments, then check only what remains
      // for an actual invocation.
      const codeOnly = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      expect(codeOnly, `${file} must not call resolve_tracking_site(...)`).not.toMatch(/resolve_tracking_site\s*\(/);
    }
  });

  it("cross-org data remains isolated: org A's granted consent/visitor never affects org B's ingest for the same anonymous_id/session", async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const siteB = await createTrackingSite(orgB);
    const sharedAnonymousId = randomUUID();
    const sharedSessionId = randomUUID();

    // Org A grants consent and ingests successfully.
    const siteA = await createTrackingSite(orgA);
    await recordConsent({ organizationId: orgA, anonymousId: sharedAnonymousId, status: "granted" });
    const resultA = await ingestTrackingEvent(
      { organizationId: orgA },
      { trackingSiteId: siteA, anonymousId: sharedAnonymousId, anonymousSessionId: sharedSessionId, eventType: "pageview" },
    );
    expect(resultA.accepted).toBe(true);

    // Org B never granted consent for the same anonymous_id — must be rejected.
    const resultB = await ingestTrackingEvent(
      { organizationId: orgB },
      { trackingSiteId: siteB, anonymousId: sharedAnonymousId, anonymousSessionId: sharedSessionId, eventType: "pageview" },
    );
    expect(resultB).toEqual({ accepted: false, reason: "consent_not_granted" });
    expect(await rowCounts(orgB)).toEqual({ visitors: 0, sessions: 0, events: 0 });
  });
});
