import { withTenantContext } from "@ai-revenue-os/database";
import type { OwnerOption } from "./owner-option";

/**
 * Milestone 2.2-P0. Resource-neutral — shared by Companies, Contacts, and
 * (later) Deals, rather than living under any one resource's own route
 * segment. Calls the new get_organization_member_identities() SECURITY
 * DEFINER function (tenant-scoped, active-memberships-only, never
 * broadens public.users' own self-scoped RLS) through the same
 * withTenantContext path every other server-side query in this app
 * already uses (ADR-004) — no new data-access pattern introduced.
 *
 * Deliberately server-only: this module's top-level import of
 * @ai-revenue-os/database (and transitively `pg`, which needs Node's
 * `net`/`tls`) breaks a production build the moment any "use client"
 * component imports a real (non-type) export from it. The pure display
 * helpers (OwnerOption, withResolvedOwnerFallback, resolveOwnerLabel)
 * therefore live in ./owner-option instead, which client components
 * import directly — never through this file. Only re-export the
 * OwnerOption *type* here for server-side callers' convenience: a
 * type-only re-export is erased at compile time and carries no runtime
 * import, so it cannot reintroduce the same bundling failure.
 */

export type { OwnerOption };

interface MemberIdentityRow {
  user_id: string;
  email: string;
  full_name: string | null;
}

function toLabel(fullName: string | null, email: string): string {
  const trimmed = fullName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : email;
}

export async function listActiveOwnerOptions(ctx: {
  userId: string;
  organizationId: string;
  roleKey: string;
}): Promise<OwnerOption[]> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<MemberIdentityRow>(
      "select * from public.get_organization_member_identities($1)",
      [ctx.organizationId],
    );
    return r.rows
      .map((row) => ({ userId: row.user_id, label: toLabel(row.full_name, row.email) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });
}
