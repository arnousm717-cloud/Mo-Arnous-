import { NextResponse } from "next/server";
import { deleteTagging } from "@ai-revenue-os/crm";
import { isValidUuid } from "../../_shared/uuid";
import { resolveActor, toTaggingResponseBody } from "../handlers";

/**
 * Milestone 2.3D. DELETE only — no GET-by-id, no PATCH (Taggings have no
 * update operation at any layer, 2.3A schema through 2.3C RBAC). Cross-org
 * and nonexistent :id are indistinguishable — packages/crm's
 * deleteTagging already returns null for both cases identically; this
 * file adds no special-casing, it just maps null to 404. A malformed
 * (non-UUID-shaped) :id is classified identically — also 404, never
 * reaching the database.
 *
 * This IS the deliberate exception to every other resource's soft-delete
 * convention: deleteTagging performs a real, physical DELETE (frozen 2.3
 * design) — there is no deletedAt field on a Tagging at all.
 */
export async function handleDeleteTagging(userId: string | null, id: string): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tags:delete");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const tagging = await deleteTagging(actor, id);
  if (!tagging) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(toTaggingResponseBody(tagging));
}
