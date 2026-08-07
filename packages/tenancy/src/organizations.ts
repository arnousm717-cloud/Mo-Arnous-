import { withTenantContext } from "@ai-revenue-os/database";
import { slugify, slugWithSuffix } from "./slug";

export interface NewOrganizationResult {
  organizationId: string;
  membershipId: string;
  slug: string;
}

const UNIQUE_VIOLATION = "23505";
const MAX_SLUG_ATTEMPTS = 5;

/**
 * Creates a brand-new organization owned by userId, with them as its first
 * org_admin member — the only supported way to create an organization
 * (ADR-003: a direct client INSERT cannot satisfy RLS's RETURNING
 * requirement for a row that doesn't exist yet).
 */
export async function createOrganizationForNewUser(
  userId: string,
  orgName: string,
): Promise<NewOrganizationResult> {
  const baseSlug = slugify(orgName) || "organization";
  let candidateSlug = baseSlug;

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      const result = await withTenantContext({ userId }, async (client) => {
        const r = await client.query<{ organization_id: string; membership_id: string }>(
          "select * from public.create_organization_with_owner($1, $2, $3)",
          [orgName, candidateSlug, userId],
        );
        return r.rows[0];
      });
      if (!result) {
        throw new Error("create_organization_with_owner returned no row — this should be unreachable.");
      }
      return { organizationId: result.organization_id, membershipId: result.membership_id, slug: candidateSlug };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === UNIQUE_VIOLATION && attempt < MAX_SLUG_ATTEMPTS) {
        candidateSlug = slugWithSuffix(baseSlug);
        continue;
      }
      throw err;
    }
  }

  // Unreachable given the loop above always either returns or throws, but
  // TypeScript can't see that — satisfies the function's return type.
  throw new Error(`Could not generate a unique organization slug after ${MAX_SLUG_ATTEMPTS} attempts.`);
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
}

/**
 * Fetches basic organization details for display (e.g. the dashboard's
 * "Welcome, {org name}"). Relies on the caller's tenant context already
 * being resolved — RLS's organizations_select_own policy (id = current_org())
 * is what actually restricts this to the org the caller is scoped to.
 */
export async function getOrganizationById(
  ctx: { userId: string; organizationId: string },
): Promise<OrganizationSummary | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<OrganizationSummary>(
      "select id, name, slug from public.organizations where id = $1",
      [ctx.organizationId],
    );
    return r.rows[0] ?? null;
  });
}

export interface NewClientOrganizationResult {
  organizationId: string;
  slug: string;
}

/**
 * Creates a new client organization under an agency — the application-layer
 * counterpart to create_client_organization_for_agency() (M1.4 backend
 * checkpoint). agencyId must come from the caller's own server-resolved
 * agency context (packages/auth's resolveAgencyContextForUser), never from
 * a client-supplied value — the SQL function's own auth.uid()/membership
 * check is defense-in-depth beneath that, not the only gate.
 */
export async function createClientOrganizationForAgency(
  userId: string,
  agencyId: string,
  orgName: string,
): Promise<NewClientOrganizationResult> {
  const baseSlug = slugify(orgName) || "organization";
  let candidateSlug = baseSlug;

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      const result = await withTenantContext({ userId, agencyId }, async (client) => {
        const r = await client.query<{ organization_id: string }>(
          "select * from public.create_client_organization_for_agency($1, $2, $3, $4)",
          [orgName, candidateSlug, agencyId, userId],
        );
        return r.rows[0];
      });
      if (!result) {
        throw new Error(
          "create_client_organization_for_agency returned no row — this should be unreachable.",
        );
      }
      return { organizationId: result.organization_id, slug: candidateSlug };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === UNIQUE_VIOLATION && attempt < MAX_SLUG_ATTEMPTS) {
        candidateSlug = slugWithSuffix(baseSlug);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Could not generate a unique organization slug after ${MAX_SLUG_ATTEMPTS} attempts.`);
}

/**
 * Lists the calling agency's client organizations via the
 * agency_rollup_organizations view (M1.4 backend checkpoint) — the only
 * supported cross-organization read path; never a broadened base-table
 * query. ctx.roleKey must be agency_owner/agency_admin for the underlying
 * view's own WHERE clause to return anything at all.
 */
export async function listOrganizationsForAgency(
  ctx: { userId: string; agencyId: string; roleKey: string },
): Promise<OrganizationSummary[]> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<OrganizationSummary>(
      "select id, name, slug from public.agency_rollup_organizations order by name",
    );
    return r.rows;
  });
}
