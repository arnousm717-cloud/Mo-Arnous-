import { withTenantContext } from "@ai-revenue-os/database";

/**
 * Milestone 2.4C: read-only domain layer for the four Milestone 2.4A
 * agency roll-up views (agency_rollup_companies/contacts/deals/pipelines).
 * Mirrors listOrganizationsForAgency (./organizations.ts) exactly — same
 * ctx shape, same withTenantContext() usage, same "query the view, trust
 * current_agency()/current_role_key() as the real security boundary"
 * discipline.
 *
 * Authorization is DELIBERATELY NOT checked here (approved Milestone 2.4C
 * decision, Option A) — packages/tenancy has never depended on
 * @ai-revenue-os/auth (confirmed: package.json, and zero can() calls
 * anywhere in this package's source). The one existing precedent for an
 * agency-scoped mutation through this package,
 * createClientOrganizationForAgency, is authorized one layer above, in
 * apps/web/app/agency/create-client-org-logic.ts
 * (`can(agencyContext, "organizations:create-client")`) — never inside
 * the tenancy function itself. These four functions follow that same
 * convention: a future apps/web caller is responsible for checking
 * `can(actor, "companies:agency-rollup-read")` (and the matching
 * contacts:/deals:/pipelines: keys) before ever calling into this file.
 * The real, underlying security boundary regardless of that application
 * check is the database itself — each function queries only its matching
 * agency_rollup_* view, which is security_invoker=false with
 * current_agency()/current_role_key() as its own WHERE clause (2.4A) —
 * never a base CRM table, and never with a client-supplied
 * agencyId/organizationId override (ctx.agencyId is the only agency
 * scope, always the caller's own already-resolved context, exactly like
 * listOrganizationsForAgency).
 *
 * Pagination (approved Milestone 2.4C decision): no cursor framework —
 * packages/crm's Cursor/Page/encodeCursor/decodeCursor apparatus is not
 * duplicated here, and packages/tenancy does not take on a new dependency
 * on @ai-revenue-os/crm merely to reuse it. Each function returns a plain
 * array (matching listOrganizationsForAgency's own existing shape) capped
 * at a small, local, bounded `limit` — no next-page cursor is offered
 * because none of these four functions need one yet (2.4D's actual UI
 * requirement, once built, may justify adding one later; not guessed at
 * now).
 *
 * organizationName is deliberately NOT included in any of these four
 * result types — the 2.4A views don't expose it (Milestone 2.4A
 * deliberately excluded raw-UUID-with-no-resolution columns; adding an
 * organization label would mean either widening those views, which this
 * milestone's own scope forbids, or joining here, which this file avoids
 * for the same reason it avoids adding an auth dependency: it would only
 * ever be needed for display, a 2.4D UI concern). A future 2.4D
 * composition layer can resolve organization names safely by calling the
 * already-existing listOrganizationsForAgency (./organizations.ts) once
 * per request and joining in memory — never a new view, never a new
 * query added to these four functions themselves.
 */

interface AgencyRollupContext {
  userId: string;
  agencyId: string;
  roleKey: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Validates an optional caller-supplied limit — small, local, and
 * deliberately not imported from packages/crm's own resolveLimit (that
 * would pull in the full pagination module for one function). Same
 * validation shape regardless: a positive integer, capped at MAX_LIMIT,
 * defaulting to DEFAULT_LIMIT when omitted. Throws a plain Error (this
 * package has no ValidationError of its own, and introducing one for a
 * single validation helper would be its own small duplication) — the
 * message never leaks anything beyond the limit's own valid range. */
function resolveAgencyRollupLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  if (limit > MAX_LIMIT) {
    throw new Error(`limit must not exceed ${MAX_LIMIT}`);
  }
  return limit;
}

export interface AgencyRollupCompany {
  id: string;
  organizationId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  // numeric column — the pg driver returns numeric as a string, never a
  // JS number (precision-preserving), matching packages/crm's own
  // Company.annualRevenue convention exactly.
  annualRevenue: string | null;
  createdAt: string;
}

export interface AgencyRollupContact {
  id: string;
  organizationId: string;
  companyId: string | null;
  firstName: string | null;
  lastName: string | null;
  lifecycleStage: string | null;
  createdAt: string;
  // Deliberately no email/phone/jobTitle/linkedinUrl/ownerId — the
  // agency_rollup_contacts view (2.4A) does not expose these columns at
  // all; there is nothing to select even by mistake.
}

export interface AgencyRollupDeal {
  id: string;
  organizationId: string;
  companyId: string | null;
  pipelineId: string;
  // numeric column — string, matching packages/crm's own Deal.amount
  // convention exactly.
  amount: string | null;
  currency: string;
  status: string;
  expectedCloseDate: string | null;
  createdAt: string;
}

export interface AgencyRollupPipeline {
  id: string;
  organizationId: string;
  name: string;
  // Deliberately nothing else — the agency_rollup_pipelines view (2.4A)
  // exposes only id/organization_id/name by design ("identify and label,
  // never manage").
}

interface CompanyRow {
  id: string;
  organization_id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employee_count: number | null;
  annual_revenue: string | null;
  created_at: string;
}

function toAgencyRollupCompany(row: CompanyRow): AgencyRollupCompany {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    employeeCount: row.employee_count,
    annualRevenue: row.annual_revenue,
    createdAt: row.created_at,
  };
}

/**
 * Lists the calling agency's client companies via agency_rollup_companies
 * (2.4A) — the only supported cross-organization read path for this
 * resource; never a broadened base-table query. ctx.roleKey must be
 * agency_owner/agency_admin for the underlying view's own WHERE clause to
 * return anything at all. Application-layer authorization
 * (companies:agency-rollup-read) is the caller's responsibility — see
 * this file's own top comment.
 */
export async function listCompaniesForAgency(
  ctx: AgencyRollupContext,
  options?: { limit?: number },
): Promise<AgencyRollupCompany[]> {
  const limit = resolveAgencyRollupLimit(options?.limit);
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<CompanyRow>(
      `select id, organization_id, name, domain, industry, employee_count, annual_revenue, created_at
       from public.agency_rollup_companies
       order by created_at desc, id desc
       limit $1`,
      [limit],
    );
    return r.rows.map(toAgencyRollupCompany);
  });
}

interface ContactRow {
  id: string;
  organization_id: string;
  company_id: string | null;
  first_name: string | null;
  last_name: string | null;
  lifecycle_stage: string | null;
  created_at: string;
}

function toAgencyRollupContact(row: ContactRow): AgencyRollupContact {
  return {
    id: row.id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    firstName: row.first_name,
    lastName: row.last_name,
    lifecycleStage: row.lifecycle_stage,
    createdAt: row.created_at,
  };
}

/**
 * Lists the calling agency's client contacts via agency_rollup_contacts
 * (2.4A). Same discipline as listCompaniesForAgency — see this file's own
 * top comment. The selected column list below is exhaustive: it is
 * exactly the view's own exposed columns, never `select *`, preserving
 * the view's own data-minimization guarantee (no email/phone/job_title/
 * linkedin_url/owner_id) at this layer too, not just at the database
 * layer.
 */
export async function listContactsForAgency(
  ctx: AgencyRollupContext,
  options?: { limit?: number },
): Promise<AgencyRollupContact[]> {
  const limit = resolveAgencyRollupLimit(options?.limit);
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<ContactRow>(
      `select id, organization_id, company_id, first_name, last_name, lifecycle_stage, created_at
       from public.agency_rollup_contacts
       order by created_at desc, id desc
       limit $1`,
      [limit],
    );
    return r.rows.map(toAgencyRollupContact);
  });
}

interface DealRow {
  id: string;
  organization_id: string;
  company_id: string | null;
  pipeline_id: string;
  amount: string | null;
  currency: string;
  status: string;
  expected_close_date: string | null;
  created_at: string;
}

function toAgencyRollupDeal(row: DealRow): AgencyRollupDeal {
  return {
    id: row.id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    pipelineId: row.pipeline_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    expectedCloseDate: row.expected_close_date,
    createdAt: row.created_at,
  };
}

/**
 * Lists the calling agency's client deals via agency_rollup_deals (2.4A).
 * Same discipline as listCompaniesForAgency. stage_id/primary_contact_id/
 * probability/owner_id are not selected because the view itself does not
 * expose them (2.4A's own reviewed column set) — pipelineId is the one
 * relationship column present, resolvable via listPipelinesForAgency
 * below for display, never joined here.
 */
export async function listDealsForAgency(
  ctx: AgencyRollupContext,
  options?: { limit?: number },
): Promise<AgencyRollupDeal[]> {
  const limit = resolveAgencyRollupLimit(options?.limit);
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<DealRow>(
      `select id, organization_id, company_id, pipeline_id, amount, currency, status, expected_close_date, created_at
       from public.agency_rollup_deals
       order by created_at desc, id desc
       limit $1`,
      [limit],
    );
    return r.rows.map(toAgencyRollupDeal);
  });
}

interface PipelineRow {
  id: string;
  organization_id: string;
  name: string;
}

function toAgencyRollupPipeline(row: PipelineRow): AgencyRollupPipeline {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
  };
}

/**
 * Lists the calling agency's client pipelines via agency_rollup_pipelines
 * (2.4A) — id/name only, matching that view's own deliberately minimal
 * "identify and label, never manage" column set. No created_at column
 * exists on this view (2.4A), so ordering falls back to name (then id as
 * a stable tie-breaker) rather than the created_at-based ordering the
 * other three functions use — the only deterministic ordering this
 * view's own limited columns can support.
 */
export async function listPipelinesForAgency(
  ctx: AgencyRollupContext,
  options?: { limit?: number },
): Promise<AgencyRollupPipeline[]> {
  const limit = resolveAgencyRollupLimit(options?.limit);
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<PipelineRow>(
      `select id, organization_id, name
       from public.agency_rollup_pipelines
       order by name asc, id asc
       limit $1`,
      [limit],
    );
    return r.rows.map(toAgencyRollupPipeline);
  });
}
