import type { PoolClient } from "pg";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { ValidationError } from "./errors";
import { decodeCursor, resolveLimit, buildPage, type Page } from "./pagination";
import { validateOwner } from "./owner-validation";
import { runInClientOrTransaction } from "./transaction";

/**
 * Companies domain logic (Milestone 2.1D, docs/13-Technical-Design-Review.md
 * "Milestone 2.1" Detailed design + the 2.1D approved decisions). Pure
 * domain layer — no HTTP concerns, organizationId always from ctx, never
 * accepted as a mutation input.
 */

const WHITESPACE_ONLY = /^\s*$/;

export interface CreateCompanyInput {
  name: string;
  domain?: string | null;
  industry?: string | null;
  employeeCount?: number | null;
  annualRevenue?: number | string | null;
  linkedinUrl?: string | null;
  ownerId?: string | null;
}

export interface UpdateCompanyInput {
  name?: string;
  domain?: string | null;
  industry?: string | null;
  employeeCount?: number | null;
  annualRevenue?: number | string | null;
  linkedinUrl?: string | null;
  ownerId?: string | null;
}

export interface ListCompaniesInput {
  ownerId?: string;
  cursor?: string;
  limit?: number;
}

export interface Company {
  id: string;
  organizationId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  // Postgres `numeric` comes back from node-postgres as a string by
  // default (avoiding silent float precision loss) — the domain type
  // matches that honestly rather than lossily coercing to `number`.
  annualRevenue: string | null;
  linkedinUrl: string | null;
  // Schema-complete, functionally inert until Phase 3 Lead Enrichment —
  // never a create/update input in this milestone (docs/13, migration
  // comment on companies.enrichment_status).
  enrichmentStatus: string | null;
  ownerId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CompanyRow {
  id: string;
  organization_id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employee_count: number | null;
  annual_revenue: string | null;
  linkedin_url: string | null;
  enrichment_status: string | null;
  owner_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const COMPANY_COLUMNS = `id, organization_id, name, domain, industry, employee_count, annual_revenue,
   linkedin_url, enrichment_status, owner_id, deleted_at, created_at, updated_at`;

function toCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    employeeCount: row.employee_count,
    annualRevenue: row.annual_revenue,
    linkedinUrl: row.linkedin_url,
    enrichmentStatus: row.enrichment_status,
    ownerId: row.owner_id,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Reject "", "   ", tab/newline-only, any non-string. Trim before
 * persistence. No database migration for this — enforced only at this
 * domain layer (2.1D decision 2); the DB itself only enforces NOT NULL. */
function validateCompanyName(name: unknown): string {
  if (typeof name !== "string" || WHITESPACE_ONLY.test(name)) {
    throw new ValidationError("name must contain at least one non-whitespace character");
  }
  return name.trim();
}

/**
 * `existingClient` (2.1F-A): when supplied, runs against that already-open,
 * already-tenant-scoped transaction instead of opening a new one — used by
 * the idempotency helper so reservation + mutation + response persistence
 * commit atomically as one transaction. Omitted (the default, and every
 * existing caller/test's behavior), this opens its own withTenantContext
 * transaction exactly as before — fully backward-compatible.
 */
export async function createCompany(
  ctx: RequestContext & { organizationId: string },
  input: CreateCompanyInput,
  existingClient?: PoolClient,
): Promise<Company> {
  const name = validateCompanyName(input.name);
  const ownerId = input.ownerId ?? null;

  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    await validateOwner(client, ctx.organizationId, ownerId);

    const r = await client.query<CompanyRow>(
      `insert into public.companies
         (organization_id, name, domain, industry, employee_count, annual_revenue, linkedin_url, owner_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning ${COMPANY_COLUMNS}`,
      [
        ctx.organizationId,
        name,
        input.domain ?? null,
        input.industry ?? null,
        input.employeeCount ?? null,
        input.annualRevenue ?? null,
        input.linkedinUrl ?? null,
        ownerId,
      ],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error("companies insert returned no row — this should be unreachable.");
    }
    return toCompany(row);
  });
}

/** Excludes soft-deleted rows (normal read behavior). Returns null
 * identically for nonexistent, cross-org, and soft-deleted — 2.1F maps
 * null to 404, never a distinct Forbidden. */
export async function getCompanyById(ctx: RequestContext & { organizationId: string }, id: string): Promise<Company | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<CompanyRow>(
      `select ${COMPANY_COLUMNS} from public.companies
       where id = $1 and organization_id = $2 and deleted_at is null`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toCompany(row) : null;
  });
}

/**
 * Staging bugfix (post-2.1G-C): like getCompanyById, but does not filter
 * out soft-deleted rows. A contact's stored companyId is deliberately
 * preserved when its linked company is soft-deleted (2.1B design), so a
 * display layer needs a tenant-scoped way to resolve that company's name
 * for a "<name> (deleted)" label instead of falling back to a raw id.
 * Never used for the active company list/filter/relationship-validation
 * paths — those must keep excluding soft-deleted companies unchanged;
 * this function exists solely for read-only display-name resolution.
 */
export async function getCompanyByIdIncludingDeleted(
  ctx: RequestContext & { organizationId: string },
  id: string,
): Promise<Company | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<CompanyRow>(
      `select ${COMPANY_COLUMNS} from public.companies
       where id = $1 and organization_id = $2`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toCompany(row) : null;
  });
}

export async function listCompanies(
  ctx: RequestContext & { organizationId: string },
  input: ListCompaniesInput = {},
): Promise<Page<Company>> {
  const limit = resolveLimit(input.limit);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;

  return withTenantContext(ctx, async (client) => {
    const conditions = ["organization_id = $1", "deleted_at is null"];
    const values: unknown[] = [ctx.organizationId];

    if (input.ownerId !== undefined) {
      values.push(input.ownerId);
      conditions.push(`owner_id = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);

    const r = await client.query<CompanyRow>(
      `select ${COMPANY_COLUMNS} from public.companies
       where ${conditions.join(" and ")}
       order by created_at desc, id desc
       limit $${values.length}`,
      values,
    );
    return buildPage(r.rows, limit, toCompany);
  });
}

/** Partial update — only fields actually present on `input` are
 * changed (`Object.prototype.hasOwnProperty`, not `!== undefined`, so an
 * explicit `{ domain: undefined }` from a caller is indistinguishable
 * from omission, matching normal JS/JSON semantics). Cannot target an
 * already soft-deleted row — matches "excluded from normal get/list"
 * extended to writes; a soft-deleted company is read-only. Returns null
 * for nonexistent/cross-org/already-deleted, never throws for those. */
export async function updateCompany(
  ctx: RequestContext & { organizationId: string },
  id: string,
  input: UpdateCompanyInput,
  existingClient?: PoolClient,
): Promise<Company | null> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const sets: string[] = [];
    const values: unknown[] = [];

    const has = (key: keyof UpdateCompanyInput) => Object.prototype.hasOwnProperty.call(input, key);

    if (has("name")) {
      values.push(validateCompanyName(input.name));
      sets.push(`name = $${values.length}`);
    }
    if (has("domain")) {
      values.push(input.domain ?? null);
      sets.push(`domain = $${values.length}`);
    }
    if (has("industry")) {
      values.push(input.industry ?? null);
      sets.push(`industry = $${values.length}`);
    }
    if (has("employeeCount")) {
      values.push(input.employeeCount ?? null);
      sets.push(`employee_count = $${values.length}`);
    }
    if (has("annualRevenue")) {
      values.push(input.annualRevenue ?? null);
      sets.push(`annual_revenue = $${values.length}`);
    }
    if (has("linkedinUrl")) {
      values.push(input.linkedinUrl ?? null);
      sets.push(`linkedin_url = $${values.length}`);
    }
    if (has("ownerId")) {
      const ownerId = input.ownerId ?? null;
      await validateOwner(client, ctx.organizationId, ownerId);
      values.push(ownerId);
      sets.push(`owner_id = $${values.length}`);
    }

    if (sets.length === 0) {
      const current = await client.query<CompanyRow>(
        `select ${COMPANY_COLUMNS} from public.companies
         where id = $1 and organization_id = $2 and deleted_at is null`,
        [id, ctx.organizationId],
      );
      const row = current.rows[0];
      return row ? toCompany(row) : null;
    }

    // set_updated_at() trigger (2.1B) already sets updated_at = now() on
    // every UPDATE — not restated here.
    values.push(id, ctx.organizationId);
    const r = await client.query<CompanyRow>(
      `update public.companies set ${sets.join(", ")}
       where id = $${values.length - 1} and organization_id = $${values.length} and deleted_at is null
       returning ${COMPANY_COLUMNS}`,
      values,
    );
    const row = r.rows[0];
    return row ? toCompany(row) : null;
  });
}

/** deleted_at = now(). Cannot double-soft-delete (WHERE deleted_at is
 * null) — returns null if already deleted/nonexistent/cross-org. Never a
 * physical DELETE — no DELETE grant exists on this table at all (2.1B). */
export async function softDeleteCompany(ctx: RequestContext & { organizationId: string }, id: string): Promise<Company | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<CompanyRow>(
      `update public.companies set deleted_at = now()
       where id = $1 and organization_id = $2 and deleted_at is null
       returning ${COMPANY_COLUMNS}`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toCompany(row) : null;
  });
}
