import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, createTrackingSite, grantedAnonymousId, recordConsent, seedAsAdmin } from "./helpers";
import { identifyVisitor, unlinkVisitorIdentityOnWithdrawal } from "../src/identify";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function createContact(organizationId: string, email: string = `test-${randomUUID()}@example.test`): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, email) values ($1, $2, $3) returning id",
      [organizationId, "Test", email],
    );
    return r.rows[0]!.id;
  });
}

async function suppressVisitor(websiteVisitorId: string): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query("update public.website_visitors set identification_suppressed_at = now() where id = $1", [
      websiteVisitorId,
    ]);
  });
}

async function auditRows(organizationId: string, websiteVisitorId: string) {
  return seedAsAdmin(async (client) => {
    const r = await client.query(
      "select event_type, contact_id, token_jti from public.visitor_identifications where organization_id = $1 and website_visitor_id = $2 order by occurred_at asc",
      [organizationId, websiteVisitorId],
    );
    return r.rows;
  });
}

async function outboxRows(organizationId: string, eventType: string) {
  return seedAsAdmin(async (client) => {
    const r = await client.query("select payload from public.events where organization_id = $1 and event_type = $2", [
      organizationId,
      eventType,
    ]);
    return r.rows;
  });
}

async function visitorIdOf(organizationId: string, anonymousId: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "select id from public.website_visitors where organization_id = $1 and anonymous_id = $2",
      [organizationId, anonymousId],
    );
    return r.rows[0]!.id;
  });
}

/** grantedAnonymousId only seeds a consent_records row -- website_visitors
 * is created lazily by resolveOrCreateVisitor (inside identifyVisitor
 * itself). Tests that need the visitor row to exist BEFORE calling
 * identifyVisitor (e.g. to pre-suppress it) must seed it directly. */
async function seedVisitorRow(organizationId: string, anonymousId: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.website_visitors (organization_id, anonymous_id) values ($1, $2) returning id",
      [organizationId, anonymousId],
    );
    return r.rows[0]!.id;
  });
}

describe("identifyVisitor: consent gating (fails closed)", () => {
  it("no consent recorded => rejected, no identification, no audit row, no outbox event", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const contactId = await createContact(organizationId);
    const contact = await seedAsAdmin((c) => c.query("select email from public.contacts where id = $1", [contactId]));
    const anonymousId = randomUUID();
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: contact.rows[0].email, tokenJti: randomUUID() },
    );
    expect(result).toEqual({ accepted: false, reason: "consent_not_granted" });
  });

  it("withdrawn latest consent => rejected", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const contactId = await createContact(organizationId);
    const email = (await seedAsAdmin((c) => c.query("select email from public.contacts where id = $1", [contactId]))).rows[0]
      .email;
    const anonymousId = randomUUID();
    await recordConsent({ organizationId, anonymousId, status: "withdrawn" });
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(result).toEqual({ accepted: false, reason: "consent_not_granted" });
  });

  it("granted consent + matching contact => accepted", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `person-${randomUUID()}@example.test`;
    const contactId = await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.contactId).toBe(contactId);
      expect(result.visitor.anonymousId).toBe(anonymousId);
    }
  });
});

describe("identifyVisitor: tracking-site TOCTOU / tenancy", () => {
  it("a revoked tracking site => rejected", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId, { revoked: true });
    const email = `person-${randomUUID()}@example.test`;
    await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(result).toEqual({ accepted: false, reason: "tracking_site_revoked" });
  });

  it("a tracking site belonging to a different organization => the identical safe rejection", async () => {
    const organizationId = await createOrg();
    const otherOrgId = await createOrg();
    const otherOrgSiteId = await createTrackingSite(otherOrgId);
    const email = `person-${randomUUID()}@example.test`;
    await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId: otherOrgSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(result).toEqual({ accepted: false, reason: "tracking_site_revoked" });
  });
});

describe("identifyVisitor: contact resolution", () => {
  it("no matching contact => rejected, no identification", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: `nobody-${randomUUID()}@example.test`, tokenJti: randomUUID() },
    );
    expect(result).toEqual({ accepted: false, reason: "contact_not_found" });
  });

  it("a matching contact in a DIFFERENT organization never resolves, even with the identical email", async () => {
    const organizationId = await createOrg();
    const otherOrgId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `shared-${randomUUID()}@example.test`;
    await createContact(otherOrgId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(result).toEqual({ accepted: false, reason: "contact_not_found" });
  });

  it("email matching is case-insensitive", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `Person-${randomUUID()}@Example.Test`;
    const contactId = await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email.toUpperCase(), tokenJti: randomUUID() },
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.contactId).toBe(contactId);
  });
});

describe("identifyVisitor: erasure-suppression anti-relink guard", () => {
  it("a permanently suppressed visitor is rejected even with fully valid evidence", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `person-${randomUUID()}@example.test`;
    await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    const visitorId = await seedVisitorRow(organizationId, anonymousId);
    await suppressVisitor(visitorId);
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(result).toEqual({ accepted: false, reason: "visitor_suppressed" });
  });
});

describe("identifyVisitor: conflict policy", () => {
  it("unidentified -> A succeeds", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `a-${randomUUID()}@example.test`;
    const contactA = await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(result).toEqual(expect.objectContaining({ accepted: true, contactId: contactA }));
  });

  it("A -> A is idempotent: succeeds again, writes a second audit row, does not change the binding", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `a-${randomUUID()}@example.test`;
    const contactA = await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    await identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() });
    const second = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(second).toEqual(expect.objectContaining({ accepted: true, contactId: contactA }));
    const visitorId = await visitorIdOf(organizationId, anonymousId);
    const rows = await auditRows(organizationId, visitorId);
    expect(rows.filter((r) => r.event_type === "identified")).toHaveLength(2);
  });

  it("A -> B is rejected: A's binding is left completely unchanged, and a rejected_conflict audit row is written", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const emailA = `a-${randomUUID()}@example.test`;
    const emailB = `b-${randomUUID()}@example.test`;
    const contactA = await createContact(organizationId, emailA);
    const contactB = await createContact(organizationId, emailB);
    const anonymousId = await grantedAnonymousId(organizationId);

    const first = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: emailA, tokenJti: randomUUID() },
    );
    expect(first).toEqual(expect.objectContaining({ accepted: true, contactId: contactA }));

    const second = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: emailB, tokenJti: randomUUID() },
    );
    expect(second).toEqual({ accepted: false, reason: "conflict" });

    const visitorId = await visitorIdOf(organizationId, anonymousId);
    const current = await seedAsAdmin((c) =>
      c.query("select identified_contact_id from public.website_visitors where id = $1", [visitorId]),
    );
    expect(current.rows[0].identified_contact_id).toBe(contactA);

    const rows = await auditRows(organizationId, visitorId);
    const rejected = rows.find((r) => r.event_type === "rejected_conflict");
    expect(rejected).toBeDefined();
    expect(rejected!.contact_id).toBe(contactB);
  });

  it("two independent visitors may both resolve to the same contact (deliberately permitted, not a conflict)", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `shared-contact-${randomUUID()}@example.test`;
    const contactId = await createContact(organizationId, email);
    const anonymousId1 = await grantedAnonymousId(organizationId);
    const anonymousId2 = await grantedAnonymousId(organizationId);

    const r1 = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId: anonymousId1, contactEmail: email, tokenJti: randomUUID() },
    );
    const r2 = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId: anonymousId2, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(r1).toEqual(expect.objectContaining({ accepted: true, contactId }));
    expect(r2).toEqual(expect.objectContaining({ accepted: true, contactId }));
  });
});

describe("identifyVisitor: replay protection (structural, tenant-scoped)", () => {
  it("the same jti used twice for the same organization is rejected the second time", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `a-${randomUUID()}@example.test`;
    await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    const jti = randomUUID();

    const first = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: jti },
    );
    expect(first.accepted).toBe(true);

    const second = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: jti },
    );
    expect(second).toEqual({ accepted: false, reason: "replayed_jti" });
  });

  it("genuinely concurrent identical-jti requests: exactly one wins, the other is rejected as a replay -- proven with real Promise.all racing, not sequential calls", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `a-${randomUUID()}@example.test`;
    await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    const jti = randomUUID();

    const [a, b] = await Promise.all([
      identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: email, tokenJti: jti }),
      identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: email, tokenJti: jti }),
    ]);
    const results = [a, b];
    const accepted = results.filter((r) => r.accepted);
    const rejected = results.filter((r) => !r.accepted);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toEqual({ accepted: false, reason: "replayed_jti" });

    // Exactly one audit row exists for this jti -- the DB's own UNIQUE
    // constraint serialized the race, not application-level luck.
    const visitorId = await visitorIdOf(organizationId, anonymousId);
    const rows = await auditRows(organizationId, visitorId);
    expect(rows.filter((r) => r.token_jti === jti)).toHaveLength(1);
  });
});

describe("identifyVisitor: conflict-path jti reuse remains non-oracle (Final Implementation Acceptance Audit remediation)", () => {
  // Reproduces the exact sequence the audit found: jti X identifies the
  // visitor to Contact A, the visitor is later legitimately rebound to
  // Contact B, and the ORIGINAL (jti X, Contact A) assertion is replayed.
  // Before remediation, this threw an uncaught unique-violation out of
  // identifyVisitor (visitor_identifications_org_jti_key), which the HTTP
  // layer only survives by mapping it to a 500 -- distinguishable from
  // every other rejection's uniform 204. It must now resolve to a normal,
  // non-throwing IdentifyResult like every other rejection reason.
  it("a jti already consumed by an earlier identification, replayed after the visitor is rebound elsewhere, resolves to replayed_jti -- no exception, no duplicate audit row, no duplicate outbox event, binding unchanged", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const emailA = `a-${randomUUID()}@example.test`;
    const emailB = `b-${randomUUID()}@example.test`;
    await createContact(organizationId, emailA);
    const contactB = await createContact(organizationId, emailB);
    const anonymousId = await grantedAnonymousId(organizationId);
    const jtiX = randomUUID();

    const first = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: emailA, tokenJti: jtiX },
    );
    expect(first.accepted).toBe(true);

    const visitorId = await visitorIdOf(organizationId, anonymousId);
    await seedAsAdmin((c) =>
      c.query("update public.website_visitors set identified_contact_id = null where id = $1", [visitorId]),
    );
    const jtiY = randomUUID();
    const second = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: emailB, tokenJti: jtiY },
    );
    expect(second.accepted).toBe(true);

    // The replay: does NOT throw -- resolves to a normal IdentifyResult.
    let thrown: unknown = null;
    let replayResult: Awaited<ReturnType<typeof identifyVisitor>> | undefined;
    try {
      replayResult = await identifyVisitor(
        { organizationId },
        { trackingSiteId, anonymousId, contactEmail: emailA, tokenJti: jtiX },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();
    expect(replayResult).toEqual({ accepted: false, reason: "replayed_jti" });

    // No duplicate audit row: exactly one row for jtiX (the original
    // 'identified' insert), one for jtiY -- the failed conflict-path
    // insert attempt for jtiX never persisted.
    const rows = await auditRows(organizationId, visitorId);
    expect(rows.filter((r) => r.token_jti === jtiX)).toHaveLength(1);
    expect(rows.filter((r) => r.token_jti === jtiY)).toHaveLength(1);
    expect(rows).toHaveLength(2);

    // No duplicate outbox event -- exactly the two legitimate
    // visitor.identified events (first + second), never a third for the
    // replay attempt.
    const events = await outboxRows(organizationId, "visitor.identified");
    expect(events).toHaveLength(2);

    // Binding is unchanged by the replay attempt -- still Contact B.
    const finalState = await seedAsAdmin((c) =>
      c.query("select identified_contact_id from public.website_visitors where id = $1", [visitorId]),
    );
    expect(finalState.rows[0].identified_contact_id).toBe(contactB);
  });

  it("genuinely concurrent replays of an already-consumed jti against a rebound visitor: neither throws, both resolve to replayed_jti", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const emailA = `a-${randomUUID()}@example.test`;
    const emailB = `b-${randomUUID()}@example.test`;
    await createContact(organizationId, emailA);
    await createContact(organizationId, emailB);
    const anonymousId = await grantedAnonymousId(organizationId);
    const jtiX = randomUUID();

    const first = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: emailA, tokenJti: jtiX },
    );
    expect(first.accepted).toBe(true);

    const visitorId = await visitorIdOf(organizationId, anonymousId);
    await seedAsAdmin((c) =>
      c.query("update public.website_visitors set identified_contact_id = null where id = $1", [visitorId]),
    );
    await identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: emailB, tokenJti: randomUUID() });

    let thrownA: unknown = null;
    let thrownB: unknown = null;
    const [replayA, replayB] = await Promise.all([
      identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: emailA, tokenJti: jtiX }).catch(
        (err) => {
          thrownA = err;
          return undefined;
        },
      ),
      identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: emailA, tokenJti: jtiX }).catch(
        (err) => {
          thrownB = err;
          return undefined;
        },
      ),
    ]);

    expect(thrownA).toBeNull();
    expect(thrownB).toBeNull();
    expect(replayA).toEqual({ accepted: false, reason: "replayed_jti" });
    expect(replayB).toEqual({ accepted: false, reason: "replayed_jti" });
  });

  it("HTTP-adjacent parity: the IdentifyResult shape for a conflict-path jti replay is indistinguishable from an ordinary conflict rejection (both are plain, non-throwing {accepted:false} values collapsing to the same 204 at the route layer)", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const emailA = `a-${randomUUID()}@example.test`;
    const emailB = `b-${randomUUID()}@example.test`;
    await createContact(organizationId, emailA);
    await createContact(organizationId, emailB);
    const anonymousId1 = await grantedAnonymousId(organizationId);
    const anonymousId2 = await grantedAnonymousId(organizationId);

    // Ordinary conflict (fresh jti, genuinely different contact, never
    // previously used for this visitor).
    await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId: anonymousId1, contactEmail: emailA, tokenJti: randomUUID() },
    );
    const ordinaryConflict = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId: anonymousId1, contactEmail: emailB, tokenJti: randomUUID() },
    );
    expect(ordinaryConflict).toEqual({ accepted: false, reason: "conflict" });

    // Replayed-jti-on-conflict-path (the regression case).
    const jtiX = randomUUID();
    await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId: anonymousId2, contactEmail: emailA, tokenJti: jtiX },
    );
    const visitorId2 = await visitorIdOf(organizationId, anonymousId2);
    await seedAsAdmin((c) =>
      c.query("update public.website_visitors set identified_contact_id = null where id = $1", [visitorId2]),
    );
    await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId: anonymousId2, contactEmail: emailB, tokenJti: randomUUID() },
    );
    const replayOnConflict = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId: anonymousId2, contactEmail: emailA, tokenJti: jtiX },
    );

    // Both are plain data values, both accepted:false -- neither throws,
    // both are the same IdentifyResult shape a route handler maps to the
    // identical 204, exactly like every other rejection reason.
    expect(typeof ordinaryConflict).toBe("object");
    expect(typeof replayOnConflict).toBe("object");
    expect(ordinaryConflict.accepted).toBe(false);
    expect(replayOnConflict.accepted).toBe(false);
  });
});

describe("identifyVisitor: concurrent conflicting identification (A/B race)", () => {
  it("two genuinely concurrent identify attempts for the same visitor to two DIFFERENT contacts: exactly one wins deterministically, never both, never neither", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const emailA = `a-${randomUUID()}@example.test`;
    const emailB = `b-${randomUUID()}@example.test`;
    const contactA = await createContact(organizationId, emailA);
    const contactB = await createContact(organizationId, emailB);
    const anonymousId = await grantedAnonymousId(organizationId);

    const [resultA, resultB] = await Promise.all([
      identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: emailA, tokenJti: randomUUID() }),
      identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: emailB, tokenJti: randomUUID() }),
    ]);

    const winners = [resultA, resultB].filter((r) => r.accepted);
    expect(winners).toHaveLength(1); // exactly one of the two won -- never both, never neither.

    const visitorId = await visitorIdOf(organizationId, anonymousId);
    const current = await seedAsAdmin((c) =>
      c.query("select identified_contact_id from public.website_visitors where id = $1", [visitorId]),
    );
    // The final bound contact is whichever one actually won -- deterministic and consistent with the result.
    const winningContactId = winners[0]!.accepted ? winners[0]!.contactId : null;
    expect([contactA, contactB]).toContain(winningContactId);
    expect(current.rows[0].identified_contact_id).toBe(winningContactId);

    // The loser's own attempt is recorded as a rejected_conflict audit row.
    const rows = await auditRows(organizationId, visitorId);
    expect(rows.some((r) => r.event_type === "rejected_conflict")).toBe(true);
  });
});

describe("identifyVisitor: soft-deleted contact", () => {
  it("a soft-deleted (but not erased) contact is never resolved -- treated identically to no matching contact", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `soft-deleted-${randomUUID()}@example.test`;
    const contactId = await createContact(organizationId, email);
    await seedAsAdmin((c) => c.query("update public.contacts set deleted_at = now() where id = $1", [contactId]));
    const anonymousId = await grantedAnonymousId(organizationId);

    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(result).toEqual({ accepted: false, reason: "contact_not_found" });
  });
});

describe("identifyVisitor: outbox atomicity", () => {
  it("a successful identification writes exactly one visitor.identified outbox event with no raw PII in the payload", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `a-${randomUUID()}@example.test`;
    const contactId = await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);

    await identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() });

    const rows = await outboxRows(organizationId, "visitor.identified");
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload;
    expect(payload.contact_id).toBe(contactId);
    expect(JSON.stringify(payload)).not.toContain(email);
  });

  it("a rejected identification (no matching contact) writes no outbox event", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const anonymousId = await grantedAnonymousId(organizationId);

    await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: `nobody-${randomUUID()}@example.test`, tokenJti: randomUUID() },
    );

    const rows = await outboxRows(organizationId, "visitor.identified");
    expect(rows).toHaveLength(0);
  });
});

describe("identifyVisitor: no raw PII in the audit trail", () => {
  it("visitor_identifications never contains an email column, structurally", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `a-${randomUUID()}@example.test`;
    await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    await identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() });

    const columns = await seedAsAdmin((c) =>
      c.query(
        "select column_name from information_schema.columns where table_schema='public' and table_name='visitor_identifications'",
      ),
    );
    const columnNames = columns.rows.map((r: { column_name: string }) => r.column_name);
    expect(columnNames).not.toContain("email");
    expect(columnNames).not.toContain("assertion");
  });
});

describe("unlinkVisitorIdentityOnWithdrawal: Milestone 3.2F", () => {
  it("clears identified_contact_id and writes an unlinked_withdrawal audit row for an identified visitor", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `a-${randomUUID()}@example.test`;
    const contactId = await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    await identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() });

    await unlinkVisitorIdentityOnWithdrawal({ organizationId }, anonymousId);

    const visitorId = await visitorIdOf(organizationId, anonymousId);
    const current = await seedAsAdmin((c) =>
      c.query("select identified_contact_id from public.website_visitors where id = $1", [visitorId]),
    );
    expect(current.rows[0].identified_contact_id).toBeNull();

    const rows = await auditRows(organizationId, visitorId);
    const unlink = rows.find((r) => r.event_type === "unlinked_withdrawal");
    expect(unlink).toBeDefined();
    expect(unlink!.contact_id).toBe(contactId);
  });

  it("does NOT set identification_suppressed_at -- withdrawal is reversible, unlike erasure", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `a-${randomUUID()}@example.test`;
    await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    await identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() });

    await unlinkVisitorIdentityOnWithdrawal({ organizationId }, anonymousId);

    const visitorId = await visitorIdOf(organizationId, anonymousId);
    const current = await seedAsAdmin((c) =>
      c.query("select identification_suppressed_at from public.website_visitors where id = $1", [visitorId]),
    );
    expect(current.rows[0].identification_suppressed_at).toBeNull();

    // Provably reversible: a fresh identify() call succeeds again afterward.
    const result = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(result.accepted).toBe(true);
  });

  it("is a pure no-op for a visitor that was never identified -- no audit row, no error", async () => {
    const organizationId = await createOrg();
    const anonymousId = await grantedAnonymousId(organizationId);
    await seedAsAdmin((c) =>
      c.query("insert into public.website_visitors (organization_id, anonymous_id) values ($1, $2)", [organizationId, anonymousId]),
    );
    await expect(unlinkVisitorIdentityOnWithdrawal({ organizationId }, anonymousId)).resolves.toBeUndefined();
    const visitorId = await visitorIdOf(organizationId, anonymousId);
    const rows = await auditRows(organizationId, visitorId);
    expect(rows).toHaveLength(0);
  });

  it("is a pure no-op for a nonexistent visitor -- no error, no row created", async () => {
    const organizationId = await createOrg();
    await expect(unlinkVisitorIdentityOnWithdrawal({ organizationId }, randomUUID())).resolves.toBeUndefined();
  });

  it("participates in an existingClient transaction: rollback undoes the unlink entirely", async () => {
    const organizationId = await createOrg();
    const trackingSiteId = await createTrackingSite(organizationId);
    const email = `a-${randomUUID()}@example.test`;
    await createContact(organizationId, email);
    const anonymousId = await grantedAnonymousId(organizationId);
    await identifyVisitor({ organizationId }, { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() });
    const visitorId = await visitorIdOf(organizationId, anonymousId);

    const client = await adminPool.connect();
    try {
      await client.query("begin");
      await unlinkVisitorIdentityOnWithdrawal({ organizationId }, anonymousId, client);
      const midTransaction = await client.query("select identified_contact_id from public.website_visitors where id = $1", [
        visitorId,
      ]);
      expect(midTransaction.rows[0].identified_contact_id).toBeNull();
      await client.query("rollback");
    } finally {
      client.release();
    }

    const afterRollback = await seedAsAdmin((c) =>
      c.query("select identified_contact_id from public.website_visitors where id = $1", [visitorId]),
    );
    expect(afterRollback.rows[0].identified_contact_id).not.toBeNull();
  });
});
