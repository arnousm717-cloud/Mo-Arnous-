import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { dispatchPendingEvents, type DomainEvent, type EventConsumer } from "@ai-revenue-os/database";
import {
  recordWorkflowRunStarted,
  recordWorkflowRunTriggerFailed,
  recalculateContactScoreForEvent,
  recoverPendingPostEnrichmentScoring,
} from "@ai-revenue-os/intelligence";
import {
  contactProjectionConsumer,
  companyProjectionConsumer,
  dealProjectionConsumer,
  claimBrainProjectionRun,
  completeBrainProjectionRun,
  EVENT_TYPES_BY_ENTITY,
  type EntityType,
} from "@ai-revenue-os/brain";
import { apiError } from "../../v1/_shared/api-error";

/**
 * Milestone 3.3F — GET /api/internal/dispatch-events. The cron-driven
 * trigger for the in-process outbox dispatcher (Milestone 3.3
 * Architecture Resolution Report §H), invoked by Vercel Cron on a
 * schedule (vercel.json). GET, not POST — Vercel Cron Jobs always invoke
 * via GET, automatically attaching `Authorization: Bearer $CRON_SECRET`
 * when that env var is configured; this handler verifies it explicitly
 * rather than trusting Vercel's own routing to be sufficient on its own.
 * Not under /api/v1/* — this is internal platform infrastructure, never
 * a tenant-facing or n8n-facing surface, protected by a dedicated
 * CRON_SECRET, never session or api_keys auth.
 *
 * Milestone 3.3 Reliability Remediation — this route no longer opens or
 * manages a database transaction or advisory lock at all. The original
 * design's transaction-scoped pg_try_advisory_xact_lock, wrapping the
 * entire dispatch pass, is gone: dispatchPendingEvents() itself now
 * provides all the concurrency safety this route needs (a bounded batch
 * per call, and an atomic claim-per-delivery that is safe under arbitrary
 * concurrency with no lock of any kind) — see that module's own header
 * comment for the full reasoning. This route's only remaining job is
 * CRON_SECRET verification and invoking one bounded dispatch pass.
 */

function timingSafeEqualStrings(a: string, b: string): boolean {
  // Hash both sides first — the same discipline verifyApiKey (packages/
  // auth/src/api-keys.ts) already established — so timingSafeEqual never
  // has to handle variable-length inputs (it throws on length mismatch,
  // which would itself leak length information via the exception path).
  const hashA = createHash("sha256").update(a, "utf8").digest();
  const hashB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * The one consumer this milestone ships: Lead Enrichment, triggered by
 * visitor.identified (the only event source that concretely exists and
 * fires today — Milestone 3.2). contact.created/company.created are
 * documented as alternate triggers (docs/06 §2) but no domain code in
 * this repository emits either event yet; wiring those is explicitly
 * deferred, not silently added here.
 *
 * Provider-agnostic and holds no provider credential — see this module's
 * own outbound call: it posts only {eventId, organizationId, entityType,
 * entityId} to a generic, operator-configured webhook URL. n8n decides
 * what to do with the trigger and which provider to call, entirely on
 * its own side (Milestone 3.3 Architecture Resolution Report §D/§E).
 */
const leadEnrichmentConsumer: EventConsumer = {
  name: "lead_enrichment",
  eventTypes: ["visitor.identified"],
  handle: async (event: DomainEvent) => {
    const webhookUrl = process.env.N8N_LEAD_ENRICHMENT_WEBHOOK_URL;
    if (!webhookUrl) {
      // Fails this one delivery attempt cleanly — caught by
      // dispatchPendingEvents' own per-delivery try/catch, contributing
      // to deliveriesFailed, never breaking the loop or any other
      // consumer/event. Retried on the next dispatch tick once
      // configured.
      throw new Error("N8N_LEAD_ENRICHMENT_WEBHOOK_URL is not configured");
    }

    const payload = event.payload as { organization_id: string; contact_id: string | null };
    if (!payload.contact_id) {
      return; // nothing to enrich for this event.
    }

    await recordWorkflowRunStarted(
      { organizationId: payload.organization_id },
      { workflowKey: "lead_enrichment", sourceEventId: event.id },
    );

    const headers: Record<string, string> = { "content-type": "application/json" };
    const webhookSecret = process.env.N8N_LEAD_ENRICHMENT_WEBHOOK_SECRET;
    if (webhookSecret) {
      headers.authorization = `Bearer ${webhookSecret}`;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          eventId: event.id,
          organizationId: payload.organization_id,
          entityType: "contact",
          entityId: payload.contact_id,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`n8n webhook responded with status ${response.status}`);
      }
    } catch (err) {
      // Milestone 3.3 Reliability Remediation — the TRIGGER call itself
      // failed (network error, timeout, or a non-OK response), as
      // distinct from a provider lookup that n8n itself later reports
      // failed via the write-back endpoint. Without this, the
      // workflow_runs row recordWorkflowRunStarted just wrote above would
      // be left stranded at 'running' indefinitely if this particular
      // trigger attempt never gets a definitive write-back — this makes
      // the failed attempt itself deterministic and visible. Best-effort:
      // wrapped so a failure recording the failure can never prevent the
      // re-throw below, which is what lets dispatchPendingEvents release
      // the delivery claim and retry on a future tick.
      try {
        await recordWorkflowRunTriggerFailed(
          { organizationId: payload.organization_id },
          {
            workflowKey: "lead_enrichment",
            sourceEventId: event.id,
            error: err instanceof Error ? err.message : "trigger call failed",
          },
        );
      } catch {
        // Swallowed deliberately — see comment above.
      }
      throw err;
    }
  },
};

/**
 * Milestone 3.4C — the second consumer this dispatcher ships, triggered
 * by the same visitor.identified event as lead_enrichment (registering
 * two consumers for one event type is exactly what the Milestone 3.3
 * processed_at fix hardened for — events.processed_at correctly waits
 * for BOTH this consumer's own delivery and lead_enrichment's own,
 * independently). Deliberately reuses workflow_runs for event-trigger
 * deduplication (Milestone 3.4 Implementation Authorization) rather than
 * any new mechanism — see recalculateContactScoreForEvent's own header
 * comment for why lead_scores' historized design needs this extra,
 * explicit claim layer that contact_enrichment's own monotonic upsert
 * gets for free.
 *
 * `{accepted:false}` outcomes (a since-deleted contact, or a redelivered
 * trigger already processed) are legitimate "nothing further to do"
 * results, not failures — this handler does not throw for either, so the
 * dispatcher marks the delivery as succeeded and never retries a
 * pointless re-attempt. Only a genuine, unexpected exception (e.g. a
 * transient DB error) propagates, which is exactly when a retry is
 * actually useful.
 */
const leadScoringConsumer: EventConsumer = {
  name: "lead_scoring",
  eventTypes: ["visitor.identified"],
  handle: async (event: DomainEvent) => {
    const payload = event.payload as { organization_id: string; contact_id: string | null };
    if (!payload.contact_id) {
      return; // nothing to score for this event.
    }

    await recalculateContactScoreForEvent(
      { organizationId: payload.organization_id },
      { contactId: payload.contact_id, workflowKey: "lead_scoring", sourceEventId: event.id },
    );
  },
};

const PAYLOAD_ID_KEY: Record<EntityType, "contact_id" | "company_id" | "deal_id"> = {
  contact: "contact_id",
  company: "company_id",
  deal: "deal_id",
};

/**
 * Milestone 4.1 Phase 3 — notifies the (future, not-yet-built) n8n Brain
 * Indexing workflow that a contact/company/deal profile may need a
 * (re-)embedding. Registered on the same nine contact/company/deal events
 * `brain_projection_*` already drains — the "one dispatcher, many
 * independent consumers" pattern this file already establishes twice
 * over. Deliberately does NOT depend on `brain_projection_*` having
 * already run in this same tick: `POST /api/v1/brain/embeddings`
 * (`upsertEntityEmbedding`) independently re-reads the CURRENT
 * `brain_entity_profiles` row and rejects a result computed against a
 * stale/nonexistent profile — the same "re-read current state, never
 * trust delivery ordering" discipline `brain_projection_*` itself already
 * relies on, so no ordering dependency between the two consumers is ever
 * required for correctness.
 *
 * ID-minimized payload only ({eventId, organizationId, entityType,
 * entityId}) — no profile/CRM text of any kind, mirroring
 * leadEnrichmentConsumer's own payload exactly. Reuses
 * claimBrainProjectionRun/completeBrainProjectionRun verbatim (a plain
 * `workflowKey` string parameter, no code change needed in
 * packages/brain) under a new `brain_embedding_trigger_<entity>` key
 * family, distinct from `brain_projection_<entity>` — a redelivered event
 * is a clean no-op at the claim layer, never reaching the webhook call.
 * Holds no provider credential and calls no provider — see
 * packages/brain/src/embeddings.ts's own header comment.
 */
function createBrainEmbeddingTriggerConsumer(entityType: EntityType): EventConsumer {
  const workflowKey = `brain_embedding_trigger_${entityType}`;
  const payloadIdKey = PAYLOAD_ID_KEY[entityType];

  return {
    name: workflowKey,
    eventTypes: EVENT_TYPES_BY_ENTITY[entityType],
    handle: async (event: DomainEvent) => {
      const payload = event.payload as Record<string, string | null | undefined>;
      const organizationId = payload.organization_id;
      const entityId = payload[payloadIdKey];
      if (!organizationId || !entityId) {
        return; // Unreachable in practice — see createBrainProjectionConsumer's own identical guard.
      }

      const ctx = { organizationId };
      const claimed = await claimBrainProjectionRun(ctx, { workflowKey, sourceEventId: event.id });
      if (!claimed) {
        return; // already processed, or a concurrent attempt is in flight — clean no-op.
      }

      const webhookUrl = process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL;
      if (!webhookUrl) {
        // Deliberately DOES NOT throw, unlike leadEnrichmentConsumer's own
        // otherwise-identical guard — a real difference, not an
        // inconsistency. leadEnrichmentConsumer's sole event type
        // (visitor.identified) is comparatively rare across the ambient
        // event stream; these three consumers share the exact same nine
        // high-frequency contact/company/deal events contactProjectionConsumer
        // already drains. events are selected strictly `created_at asc`
        // (packages/database/src/events.ts), globally across every
        // registered consumer's event types — an indefinitely-retried
        // (thrown) delivery here would never reach a terminal state while
        // this env var stays unset (expected for a while: no real n8n
        // Brain Indexing workflow exists yet, per this phase's own
        // authorized scope), permanently occupying the head of that
        // shared queue and starving contactProjectionConsumer's own
        // already-accepted delivery for the SAME and every LATER event —
        // a real regression risk to Phase 2's already-accepted behavior,
        // reproduced directly under full-suite ambient load before this
        // fix. Returning cleanly marks event_deliveries 'delivered' for
        // THIS consumer only (no further retry of this exact event by
        // this consumer), while still recording an honest 'failed'
        // workflow_runs entry for observability. An event missed this way
        // is not lost: findProfilesNeedingEmbedding (packages/brain/src/
        // backfill.ts) is the designed catch-up path for exactly this
        // case, the same relationship the entity-profile backfill already
        // has with the live projection path.
        await completeBrainProjectionRun(ctx, { workflowKey, sourceEventId: event.id, status: "failed", error: "webhook not configured" }).catch(() => {});
        return;
      }

      const headers: Record<string, string> = { "content-type": "application/json" };
      const webhookSecret = process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_SECRET;
      if (webhookSecret) {
        headers.authorization = `Bearer ${webhookSecret}`;
      }

      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ eventId: event.id, organizationId, entityType, entityId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new Error(`n8n webhook responded with status ${response.status}`);
        }
        await completeBrainProjectionRun(ctx, { workflowKey, sourceEventId: event.id, status: "succeeded" });
      } catch (err) {
        await completeBrainProjectionRun(ctx, {
          workflowKey,
          sourceEventId: event.id,
          status: "failed",
          error: err instanceof Error ? err.message : "trigger call failed",
        }).catch(() => {});
        throw err; // let dispatchPendingEvents release the delivery lease and retry on the next tick.
      }
    },
  };
}

const brainEmbeddingTriggerContactConsumer = createBrainEmbeddingTriggerConsumer("contact");
const brainEmbeddingTriggerCompanyConsumer = createBrainEmbeddingTriggerConsumer("company");
const brainEmbeddingTriggerDealConsumer = createBrainEmbeddingTriggerConsumer("deal");

export async function handleDispatchEvents(request: Request): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError("INTERNAL_ERROR", "CRON_SECRET is not configured", 500);
  }
  const provided = request.headers.get("authorization");
  if (!provided || !timingSafeEqualStrings(provided, `Bearer ${cronSecret}`)) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }

  let summary;
  try {
    summary = await dispatchPendingEvents([
      leadEnrichmentConsumer,
      leadScoringConsumer,
      // Milestone 4.1 Phase 2 — Brain entity-profile projection, triggered
      // by the nine contact/company/deal domain events (packages/crm),
      // never by visitor.identified. Registering three consumers here is
      // the same "one dispatcher, many independent consumers" pattern
      // already proven for lead_enrichment/lead_scoring — events.processed_at
      // correctly waits for every applicable consumer's own delivery,
      // independently.
      contactProjectionConsumer,
      companyProjectionConsumer,
      dealProjectionConsumer,
      // Milestone 4.1 Phase 3 — notifies n8n's (future) Brain Indexing
      // workflow that a profile may need a (re-)embedding. Same nine
      // events, same "one dispatcher, many independent consumers"
      // pattern, no ordering dependency on the projection consumers
      // above — see createBrainEmbeddingTriggerConsumer's own header
      // comment for why.
      brainEmbeddingTriggerContactConsumer,
      brainEmbeddingTriggerCompanyConsumer,
      brainEmbeddingTriggerDealConsumer,
    ]);
  } catch {
    return apiError("INTERNAL_ERROR", "Dispatch failed", 500);
  }

  // Milestone 3.4 Targeted Acceptance Remediation (Finding 3) — the same
  // cron tick that drains the event outbox also sweeps for durable,
  // stale/failed post-enrichment scoring retries (recordEnrichmentResult's
  // own best-effort hook), reusing this route's existing schedule rather
  // than a second cron entry. Isolated in its own try/catch: a failure
  // here must never mask the dispatch summary above or turn an otherwise
  // successful dispatch pass into a 500 — the pending rows it would have
  // picked up simply remain pending for the next tick, exactly like a
  // failed dispatch delivery already does.
  let recovery: { attempted: number; succeeded: number } | null = null;
  try {
    recovery = await recoverPendingPostEnrichmentScoring();
  } catch {
    recovery = null;
  }

  return NextResponse.json({ summary, recovery }, { status: 200 });
}
