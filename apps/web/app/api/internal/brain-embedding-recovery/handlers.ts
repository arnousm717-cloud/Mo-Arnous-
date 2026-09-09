import { NextResponse } from "next/server";
import { getPool } from "@ai-revenue-os/database";
import {
  findEmbeddingRecoveryCandidates,
  deriveEmbeddingRecoveryEventId,
  claimEmbeddingRecoveryAttempt,
  completeBrainProjectionRun,
  type EntityType,
} from "@ai-revenue-os/brain";
import { apiError } from "../../v1/_shared/api-error";
import { timingSafeEqualStrings } from "../_shared/cron-auth";

/**
 * Milestone 4.1 Phase 5 — GET /api/internal/brain-embedding-recovery.
 *
 * Closes the operational gap Phase 3 self-disclosed and left open
 * (`packages/brain/src/backfill.ts`'s own `createBrainEmbeddingTriggerConsumer`
 * comment): a profile whose live embedding-trigger notification was
 * missed (an unconfigured-webhook window, a transient delivery failure)
 * had no automatic recovery path — `findProfilesNeedingEmbedding`'s
 * discovery pass existed but was never invoked from anywhere at runtime.
 * This route is that missing invocation, on its own schedule, separate
 * from the live per-minute `dispatch-events` cron — see `vercel.json`'s
 * own comment for the cadence choice.
 *
 * Internal platform infrastructure, identical security model to
 * `dispatch-events`: CRON_SECRET bearer only, never session or api_keys
 * auth, no request body, no organization selector — every organization
 * is enumerated server-side.
 *
 * Re-notifies the EXACT SAME (future, not-yet-built) n8n Brain Indexing
 * webhook the live trigger already calls, with the identical
 * ID-minimized payload shape — never a second, divergent notification
 * protocol. This repository still calls no embedding provider and holds
 * no provider credential; this route only asks n8n to try again.
 *
 * A webhook 2xx response is NEVER treated as permanent proof the
 * embedding actually materialized — only that n8n accepted the request.
 * `claimEmbeddingRecoveryAttempt` (`packages/brain/src/repository.ts`,
 * used below instead of the generic `claimBrainProjectionRun`) allows a
 * `'succeeded'` attempt to become reclaimable again after a bounded
 * cooldown if `findEmbeddingRecoveryCandidates`'s own next call still
 * finds the profile missing/stale — this is what makes recovery genuinely
 * self-healing rather than a fire-once best-effort notification.
 */

const RECOVERY_WORKFLOW_KEY: Record<EntityType, string> = {
  contact: "brain_embedding_recovery_contact",
  company: "brain_embedding_recovery_company",
  deal: "brain_embedding_recovery_deal",
};

interface RecoverySummary {
  organizationsProcessed: number;
  candidatesFound: number;
  notificationsSent: number;
  skipped: number;
  errors: number;
}

async function notifyCandidate(
  organizationId: string,
  candidate: { entityType: EntityType; entityId: string; profileId: string; computedAt: string },
  webhookUrl: string,
  webhookSecret: string | undefined,
): Promise<"sent" | "skipped" | "error"> {
  const workflowKey = RECOVERY_WORKFLOW_KEY[candidate.entityType];
  const sourceEventId = deriveEmbeddingRecoveryEventId(candidate.profileId, candidate.computedAt);
  const ctx = { organizationId };

  const claimed = await claimEmbeddingRecoveryAttempt(ctx, {
    workflowKey,
    sourceEventId,
    ...(candidate.entityType === "contact" ? { contactId: candidate.entityId } : {}),
  });
  if (!claimed) {
    // Either a concurrent recovery run currently holds the lease, or a
    // prior attempt for this exact profile state already succeeded (or
    // failed) too recently to retry yet — the recovery-specific cooldown
    // in claimEmbeddingRecoveryAttempt (packages/brain/src/repository.ts)
    // is what makes this a REAL skip, not a permanent one: this same
    // candidate becomes reclaimable again once the cooldown elapses, on
    // a future invocation, as long as findEmbeddingRecoveryCandidates
    // still finds it (i.e. no embedding has materialized in the
    // meantime).
    return "skipped";
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (webhookSecret) {
    headers.authorization = `Bearer ${webhookSecret}`;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        eventId: sourceEventId,
        organizationId,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`n8n webhook responded with status ${response.status}`);
    }
    await completeBrainProjectionRun(ctx, { workflowKey, sourceEventId, status: "succeeded" });
    return "sent";
  } catch (err) {
    // Never re-thrown: unlike the live dispatcher (which relies on an
    // exception to release a delivery lease and retry on the NEXT tick,
    // seconds away), this route IS the retry mechanism — its own next
    // scheduled invocation naturally re-discovers this candidate (still
    // missing/stale) and re-attempts the claim, which succeeds again
    // because this attempt's own completion below leaves the row
    // 'failed'. One candidate's failure must never abort the batch.
    await completeBrainProjectionRun(ctx, {
      workflowKey,
      sourceEventId,
      status: "failed",
      error: err instanceof Error ? err.message : "recovery notification failed",
    }).catch(() => {});
    return "error";
  }
}

export async function handleBrainEmbeddingRecovery(request: Request): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError("INTERNAL_ERROR", "CRON_SECRET is not configured", 500);
  }
  const provided = request.headers.get("authorization");
  if (!provided || !timingSafeEqualStrings(provided, `Bearer ${cronSecret}`)) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }

  const summary: RecoverySummary = { organizationsProcessed: 0, candidatesFound: 0, notificationsSent: 0, skipped: 0, errors: 0 };

  const webhookUrl = process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL;
  if (!webhookUrl) {
    // Same doctrine as the live dispatcher consumer: no crash-loop, no
    // false success. Nothing in the database is touched — there is
    // nothing a discovery pass could usefully report when no notification
    // can ever be sent.
    return NextResponse.json({ summary, unconfiguredWebhook: true }, { status: 200 });
  }
  const webhookSecret = process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_SECRET;

  // Accepted, disclosed scale limitation: enumerates every organization
  // on every invocation (no batching/pagination across the org list
  // itself), unlike `dispatch-events`, which is bounded by its own event
  // queue's DISPATCH_BATCH_SIZE rather than tenant count. Appropriate for
  // this milestone's real target scale (`01-Vision.md`'s own Year 1
  // wedge-validation range: roughly 30-60 client organizations) — revisit
  // (e.g. paginate this query, or shard organizations across multiple
  // cron ticks) only if production organization count grows enough to
  // make one 15-minute sweep's own duration a real concern, not
  // speculatively ahead of that evidence.
  let organizationIds: string[];
  try {
    const result = await getPool().query<{ id: string }>("select id from public.organizations order by id asc");
    organizationIds = result.rows.map((row) => row.id);
  } catch {
    return apiError("INTERNAL_ERROR", "Failed to enumerate organizations", 500);
  }

  for (const organizationId of organizationIds) {
    try {
      const candidates = await findEmbeddingRecoveryCandidates({ organizationId });
      summary.candidatesFound += candidates.length;

      for (const candidate of candidates) {
        try {
          const outcome = await notifyCandidate(organizationId, candidate, webhookUrl, webhookSecret);
          if (outcome === "sent") summary.notificationsSent += 1;
          else if (outcome === "skipped") summary.skipped += 1;
          else summary.errors += 1;
        } catch {
          // One candidate's unexpected failure must never block the rest
          // of this organization's batch, let alone later organizations.
          summary.errors += 1;
        }
      }
      summary.organizationsProcessed += 1;
    } catch {
      // One organization's failure must never block later organizations.
      summary.errors += 1;
    }
  }

  return NextResponse.json({ summary }, { status: 200 });
}
