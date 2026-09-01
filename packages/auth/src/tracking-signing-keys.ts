import type { PoolClient } from "pg";
import { type RequestContext, runInClientOrTransaction, withTenantContext } from "@ai-revenue-os/database";
import {
  isValidEd25519SpkiPublicKeyPem,
  parseCompactAssertion,
  parseAndValidateClaims,
  isAssertionCurrentlyValid,
  verifyAssertionSignature,
  type IdentityAssertionClaims,
} from "./tracking-identity-assertions";

/**
 * Ed25519 public-key registration/lookup for the visitor-identification
 * assertion trust boundary (Milestone 3.2B). Two distinct access
 * patterns, both real, both already-established in this codebase --
 * no new authentication mechanism is introduced for either:
 *
 * - register/list/revoke: a real, session-authenticated staff caller
 *   with a genuine organizationId already resolved (mirrors
 *   packages/crm's own (ctx, ..., existingClient?) convention exactly).
 *   Ordinary RLS (tracking_site_public_keys_select_own/insert_own/
 *   update_own) is the actual enforcement layer here -- these functions
 *   add no privilege of their own, they simply issue the query.
 *
 * - resolveActiveTrackingSitePublicKey: called from the public
 *   /track/identify pathway, AFTER organizationId/trackingSiteId are
 *   already resolved from siteKey (resolveOrganizationContextForTrackingSite).
 *   Reuses withTenantContext({organizationId}) -- the identical
 *   mechanism packages/intelligence's ingestTrackingEvent already relies
 *   on for its own writes once organizationId is known -- rather than a
 *   new SECURITY DEFINER function: the existing
 *   tracking_site_public_keys_select_own RLS policy already scopes
 *   correctly once app.current_org is set, so no bypass-RLS mechanism is
 *   needed for a read that RLS itself already permits.
 */

export interface RegisteredTrackingSitePublicKey {
  id: string;
  createdAt: string;
  revokedAt: string | null;
}

interface PublicKeyRow {
  id: string;
  created_at: string;
  revoked_at: string | null;
}

export class InvalidPublicKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPublicKeyError";
  }
}

/**
 * Registers a new Ed25519 public key for a tracking site. Rejects
 * anything that does not parse as a genuine Ed25519 SPKI PEM public key
 * (InvalidPublicKeyError) before ever reaching the database -- the
 * table's own CHECK constraint is a defensive length floor/ceiling, not
 * a substitute for this real format validation. A trackingSiteId
 * belonging to a different organization is rejected structurally by the
 * table's own composite FK (tracking_site_public_keys_site_org_fk),
 * surfaced as an ordinary thrown error, unwrapped -- no redundant
 * pre-check duplicates what the database already guarantees.
 */
export async function registerTrackingSitePublicKey(
  ctx: RequestContext & { organizationId: string },
  trackingSiteId: string,
  publicKeyPem: string,
  existingClient?: PoolClient,
): Promise<RegisteredTrackingSitePublicKey> {
  if (!isValidEd25519SpkiPublicKeyPem(publicKeyPem)) {
    throw new InvalidPublicKeyError("publicKeyPem must be a valid Ed25519 SPKI PEM public key");
  }
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const r = await client.query<PublicKeyRow>(
      `insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem, created_by)
       values ($1, $2, $3, $4)
       returning id, created_at, revoked_at`,
      [ctx.organizationId, trackingSiteId, publicKeyPem, ctx.userId ?? null],
    );
    const row = r.rows[0]!;
    return { id: row.id, createdAt: row.created_at, revokedAt: row.revoked_at };
  });
}

/** Safe metadata only -- id/createdAt/revokedAt, never the PEM itself (not secret, but not useful in a list view either). */
export async function listTrackingSitePublicKeys(
  ctx: RequestContext & { organizationId: string },
  trackingSiteId: string,
): Promise<RegisteredTrackingSitePublicKey[]> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<PublicKeyRow>(
      `select id, created_at, revoked_at from public.tracking_site_public_keys
       where organization_id = $1 and tracking_site_id = $2
       order by created_at desc`,
      [ctx.organizationId, trackingSiteId],
    );
    return r.rows.map((row) => ({ id: row.id, createdAt: row.created_at, revokedAt: row.revoked_at }));
  });
}

/**
 * Revokes a key by setting revoked_at -- never a real DELETE, matching
 * tracking_sites.revoked_at's own established soft-lifecycle idiom.
 * Returns false (not an error) if the key does not exist, is not owned
 * by the caller's organization, or is already revoked -- idempotent,
 * consistent with every other revoke-style operation in this codebase.
 */
export async function revokeTrackingSitePublicKey(
  ctx: RequestContext & { organizationId: string },
  trackingSiteId: string,
  keyId: string,
): Promise<boolean> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query(
      `update public.tracking_site_public_keys
       set revoked_at = now()
       where id = $1 and tracking_site_id = $2 and organization_id = $3 and revoked_at is null`,
      [keyId, trackingSiteId, ctx.organizationId],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

/**
 * Resolves the PEM for one specific, currently-active registered key,
 * scoped structurally to (organizationId, trackingSiteId, keyId)
 * together -- a kid value can never select a key belonging to a
 * different tenant or a different tracking site than the ones already
 * resolved from the request's own siteKey, regardless of what an
 * attacker-controlled token claims. Returns null (never throws, never
 * distinguishes "no such key" from "revoked" from "wrong site") for any
 * non-match -- the public /track/identify pathway's own non-oracle
 * response design depends on this.
 */
export interface VerifyIdentityAssertionInput {
  assertion: string;
  organizationId: string;
  trackingSiteId: string;
  anonymousId: string;
}

/**
 * The single, composed entry point POST /track/identify (Milestone 3.2D)
 * calls -- ties together every verification step from the accepted
 * design's own order (structural parse -> claims shape -> aud/org/
 * anonymousId binding -> freshness -> key resolution -> signature) into
 * one function, so the route handler itself never has to get that order
 * right independently. Cheap, DB-free checks run first -- a structurally
 * invalid or mis-bound token is rejected before ever touching the
 * database, closing off a cheap DoS vector against the key-lookup query.
 *
 * Returns null (never throws, never distinguishes which check failed)
 * for any failure -- this is precisely what preserves POST /track/
 * identify's own non-oracle response design; the caller collapses every
 * null into the identical rejection response.
 */
export async function verifyIdentityAssertion(
  input: VerifyIdentityAssertionInput,
  existingClient?: PoolClient,
): Promise<IdentityAssertionClaims | null> {
  const parsed = parseCompactAssertion(input.assertion);
  if (!parsed) return null;

  const claims = parseAndValidateClaims(parsed.payloadSegment);
  if (!claims) return null;

  if (claims.aud !== input.trackingSiteId) return null;
  if (claims.organizationId !== undefined && claims.organizationId !== input.organizationId) return null;
  if (claims.anonymousId !== undefined && claims.anonymousId !== input.anonymousId) return null;
  if (!isAssertionCurrentlyValid(claims)) return null;

  const publicKeyPem = await resolveActiveTrackingSitePublicKey(
    input.organizationId,
    input.trackingSiteId,
    claims.kid,
    existingClient,
  );
  if (!publicKeyPem) return null;

  if (!verifyAssertionSignature(parsed.payloadSegment, parsed.signature, publicKeyPem)) return null;

  return claims;
}

export async function resolveActiveTrackingSitePublicKey(
  organizationId: string,
  trackingSiteId: string,
  keyId: string,
  existingClient?: PoolClient,
): Promise<string | null> {
  return runInClientOrTransaction({ organizationId }, existingClient, async (client) => {
    const r = await client.query<{ public_key_pem: string }>(
      `select public_key_pem from public.tracking_site_public_keys
       where id = $1 and tracking_site_id = $2 and organization_id = $3 and revoked_at is null`,
      [keyId, trackingSiteId, organizationId],
    );
    return r.rows[0]?.public_key_pem ?? null;
  });
}
