import { NextResponse } from "next/server";
import { getContactById } from "@ai-revenue-os/crm";
import { recalculateContactScore } from "@ai-revenue-os/intelligence";
import { resolveActor } from "../../../handlers";
import { apiError } from "../../../../_shared/api-error";
import { isValidUuid } from "../../../../_shared/uuid";

/**
 * Milestone 3.4D — POST /api/v1/contacts/{id}/lead-scores/recalculate.
 * Session auth, contacts:update (triggering a recalculation is analogous
 * to updating contact-derived data — not a new permission for a single,
 * low-stakes staff action). Always safe to call repeatedly: each call
 * legitimately inserts a new historized row, so no Idempotency-Key
 * support is needed the way a genuinely destructive/expensive mutation
 * would need it (Milestone 3.4 Pre-Implementation Audit §L).
 */
export async function handleRecalculateContactScore(userId: string | null, contactId: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "contacts:update");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(contactId)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  const contact = await getContactById(actor, contactId);
  if (!contact) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const outcome = await recalculateContactScore(actor, { contactId });
  if (!outcome.accepted) {
    // The live re-check inside recalculateContactScore found the contact
    // gone/soft-deleted in the moment between the existence check above
    // and this call — a genuine, if narrow, TOCTOU window, resolved the
    // same non-oracle way every other race in this API is: a clean 404,
    // not a 500.
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json({ score: { score: outcome.score, grade: outcome.grade } }, { status: 200 });
}
