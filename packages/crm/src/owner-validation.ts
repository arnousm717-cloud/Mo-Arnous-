import type { PoolClient } from "pg";
import { InvalidOwnerError } from "./errors";

/**
 * Shared by companies.ts and contacts.ts — genuine duplication, not
 * speculative sharing (Milestone 2.1D decision 1: strict organization-
 * scoped membership rule). ownerId is valid only if null, or if it
 * references a user holding an ACTIVE membership in exactly this
 * organization. Agency-level membership alone never qualifies —
 * memberships.organization_id is NULL for agency-scoped rows (ADR-005:
 * "no membership row is created for the caller" when an agency creates a
 * client organization), so filtering on organization_id = $2 already
 * excludes them structurally; no special-casing needed. Must be called
 * with the same PoolClient/transaction as the eventual write, so
 * validation and mutation are atomic (no separate validation transaction).
 */
export async function validateOwner(client: PoolClient, organizationId: string, ownerId: string | null): Promise<void> {
  if (ownerId === null) {
    return;
  }
  const r = await client.query(
    `select 1 from public.memberships
     where user_id = $1 and organization_id = $2 and status = 'active'
     limit 1`,
    [ownerId, organizationId],
  );
  if (r.rows.length === 0) {
    throw new InvalidOwnerError("ownerId must reference a user with an active membership in this organization");
  }
}
