import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";

/**
 * Enrichment write-back domain layer (Milestone 3.3D, Milestone 3.3
 * Architecture Resolution Report §G/§I/§J/§K). Provider-agnostic by
 * construction — this module never talks to any provider, never sees a
 * provider credential, and never knows which provider produced a result
 * beyond its own bare `provider` attribution string. n8n calls the
 * provider directly and pushes an already-normalized result here.
 *
 * Every write re-derives and re-verifies LIVE state immediately before
 * writing, inside the same transaction, mirroring identifyVisitor's own
 * TOCTOU discipline (its live tracking-site and live-consent re-checks)
 * rather than inventing a new pattern: a stale trigger or a delayed
 * provider response can never write enrichment data for a contact/company
 * that no longer exists or has been soft-deleted.
 */

export type EnrichmentEntityType = "contact" | "company";
export type EnrichmentErrorClassification = "timeout" | "provider_4xx" | "provider_5xx" | "malformed_response" | "internal_error";

const ENTITY_TABLE: Record<EnrichmentEntityType, string> = {
  contact: "contacts",
  company: "companies",
};
const ENRICHMENT_TABLE: Record<EnrichmentEntityType, string> = {
  contact: "contact_enrichment",
  company: "company_enrichment",
};
const ENTITY_COLUMN: Record<EnrichmentEntityType, string> = {
  contact: "contact_id",
  company: "company_id",
};

/** Milestone 3.3 Architecture Resolution Report §E/§S — accepted default; a product/cost tuning value, not re-derived from anything else. */
export const DEFAULT_ENRICHMENT_TTL_DAYS = 30;

export interface RecordEnrichmentResultInput {
  entityType: EnrichmentEntityType;
  entityId: string;
  provider: string;
  status: "completed" | "failed";
  normalizedResult?: unknown;
  rawPayload?: unknown;
  error?: string;
  errorClassification?: EnrichmentErrorClassification;
  costUsd?: number;
  /** The public.events.id (visitor.identified/contact.created) that triggered this lookup, when event-triggered. Also the workflow_runs dedup key. */
  sourceEventId?: string;
  /**
   * When the provider lookup itself actually happened, per n8n's own
   * clock — NOT when this write-back call was received. This is what
   * makes stale/out-of-order-result rejection meaningful: two results
   * for the same entity can arrive in either order over the network:
   * the one with the LATER fetchedAt always wins, regardless of arrival
   * order. Defaults to receipt time if the caller doesn't supply one
   * (a degraded-but-safe fallback, not the recommended contract).
   */
  fetchedAt?: string;
  /** Static, code-defined workflow identifier, e.g. 'lead_enrichment'. */
  workflowKey: string;
}

export type RecordEnrichmentResultOutcome =
  | { accepted: true }
  | { accepted: false; reason: "entity_not_found" | "stale_result" };

function computeExpiresAt(fetchedAt: string): string {
  const fetchedAtMs = new Date(fetchedAt).getTime();
  return new Date(fetchedAtMs + DEFAULT_ENRICHMENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The one write path for a provider enrichment result. Atomic: live
 * entity re-check, monotonic (never-stale) upsert into the dedicated
 * enrichment table, and workflow_runs completion bookkeeping all happen
 * in one transaction.
 *
 * Never writes to `contacts`/`companies` themselves — see this module's
 * own header comment; provider data can never overwrite a customer-
 * entered CRM field, structurally, because no code path here touches
 * those tables' columns at all.
 */
export async function recordEnrichmentResult(
  ctx: RequestContext & { organizationId: string },
  input: RecordEnrichmentResultInput,
): Promise<RecordEnrichmentResultOutcome> {
  return withTenantContext(ctx, async (client) => {
    // Step 1: live re-check. A contact is rejected identically whether it
    // no longer exists at all (hard-erased, Milestone 3.2F-style GDPR
    // erasure — contacts genuinely undergo this) or still exists but is
    // soft-deleted (deleted_at is not null) — this codebase's ordinary,
    // ordinary-ordinary CRM soft-delete has no independent existence
    // reason to receive fresh enrichment writes either. Companies are
    // never hard-erased anywhere in this codebase (firmographic, not
    // personal, data) — the identical `deleted_at is null` check is what
    // actually matters for companies; the table simply never reaches the
    // "row doesn't exist at all" branch for a company in practice.
    const table = ENTITY_TABLE[input.entityType];
    const existsCheck = await client.query<{ id: string }>(
      `select id from public.${table} where id = $1 and organization_id = $2 and deleted_at is null`,
      [input.entityId, ctx.organizationId],
    );
    if (existsCheck.rows.length === 0) {
      return { accepted: false, reason: "entity_not_found" };
    }

    const enrichmentTable = ENRICHMENT_TABLE[input.entityType];
    const entityColumn = ENTITY_COLUMN[input.entityType];
    const fetchedAt = input.fetchedAt ?? new Date().toISOString();

    // Step 2: monotonic upsert. On a genuine first INSERT (no existing
    // row for this (organization, entity, provider)) this always
    // succeeds and returns exactly one row. On a conflict, the UPDATE
    // branch's own WHERE clause only fires when the incoming result is
    // STRICTLY newer than what's already stored — a stale OR
    // equal-timestamp result is silently rejected (zero rows returned).
    // Milestone 3.3 Reliability Remediation: this was originally `>=`,
    // which let an equal fetchedAt freely replace the stored row —
    // meaning two results that happen to share a timestamp (low clock
    // resolution on the provider/n8n side, or a naive retry that resends
    // the same timestamp with different content) would be resolved by
    // WHICHEVER WRITE REACHES POSTGRES LAST, not by any semantic
    // ordering — a real, arrival-order-dependent nondeterminism. Strict
    // `>` makes the rule fully deterministic: once a row exists for a
    // given fetchedAt, no later write carrying that same-or-older
    // timestamp can ever displace it, regardless of arrival order or
    // payload content. A resend with an IDENTICAL (fetchedAt, payload)
    // is correctly a no-op under this rule — the stored data is already
    // exactly what would have been written, so declining to write is
    // observably idempotent even though the call reports "stale_result"
    // rather than "accepted" (see recordEnrichmentResultOutcome's own
    // contract — the return value describes whether a write happened,
    // not whether the caller's data is already correctly reflected).
    // Deliberately no additional ordering/sequence column: fetchedAt
    // already carries a total, if coarse, order for this milestone's one
    // real provider integration, and introducing a second tiebreaker
    // field has no requirement backing it.
    const upsertResult = await client.query<{ id: string }>(
      `insert into public.${enrichmentTable}
         (organization_id, ${entityColumn}, provider, status, normalized_result, raw_payload, error, cost_usd, source_event_id, fetched_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (organization_id, ${entityColumn}, provider) do update set
         status = excluded.status,
         normalized_result = excluded.normalized_result,
         raw_payload = excluded.raw_payload,
         error = excluded.error,
         cost_usd = excluded.cost_usd,
         source_event_id = excluded.source_event_id,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at
       where excluded.fetched_at > public.${enrichmentTable}.fetched_at
       returning id`,
      [
        ctx.organizationId,
        input.entityId,
        input.provider,
        input.status,
        input.normalizedResult !== undefined ? JSON.stringify(input.normalizedResult) : null,
        input.rawPayload !== undefined ? JSON.stringify(input.rawPayload) : null,
        input.error ?? null,
        input.costUsd ?? null,
        input.sourceEventId ?? null,
        fetchedAt,
        computeExpiresAt(fetchedAt),
      ],
    );

    if (upsertResult.rows.length === 0) {
      return { accepted: false, reason: "stale_result" };
    }

    // Step 3: workflow_runs completion bookkeeping — upsert-safe against
    // a retried/duplicated write-back for the same (organization,
    // workflow, source event). Once a run's status is 'succeeded', this
    // WHERE clause structurally prevents any later conflicting write
    // from re-recording cost or flipping the outcome — the real
    // duplicate-cost-accounting guard (Milestone 3.3 Architecture
    // Resolution Report §I/§K). A null sourceEventId (on-demand trigger)
    // never conflicts with another null under ordinary SQL unique-
    // constraint semantics, so each on-demand run always inserts its own
    // independent row, by design.
    await client.query(
      `insert into public.workflow_runs
         (organization_id, workflow_key, source_event_id, status, cost_usd, error, error_classification, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (organization_id, workflow_key, source_event_id) do update set
         status = excluded.status,
         cost_usd = excluded.cost_usd,
         error = excluded.error,
         error_classification = excluded.error_classification,
         completed_at = excluded.completed_at,
         attempt_count = public.workflow_runs.attempt_count + 1
       where public.workflow_runs.status <> 'succeeded'`,
      [
        ctx.organizationId,
        input.workflowKey,
        input.sourceEventId ?? null,
        input.status === "completed" ? "succeeded" : "failed",
        input.costUsd ?? null,
        input.error ?? null,
        input.errorClassification ?? null,
      ],
    );

    return { accepted: true };
  });
}

/**
 * Records that a workflow run has started — called by the dispatch-side
 * consumer immediately before it makes the outbound call that triggers
 * n8n, never by the write-back endpoint. INSERT ... ON CONFLICT DO
 * NOTHING deliberately: this must never overwrite a run's own outcome
 * (whatever it currently is) — only recordEnrichmentResult's own
 * completion write is ever allowed to transition status away from
 * 'running'. A retried dispatch attempt for the same (organization,
 * workflow, source event) is therefore a harmless no-op here.
 */
export async function recordWorkflowRunStarted(
  ctx: RequestContext & { organizationId: string },
  input: { workflowKey: string; sourceEventId?: string },
): Promise<void> {
  await withTenantContext(ctx, async (client) => {
    await client.query(
      `insert into public.workflow_runs (organization_id, workflow_key, source_event_id, status)
       values ($1, $2, $3, 'running')
       on conflict (organization_id, workflow_key, source_event_id) do nothing`,
      [ctx.organizationId, input.workflowKey, input.sourceEventId ?? null],
    );
  });
}

/**
 * Milestone 3.3 Reliability Remediation — records that the TRIGGER itself
 * (the dispatch-side call that hands off to n8n) failed, as distinct from a
 * provider lookup that n8n itself reports back as failed via
 * recordEnrichmentResult. Before this function existed, a trigger-call
 * failure (e.g. the webhook POST times out, or n8n never responds) left a
 * workflow_runs row stranded at 'running' with no record of the failed
 * attempt — indistinguishable from "still genuinely in flight" — until (if
 * ever) a later retry happened to reach a definitive completed/failed
 * write-back. This closes that gap: the dispatch-side consumer calls this
 * on a trigger-call failure, immediately before re-throwing so
 * dispatchPendingEvents' own claim-release/retry logic still runs.
 *
 * Same `WHERE status <> 'succeeded'` guard as recordEnrichmentResult's own
 * workflow_runs upsert — once a run has genuinely succeeded, nothing can
 * ever flip it back to failed or re-record cost, preserving the
 * already-proven no-double-count guarantee. attempt_count increments,
 * exactly like a provider-side failure would, so failed trigger attempts
 * are visible in the same observability signal as failed provider attempts.
 */
export async function recordWorkflowRunTriggerFailed(
  ctx: RequestContext & { organizationId: string },
  input: { workflowKey: string; sourceEventId?: string; error: string },
): Promise<void> {
  await withTenantContext(ctx, async (client) => {
    await client.query(
      `insert into public.workflow_runs
         (organization_id, workflow_key, source_event_id, status, error, error_classification, completed_at)
       values ($1, $2, $3, 'failed', $4, 'internal_error', now())
       on conflict (organization_id, workflow_key, source_event_id) do update set
         status = 'failed',
         error = excluded.error,
         error_classification = excluded.error_classification,
         completed_at = excluded.completed_at,
         attempt_count = public.workflow_runs.attempt_count + 1
       where public.workflow_runs.status <> 'succeeded'`,
      [ctx.organizationId, input.workflowKey, input.sourceEventId ?? null, input.error],
    );
  });
}
