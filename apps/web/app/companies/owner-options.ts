import { withTenantContext } from "@ai-revenue-os/database";

/**
 * 2.1G-B audit finding, not a pre-existing primitive: there is no
 * tenancy/auth function that returns other organization members' display
 * names. public.users' RLS is strictly self-scoped (`id = auth.uid()`,
 * M1.2) — even an org_admin cannot read a teammate's email/full_name
 * through the ordinary withTenantContext + RLS path a join would need.
 *
 * This returns only what IS legitimately visible: the organization-scoped
 * list of active member user ids (memberships RLS: organization_id =
 * current_org()) — user id only, no name, no email. This is a real,
 * reported UX limitation (the owner filter/form shows raw ids, not
 * names) rather than a silent workaround — closing it properly would mean
 * a new SECURITY DEFINER function or a loosened users RLS policy, both a
 * schema change requiring separate explicit approval, which this step
 * does not have and did not make.
 */
export interface OwnerOption {
  userId: string;
}

export async function listActiveOwnerOptions(ctx: {
  userId: string;
  organizationId: string;
  roleKey: string;
}): Promise<OwnerOption[]> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<{ user_id: string }>(
      `select user_id from public.memberships
       where organization_id = $1 and status = 'active'
       order by user_id`,
      [ctx.organizationId],
    );
    return r.rows.map((row) => ({ userId: row.user_id }));
  });
}
