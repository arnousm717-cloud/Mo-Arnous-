import { NextResponse } from "next/server";
import {
  can,
  resolveOrganizationContextForUser,
  registerTrackingSitePublicKey,
  listTrackingSitePublicKeys,
  InvalidPublicKeyError,
  type Actor,
  type PermissionKey,
  type RegisteredTrackingSitePublicKey,
} from "@ai-revenue-os/auth";
import { apiError } from "../../../_shared/api-error";
import { isValidUuid } from "../../../_shared/uuid";

/**
 * Milestone 3.2B — staff-authenticated Ed25519 public-key registration
 * for a tracking site. Mirrors pipelines/handlers.ts's own resolveActor
 * pattern exactly, gated on the new tracking:manage-identity-keys
 * permission (org_admin only, same reasoning as consent:record).
 *
 * The private key never appears anywhere in this codebase — only the
 * PEM-encoded public key is ever accepted, validated (real Ed25519 SPKI
 * parse, not merely a length check), and stored.
 */

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

function toPublicKeyResponseBody(key: RegisteredTrackingSitePublicKey) {
  return { id: key.id, createdAt: key.createdAt, revokedAt: key.revokedAt };
}

interface RegisterBody {
  publicKeyPem?: unknown;
}

export async function handleRegisterTrackingSitePublicKey(
  userId: string | null,
  trackingSiteId: string,
  rawBody: unknown,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tracking:manage-identity-keys");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(trackingSiteId)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const body = rawBody as RegisterBody;
  if (typeof body?.publicKeyPem !== "string" || body.publicKeyPem.length === 0) {
    return apiError("VALIDATION_ERROR", "publicKeyPem is required", 400);
  }

  try {
    const key = await registerTrackingSitePublicKey(
      { userId: actor.userId, organizationId: actor.organizationId },
      trackingSiteId,
      body.publicKeyPem,
    );
    return NextResponse.json({ publicKey: toPublicKeyResponseBody(key) }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPublicKeyError) {
      return apiError("VALIDATION_ERROR", "publicKeyPem must be a valid Ed25519 SPKI PEM public key", 400);
    }
    // A trackingSiteId that doesn't resolve to this organization's own
    // tracking site fails the composite FK (tracking_site_public_keys_
    // site_org_fk) -- surfaced here as 404, matching set-default's own
    // path-resource convention (never 400: this is a path identifier,
    // not a body relationship field).
    if (err instanceof Error && /tracking_site_public_keys_site_org_fk|foreign key/i.test(err.message)) {
      return apiError("NOT_FOUND", "Not found", 404);
    }
    return apiError("INTERNAL_ERROR", "Failed to register public key", 500);
  }
}

export async function handleListTrackingSitePublicKeys(
  userId: string | null,
  trackingSiteId: string,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "tracking:manage-identity-keys");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(trackingSiteId)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  const keys = await listTrackingSitePublicKeys({ userId: actor.userId, organizationId: actor.organizationId }, trackingSiteId);
  return NextResponse.json({ publicKeys: keys.map(toPublicKeyResponseBody) });
}
