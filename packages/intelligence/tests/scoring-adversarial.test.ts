import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, seedAsAdmin } from "./helpers";
import { recalculateContactScore, recalculateContactScoreForEvent, recoverPendingPostEnrichmentScoring, POST_ENRICHMENT_SCORING_WORKFLOW_KEY } from "../src/scoring";
import { unlinkVisitorIdentityOnWithdrawal } from "../src/identify";
import { recordEnrichmentResult } from "../src/enrichment";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.4F — hostile/adversarial and concurrency verification for
 * the lead-scoring domain layer. Mirrors packages/database/tests/
 * dispatcher.test.ts's own style for the concurrency probes (Promise.all,
 * not sequential awaits, against real Postgres).
 */

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function createContact(organizationId: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name) values ($1, 'Adversarial') returning id",
      [organizationId],
    );
    return r.rows[0]!.id;
  });
}

async function leadScoreCount(contactId: string): Promise<number> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ n: string }>("select count(*)::int as n from public.lead_scores where contact_id = $1", [
      contactId,
    ]);
    return Number(r.rows[0]!.n);
  });
}

describe("recalculateContactScoreForEvent: duplicate-delivery concurrency", () => {
  it("two genuinely simultaneous calls for the SAME (workflow_key, source_event_id) must not both insert a lead_scores row", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();
    const ctx = { organizationId };

    const [a, b] = await Promise.all([
      recalculateContactScoreForEvent(ctx, { contactId, workflowKey: "lead_scoring", sourceEventId }),
      recalculateContactScoreForEvent(ctx, { contactId, workflowKey: "lead_scoring", sourceEventId }),
    ]);

    const acceptedCount = [a, b].filter((o) => o.accepted).length;
    expect(acceptedCount).toBe(1);
    expect(await leadScoreCount(contactId)).toBe(1);
  });

  it("a redelivery after the first call has already succeeded is a clean no-op — no second row", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();
    const ctx = { organizationId };

    const first = await recalculateContactScoreForEvent(ctx, { contactId, workflowKey: "lead_scoring", sourceEventId });
    expect(first.accepted).toBe(true);

    const redelivered = await recalculateContactScoreForEvent(ctx, {
      contactId,
      workflowKey: "lead_scoring",
      sourceEventId,
    });
    expect(redelivered).toEqual({ accepted: false, reason: "already_processed" });
    expect(await leadScoreCount(contactId)).toBe(1);
  });

  it("crash recovery: a workflow_runs row stranded at 'running' by a crashed prior process is reclaimed by the next attempt, exactly once", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();

    // Simulates a process that won the claim and then died before ever
    // reaching the completion-bookkeeping UPDATE — the only observable
    // trace left behind is a permanently 'running' row.
    await seedAsAdmin((c) =>
      c.query(
        "insert into public.workflow_runs (organization_id, workflow_key, source_event_id, status, started_at) values ($1, 'lead_scoring', $2, 'running', now() - interval '1 hour')",
        [organizationId, sourceEventId],
      ),
    );

    const outcome = await recalculateContactScoreForEvent(
      { organizationId },
      { contactId, workflowKey: "lead_scoring", sourceEventId },
    );
    expect(outcome.accepted).toBe(true);
    expect(await leadScoreCount(contactId)).toBe(1);
  });

  it("different contacts sharing no source_event_id never collide — each gets its own independent row", async () => {
    const organizationId = await createOrg();
    const contactA = await createContact(organizationId);
    const contactB = await createContact(organizationId);

    await Promise.all([
      recalculateContactScoreForEvent({ organizationId }, { contactId: contactA, workflowKey: "lead_scoring", sourceEventId: randomUUID() }),
      recalculateContactScoreForEvent({ organizationId }, { contactId: contactB, workflowKey: "lead_scoring", sourceEventId: randomUUID() }),
    ]);

    expect(await leadScoreCount(contactA)).toBe(1);
    expect(await leadScoreCount(contactB)).toBe(1);
  });
});

describe("recalculateContactScore: simultaneous scoring of one contact (no dedup layer — historized by design)", () => {
  it("two genuinely simultaneous, non-event-triggered calls each insert their own historized row — no crash, no lost write", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);

    const [a, b] = await Promise.all([
      recalculateContactScore({ organizationId }, { contactId }),
      recalculateContactScore({ organizationId }, { contactId }),
    ]);
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    expect(await leadScoreCount(contactId)).toBe(2);
  });
});

describe("recalculateContactScore: cascade-delete on contact erasure", () => {
  it("hard-deleting a contact removes its lead_scores history via the composite FK cascade", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    await recalculateContactScore({ organizationId }, { contactId });
    expect(await leadScoreCount(contactId)).toBe(1);

    await seedAsAdmin((c) => c.query("delete from public.contacts where id = $1", [contactId]));

    const remaining = await seedAsAdmin((c) => c.query("select count(*)::int as n from public.lead_scores where contact_id = $1", [contactId]));
    expect(remaining.rows[0].n).toBe(0);
  });
});

describe("recalculateContactScore: consent-withdrawal interaction", () => {
  it("after unlinkVisitorIdentityOnWithdrawal, a later recalculation no longer counts that visitor's engagement — a prior historized score is untouched", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const anonymousId = randomUUID();

    const siteId = await seedAsAdmin(async (c) => {
      const r = await c.query<{ id: string }>("insert into public.tracking_sites (organization_id, label) values ($1, 'Site') returning id", [organizationId]);
      return r.rows[0]!.id;
    });
    const visitorId = await seedAsAdmin(async (c) => {
      const r = await c.query<{ id: string }>(
        "insert into public.website_visitors (organization_id, anonymous_id, identified_contact_id) values ($1, $2, $3) returning id",
        [organizationId, anonymousId, contactId],
      );
      return r.rows[0]!.id;
    });
    const sessionId = await seedAsAdmin(async (c) => {
      const r = await c.query<{ id: string }>(
        "insert into public.visitor_sessions (organization_id, visitor_id, tracking_site_id, anonymous_session_id) values ($1, $2, $3, $4) returning id",
        [organizationId, visitorId, siteId, randomUUID()],
      );
      return r.rows[0]!.id;
    });
    await seedAsAdmin((c) =>
      c.query("insert into public.visitor_events (organization_id, session_id, event_type) values ($1, $2, 'pageview'), ($1, $2, 'pageview')", [
        organizationId,
        sessionId,
      ]),
    );
    await seedAsAdmin((c) =>
      c.query(
        "insert into public.scoring_rules (organization_id, name, field, operator, value, weight) values ($1, 'r', 'engagement.pageviews_30d', 'gte', '2', 40)",
        [organizationId],
      ),
    );

    const before = await recalculateContactScore({ organizationId }, { contactId });
    expect(before.accepted).toBe(true);
    if (before.accepted) expect(before.score).toBe(40);

    await unlinkVisitorIdentityOnWithdrawal({ organizationId }, anonymousId);

    const after = await recalculateContactScore({ organizationId }, { contactId });
    expect(after.accepted).toBe(true);
    if (after.accepted) expect(after.score).toBe(0); // no longer identified -- engagement facts see nothing.

    // The prior, already-historized row is never mutated by the unlink.
    const historicRow = await seedAsAdmin((c) =>
      c.query("select score from public.lead_scores where contact_id = $1 order by computed_at asc limit 1", [contactId]),
    );
    expect(historicRow.rows[0].score).toBe(40);
  });
});

describe("computeScore breakdown: no PII beyond allowlisted field/operator/matched/contribution", () => {
  it("a matched rule's breakdown entry never carries the contact's actual field VALUE — only the fixed shape", async () => {
    const organizationId = await createOrg();
    const contactId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, first_name, job_title) values ($1, 'PII Check', 'Chief Secret Officer') returning id",
        [organizationId],
      );
      return r.rows[0]!.id;
    });
    await seedAsAdmin((c) =>
      c.query(
        "insert into public.scoring_rules (organization_id, name, field, operator, value, weight) values ($1, 'r', 'contact.job_title', 'exists', 'null', 15)",
        [organizationId],
      ),
    );

    const outcome = await recalculateContactScore({ organizationId }, { contactId });
    expect(outcome.accepted).toBe(true);

    const row = await seedAsAdmin((c) => c.query("select breakdown from public.lead_scores where contact_id = $1", [contactId]));
    const breakdown = JSON.stringify(row.rows[0].breakdown);
    expect(breakdown).not.toContain("Chief Secret Officer");
    expect(row.rows[0].breakdown[0]).toEqual(
      expect.objectContaining({ field: "contact.job_title", operator: "exists", matched: true, contribution: 15 }),
    );
  });
});

describe("recordEnrichmentResult -> post-enrichment scoring: durable retry (Milestone 3.4 Targeted Acceptance Remediation, Finding 3)", () => {
  it("recordEnrichmentResult's own post-write hook creates a real, durable lead_scoring_post_enrichment claim keyed by the write-back's own sourceEventId, with contact_id populated", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();

    const outcome = await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test", status: "completed", sourceEventId, workflowKey: "lead_enrichment" },
    );
    expect(outcome.accepted).toBe(true); // enrichment write-back succeeds.

    const enrichmentRow = await seedAsAdmin((c) => c.query("select status from public.contact_enrichment where contact_id = $1", [contactId]));
    expect(enrichmentRow.rows[0].status).toBe("completed");

    const run = await seedAsAdmin((c) =>
      c.query(
        "select status, contact_id from public.workflow_runs where organization_id = $1 and workflow_key = $2 and source_event_id = $3",
        [organizationId, POST_ENRICHMENT_SCORING_WORKFLOW_KEY, sourceEventId],
      ),
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0].status).toBe("succeeded");
    expect(run.rows[0].contact_id).toBe(contactId);
    expect(await leadScoreCount(contactId)).toBe(1);
  });

  it("a durably-recorded post-enrichment scoring failure is found and completed by the recovery sweep — no manual recalculation, no new visitor.identified event", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();
    await seedAsAdmin((c) =>
      c.query(
        "insert into public.scoring_rules (organization_id, name, field, operator, value, weight) values ($1, 'r', 'contact.job_title', 'exists', 'null', 33)",
        [organizationId],
      ),
    );

    // Simulates: recordEnrichmentResult's own post-write hook claimed this
    // row and then genuinely failed (a transient DB error, say) — the
    // same "seed the end-state directly" technique the Milestone 3.3
    // Crash A/B tests already establish as the faithful way to represent
    // a failure without literally forcing a process crash mid-flight.
    // Enrichment persistence itself is not modeled here at all — this
    // test isolates the retry mechanism specifically; the sibling test
    // above already proves enrichment write-back succeeds independently
    // of this row's own eventual outcome.
    await seedAsAdmin((c) =>
      c.query(
        `insert into public.workflow_runs (organization_id, workflow_key, source_event_id, contact_id, status, started_at, completed_at, error)
         values ($1, $2, $3, $4, 'failed', now(), now(), 'simulated transient failure')`,
        [organizationId, POST_ENRICHMENT_SCORING_WORKFLOW_KEY, sourceEventId, contactId],
      ),
    );
    expect(await leadScoreCount(contactId)).toBe(0); // durably pending, not yet scored.

    const summary = await recoverPendingPostEnrichmentScoring();
    expect(summary.attempted).toBeGreaterThanOrEqual(1);
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);

    expect(await leadScoreCount(contactId)).toBe(1); // automatically recovered.
    const run = await seedAsAdmin((c) =>
      c.query(
        "select status from public.workflow_runs where organization_id = $1 and workflow_key = $2 and source_event_id = $3",
        [organizationId, POST_ENRICHMENT_SCORING_WORKFLOW_KEY, sourceEventId],
      ),
    );
    expect(run.rows[0].status).toBe("succeeded");
  });

  it("a stale (crashed mid-flight) claim is also recoverable, exactly mirroring the dispatcher-triggered path's own crash-recovery guarantee", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();
    await seedAsAdmin((c) =>
      c.query(
        `insert into public.workflow_runs (organization_id, workflow_key, source_event_id, contact_id, status, started_at)
         values ($1, $2, $3, $4, 'running', now() - interval '1 hour')`,
        [organizationId, POST_ENRICHMENT_SCORING_WORKFLOW_KEY, sourceEventId, contactId],
      ),
    );

    const summary = await recoverPendingPostEnrichmentScoring();
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);
    expect(await leadScoreCount(contactId)).toBe(1);
  });

  it("duplicate/replayed recovery does not violate the historized-once-succeeded invariant — a second sweep after success is a clean no-op", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();
    await seedAsAdmin((c) =>
      c.query(
        `insert into public.workflow_runs (organization_id, workflow_key, source_event_id, contact_id, status, started_at, completed_at)
         values ($1, $2, $3, $4, 'failed', now(), now())`,
        [organizationId, POST_ENRICHMENT_SCORING_WORKFLOW_KEY, sourceEventId, contactId],
      ),
    );

    const first = await recoverPendingPostEnrichmentScoring();
    expect(first.succeeded).toBeGreaterThanOrEqual(1);
    expect(await leadScoreCount(contactId)).toBe(1);

    // A second sweep tick: the row is now 'succeeded' and therefore no
    // longer selected by the sweep's own WHERE clause at all -- not
    // reattempted, not re-inserted.
    const second = await recoverPendingPostEnrichmentScoring();
    expect(await leadScoreCount(contactId)).toBe(1);
    const thisRowStillJustOne = await seedAsAdmin((c) =>
      c.query(
        "select count(*)::int as n from public.workflow_runs where organization_id = $1 and workflow_key = $2 and source_event_id = $3",
        [organizationId, POST_ENRICHMENT_SCORING_WORKFLOW_KEY, sourceEventId],
      ),
    );
    expect(thisRowStillJustOne.rows[0].n).toBe(1);
    void second;
  });

  it("the recovery sweep processes each organization's own pending retries independently — no cross-tenant leakage", async () => {
    const orgA = await createOrg();
    const contactA = await createContact(orgA);
    const orgB = await createOrg();
    const contactB = await createContact(orgB);

    for (const [org, contact] of [
      [orgA, contactA],
      [orgB, contactB],
    ] as const) {
      await seedAsAdmin((c) =>
        c.query(
          `insert into public.workflow_runs (organization_id, workflow_key, source_event_id, contact_id, status, started_at, completed_at)
           values ($1, $2, $3, $4, 'failed', now(), now())`,
          [org, POST_ENRICHMENT_SCORING_WORKFLOW_KEY, randomUUID(), contact],
        ),
      );
    }

    await recoverPendingPostEnrichmentScoring();

    expect(await leadScoreCount(contactA)).toBe(1);
    expect(await leadScoreCount(contactB)).toBe(1);
    const scoreOrgs = await seedAsAdmin((c) =>
      c.query("select organization_id, contact_id from public.lead_scores where contact_id = any($1)", [[contactA, contactB]]),
    );
    for (const row of scoreOrgs.rows as { organization_id: string; contact_id: string }[]) {
      expect(row.organization_id).toBe(row.contact_id === contactA ? orgA : orgB);
    }
  });

  it("enrichment write-back persists even when its own post-write scoring claim cannot proceed (an already-active concurrent claim holds the row)", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const sourceEventId = randomUUID();

    // Pre-occupies the exact claim recordEnrichmentResult's own hook will
    // attempt, simulating scoring being genuinely unavailable/busy at
    // that instant -- deterministic, no mocking required.
    await seedAsAdmin((c) =>
      c.query(
        `insert into public.workflow_runs (organization_id, workflow_key, source_event_id, contact_id, status, started_at)
         values ($1, $2, $3, $4, 'running', now())`,
        [organizationId, POST_ENRICHMENT_SCORING_WORKFLOW_KEY, sourceEventId, contactId],
      ),
    );

    const outcome = await recordEnrichmentResult(
      { organizationId },
      { entityType: "contact", entityId: contactId, provider: "test", status: "completed", sourceEventId, workflowKey: "lead_enrichment" },
    );
    expect(outcome.accepted).toBe(true); // enrichment persistence is never rolled back merely because scoring could not proceed.

    const enrichmentRow = await seedAsAdmin((c) => c.query("select status from public.contact_enrichment where contact_id = $1", [contactId]));
    expect(enrichmentRow.rows[0].status).toBe("completed");
    expect(await leadScoreCount(contactId)).toBe(0); // scoring genuinely did not happen this time -- but recoverPendingPostEnrichmentScoring will pick the still-active-then-eventually-stale claim back up later.
  });

  it("no raw enrichment payload or contact PII is ever written into the durable workflow_runs claim row", async () => {
    const organizationId = await createOrg();
    const contactId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, first_name, email, job_title) values ($1, 'PII Contact', 'secret.person@example.test', 'Confidential Title') returning id",
        [organizationId],
      );
      return r.rows[0]!.id;
    });
    const sourceEventId = randomUUID();

    await recordEnrichmentResult(
      { organizationId },
      {
        entityType: "contact",
        entityId: contactId,
        provider: "test",
        status: "completed",
        sourceEventId,
        workflowKey: "lead_enrichment",
        normalizedResult: { companyDomain: "example.test", secretNote: "super-secret-enrichment-payload-value" },
      },
    );

    const run = await seedAsAdmin((c) =>
      c.query("select * from public.workflow_runs where organization_id = $1 and workflow_key = $2 and source_event_id = $3", [
        organizationId,
        POST_ENRICHMENT_SCORING_WORKFLOW_KEY,
        sourceEventId,
      ]),
    );
    const serialized = JSON.stringify(run.rows[0]);
    for (const secret of ["secret.person@example.test", "Confidential Title", "super-secret-enrichment-payload-value", "PII Contact"]) {
      expect(serialized).not.toContain(secret);
    }
    // Only opaque ids and operational bookkeeping fields are present.
    expect(Object.keys(run.rows[0]).sort()).toEqual(
      ["attempt_count", "completed_at", "contact_id", "cost_usd", "error", "error_classification", "id", "organization_id", "provider", "source_event_id", "started_at", "status", "workflow_key"].sort(),
    );
  });
});
