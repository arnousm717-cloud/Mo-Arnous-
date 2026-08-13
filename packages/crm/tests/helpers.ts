import { randomUUID } from "node:crypto";
import { Pool } from "pg";

// Same well-known local Supabase CLI default connection string used across
// every package's test suite — never valid against a real project.
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const adminPool = new Pool({ connectionString: LOCAL_DB_URL });

/** Real, committed transaction — for fixture setup. Never withTenantContext
 * for setup: withTenantContext (the real, non-test one from
 * @ai-revenue-os/database) commits normally, but chaining multiple
 * withTenantContext calls for setup-then-assert still risks the
 * transaction-time now() staleness and cross-call-visibility pitfalls
 * documented elsewhere in this repo's test suites — seedAsAdmin sidesteps
 * all of that by being a single, real, admin-privileged transaction. */
export async function seedAsAdmin<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export interface OrgFixture {
  organizationId: string;
  userId: string;
  roleKey: string;
}

/** Creates a real organization + a real auth.users row + an active
 * org_admin membership, via direct SQL (not the create_organization_with_owner
 * RPC, which requires a live authenticated session this test harness
 * doesn't simulate) — matching companies-contacts-rls.test.ts's own
 * seedFixture convention. */
export async function createOrgWithActiveMember(roleKey: "org_admin" | "org_member" | "org_viewer" = "org_admin"): Promise<OrgFixture> {
  return seedAsAdmin(async (client) => {
    const userId = randomUUID();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `crm-test-${userId}@example.test`,
    ]);

    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      ["CRM Test Org", `crm-test-org-${randomUUID()}`],
    );
    const organizationId = org.rows[0]!.id;

    const role = await client.query<{ id: string }>("select id from public.roles where key = $1", [roleKey]);
    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, organizationId, role.rows[0]!.id],
    );

    return { organizationId, userId, roleKey };
  });
}

export async function setMembershipStatus(userId: string, organizationId: string, status: "active" | "removed"): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query("update public.memberships set status = $1 where user_id = $2 and organization_id = $3", [
      status,
      userId,
      organizationId,
    ]);
  });
}
