import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createPipeline, createPipelineStage, createDeal as crmCreateDeal } from "@ai-revenue-os/crm";

// Same well-known local Supabase CLI default connection string used across
// every package's test suite — never valid against a real project.
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const adminPool = new Pool({ connectionString: LOCAL_DB_URL });

/** Real, committed transaction — for fixture setup, mirroring
 * packages/crm/tests/helpers.ts's own seedAsAdmin exactly. */
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

/** Mirrors packages/crm/tests/helpers.ts's own createOrgWithActiveMember exactly — a real organization + auth.users row + active org_admin membership, via direct SQL. */
export async function createOrgWithActiveMember(): Promise<OrgFixture> {
  return seedAsAdmin(async (client) => {
    const userId = randomUUID();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `brain-test-${userId}@example.test`,
    ]);

    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      ["Brain Test Org", `brain-test-org-${randomUUID()}`],
    );
    const organizationId = org.rows[0]!.id;

    const role = await client.query<{ id: string }>("select id from public.roles where key = 'org_admin'");
    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, organizationId, role.rows[0]!.id],
    );

    return { organizationId, userId, roleKey: "org_admin" };
  });
}

export async function seedContact(organizationId: string, overrides: { firstName?: string; email?: string } = {}): Promise<{ id: string; updatedAt: string }> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string; updated_at: string }>(
      "insert into public.contacts (organization_id, first_name, email) values ($1, $2, $3) returning id, updated_at",
      [organizationId, overrides.firstName ?? "Ada", overrides.email ?? `brain-${randomUUID()}@example.test`],
    );
    return { id: r.rows[0]!.id, updatedAt: r.rows[0]!.updated_at };
  });
}

export async function seedCompany(organizationId: string, overrides: { name?: string } = {}): Promise<{ id: string; updatedAt: string }> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string; updated_at: string }>(
      "insert into public.companies (organization_id, name) values ($1, $2) returning id, updated_at",
      [organizationId, overrides.name ?? "Acme Inc"],
    );
    return { id: r.rows[0]!.id, updatedAt: r.rows[0]!.updated_at };
  });
}

/** Real CRM calls (not raw SQL) — avoids guessing pipeline/stage schema
 * details and exercises the real createDeal -> emit_deal_event('deal.created')
 * path along the way, matching how a deal actually comes to exist. */
export async function seedDealFixture(fixture: OrgFixture): Promise<{ id: string; updatedAt: string }> {
  const ctx = { userId: fixture.userId, organizationId: fixture.organizationId, roleKey: fixture.roleKey };
  const pipeline = await createPipeline(ctx, { name: `Brain Test Pipeline ${randomUUID()}`, isDefault: true });
  const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 10 });
  const deal = await crmCreateDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
  return { id: deal.id, updatedAt: deal.updatedAt };
}

export async function getBrainProfileRow(organizationId: string, entityColumn: "contact_id" | "company_id" | "deal_id", entityId: string) {
  return seedAsAdmin(async (client) => {
    const r = await client.query(
      `select id, profile, computed_at from public.brain_entity_profiles where organization_id = $1 and ${entityColumn} = $2`,
      [organizationId, entityId],
    );
    return r.rows[0] ?? null;
  });
}

export async function countBrainHistoryRows(entityProfileId: string): Promise<number> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ count: string }>(
      "select count(*)::text as count from public.brain_entity_profile_history where entity_profile_id = $1",
      [entityProfileId],
    );
    return Number(r.rows[0]!.count);
  });
}
