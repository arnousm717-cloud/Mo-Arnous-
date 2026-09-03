import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, seedAsAdmin } from "./helpers";
import { recordEnrichmentResult, recordWorkflowRunStarted, recordWorkflowRunTriggerFailed } from "../src/enrichment";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function createContact(organizationId: string, opts: { deleted?: boolean } = {}): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, deleted_at) values ($1, $2, $3) returning id",
      [organizationId, "Test", opts.deleted ? new Date().toISOString() : null],
    );
    return r.rows[0]!.id;
  });
}

async function createCompany(organizationId: string, opts: { deleted?: boolean } = {}): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name, deleted_at) values ($1, $2, $3) returning id",
      [organizationId, "Test Co", opts.deleted ? new Date().toISOString() : null],
    );
    return r.rows[0]!.id;
  });
}

async function enrichmentRow(table: "contact_enrichment" | "company_enrichment", organizationId: string, entityId: string, entityColumn: "contact_id" | "company_id") {
  return seedAsAdmin(async (client) => {
    const r = await client.query(
      `select status, normalized_result, fetched_at, cost_usd from public.${table} where organization_id = $1 and ${entityColumn} = $2`,
      [organizationId, entityId],
    );
    return r.rows[0];
  });
}

async function workflowRun(organizationId: string, workflowKey: string, sourceEventId: string | null) {
  return seedAsAdmin(async (client) => {
    const r = await client.query(
      sourceEventId
        ? "select status, attempt_count, cost_usd from public.workflow_runs where organization_id = $1 and workflow_key = $2 and source_event_id = $3"
        : "select status, attempt_count, cost_usd from public.workflow_runs where organization_id = $1 and workflow_key = $2 and source_event_id is null order by started_at desc limit 1",
      sourceEventId ? [organizationId, workflowKey, sourceEventId] : [organizationId, workflowKey],
    );
    return r.rows[0];
  });
}

describe("recordEnrichmentResult: contact happy path", () => {
  it("a completed result for an active contact is accepted and stored, never touching contacts.* columns", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);

    const result = await recordEnrichmentResult(
      { organizationId },
      {
        entityType: "contact",
        entityId: contactId,
        provider: "test-provider",
        status: "completed",
        normalizedResult: { companyDomain: "acme.example" },
        workflowKey: "lead_enrichment",
      },
    );
    expect(result).toEqual({ accepted: true });

    const row = await enrichmentRow("contact_enrichment", organizationId, contactId, "contact_id");
    expect(row.status).toBe("completed");
    expect(row.normalized_result).toEqual({ companyDomain: "acme.example" });

    // The contact's own columns are completely untouched.
    const contact = await seedAsAdmin((c) => c.query("select first_name from public.contacts where id = $1", [contactId]));
    expect(contact.rows[0].first_name).toBe("Test");
  });
});

describe("recordEnrichmentResult: erasure/soft-delete races", () => {
  it("a nonexistent contact_id is rejected — no row written", async () => {
    const organizationId = await createOrg();
    const result = await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: randomUUID(), provider: "test-provider", status: "completed", workflowKey: "lead_enrichment" },
    );
    expect(result).toEqual({ accepted: false, reason: "entity_not_found" });
  });

  it("a hard-erased-style (nonexistent) contact_id — the exact delayed-response-after-erasure scenario — is rejected", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    // Simulate hard erasure: the row is gone by the time the delayed
    // provider response arrives.
    await seedAsAdmin((c) => c.query("delete from public.contacts where id = $1", [contactId]));

    const result = await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", workflowKey: "lead_enrichment" },
    );
    expect(result).toEqual({ accepted: false, reason: "entity_not_found" });

    const row = await enrichmentRow("contact_enrichment", organizationId, contactId, "contact_id");
    expect(row).toBeUndefined();
  });

  it("a soft-deleted contact is rejected identically to a nonexistent one", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId, { deleted: true });

    const result = await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", workflowKey: "lead_enrichment" },
    );
    expect(result).toEqual({ accepted: false, reason: "entity_not_found" });
  });

  it("a soft-deleted company is rejected — the only lifecycle event that actually applies to companies in this codebase", async () => {
    const organizationId = await createOrg();
    const companyId = await createCompany(organizationId, { deleted: true });

    const result = await recordEnrichmentResult(
      { organizationId },
      { entityType: "company", entityId: companyId, provider: "test-provider", status: "completed", workflowKey: "lead_enrichment" },
    );
    expect(result).toEqual({ accepted: false, reason: "entity_not_found" });
  });

  it("a delayed write-back for a contact that was erased and later re-created with a different id never attaches to the new contact", async () => {
    const organizationId = await createOrg();
    const originalContactId = await createContact(organizationId);
    await seedAsAdmin((c) => c.query("delete from public.contacts where id = $1", [originalContactId]));
    const recreatedContactId = await createContact(organizationId); // brand-new uuid, unrelated

    const result = await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: originalContactId, provider: "test-provider", status: "completed", workflowKey: "lead_enrichment" },
    );
    expect(result).toEqual({ accepted: false, reason: "entity_not_found" });

    const recreatedRow = await enrichmentRow("contact_enrichment", organizationId, recreatedContactId, "contact_id");
    expect(recreatedRow).toBeUndefined();
  });
});

describe("recordEnrichmentResult: cross-tenant isolation", () => {
  it("a contact_id belonging to a different organization is rejected, indistinguishably from nonexistent", async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const contactInOrgA = await createContact(orgA);

    const result = await recordEnrichmentResult(
      { organizationId: orgB },
      { entityType: "contact", entityId: contactInOrgA, provider: "test-provider", status: "completed", workflowKey: "lead_enrichment" },
    );
    expect(result).toEqual({ accepted: false, reason: "entity_not_found" });

    const row = await enrichmentRow("contact_enrichment", orgB, contactInOrgA, "contact_id");
    expect(row).toBeUndefined();
  });
});

describe("recordEnrichmentResult: stale/out-of-order result rejection", () => {
  it("a result with an OLDER fetchedAt than what is already stored is rejected — never overwrites a newer result", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const now = Date.now();
    const newer = new Date(now).toISOString();
    const older = new Date(now - 60_000).toISOString();

    const first = await recordEnrichmentResult(
      { organizationId },
      {
        entityType: "contact",
        entityId: contactId,
        provider: "test-provider",
        status: "completed",
        normalizedResult: { v: "newer" },
        fetchedAt: newer,
        workflowKey: "lead_enrichment",
      },
    );
    expect(first).toEqual({ accepted: true });

    const stale = await recordEnrichmentResult(
      { organizationId },
      {
        entityType: "contact",
        entityId: contactId,
        provider: "test-provider",
        status: "completed",
        normalizedResult: { v: "older-should-not-win" },
        fetchedAt: older,
        workflowKey: "lead_enrichment",
      },
    );
    expect(stale).toEqual({ accepted: false, reason: "stale_result" });

    const row = await enrichmentRow("contact_enrichment", organizationId, contactId, "contact_id");
    expect(row.normalized_result).toEqual({ v: "newer" });
  });

  it("a result with a NEWER fetchedAt correctly overwrites an older stored result, regardless of arrival order", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const now = Date.now();
    const older = new Date(now - 60_000).toISOString();
    const newer = new Date(now).toISOString();

    await recordEnrichmentResult(
      { organizationId },
      {
        entityType: "contact",
        entityId: contactId,
        provider: "test-provider",
        status: "completed",
        normalizedResult: { v: "older-arrived-first" },
        fetchedAt: older,
        workflowKey: "lead_enrichment",
      },
    );
    const second = await recordEnrichmentResult(
      { organizationId },
      {
        entityType: "contact",
        entityId: contactId,
        provider: "test-provider",
        status: "completed",
        normalizedResult: { v: "newer-arrived-second" },
        fetchedAt: newer,
        workflowKey: "lead_enrichment",
      },
    );
    expect(second).toEqual({ accepted: true });

    const row = await enrichmentRow("contact_enrichment", organizationId, contactId, "contact_id");
    expect(row.normalized_result).toEqual({ v: "newer-arrived-second" });
  });

  it("Milestone 3.3 Reliability Remediation: equal fetchedAt with an IDENTICAL payload is idempotent — the stored row is unchanged regardless of the reported outcome", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sharedFetchedAt = new Date().toISOString();

    const first = await recordEnrichmentResult(
      { organizationId },
      {
        entityType: "contact",
        entityId: contactId,
        provider: "test-provider",
        status: "completed",
        normalizedResult: { v: "identical" },
        fetchedAt: sharedFetchedAt,
        workflowKey: "lead_enrichment",
      },
    );
    expect(first).toEqual({ accepted: true });

    // A resend of the exact same (fetchedAt, payload) — e.g. a retried
    // delivery of an identical provider result.
    const second = await recordEnrichmentResult(
      { organizationId },
      {
        entityType: "contact",
        entityId: contactId,
        provider: "test-provider",
        status: "completed",
        normalizedResult: { v: "identical" },
        fetchedAt: sharedFetchedAt,
        workflowKey: "lead_enrichment",
      },
    );
    // Strict `>` means an equal timestamp never replaces the stored row —
    // the second call correctly reports it did not write anything.
    expect(second).toEqual({ accepted: false, reason: "stale_result" });

    // The observable, meaningful guarantee: the stored data is exactly
    // what it would have been regardless — a byte-identical resend is
    // idempotent in effect, even though the return value distinguishes
    // "wrote" from "already correct."
    const row = await enrichmentRow("contact_enrichment", organizationId, contactId, "contact_id");
    expect(row.normalized_result).toEqual({ v: "identical" });
  });

  it("Milestone 3.3 Reliability Remediation: equal fetchedAt with a DIFFERENT payload cannot nondeterministically overwrite the existing result — deterministically rejected regardless of call order", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sharedFetchedAt = new Date().toISOString();

    const first = await recordEnrichmentResult(
      { organizationId },
      {
        entityType: "contact",
        entityId: contactId,
        provider: "test-provider",
        status: "completed",
        normalizedResult: { v: "first-writer" },
        fetchedAt: sharedFetchedAt,
        workflowKey: "lead_enrichment",
      },
    );
    expect(first).toEqual({ accepted: true });

    // A second, genuinely different result sharing the identical
    // fetchedAt — e.g. two independent triggers whose provider calls
    // happened to be timestamped at the same resolution boundary. Under
    // the OLD `>=` rule this would have won arbitrarily (whichever write
    // reached Postgres last); under strict `>` it is always rejected, no
    // matter which of these two calls Postgres sees first.
    const second = await recordEnrichmentResult(
      { organizationId },
      {
        entityType: "contact",
        entityId: contactId,
        provider: "test-provider",
        status: "completed",
        normalizedResult: { v: "second-writer-must-not-win" },
        fetchedAt: sharedFetchedAt,
        workflowKey: "lead_enrichment",
      },
    );
    expect(second).toEqual({ accepted: false, reason: "stale_result" });

    const row = await enrichmentRow("contact_enrichment", organizationId, contactId, "contact_id");
    // The FIRST writer's data is the one that persists, deterministically
    // — never arrival-order-dependent, since no later equal-timestamped
    // write can ever displace an already-stored row.
    expect(row.normalized_result).toEqual({ v: "first-writer" });
  });

  it("re-lookup for the same (organization, contact, provider) upserts in place — never accumulates a second row", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);

    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", fetchedAt: new Date(Date.now() - 1000).toISOString(), workflowKey: "lead_enrichment" },
    );
    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", fetchedAt: new Date().toISOString(), workflowKey: "lead_enrichment" },
    );

    const rows = await seedAsAdmin((c) =>
      c.query("select count(*)::int as n from public.contact_enrichment where organization_id = $1 and contact_id = $2", [
        organizationId,
        contactId,
      ]),
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

describe("recordEnrichmentResult: workflow_runs cost/duplicate-delivery accounting", () => {
  it("two write-backs for the SAME source_event_id (a retried delivery) never double-count cost — the second is a no-op once succeeded", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();

    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", costUsd: 0.05, sourceEventId, workflowKey: "lead_enrichment" },
    );
    const run1 = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(run1.status).toBe("succeeded");
    expect(Number(run1.cost_usd)).toBe(0.05);

    // A retried/duplicated delivery for the exact same trigger, attempting
    // to record cost again.
    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", costUsd: 0.05, sourceEventId, workflowKey: "lead_enrichment" },
    );

    const run2 = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(run2.status).toBe("succeeded");
    // attempt_count must NOT have incremented past what a genuine retry
    // recording would show if it were allowed to re-fire the WHERE
    // status <> 'succeeded' branch -- it stayed exactly as set by the
    // first success, proving the second write was a structural no-op.
    expect(run2.attempt_count).toBe(run1.attempt_count);

    // Only one lead_enrichment workflow_runs row exists for this event --
    // no duplicate cost row was created either. Scoped to workflow_key
    // (Milestone 3.4 Targeted Acceptance Remediation, Finding 3): this
    // same source_event_id now legitimately also carries its own,
    // independent lead_scoring_post_enrichment row (recordEnrichmentResult's
    // own durable scoring-retry claim) -- a second row under a DIFFERENT
    // workflow_key is correct and expected, not the double-count this
    // assertion actually guards against.
    const allRows = await seedAsAdmin((c) =>
      c.query(
        "select count(*)::int as n from public.workflow_runs where organization_id = $1 and source_event_id = $2 and workflow_key = 'lead_enrichment'",
        [organizationId, sourceEventId],
      ),
    );
    expect(allRows.rows[0].n).toBe(1);
  });

  it("a failed attempt followed by a successful retry correctly transitions status and increments attempt_count", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();

    await recordWorkflowRunStarted({ organizationId }, { workflowKey: "lead_enrichment", sourceEventId });
    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "failed", error: "timeout", errorClassification: "timeout", sourceEventId, workflowKey: "lead_enrichment" },
    );
    const afterFailure = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(afterFailure.status).toBe("failed");

    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", costUsd: 0.05, sourceEventId, workflowKey: "lead_enrichment" },
    );
    const afterRetrySuccess = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(afterRetrySuccess.status).toBe("succeeded");
    expect(afterRetrySuccess.attempt_count).toBeGreaterThan(afterFailure.attempt_count);
  });

  it("two independent on-demand (no source_event_id) triggers never collide with each other", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);

    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", costUsd: 0.05, workflowKey: "lead_enrichment" },
    );
    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", costUsd: 0.05, workflowKey: "lead_enrichment" },
    );

    const rows = await seedAsAdmin((c) =>
      c.query(
        "select count(*)::int as n from public.workflow_runs where organization_id = $1 and workflow_key = $2 and source_event_id is null",
        [organizationId, "lead_enrichment"],
      ),
    );
    expect(rows.rows[0].n).toBe(2);
  });
});

describe("recordWorkflowRunStarted", () => {
  it("creates a running row that a later completion can transition to succeeded", async () => {
    const organizationId = await createOrg();
    const sourceEventId = randomUUID();

    await recordWorkflowRunStarted({ organizationId }, { workflowKey: "lead_enrichment", sourceEventId });
    const running = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(running.status).toBe("running");
  });

  it("never overwrites an already-succeeded run's status (a late/duplicate start signal is a no-op)", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();

    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", costUsd: 0.05, sourceEventId, workflowKey: "lead_enrichment" },
    );
    await recordWorkflowRunStarted({ organizationId }, { workflowKey: "lead_enrichment", sourceEventId });

    const row = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(row.status).toBe("succeeded");
  });
});

describe("recordWorkflowRunTriggerFailed (Milestone 3.3 Reliability Remediation)", () => {
  it("a trigger-call failure (e.g. the webhook POST itself failing) deterministically transitions running -> failed, instead of leaving the row stranded at running", async () => {
    const organizationId = await createOrg();
    const sourceEventId = randomUUID();

    await recordWorkflowRunStarted({ organizationId }, { workflowKey: "lead_enrichment", sourceEventId });
    const running = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(running.status).toBe("running");

    await recordWorkflowRunTriggerFailed(
      { organizationId },
      { workflowKey: "lead_enrichment", sourceEventId, error: "webhook POST timed out" },
    );
    const afterTriggerFailure = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(afterTriggerFailure.status).toBe("failed");
    expect(afterTriggerFailure.attempt_count).toBeGreaterThan(running.attempt_count);
  });

  it("failure -> retry -> success: a subsequent successful write-back still correctly transitions the run to succeeded and records cost exactly once", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();

    await recordWorkflowRunStarted({ organizationId }, { workflowKey: "lead_enrichment", sourceEventId });
    await recordWorkflowRunTriggerFailed(
      { organizationId },
      { workflowKey: "lead_enrichment", sourceEventId, error: "webhook POST timed out" },
    );
    const afterFailure = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(afterFailure.status).toBe("failed");

    // A retried dispatch tick re-triggers, then succeeds.
    await recordWorkflowRunStarted({ organizationId }, { workflowKey: "lead_enrichment", sourceEventId });
    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", costUsd: 0.05, sourceEventId, workflowKey: "lead_enrichment" },
    );
    const afterSuccess = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(afterSuccess.status).toBe("succeeded");
    expect(Number(afterSuccess.cost_usd)).toBe(0.05);
    expect(afterSuccess.attempt_count).toBeGreaterThan(afterFailure.attempt_count);
  });

  it("cannot flip an already-succeeded run back to failed, or double-count/lose its cost — a late/stale trigger-failure signal arriving after success is a no-op", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();

    await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test-provider", status: "completed", costUsd: 0.05, sourceEventId, workflowKey: "lead_enrichment" },
    );
    const succeeded = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(succeeded.status).toBe("succeeded");

    // A stale/duplicate trigger-failure signal (e.g. a slow, already-
    // superseded delivery attempt finally erroring out after a different
    // attempt already succeeded) must never override the succeeded state.
    await recordWorkflowRunTriggerFailed(
      { organizationId },
      { workflowKey: "lead_enrichment", sourceEventId, error: "stale trigger failure, arrived after success" },
    );

    const afterStaleFailure = await workflowRun(organizationId, "lead_enrichment", sourceEventId);
    expect(afterStaleFailure.status).toBe("succeeded");
    expect(Number(afterStaleFailure.cost_usd)).toBe(0.05);
    expect(afterStaleFailure.attempt_count).toBe(succeeded.attempt_count);
  });
});

describe("recordEnrichmentResult: company path parity", () => {
  it("mirrors the contact path for company_enrichment", async () => {
    const organizationId = await createOrg();
    const companyId = await createCompany(organizationId);

    const result = await recordEnrichmentResult(
      { organizationId },
      { entityType: "company", entityId: companyId, provider: "test-provider", status: "completed", normalizedResult: { industry: "SaaS" }, workflowKey: "lead_enrichment" },
    );
    expect(result).toEqual({ accepted: true });

    const row = await enrichmentRow("company_enrichment", organizationId, companyId, "company_id");
    expect(row.normalized_result).toEqual({ industry: "SaaS" });

    const company = await seedAsAdmin((c) => c.query("select name from public.companies where id = $1", [companyId]));
    expect(company.rows[0].name).toBe("Test Co");
  });
});
