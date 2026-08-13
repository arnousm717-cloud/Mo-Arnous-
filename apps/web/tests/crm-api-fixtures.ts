import { randomUUID } from "node:crypto";
import { getPool } from "@ai-revenue-os/database";

/**
 * Shared fixtures for companies-api.test.ts / contacts-api.test.ts —
 * genuine, large duplication otherwise (auth/RBAC/tenancy setup is
 * identical for both resources), matching CLAUDE.md's "no duplicate
 * logic" rule. Not a *.test.ts file itself, so vitest never collects it
 * as a suite.
 *
 * Sets DATABASE_URL here, not just in the importing test file — this
 * module's own top-level getPool() call executes as part of import
 * resolution, before any of the importing test file's own top-level
 * statements run, so relying on the test file to set it first would be
 * too late.
 */
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const adminPool = getPool();

export interface OrgActor {
  organizationId: string;
  userId: string;
  roleKey: string;
}

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  const client = await adminPool.connect();
  try {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `crm-api-${label}-${userId}@example.test`,
    ]);
  } finally {
    client.release();
  }
  return userId;
}

export async function createOrgWithRole(
  roleKey: "org_admin" | "org_member" | "org_viewer",
  label: string = roleKey,
): Promise<OrgActor> {
  const userId = await createAuthUser(label);
  const client = await adminPool.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      ["CRM API Test Org", `crm-api-org-${randomUUID()}`],
    );
    const organizationId = org.rows[0]!.id;
    const role = await client.query<{ id: string }>("select id from public.roles where key = $1", [roleKey]);
    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, organizationId, role.rows[0]!.id],
    );
    // get_my_membership_context() (called via resolveOrganizationContextForUser,
    // which every route handler uses) resolves via users.default_organization_id,
    // not just an active membership row — normally set by
    // create_organization_with_owner(), which this direct-SQL fixture bypasses.
    await client.query("update public.users set default_organization_id = $1 where id = $2", [
      organizationId,
      userId,
    ]);
    return { organizationId, userId, roleKey };
  } finally {
    client.release();
  }
}

/** A user with an active agency-level membership only (agency_owner) and
 * zero org-scoped membership — per ADR-005, agency roles never
 * automatically receive an org-scoped row. Used to prove pure agency
 * actors get 403 on every CRM route. */
export async function createPureAgencyActor(): Promise<string> {
  const userId = await createAuthUser("agency-only");
  const client = await adminPool.connect();
  try {
    const agency = await client.query<{ id: string }>(
      "insert into public.agencies (name, slug) values ($1, $2) returning id",
      ["CRM API Test Agency", `crm-api-agency-${randomUUID()}`],
    );
    const role = await client.query<{ id: string }>("select id from public.roles where key = 'agency_owner'");
    await client.query(
      "insert into public.memberships (user_id, agency_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, agency.rows[0]!.id, role.rows[0]!.id],
    );
    return userId;
  } finally {
    client.release();
  }
}

/** An authenticated user with no membership row at all — proves the
 * "authenticated but no org context" 403 path, distinct from 401. */
export async function createUnaffiliatedUser(): Promise<string> {
  return createAuthUser("unaffiliated");
}

export async function setMembershipStatus(
  userId: string,
  organizationId: string,
  status: "active" | "removed",
): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("update public.memberships set status = $1 where user_id = $2 and organization_id = $3", [
      status,
      userId,
      organizationId,
    ]);
  } finally {
    client.release();
  }
}

export async function seedCompany(
  organizationId: string,
  overrides: Partial<{ name: string; ownerId: string | null }> = {},
): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id",
      [organizationId, overrides.name ?? "Seeded Co", overrides.ownerId ?? null],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

export async function seedContact(
  organizationId: string,
  overrides: Partial<{ firstName: string; companyId: string | null }> = {},
): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, company_id) values ($1, $2, $3) returning id",
      [organizationId, overrides.firstName ?? "Seeded Contact", overrides.companyId ?? null],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}
