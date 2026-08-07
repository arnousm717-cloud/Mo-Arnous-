import { withTenantContext } from "@ai-revenue-os/database";

export interface AgencySummary {
  id: string;
  name: string;
  slug: string;
}

/**
 * Fetches basic agency details for display (the Agency Console's identity
 * header). Relies on the caller's agency context already being resolved —
 * RLS's agencies_select_own policy (id = current_agency(), M1.2) is what
 * actually restricts this to the agency the caller belongs to.
 */
export async function getAgencyById(
  ctx: { userId: string; agencyId: string },
): Promise<AgencySummary | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<AgencySummary>("select id, name, slug from public.agencies where id = $1", [
      ctx.agencyId,
    ]);
    return r.rows[0] ?? null;
  });
}
