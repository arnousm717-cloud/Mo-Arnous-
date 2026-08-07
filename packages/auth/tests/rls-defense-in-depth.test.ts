import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenantContext } from "@ai-revenue-os/database";
import { can } from "../src/permissions";

// Same well-known local Supabase CLI demo keys used throughout this
// monorepo's test suites — never valid against a real project.
const API_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function createAuthUser(label: string): Promise<string> {
  const { data, error } = await adminClient.auth.admin.createUser({
    email: `rls-defense-${label}-${randomUUID()}@example.test`,
    password: "Correct horse battery staple 1!",
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Test setup failed: ${error?.message}`);
  return data.user.id;
}

async function createAgencyWithOwner(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
      name,
      `rls-defense-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.agency_id as string;
}

async function createStandaloneOrg(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `rls-defense-standalone-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.organization_id as string;
}

/** Calls create_client_organization_for_agency() directly — not via
 * packages/tenancy's wrapper, deliberately, since this test's whole point
 * is bypassing every app-layer check (including can()) and confirming the
 * database layer alone still holds. */
async function createClientOrgDirect(userId: string, agencyId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query(
      "select * from public.create_client_organization_for_agency($1, $2, $3, $4)",
      [name, `rls-defense-client-${randomUUID()}`, agencyId, userId],
    );
    return r.rows[0];
  });
  return result.organization_id as string;
}

const cleanupUserIds: string[] = [];

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await adminClient.auth.admin.deleteUser(id);
  }
  await closePool();
});

/**
 * M1.5 constraint #8: explicit proof that RLS still blocks unauthorized
 * access even if application-level authorization is bypassed entirely —
 * not just that RLS *also* happens to be tested elsewhere. Each test here
 * deliberately does NOT call can() (or deliberately ignores what it says),
 * simulating exactly the bug this milestone's TDR names as the real risk:
 * "some routes wired through can(), others missed." The database layer
 * must reject the operation regardless, matching docs/08-Security.md §2's
 * "neither layer alone is trusted as sufficient."
 */
describe("RLS/SECURITY DEFINER checks independently block what a missing can() check would have allowed to reach", () => {
  it("an org_admin (org-scoped role) attempting to create a client organization under some agency is rejected at the database layer, even though nothing here ever calls can()", async () => {
    const orgUserId = await createAuthUser("org-admin-bypass");
    cleanupUserIds.push(orgUserId);
    await createStandaloneOrg(orgUserId, "RLS Defense Org");

    const someOwnerUserId = await createAuthUser("some-agency-owner-bypass");
    cleanupUserIds.push(someOwnerUserId);
    const targetAgencyId = await createAgencyWithOwner(someOwnerUserId, "RLS Defense Target Agency");

    // Confirm can() WOULD have denied this — establishes the baseline the
    // rest of this test is proving is redundant-but-necessary, not the
    // only thing standing between this call and success.
    const actor = { userId: orgUserId, roleKey: "org_admin", organizationId: randomUUID() };
    expect(can(actor, "organizations:create-client")).toBe(false);

    // Call the underlying function DIRECTLY — the exact call the API route
    // makes AFTER its can() check, here made WITHOUT that check at all,
    // simulating a route that forgot to add it.
    await expect(
      createClientOrgDirect(orgUserId, targetAgencyId, "Should Never Exist"),
    ).rejects.toThrow(/not an active agency_owner\/agency_admin/);

    const orphan = await withTenantContext({ userId: someOwnerUserId, agencyId: targetAgencyId, roleKey: "agency_owner" }, async (client) => {
      const r = await client.query("select id from public.organizations where name = $1", [
        "Should Never Exist",
      ]);
      return r.rows;
    });
    expect(orphan).toHaveLength(0);
  });

  it("agency A's owner attempting to read agency B's client organizations via a direct query (not the rollup view) gets zero rows, even though nothing here ever calls can()", async () => {
    const ownerA = await createAuthUser("direct-read-bypass-a");
    cleanupUserIds.push(ownerA);
    const agencyA = await createAgencyWithOwner(ownerA, "RLS Defense Direct Read Agency A");

    const ownerB = await createAuthUser("direct-read-bypass-b");
    cleanupUserIds.push(ownerB);
    const agencyB = await createAgencyWithOwner(ownerB, "RLS Defense Direct Read Agency B");
    const orgB = await createClientOrgDirect(ownerB, agencyB, "RLS Defense B Client");

    // can() has no relevant concept of "read this specific other agency's
    // org list" to even check here — this scenario is exactly the kind a
    // missing/incomplete can() call site would silently let through if RLS
    // weren't independently enforcing it. Direct table query, not the
    // rollup view — the base table's own organizations_select_own policy
    // (id = current_org()) is what's actually being proven here.
    const rows = await withTenantContext(
      { userId: ownerA, agencyId: agencyA, roleKey: "agency_owner" },
      async (client) => {
        const r = await client.query("select id from public.organizations where id = $1", [orgB]);
        return r.rows;
      },
    );
    expect(rows).toHaveLength(0);
  });
});
