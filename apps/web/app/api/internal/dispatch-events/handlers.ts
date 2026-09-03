import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { dispatchPendingEvents, type DomainEvent, type EventConsumer } from "@ai-revenue-os/database";
import {
  recordWorkflowRunStarted,
  recordWorkflowRunTriggerFailed,
  recalculateContactScoreForEvent,
  recoverPendingPostEnrichmentScoring,
} from "@ai-revenue-os/intelligence";
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
    summary = await dispatchPendingEvents([leadEnrichmentConsumer, leadScoringConsumer]);
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
