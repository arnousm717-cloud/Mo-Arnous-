import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser, revokeTrackingSitePublicKey, type Actor, type PermissionKey } from "@ai-revenue-os/auth";
import { apiError } from "../../../../../_shared/api-error";
import { isValidUuid } from "../../../../../_shared/uuid";

interface ResolvedActor {
  userId: string;
  organizationId: string;
  roleKey: string;
}

async function resolveActor(userId: string | null, permission: PermissionKey): Promise<ResolvedActor | NextResponse> {
  if (!userId) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }
  const orgContext = await resolveOrganizationContextForUser(userId);
  const actor: Actor | null = orgContext ? { userId, ...orgContext } : null;
  if (!actor || !can(actor, permission)) {
    return apiError("FORBIDDEN", "Forbidden", 403);
  }
  return { userId, organizationId: orgContext!.organizationId, roleKey: orgContext!.roleKey };
}

/**
 * Milestone 3.2B — dedicated action endpoint, mirroring the existing
 * POST .../set-default / POST .../preview /execute precedent: a
 * revocation is a real, security-sensitive state change with its own
 * authorization story, not a hidden PATCH field. Idempotent-shaped: a
 * key already revoked, or a nonexistent/foreign keyId, both map to the
 * same 404 -- revokeTrackingSitePublicKey itself never distinguishes
 * "already revoked" from "never existed" from "not yours" (returns
 * false uniformly), matching this repository's own cross-org/nonexistent
 * indistinguishability convention.
 */
export async function handleRevokeTrackingSitePublicKey(
  userId: string | null,
  trackingSiteId: string,
  keyId: string,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tracking:manage-identity-keys");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(trackingSiteId) || !isValidUuid(keyId)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const revoked = await revokeTrackingSitePublicKey(
    { userId: actor.userId, organizationId: actor.organizationId },
    trackingSiteId,
    keyId,
  );
  if (!revoked) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json({ revoked: true });
}
