import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool, withTenantContext } from "@ai-revenue-os/database";
import { getOrganizationById } from "../src/organizations";

// Same well-known local Supabase CLI demo keys used throughout this
// monorepo's test suites — never valid against a real project.
const API_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface RealTenant {
  userId: string;
  organizationId: string;
  organizationName: string;
}

async function createRealTenant(organizationName: string): Promise<RealTenant> {
  const email = `rls-cross-tenant-${randomUUID()}@example.test`;
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password: "Correct horse battery staple 1!",
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Test setup failed to create auth user: ${error?.message}`);
  }

  const slug = `rls-cross-tenant-${randomUUID()}`;
  const organizationId = await withTenantContext({ userId: data.user.id }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      organizationName,
      slug,
      data.user.id,
    ]);
    return r.rows[0].organization_id as string;
  });

  return { userId: data.user.id, organizationId, organizationName };
}

/** Mirrors exactly what packages/auth's resolveRequestContext() does — real
 * session, real get_my_membership_context() resolution — so this test's
 * "logged-in user's context" is the genuine article, not a stand-in. */
async function resolveRealContext(userId: string): Promise<{ userId: string; organizationId: string }> {
  const row = await withTenantContext({ userId }, async (client) => {
    const r = await client.query<{ organization_id: string }>(
      "select * from public.get_my_membership_context()",
    );
    return r.rows[0];
  });
  if (!row) {
    throw new Error(`get_my_membership_context() resolved no row for ${userId}`);
  }
  return { userId, organizationId: row.organization_id };
}

/**
 * Verifies the exact guarantee requested for the authenticated tenant flow:
 * "Supabase RLS voorkomt dat deze gebruiker data van andere tenants kan
 * lezen of wijzigen" — using a real, correctly-resolved session context (via
 * get_my_membership_context(), the same function resolveRequestContext()
 * calls), not a manufactured one. packages/database/tests/rls-isolation.test.ts
 * already proves the underlying RLS policies hold under a manufactured
 * context; this proves the same guarantee holds end-to-end through the real
 * resolution pipeline and the actual app-layer function (getOrganizationById)
 * the dashboard calls.
 */
describe("RLS cross-tenant isolation under a real, correctly-resolved session context", () => {
  let tenantA: RealTenant;
  let tenantB: RealTenant;

  beforeAll(async () => {
    [tenantA, tenantB] = await Promise.all([
      createRealTenant("RLS Cross Tenant Org A"),
      createRealTenant("RLS Cross Tenant Org B"),
    ]);
  });

  afterAll(async () => {
    await adminClient.auth.admin.deleteUser(tenantA.userId);
    await adminClient.auth.admin.deleteUser(tenantB.userId);
    await closePool();
  });

  it("getOrganizationById returns the caller's own organization under their real resolved context", async () => {
    const ctx = await resolveRealContext(tenantA.userId);
    const org = await getOrganizationById(ctx);
    expect(org?.id).toBe(tenantA.organizationId);
    expect(org?.name).toBe(tenantA.organizationName);
  });

  it("a direct read for another tenant's organization returns zero rows under the caller's real context", async () => {
    const ctxA = await resolveRealContext(tenantA.userId);
    const rows = await withTenantContext(ctxA, async (client) => {
      const r = await client.query("select id, name from public.organizations where id = $1", [
        tenantB.organizationId,
      ]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("an attempted write to another tenant's organization affects zero rows and never mutates the data", async () => {
    const ctxA = await resolveRealContext(tenantA.userId);
    const updateResult = await withTenantContext(ctxA, async (client) => {
      return client.query("update public.organizations set name = $1 where id = $2", [
        "HACKED BY TENANT A",
        tenantB.organizationId,
      ]);
    });
    expect(updateResult.rowCount).toBe(0);

    // Verified via a direct, unrestricted Postgres connection (DATABASE_URL's
    // postgres role, not PostgREST/service_role — the app never uses
    // PostgREST for data access at all, per ADR-004) rather than trusting
    // rowCount alone.
    const pool = getPool();
    const stillIntact = await pool.query<{ name: string }>(
      "select name from public.organizations where id = $1",
      [tenantB.organizationId],
    );
    expect(stillIntact.rows[0]?.name).toBe(tenantB.organizationName);
  });

  it("both tenants can still read their own organization normally (isolation isn't a blanket deny)", async () => {
    const ctxA = await resolveRealContext(tenantA.userId);
    const ctxB = await resolveRealContext(tenantB.userId);
    const orgA = await getOrganizationById(ctxA);
    const orgB = await getOrganizationById(ctxB);
    expect(orgA?.name).toBe(tenantA.organizationName);
    expect(orgB?.name).toBe(tenantB.organizationName);
  });
});
