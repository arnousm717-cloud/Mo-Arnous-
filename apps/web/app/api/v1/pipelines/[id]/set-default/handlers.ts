import { NextResponse } from "next/server";
import { setDefaultPipeline, InvalidPipelineRelationshipError } from "@ai-revenue-os/crm";
import { resolveActor, toPipelineResponseBody } from "../../handlers";
import { apiError } from "../../../_shared/api-error";

/**
 * Milestone 2.2D — the explicit default-switch contract this milestone's
 * own prompt required a decision on. packages/crm's setDefaultPipeline
 * (Milestone 2.2B) already safely unsets the old default and sets the new
 * one in one transaction; ordinary PATCH /api/v1/pipelines/{id}
 * deliberately has no code path for isDefault at all (../handlers.ts). A
 * dedicated action endpoint — not a hidden PATCH field — is this
 * milestone's chosen contract, mirroring the existing
 * POST .../{id}/preview / POST .../{id}/execute dedicated-verb-pair
 * precedent already established for data-subject-requests (docs/04 §2.2,
 * M1.6 Decision D): an action with real side effects and its own
 * authorization/atomicity story gets its own named endpoint rather than
 * being folded into a general-purpose update.
 *
 * :id is a path-identified resource (the same role a company/contact's
 * own :id plays elsewhere), so InvalidPipelineRelationshipError here means
 * exactly "this id does not resolve to something you can act on" — mapped
 * to 404, matching the cross-org/nonexistent convention for path
 * resources, NOT the 400 used for deals.ts's pipelineId (a body
 * relationship field there, a fundamentally different role).
 *
 * No Idempotency-Key support: not one of the six routes this milestone's
 * own approved plan enumerates (POST deals, PATCH deal, POST pipelines,
 * PATCH pipeline, POST stages, PATCH stage) — and the underlying
 * operation is already naturally idempotent (setDefaultPipeline no-ops if
 * the target is already the default), so nothing is lost by not wiring
 * the reservation/replay machinery here.
 */
export async function handleSetDefaultPipeline(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "pipelines:update");
  if (actor instanceof NextResponse) {
    return actor;
  }

  try {
    const pipeline = await setDefaultPipeline(actor, id);
    return NextResponse.json(toPipelineResponseBody(pipeline));
  } catch (err) {
    if (err instanceof InvalidPipelineRelationshipError) {
      return apiError("NOT_FOUND", "Not found", 404);
    }
    return apiError("INTERNAL_ERROR", "Failed to set default pipeline", 500);
  }
}
