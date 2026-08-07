import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withTenantContext, getPool, closePool } from "@ai-revenue-os/database";
import {
  handleCreateOrganization,
  handleGetOrganizations,
  isSameOrigin,
} from "../app/api/v1/organizations/handlers";

// Same well-known local-only default as every other test in this monorepo
// (packages/database/tests/helpers.ts) — never valid against a real project.
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// getPool() connects via DATABASE_URL, which locally is the postgres
// superuser — used here for admin-bypass fixture setup/verification, same
// pattern packages/tenancy/tests/rls-cross-tenant.test.ts already
// established, rather than adding a direct `pg` dependency just for this.
const adminPool = getPool();

/**
 * handleGetOrganizations/handleCreateOrganization take a resolved userId
 * directly (not a request/cookie) — see handlers.ts's own comment for why.
 * Fixtures use the same admin-bypass, direct-SQL-function pattern as
 * packages/database's tests: withTenantContext({userId}, ...) sets
 * request.jwt.claims itself, which is what makes get_my_agency_context()/
 * get_my_membership_context()'s internal auth.uid() resolve correctly —
 * no real Supabase Auth session/cookie is needed to exercise this layer.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  const client = await adminPool.connect();
  try {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `org-api-${label}-${userId}@example.test`,
    ]);
  } finally {
    client.release();
  }
  return userId;
}

async function createAgencyWithOwner(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
      name,
      `org-api-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.agency_id as string;
}

async function seedAgencyMembership(userId: string, agencyId: string, roleKey: string): Promise<void> {
  const client = await adminPool.connect();
  try {
    const roleRow = await client.query<{ id: string }>("select id from public.roles where key = $1", [
      roleKey,
    ]);
    const roleId = roleRow.rows[0]?.id;
    if (!roleId) throw new Error(`no seeded role for key ${roleKey}`);
    await client.query(
      "insert into public.memberships (user_id, agency_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, agencyId, roleId],
    );
  } finally {
    client.release();
  }
}

async function createStandaloneOrg(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `org-api-standalone-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.organization_id as string;
}

async function createClientOrg(userId: string, agencyId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query(
      "select * from public.create_client_organization_for_agency($1, $2, $3, $4)",
      [name, `org-api-client-${randomUUID()}`, agencyId, userId],
    );
    return r.rows[0];
  });
  return result.organization_id as string;
}

async function jsonOf(response: Response): Promise<{
  organizations?: { id: string; name: string; slug: string }[];
  organization?: { id: string; name: string; slug: string };
  error?: string;
}> {
  return response.json();
}

afterAll(async () => {
  // adminPool IS the same singleton getPool() returns — closePool() alone
  // is sufficient and correct; calling both would double-close it.
  await closePool();
});

describe("GET /api/v1/organizations", () => {
  it("unauthenticated (no resolved user) returns 401", async () => {
    const response = await handleGetOrganizations(null);
    expect(response.status).toBe(401);
    const body = await jsonOf(response);
    expect(body.error).toBeTruthy();
  });

  it("an org-level user gets only their own organization", async () => {
    const userId = await createAuthUser("org-user-get");
    const orgId = await createStandaloneOrg(userId, "Org API Standalone Co");

    const response = await handleGetOrganizations(userId);
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations?.[0]?.id).toBe(orgId);
  });

  it("an agency_owner gets only their agency's client organizations", async () => {
    const owner = await createAuthUser("agency-owner-get");
    const agencyId = await createAgencyWithOwner(owner, "Org API Owner Agency");
    const org1 = await createClientOrg(owner, agencyId, "Owner Client 1");
    const org2 = await createClientOrg(owner, agencyId, "Owner Client 2");

    const response = await handleGetOrganizations(owner);
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body.organizations?.map((o) => o.id).sort()).toEqual([org1, org2].sort());
  });

  it("an agency_admin gets only their agency's client organizations", async () => {
    const owner = await createAuthUser("agency-admin-get-owner");
    const agencyId = await createAgencyWithOwner(owner, "Org API Admin Agency");
    const admin = await createAuthUser("agency-admin-get");
    await seedAgencyMembership(admin, agencyId, "agency_admin");
    const org1 = await createClientOrg(owner, agencyId, "Admin-Visible Client 1");

    const response = await handleGetOrganizations(admin);
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body.organizations?.map((o) => o.id)).toEqual([org1]);
  });

  it("agency A never sees agency B's organizations", async () => {
    const ownerA = await createAuthUser("get-isolation-a");
    const agencyA = await createAgencyWithOwner(ownerA, "Org API Isolation Agency A");
    const orgA = await createClientOrg(ownerA, agencyA, "Isolation A Client");

    const ownerB = await createAuthUser("get-isolation-b");
    const agencyB = await createAgencyWithOwner(ownerB, "Org API Isolation Agency B");
    await createClientOrg(ownerB, agencyB, "Isolation B Client");

    const response = await handleGetOrganizations(ownerA);
    const body = await jsonOf(response);
    expect(body.organizations?.map((o) => o.id)).toEqual([orgA]);
  });

  it("an authenticated user with no organization or agency membership gets an empty list, not an error", async () => {
    const userId = await createAuthUser("no-membership-get");
    const response = await handleGetOrganizations(userId);
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body.organizations).toEqual([]);
  });
});

describe("POST /api/v1/organizations", () => {
  it("unauthenticated (no resolved user) returns 401", async () => {
    const response = await handleCreateOrganization(null, { name: "Should Not Exist" });
    expect(response.status).toBe(401);
  });

  it("an agency_owner can create a client organization", async () => {
    const owner = await createAuthUser("post-owner");
    await createAgencyWithOwner(owner, "Org API POST Owner Agency");

    const response = await handleCreateOrganization(owner, { name: "New Client Via API" });
    expect(response.status).toBe(201);
    const body = await jsonOf(response);
    expect(body.organization?.name).toBe("New Client Via API");

    const listResponse = await handleGetOrganizations(owner);
    const listBody = await jsonOf(listResponse);
    expect(listBody.organizations?.map((o) => o.id)).toContain(body.organization?.id);
  });

  it("an agency_admin can create a client organization", async () => {
    const owner = await createAuthUser("post-admin-owner");
    const agencyId = await createAgencyWithOwner(owner, "Org API POST Admin Agency");
    const admin = await createAuthUser("post-admin");
    await seedAgencyMembership(admin, agencyId, "agency_admin");

    const response = await handleCreateOrganization(admin, { name: "Admin-Created Client" });
    expect(response.status).toBe(201);
  });

  it("an ordinary org_admin is rejected with 403", async () => {
    const userId = await createAuthUser("post-org-admin-rejected");
    await createStandaloneOrg(userId, "Org API Rejecting Org");
    const rejectedName = `Should Not Be Created ${randomUUID()}`;

    const response = await handleCreateOrganization(userId, { name: rejectedName });
    expect(response.status).toBe(403);

    const client = await adminPool.connect();
    try {
      const r = await client.query("select id from public.organizations where name = $1", [rejectedName]);
      expect(r.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it("a client-supplied agencyId in the body cannot spoof the target agency", async () => {
    const ownerA = await createAuthUser("spoof-owner-a");
    const agencyA = await createAgencyWithOwner(ownerA, "Org API Spoof Agency A");
    const ownerB = await createAuthUser("spoof-owner-b");
    const agencyB = await createAgencyWithOwner(ownerB, "Org API Spoof Agency B");

    // The handler never reads an agencyId from the body at all (see
    // handlers.ts) — this proves that even attempting to supply one has no
    // effect: the created org always lands under the caller's own,
    // server-resolved agency.
    const response = await handleCreateOrganization(ownerA, {
      name: `Spoof Attempt Org ${randomUUID()}`,
      agencyId: agencyB,
    });
    expect(response.status).toBe(201);
    const body = await jsonOf(response);
    const createdId = body.organization?.id;
    expect(createdId).toBeTruthy();

    const client = await adminPool.connect();
    try {
      // Queried by the exact created id, not by name — organizations.name
      // has no uniqueness constraint, so a name-based lookup risks matching
      // an unrelated row from a different test run entirely.
      const r = await client.query<{ agency_id: string }>(
        "select agency_id from public.organizations where id = $1",
        [createdId],
      );
      expect(r.rows[0]?.agency_id).toBe(agencyA);
      expect(r.rows[0]?.agency_id).not.toBe(agencyB);
    } finally {
      client.release();
    }
  });

  it("rejects a missing name with 400", async () => {
    const owner = await createAuthUser("post-missing-name");
    await createAgencyWithOwner(owner, "Org API Missing Name Agency");

    const response = await handleCreateOrganization(owner, {});
    expect(response.status).toBe(400);
  });

  it("rejects an empty/whitespace-only name with 400", async () => {
    const owner = await createAuthUser("post-empty-name");
    await createAgencyWithOwner(owner, "Org API Empty Name Agency");

    const response = await handleCreateOrganization(owner, { name: "   " });
    expect(response.status).toBe(400);
  });

  it("rejects a non-string name with 400", async () => {
    const owner = await createAuthUser("post-non-string-name");
    await createAgencyWithOwner(owner, "Org API Non String Name Agency");

    const response = await handleCreateOrganization(owner, { name: 12345 });
    expect(response.status).toBe(400);
  });

  it("rejects an oversized name with 400", async () => {
    const owner = await createAuthUser("post-oversized-name");
    await createAgencyWithOwner(owner, "Org API Oversized Name Agency");

    const response = await handleCreateOrganization(owner, { name: "x".repeat(500) });
    expect(response.status).toBe(400);
  });

  it("two client organizations with the same name under the same agency both succeed, with distinct auto-generated slugs", async () => {
    const owner = await createAuthUser("post-duplicate-name");
    await createAgencyWithOwner(owner, "Org API Duplicate Name Agency");

    const first = await handleCreateOrganization(owner, { name: "Repeated Client Name" });
    const second = await handleCreateOrganization(owner, { name: "Repeated Client Name" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const firstBody = await jsonOf(first);
    const secondBody = await jsonOf(second);
    expect(firstBody.organization?.slug).not.toBe(secondBody.organization?.slug);
    expect(firstBody.organization?.id).not.toBe(secondBody.organization?.id);
  });
});

describe("isSameOrigin()", () => {
  it("allows a matching origin", () => {
    expect(isSameOrigin("https://example.test", "https://example.test/api/v1/organizations")).toBe(true);
  });

  it("rejects a mismatched origin", () => {
    expect(isSameOrigin("https://attacker.test", "https://example.test/api/v1/organizations")).toBe(false);
  });

  it("tolerates a missing origin header rather than rejecting it", () => {
    expect(isSameOrigin(null, "https://example.test/api/v1/organizations")).toBe(true);
  });
});
