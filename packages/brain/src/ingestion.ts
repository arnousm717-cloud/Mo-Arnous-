import {
  getContactById,
  getContactByIdIncludingDeleted,
  getCompanyById,
  getCompanyByIdIncludingDeleted,
  getDealById,
  getDealByIdIncludingDeleted,
} from "@ai-revenue-os/crm";
import type { RequestContext, EventConsumer, DomainEvent } from "@ai-revenue-os/database";
import { projectContactProfile, projectCompanyProfile, projectDealProfile } from "./projector";
import { upsertEntityProfile, claimBrainProjectionRun, completeBrainProjectionRun, BRAIN_PROJECTION_WORKFLOW_KEY } from "./repository";
import { MalformedEventPayloadError } from "./errors";
import type { EntityType } from "./types";

/**
 * Milestone 4.1 Phase 2 event consumers (Detailed Design §E/§J, Final
 * Design Challenge §A/§B/§C). Reconciliation, NOT historical event-state
 * projection (Final Design Challenge §A/§6): an entity event is merely a
 * trigger to re-read CURRENT authoritative CRM state and reconcile Brain
 * to it. `events.payload` carries only an identity reference, never a
 * snapshot — nothing here ever attempts to reconstruct historical state
 * from the payload.
 */

export const EVENT_TYPES_BY_ENTITY: Record<EntityType, string[]> = {
  contact: ["contact.created", "contact.updated", "contact.deleted"],
  company: ["company.created", "company.updated", "company.deleted"],
  deal: ["deal.created", "deal.updated", "deal.deleted"],
};

const PAYLOAD_ID_KEY: Record<EntityType, string> = {
  contact: "contact_id",
  company: "company_id",
  deal: "deal_id",
};

export type ReconcileOutcome =
  | { accepted: true; action: "created" | "updated" | "unchanged" }
  | { accepted: false; reason: "entity_not_found" };

/**
 * Read path selection (Final Design Challenge §B — the mandatory
 * tombstone contract): `.deleted` events read via the `...IncludingDeleted`
 * variant (the row still physically exists, only deleted_at is set) and
 * force `isDeleted: true`. `.created`/`.updated` read via the plain,
 * active-only getXById — `updateContact`'s own `WHERE deleted_at IS NULL`
 * guard (and its contact/company/deal siblings) means these event types
 * can structurally never fire for an already-deleted row, so `isDeleted`
 * is always `false` on this path.
 *
 * A `null` result from the read (nonexistent, cross-tenant, or — on the
 * `.deleted` path — genuinely hard-erased) is `entity_not_found`: a clean,
 * non-throwing no-op. Phase 1's own `ON DELETE CASCADE` already removed
 * any Brain profile row for a hard-erased entity structurally; there is
 * nothing to recreate and nothing further to do.
 */
async function reconcileContact(ctx: RequestContext & { organizationId: string }, contactId: string, isDeleteEvent: boolean): Promise<ReconcileOutcome> {
  const contact = isDeleteEvent ? await getContactByIdIncludingDeleted(ctx, contactId) : await getContactById(ctx, contactId);
  if (!contact) {
    return { accepted: false, reason: "entity_not_found" };
  }
  const isDeleted = isDeleteEvent || contact.deletedAt !== null;
  const profile = projectContactProfile(contact, isDeleted);
  const result = await upsertEntityProfile(ctx, {
    entityType: "contact",
    entityId: contact.id,
    profile,
    sourceUpdatedAt: contact.updatedAt,
  });
  return { accepted: true, action: result.status === "created" ? "created" : result.status === "updated" && result.historyWritten ? "updated" : "unchanged" };
}

async function reconcileCompany(ctx: RequestContext & { organizationId: string }, companyId: string, isDeleteEvent: boolean): Promise<ReconcileOutcome> {
  const company = isDeleteEvent ? await getCompanyByIdIncludingDeleted(ctx, companyId) : await getCompanyById(ctx, companyId);
  if (!company) {
    return { accepted: false, reason: "entity_not_found" };
  }
  const isDeleted = isDeleteEvent || company.deletedAt !== null;
  const profile = projectCompanyProfile(company, isDeleted);
  const result = await upsertEntityProfile(ctx, {
    entityType: "company",
    entityId: company.id,
    profile,
    sourceUpdatedAt: company.updatedAt,
  });
  return { accepted: true, action: result.status === "created" ? "created" : result.status === "updated" && result.historyWritten ? "updated" : "unchanged" };
}

async function reconcileDeal(ctx: RequestContext & { organizationId: string }, dealId: string, isDeleteEvent: boolean): Promise<ReconcileOutcome> {
  const deal = isDeleteEvent ? await getDealByIdIncludingDeleted(ctx, dealId) : await getDealById(ctx, dealId);
  if (!deal) {
    return { accepted: false, reason: "entity_not_found" };
  }
  const isDeleted = isDeleteEvent || deal.deletedAt !== null;
  const profile = projectDealProfile(deal, isDeleted);
  const result = await upsertEntityProfile(ctx, {
    entityType: "deal",
    entityId: deal.id,
    profile,
    sourceUpdatedAt: deal.updatedAt,
  });
  return { accepted: true, action: result.status === "created" ? "created" : result.status === "updated" && result.historyWritten ? "updated" : "unchanged" };
}

const RECONCILERS: Record<EntityType, (ctx: RequestContext & { organizationId: string }, id: string, isDeleteEvent: boolean) => Promise<ReconcileOutcome>> = {
  contact: reconcileContact,
  company: reconcileCompany,
  deal: reconcileDeal,
};

/**
 * Builds the one EventConsumer for a given entity kind, registered in
 * apps/web/app/api/internal/dispatch-events/handlers.ts alongside the
 * existing leadEnrichmentConsumer/leadScoringConsumer.
 *
 * Layer 1 idempotency (Final Design Challenge §D): claims a workflow_runs
 * row under a dedicated `brain_projection_<entity>` key BEFORE any read of
 * CRM state or any Brain-table write — a redelivered/duplicate/
 * concurrently-overlapping trigger for the exact same event is a clean
 * no-op here, never reaching reconcileX at all. `entity_not_found` is
 * recorded as workflow_runs.status = 'failed' (observability label only,
 * matching recalculateContactScoreForEvent's own precedent for
 * `contact_not_found`) but does NOT throw — the dispatcher marks the
 * delivery succeeded, so an already-erased entity's stale pending event
 * is never retried forever.
 */
export function createBrainProjectionConsumer(entityType: EntityType): EventConsumer {
  const workflowKey = BRAIN_PROJECTION_WORKFLOW_KEY[entityType];
  const payloadIdKey = PAYLOAD_ID_KEY[entityType];
  const deleteEventType = `${entityType}.deleted`;

  return {
    name: `brain_projection_${entityType}`,
    eventTypes: EVENT_TYPES_BY_ENTITY[entityType],
    handle: async (event: DomainEvent) => {
      const payload = event.payload as Record<string, string | null | undefined>;
      const organizationId = payload.organization_id;
      const entityId = payload[payloadIdKey];
      if (!organizationId || !entityId) {
        // Unreachable in practice — every emit_<entity>_event function
        // always populates both — but a malformed/forged payload must
        // never crash the dispatcher's own retry loop with an unhandled
        // shape error; this is a genuine bug signal, not a transient
        // failure, so it is thrown (not swallowed) for visibility, but as
        // a typed error rather than a raw TypeError from a `.` on
        // `undefined` deeper in the call stack.
        throw new MalformedEventPayloadError(`event ${event.id} (${event.eventType}) is missing ${payloadIdKey} or organization_id`);
      }

      const ctx = { organizationId };
      const claimed = await claimBrainProjectionRun(ctx, {
        workflowKey,
        sourceEventId: event.id,
        ...(entityType === "contact" ? { contactId: entityId } : {}),
      });
      if (!claimed) {
        return; // already processed, or a concurrent attempt is in flight — clean no-op.
      }

      try {
        const outcome = await RECONCILERS[entityType](ctx, entityId, event.eventType === deleteEventType);
        await completeBrainProjectionRun(ctx, {
          workflowKey,
          sourceEventId: event.id,
          status: outcome.accepted ? "succeeded" : "failed",
          ...(outcome.accepted ? {} : { error: outcome.reason }),
        });
      } catch (err) {
        await completeBrainProjectionRun(ctx, {
          workflowKey,
          sourceEventId: event.id,
          status: "failed",
          error: err instanceof Error ? err.message : "brain projection failed",
        }).catch(() => {
          // Best-effort — see recordWorkflowRunTriggerFailed's own precedent.
        });
        throw err; // let dispatchPendingEvents release the delivery lease and retry on the next tick.
      }
    },
  };
}

export const contactProjectionConsumer = createBrainProjectionConsumer("contact");
export const companyProjectionConsumer = createBrainProjectionConsumer("company");
export const dealProjectionConsumer = createBrainProjectionConsumer("deal");
