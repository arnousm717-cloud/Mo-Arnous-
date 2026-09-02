import { withTenantContext } from "@ai-revenue-os/database";
import { hashApiKey, API_KEY_PREFIX_LIVE, API_KEY_PREFIX_TEST } from "./api-keys";

/**
 * Service-to-service (machine-credential) authentication (Milestone 3.3B,
 * Milestone 3.3 Architecture Resolution Report §C). Bootstraps
 * organizationId from a presented `api_keys` Bearer token — the machine
 * counterpart to resolveOrganizationContextForTrackingSite (public site
 * credential) and resolveOrganizationContextForUser (session-authenticated
 * human) — structurally the same kind of problem (resolve tenant context
 * from a credential that isn't a session), deliberately mirrored in shape
 * rather than inventing a new pattern.
 *
 * Deliberately NOT an `Actor` and NOT checked via can()/PERMISSION_MATRIX.
 * A machine credential is not a human staff member with an RBAC role — the
 * RoleKey union has no "service" member and was never designed to hold
 * one. Authorization for a ServiceActor is scope-based (api_keys.scopes,
 * already a jsonb column on the table since M1.7, never wired up until
 * now), a deliberately separate, narrower mechanism from can().
 *
 * Additive only: this resolves ONLY when a caller explicitly presents an
 * `Authorization: Bearer arev_...` header. resolveRequestContext() (session
 * auth) is completely unmodified and untouched by this file's existence —
 * a route must explicitly choose to call this resolver; nothing makes it
 * happen implicitly, and no existing route was changed to call it.
 */

const MAX_BEARER_TOKEN_LENGTH = 128; // real tokens are ~53 chars (10-char prefix + 43-char base64url of 32 random bytes); generous headroom, still a cheap defensive bound before any hashing/DB work.

export interface ServiceActor {
  apiKeyId: string;
  organizationId: string;
  scopes: string[];
}

interface ResolveApiKeyRow {
  api_key_id: string;
  organization_id: string;
  scopes: unknown;
}

/**
 * Structural pre-check only — never throws, never touches the database.
 * Rejects anything that isn't shaped like a real API key before any
 * hashing or DB round trip, the same "cheap checks first" discipline
 * tracking-identity-assertions.ts's own parseCompactAssertion already
 * established.
 */
export function parseBearerApiKey(authorizationHeader: string | null): string | null {
  if (typeof authorizationHeader !== "string") {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/.exec(authorizationHeader.trim());
  if (!match) {
    return null;
  }
  const token = match[1]!;
  if (token.length === 0 || token.length > MAX_BEARER_TOKEN_LENGTH) {
    return null;
  }
  if (!token.startsWith(API_KEY_PREFIX_LIVE) && !token.startsWith(API_KEY_PREFIX_TEST)) {
    return null;
  }
  return token;
}

function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) {
    return [];
  }
  return scopes.filter((s): s is string => typeof s === "string");
}

/**
 * Resolves a presented Authorization header to a ServiceActor. Returns
 * null for any invalid, malformed, or revoked key — deliberately
 * indistinguishable, matching resolveOrganizationContextForTrackingSite's
 * own doctrine. A genuine DB failure propagates as an ordinary thrown
 * error, unwrapped.
 *
 * organizationId is taken exclusively from the matched api_keys row —
 * never from any caller-supplied field. This is the bootstrap step,
 * called before any organizationId is known, so it always opens its own
 * withTenantContext({}) transaction, exactly like
 * resolveOrganizationContextForTrackingSite.
 */
export async function resolveServiceActorFromApiKey(authorizationHeader: string | null): Promise<ServiceActor | null> {
  const token = parseBearerApiKey(authorizationHeader);
  if (!token) {
    return null;
  }

  const keyHash = hashApiKey(token);

  const row = await withTenantContext({}, async (client) => {
    const r = await client.query<ResolveApiKeyRow>("select * from public.resolve_api_key($1)", [keyHash]);
    return r.rows[0];
  });

  if (!row) {
    return null;
  }

  return {
    apiKeyId: row.api_key_id,
    organizationId: row.organization_id,
    scopes: normalizeScopes(row.scopes),
  };
}

/** Pure, synchronous, deny-by-default — same design discipline as can(). */
export function hasScope(actor: ServiceActor, requiredScope: string): boolean {
  return actor.scopes.includes(requiredScope);
}
