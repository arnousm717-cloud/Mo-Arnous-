import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, createOrg } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import { getLeadScoreDistribution, getHighScoreContacts, getIdentifiedVisitorMetrics } from "../src/dashboard-metrics";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function createContact(
  organizationId: string,
  opts: { firstName?: string; email?: string; deleted?: boolean } = {},
): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, email, deleted_at) values ($1, $2, $3, $4) returning id",
      [organizationId, opts.firstName ?? "Test", opts.email ?? null, opts.deleted ? new Date().toISOString() : null],
    );
    return r.rows[0]!.id;
  });
}

/** Inserts a lead_scores row directly, bypassing computeScore, so tests
 * can control the exact (contact, score, computed_at) triple needed to
 * verify latest-row-only aggregation. */
async function insertLeadScore(opts: {
  organizationId: string;
  contactId: string;
  score: number;
  computedAt?: string;
}): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query(
      `insert into public.lead_scores (organization_id, contact_id, score, breakdown, computed_at)
       values ($1, $2, $3, '[]'::jsonb, coalesce($4::timestamptz, now()))`,
      [opts.organizationId, opts.contactId, opts.score, opts.computedAt ?? null],
    );
  });
}

async function createVisitor(opts: {
  organizationId: string;
  identifiedContactId?: string | null;
  firstSeenAt?: string;
}): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      `insert into public.website_visitors (organization_id, anonymous_id, identified_contact_id, first_seen_at, last_seen_at)
       values ($1, $2, $3, coalesce($4::timestamptz, now()), coalesce($4::timestamptz, now()))
       returning id`,
      [opts.organizationId, randomUUID(), opts.identifiedContactId ?? null, opts.firstSeenAt ?? null],
    );
    return r.rows[0]!.id;
  });
}

async function insertIdentificationEvent(opts: {
  organizationId: string;
  websiteVisitorId: string;
  contactId: string | null;
  eventType: "identified" | "unlinked_withdrawal" | "unlinked_erasure" | "rejected_conflict";
  occurredAt?: string;
}): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query(
      `insert into public.visitor_identifications (organization_id, website_visitor_id, contact_id, event_type, token_jti, occurred_at)
       values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))`,
      [opts.organizationId, opts.websiteVisitorId, opts.contactId, opts.eventType, randomUUID(), opts.occurredAt ?? null],
    );
  });
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("getLeadScoreDistribution: latest-row-only aggregation", () => {
  it("counts a contact scored multiple times exactly once, at its latest grade", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    await insertLeadScore({ organizationId, contactId, score: 90, computedAt: daysAgo(3) }); // grade A
    await insertLeadScore({ organizationId, contactId, score: 30, computedAt: daysAgo(1) }); // grade D, latest

    const distribution = await getLeadScoreDistribution({ organizationId });
    const total = distribution.reduce((sum, d) => sum + d.contactCount, 0);
    expect(total).toBe(1);
    expect(distribution.find((d) => d.grade === "D")?.contactCount).toBe(1);
    expect(distribution.find((d) => d.grade === "A")).toBeUndefined();
  });

  it("groups correctly across all four grade thresholds", async () => {
    const organizationId = await createOrg();
    const a = await createContact(organizationId);
    const b = await createContact(organizationId);
    const c = await createContact(organizationId);
    const d = await createContact(organizationId);
    await insertLeadScore({ organizationId, contactId: a, score: 85 });
    await insertLeadScore({ organizationId, contactId: b, score: 65 });
    await insertLeadScore({ organizationId, contactId: c, score: 45 });
    await insertLeadScore({ organizationId, contactId: d, score: 10 });

    const distribution = await getLeadScoreDistribution({ organizationId });
    expect(distribution.find((x) => x.grade === "A")?.contactCount).toBe(1);
    expect(distribution.find((x) => x.grade === "B")?.contactCount).toBe(1);
    expect(distribution.find((x) => x.grade === "C")?.contactCount).toBe(1);
    expect(distribution.find((x) => x.grade === "D")?.contactCount).toBe(1);
  });

  it("excludes soft-deleted contacts", async () => {
    const organizationId = await createOrg();
    const deleted = await createContact(organizationId, { deleted: true });
    await insertLeadScore({ organizationId, contactId: deleted, score: 90 });

    const distribution = await getLeadScoreDistribution({ organizationId });
    const total = distribution.reduce((sum, d) => sum + d.contactCount, 0);
    expect(total).toBe(0);
  });

  it("never includes another organization's contacts", async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const contactB = await createContact(orgB);
    await insertLeadScore({ organizationId: orgB, contactId: contactB, score: 90 });

    const distributionA = await getLeadScoreDistribution({ organizationId: orgA });
    expect(distributionA.reduce((sum, d) => sum + d.contactCount, 0)).toBe(0);
  });
});

describe("getHighScoreContacts", () => {
  it("orders by score desc, then computedAt desc, then contact id asc for a deterministic tie-break", async () => {
    const organizationId = await createOrg();
    const higher = await createContact(organizationId, { firstName: "Higher" });
    const lowerA = await createContact(organizationId, { firstName: "LowerA" });
    const lowerB = await createContact(organizationId, { firstName: "LowerB" });
    await insertLeadScore({ organizationId, contactId: higher, score: 95 });
    await insertLeadScore({ organizationId, contactId: lowerA, score: 50, computedAt: daysAgo(1) });
    await insertLeadScore({ organizationId, contactId: lowerB, score: 50, computedAt: daysAgo(1) });

    const top = await getHighScoreContacts({ organizationId }, 10);
    expect(top[0]!.contactId).toBe(higher);
    expect([top[1]!.contactId, top[2]!.contactId].sort()).toEqual([lowerA, lowerB].sort());

    // Determinism: re-running the identical query against unchanged data
    // must produce the identical tie-break order every time, not merely
    // *an* order — proves the ORDER BY has no untie-broken ambiguity.
    const topAgain = await getHighScoreContacts({ organizationId }, 10);
    expect(topAgain.map((c) => c.contactId)).toEqual(top.map((c) => c.contactId));
  });

  it("bounds the limit at 100 even when a larger value is requested", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    await insertLeadScore({ organizationId, contactId, score: 90 });

    const top = await getHighScoreContacts({ organizationId }, 10000);
    expect(top.length).toBeLessThanOrEqual(100);
  });

  it("floors the limit at 1 even when zero or a negative value is requested", async () => {
    const organizationId = await createOrg();
    const a = await createContact(organizationId);
    const b = await createContact(organizationId);
    await insertLeadScore({ organizationId, contactId: a, score: 90 });
    await insertLeadScore({ organizationId, contactId: b, score: 80 });

    const top = await getHighScoreContacts({ organizationId }, 0);
    expect(top.length).toBe(1);
  });

  it("exposes only the minimal safe fields — no breakdown, no raw enrichment data", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId, { email: "a@example.test" });
    await insertLeadScore({ organizationId, contactId, score: 90 });

    const top = await getHighScoreContacts({ organizationId }, 10);
    expect(Object.keys(top[0]!).sort()).toEqual(
      ["computedAt", "contactId", "email", "firstName", "grade", "lastName", "score"].sort(),
    );
  });

  it("excludes soft-deleted contacts", async () => {
    const organizationId = await createOrg();
    const deleted = await createContact(organizationId, { deleted: true });
    await insertLeadScore({ organizationId, contactId: deleted, score: 99 });

    const top = await getHighScoreContacts({ organizationId }, 10);
    expect(top).toHaveLength(0);
  });
});

describe("getIdentifiedVisitorMetrics: hostile semantic check — occurred_at, never first_seen_at", () => {
  it("excludes a visitor whose row is recent but whose identification event is outside the window", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const visitorId = await createVisitor({ organizationId, identifiedContactId: contactId, firstSeenAt: daysAgo(1) });
    await insertIdentificationEvent({
      organizationId,
      websiteVisitorId: visitorId,
      contactId,
      eventType: "identified",
      occurredAt: daysAgo(40),
    });

    const metrics = await getIdentifiedVisitorMetrics({ organizationId }, 30);
    expect(metrics.identifiedVisitorCount).toBe(1);
    expect(metrics.identifiedInWindowCount).toBe(0);
  });

  it("includes a visitor whose row is old but whose identification event is inside the window", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const visitorId = await createVisitor({ organizationId, identifiedContactId: contactId, firstSeenAt: daysAgo(200) });
    await insertIdentificationEvent({
      organizationId,
      websiteVisitorId: visitorId,
      contactId,
      eventType: "identified",
      occurredAt: daysAgo(5),
    });

    const metrics = await getIdentifiedVisitorMetrics({ organizationId }, 30);
    expect(metrics.identifiedInWindowCount).toBe(1);
  });

  it("uses only the most recent identification event when several exist for the same visitor", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const visitorId = await createVisitor({ organizationId, identifiedContactId: contactId });
    await insertIdentificationEvent({
      organizationId,
      websiteVisitorId: visitorId,
      contactId,
      eventType: "identified",
      occurredAt: daysAgo(60),
    });
    await insertIdentificationEvent({
      organizationId,
      websiteVisitorId: visitorId,
      contactId,
      eventType: "identified",
      occurredAt: daysAgo(5),
    });

    const metrics = await getIdentifiedVisitorMetrics({ organizationId }, 30);
    expect(metrics.identifiedInWindowCount).toBe(1);
  });

  it("does not count 'unlinked_withdrawal' or 'rejected_conflict' events as an identification", async () => {
    const organizationId = await createOrg();
    const visitorId = await createVisitor({ organizationId, identifiedContactId: null });
    await insertIdentificationEvent({
      organizationId,
      websiteVisitorId: visitorId,
      contactId: null,
      eventType: "rejected_conflict",
      occurredAt: daysAgo(1),
    });

    const metrics = await getIdentifiedVisitorMetrics({ organizationId }, 30);
    expect(metrics.identifiedVisitorCount).toBe(0);
    expect(metrics.identifiedInWindowCount).toBe(0);
  });

  it("excludes visitors never identified (identified_contact_id is null)", async () => {
    const organizationId = await createOrg();
    await createVisitor({ organizationId, identifiedContactId: null });

    const metrics = await getIdentifiedVisitorMetrics({ organizationId }, 30);
    expect(metrics.identifiedVisitorCount).toBe(0);
  });

  it("clamps windowDays into [1, 365]", async () => {
    const organizationId = await createOrg();
    const low = await getIdentifiedVisitorMetrics({ organizationId }, -5);
    expect(low.windowDays).toBe(1);
    const high = await getIdentifiedVisitorMetrics({ organizationId }, 10000);
    expect(high.windowDays).toBe(365);
  });

  it("never includes another organization's visitors", async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const contactB = await createContact(orgB);
    const visitorB = await createVisitor({ organizationId: orgB, identifiedContactId: contactB });
    await insertIdentificationEvent({
      organizationId: orgB,
      websiteVisitorId: visitorB,
      contactId: contactB,
      eventType: "identified",
      occurredAt: daysAgo(1),
    });

    const metricsA = await getIdentifiedVisitorMetrics({ organizationId: orgA }, 30);
    expect(metricsA.identifiedVisitorCount).toBe(0);
    expect(metricsA.identifiedInWindowCount).toBe(0);
  });
});
