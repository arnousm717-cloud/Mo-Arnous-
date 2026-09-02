import { NextResponse } from "next/server";
import { resolveServiceActorFromApiKey, hasScope, type ServiceActor } from "@ai-revenue-os/auth";
import { apiError } from "./api-error";

/**
 * Milestone 3.3E — the machine-credential counterpart to every staff
 * route's own resolveActor(userId, permission) pattern. Resolves an
 * Authorization: Bearer arev_... header to a ServiceActor and checks the
 * one scope this route requires; on any failure (missing/malformed/
 * revoked key, or a key that resolved but lacks the required scope)
 * returns the appropriate NextResponse directly, mirroring how every
 * existing staff-route resolveActor already collapses its own failure
 * branches into a returned error response the caller returns as-is.
 */
export async function resolveScopedServiceActor(
  request: Request,
  requiredScope: string,
): Promise<ServiceActor | NextResponse> {
  const actor = await resolveServiceActorFromApiKey(request.headers.get("authorization"));
  if (!actor) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }
  if (!hasScope(actor, requiredScope)) {
    return apiError("FORBIDDEN", "Forbidden", 403);
  }
  return actor;
}
