import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenantContext, type DomainEvent } from "@ai-revenue-os/database";
import { createContact, updateContact, softDeleteContact, createCompany, softDeleteCompany } from "@ai-revenue-os/crm";
import { adminPool, createOrgWithActiveMember, seedDealFixture, getBrainProfileRow } from "./helpers";
import { contactProjectionConsumer, companyProjectionConsumer, dealProjectionConsumer } from "../src/ingestion";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function latestEvent(organizationId: string, eventType: string): Promise<DomainEvent> {
  const r = await adminPool.query(
    "select id, event_type, event_version, organization_id, payload, created_at, processed_at from public.events where organization_id = $1 and event_type = $2 order by created_at desc limit 1",
    [organizationId, eventType],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`no ${eventType} event found for org ${organizationId}`);
  return {
    id: row.id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    organizationId: row.organization_id,
    payload: row.payload,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

async function workflowRunStatus(organizationId: string, workflowKey: string, sourceEventId: string): Promise<string | null> {
  const r = await adminPool.query(
    "select status from public.workflow_runs where organization_id = $1 and workflow_key = $2 and source_event_id = $3",
    [organizationId, workflowKey, sourceEventId],
  );
  return r.rows[0]?.status ?? null;
}

describe("contactProjectionConsumer", () => {
  it("registers exactly the three contact event types", () => {
    expect(contactProjectionConsumer.eventTypes).toEqual(["contact.created", "contact.updated", "contact.deleted"]);
    expect(contactProjectionConsumer.name).toBe("brain_projection_contact");
  });

  it("a valid contact.created event creates an active profile", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const contact = await createContact({ userId, organizationId, roleKey }, { firstName: "Ada" });
    const event = await latestEvent(organizationId, "contact.created");

    await contactProjectionConsumer.handle(event);

    const row = await getBrainProfileRow(organizationId, "contact_id", contact.id);
    expect(row).not.toBeNull();
    expect(row.profile.firstName).toBe("Ada");
    expect(row.profile.isDeleted).toBe(false);
    expect(await workflowRunStatus(organizationId, "brain_projection_contact", event.id)).toBe("succeeded");
  });

  it("duplicate delivery of the same event is a clean no-op — no duplicate history, no re-processing", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const contact = await createContact({ userId, organizationId, roleKey }, { firstName: "Ada" });
    const event = await latestEvent(organizationId, "contact.created");

    await contactProjectionConsumer.handle(event);
    const rowAfterFirst = await getBrainProfileRow(organizationId, "contact_id", contact.id);

    await contactProjectionConsumer.handle(event); // redelivered
    const rowAfterSecond = await getBrainProfileRow(organizationId, "contact_id", contact.id);

    expect(rowAfterSecond.computed_at).toEqual(rowAfterFirst.computed_at);
    const historyCount = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profile_history where entity_profile_id = $1",
      [rowAfterFirst.id],
    );
    expect(historyCount.rows[0].count).toBe("0");
  });

  it("retry after a failed run re-attempts and succeeds", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const contact = await createContact({ userId, organizationId, roleKey }, { firstName: "Ada" });
    const event = await latestEvent(organizationId, "contact.created");

    // Force a prior 'failed' claim row for this exact event, simulating a
    // crashed/failed first attempt.
    await adminPool.query(
      `insert into public.workflow_runs (organization_id, workflow_key, source_event_id, status, completed_at)
       values ($1, 'brain_projection_contact', $2, 'failed', now())`,
      [organizationId, event.id],
    );

    await contactProjectionConsumer.handle(event);

    expect(await workflowRunStatus(organizationId, "brain_projection_contact", event.id)).toBe("succeeded");
    const row = await getBrainProfileRow(organizationId, "contact_id", contact.id);
    expect(row).not.toBeNull();
  });

  it("a hard-erased/nonexistent contact produces a clean entity_not_found outcome, no thrown exception, no profile row", async () => {
    const { organizationId } = await createOrgWithActiveMember();
    const fakeContactId = randomUUID();
    const fakeEvent: DomainEvent = {
      id: randomUUID(),
      eventType: "contact.created",
      eventVersion: 1,
      organizationId,
      payload: { organization_id: organizationId, contact_id: fakeContactId },
      createdAt: new Date().toISOString(),
      processedAt: null,
    };

    await expect(contactProjectionConsumer.handle(fakeEvent)).resolves.toBeUndefined();
    expect(await workflowRunStatus(organizationId, "brain_projection_contact", fakeEvent.id)).toBe("failed");
    const row = await getBrainProfileRow(organizationId, "contact_id", fakeContactId);
    expect(row).toBeNull();
  });

  it("soft-delete produces a tombstone: getContactById no longer sees it, but the Brain profile shows isDeleted=true with content preserved", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const contact = await createContact(ctx, { firstName: "Ada", lastName: "Lovelace" });
    await contactProjectionConsumer.handle(await latestEvent(organizationId, "contact.created"));

    await softDeleteContact(ctx, contact.id);
    const deleteEvent = await latestEvent(organizationId, "contact.deleted");
    await contactProjectionConsumer.handle(deleteEvent);

    const row = await getBrainProfileRow(organizationId, "contact_id", contact.id);
    expect(row).not.toBeNull();
    expect(row.profile.isDeleted).toBe(true);
    expect(row.profile.firstName).toBe("Ada");
    expect(row.profile.lastName).toBe("Lovelace");
  });

  it("a tombstone created directly from a .deleted event with no prior profile row still succeeds (no .created event ever processed)", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const contact = await createContact(ctx, { firstName: "Ada" });
    // Deliberately never process the contact.created event.
    await softDeleteContact(ctx, contact.id);
    const deleteEvent = await latestEvent(organizationId, "contact.deleted");

    await contactProjectionConsumer.handle(deleteEvent);

    const row = await getBrainProfileRow(organizationId, "contact_id", contact.id);
    expect(row).not.toBeNull();
    expect(row.profile.isDeleted).toBe(true);
  });
});

describe("companyProjectionConsumer", () => {
  it("registers exactly the three company event types and projects/tombstones correctly", async () => {
    expect(companyProjectionConsumer.eventTypes).toEqual(["company.created", "company.updated", "company.deleted"]);
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const company = await createCompany(ctx, { name: "Acme Inc" });
    await companyProjectionConsumer.handle(await latestEvent(organizationId, "company.created"));

    let row = await getBrainProfileRow(organizationId, "company_id", company.id);
    expect(row.profile.name).toBe("Acme Inc");
    expect(row.profile.isDeleted).toBe(false);

    await softDeleteCompany(ctx, company.id);
    await companyProjectionConsumer.handle(await latestEvent(organizationId, "company.deleted"));
    row = await getBrainProfileRow(organizationId, "company_id", company.id);
    expect(row.profile.isDeleted).toBe(true);
  });
});

describe("dealProjectionConsumer", () => {
  it("registers exactly the three deal event types and projects a deal profile", async () => {
    expect(dealProjectionConsumer.eventTypes).toEqual(["deal.created", "deal.updated", "deal.deleted"]);
    const fixture = await createOrgWithActiveMember();
    const deal = await seedDealFixture(fixture);
    await dealProjectionConsumer.handle(await latestEvent(fixture.organizationId, "deal.created"));

    const row = await getBrainProfileRow(fixture.organizationId, "deal_id", deal.id);
    expect(row).not.toBeNull();
    expect(row.profile.status).toBe("open");
    expect(row.profile.currency).toBe("EUR");
    expect(row.profile.isDeleted).toBe(false);
  });
});

describe("cross-tenant safety", () => {
  it("an event forged with another organization's contact id (payload org mismatched to a real contact in a different org) cannot write a profile into the wrong tenant", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const contactInB = await createContact({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, { firstName: "InB" });

    // A forged event claims orgA but references orgB's real contact id.
    const forged: DomainEvent = {
      id: randomUUID(),
      eventType: "contact.created",
      eventVersion: 1,
      organizationId: orgA.organizationId,
      payload: { organization_id: orgA.organizationId, contact_id: contactInB.id },
      createdAt: new Date().toISOString(),
      processedAt: null,
    };

    await contactProjectionConsumer.handle(forged);

    // getContactById under orgA's tenant context can never see orgB's row
    // (RLS) — this must resolve as entity_not_found, never leak orgB's data
    // into an orgA-owned profile row.
    const rowUnderA = await getBrainProfileRow(orgA.organizationId, "contact_id", contactInB.id);
    expect(rowUnderA).toBeNull();
    const rowUnderB = await getBrainProfileRow(orgB.organizationId, "contact_id", contactInB.id);
    expect(rowUnderB).toBeNull(); // never processed under orgB either — the forged event claimed orgA.
  });
});

/**
 * M4.1 Phase 2 Final Implementation Acceptance Audit — LOW finding
 * strengthened: the original "hard-erased/nonexistent contact" test above
 * uses a fabricated id that was never a real row. These tests instead
 * take a REAL contact through the full lifecycle: created, projected into
 * a real brain_entity_profiles row, hard-erased via the real
 * execute_contact_erasure() RPC (not a raw DELETE), confirmed gone from
 * both public.contacts and Brain via Phase 1's own cascade, and only then
 * have a genuinely-previously-created (not fabricated) CRM Brain event
 * for that same contact replayed through the real consumer.
 */
describe("GDPR hard-erasure non-resurrection (real execute_contact_erasure, M4.1 Phase 2 Final Implementation Acceptance Audit)", () => {
  async function fileAndExecuteContactErasure(organizationId: string, adminUserId: string, contactId: string): Promise<void> {
    const dsrId = await adminPool.query(
      "insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type) values ($1, 'contact', $2, 'delete') returning id",
      [organizationId, contactId],
    );
    // The REAL, committing withTenantContext (not a rollback-only test
    // variant) — execute_contact_erasure's own hard-delete must actually
    // persist for the rest of this test to observe it.
    await withTenantContext({ userId: adminUserId, organizationId }, async (client) => {
      await client.query("select * from public.execute_contact_erasure($1, $2)", [dsrId.rows[0]!.id, adminUserId]);
    });
  }

  it("a real contact that was profiled, then hard-erased via execute_contact_erasure, is not resurrected by a stale pending contact.updated event", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const contact = await createContact(ctx, { firstName: "Erasable", lastName: "Contact", email: `erasable-${randomUUID()}@example.test` });

    // Project it for real — a genuine profile now exists.
    await contactProjectionConsumer.handle(await latestEvent(organizationId, "contact.created"));
    const profileBeforeErasure = await getBrainProfileRow(organizationId, "contact_id", contact.id);
    expect(profileBeforeErasure).not.toBeNull();

    // A second, real event (contact.updated) is created but deliberately
    // left UNPROCESSED — simulating a genuinely-pending event still
    // sitting in the outbox at the moment erasure happens (a realistic
    // eventual-consistency window, not a fabricated payload).
    await updateContact(ctx, contact.id, { jobTitle: "Soon To Be Erased" });
    const stalePendingEvent = await latestEvent(organizationId, "contact.updated");

    // Real hard erasure via the real RPC, not a raw DELETE.
    await fileAndExecuteContactErasure(organizationId, userId, contact.id);

    const contactRow = await adminPool.query("select 1 from public.contacts where id = $1", [contact.id]);
    expect(contactRow.rows).toHaveLength(0);
    const profileAfterErasure = await getBrainProfileRow(organizationId, "contact_id", contact.id);
    expect(profileAfterErasure).toBeNull(); // Phase 1's own cascade already removed it.
    const historyAfterErasure = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profile_history where entity_profile_id = $1",
      [profileBeforeErasure.id],
    );
    expect(historyAfterErasure.rows[0].count).toBe("0");

    // Now deliver the previously-created, genuinely-real, never-before-processed event.
    await expect(contactProjectionConsumer.handle(stalePendingEvent)).resolves.toBeUndefined();

    expect(await workflowRunStatus(organizationId, "brain_projection_contact", stalePendingEvent.id)).toBe("failed");
    const finalProfile = await getBrainProfileRow(organizationId, "contact_id", contact.id);
    expect(finalProfile).toBeNull(); // still not recreated.
    const finalHistory = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profile_history where entity_profile_id = $1",
      [profileBeforeErasure.id],
    );
    expect(finalHistory.rows[0].count).toBe("0"); // still no history — nothing to snapshot for a row that no longer exists.
    // No erased PII reappears anywhere Brain-owned.
    const anyProfileForThisContact = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profiles where contact_id = $1",
      [contact.id],
    );
    expect(anyProfileForThisContact.rows[0].count).toBe("0");
  });

  it("soft-delete (tombstone) -> hard erasure -> a stale .deleted event replay afterward cannot resurrect the tombstone or the profile", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const contact = await createContact(ctx, { firstName: "SoftThenHard", lastName: "Erased" });

    await contactProjectionConsumer.handle(await latestEvent(organizationId, "contact.created"));

    await softDeleteContact(ctx, contact.id);
    const deleteEvent = await latestEvent(organizationId, "contact.deleted");
    await contactProjectionConsumer.handle(deleteEvent);

    const tombstoned = await getBrainProfileRow(organizationId, "contact_id", contact.id);
    expect(tombstoned).not.toBeNull();
    expect(tombstoned.profile.isDeleted).toBe(true);

    // Hard-erase the already-soft-deleted contact (Phase 1's own contract:
    // a soft-deleted contact remains a valid erasure target).
    await fileAndExecuteContactErasure(organizationId, userId, contact.id);

    const contactRow = await adminPool.query("select 1 from public.contacts where id = $1", [contact.id]);
    expect(contactRow.rows).toHaveLength(0);
    expect(await getBrainProfileRow(organizationId, "contact_id", contact.id)).toBeNull();
    const historyAfterErasure = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profile_history where entity_profile_id = $1",
      [tombstoned.id],
    );
    expect(historyAfterErasure.rows[0].count).toBe("0");

    // A stale replay of the SAME already-tombstoned-and-now-erased
    // contact's .deleted semantics, delivered via a genuinely fresh event
    // id (simulating a redelivery/retry mechanism producing a second,
    // independent attempt rather than the already-'succeeded' original
    // claim) — the .deleted path specifically exercises
    // getContactByIdIncludingDeleted, which must also correctly find
    // nothing for a truly hard-erased row (not merely a soft-deleted one).
    const staleReplay: DomainEvent = {
      id: randomUUID(),
      eventType: "contact.deleted",
      eventVersion: 1,
      organizationId,
      payload: { organization_id: organizationId, contact_id: contact.id },
      createdAt: new Date().toISOString(),
      processedAt: null,
    };

    await expect(contactProjectionConsumer.handle(staleReplay)).resolves.toBeUndefined();

    expect(await workflowRunStatus(organizationId, "brain_projection_contact", staleReplay.id)).toBe("failed");
    expect(await getBrainProfileRow(organizationId, "contact_id", contact.id)).toBeNull();
    const finalHistory = await adminPool.query(
      "select count(*)::text as count from public.brain_entity_profile_history where entity_profile_id = $1",
      [tombstoned.id],
    );
    expect(finalHistory.rows[0].count).toBe("0");
  });
});
