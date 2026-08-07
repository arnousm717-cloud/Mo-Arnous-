import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
// Deliberately the PRODUCTION helper — these tests verify real commit/
// rollback behavior and real RLS enforcement, not the test-only
// always-rollback helper. Same reasoning as signup-flow.test.ts and
// agency-context.test.ts.
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * M1.4 backend/security checkpoint: create_agency_with_owner(),
 * create_client_organization_for_agency(), agency_rollup_organizations,
 * and the memberships_agency_self_select RLS policy. All against the real
 * local Postgres instance, nothing mocked.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `agency-mgmt-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createAgencyWithOwner(
  userId: string,
  name: string,
): Promise<{ agencyId: string; membershipId: string }> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query(
      "select * from public.create_agency_with_owner($1, $2, $3)",
      [name, `agency-mgmt-${randomUUID()}`, userId],
    );
    return r.rows[0];
  });
  return { agencyId: result.agency_id, membershipId: result.membership_id };
}

async function roleIdFor(key: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>("select id from public.roles where key = $1", [key]);
    const row = r.rows[0];
    if (!row) throw new Error(`no seeded role for key ${key}`);
    return row.id;
  });
}

/** Simulates "inviting a second agency admin" — no invite function exists
 * yet (out of scope for this checkpoint), so this fixture goes through the
 * admin bypass, same as agency-context.test.ts's seedAgencyMembership. */
async function seedAgencyMembership(userId: string, agencyId: string, roleKey: string): Promise<void> {
  const roleId = await roleIdFor(roleKey);
  await seedAsAdmin(async (client) => {
    await client.query(
      "insert into public.memberships (user_id, agency_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, agencyId, roleId],
    );
  });
}

async function createClientOrg(
  userId: string,
  agencyId: string,
  orgName: string,
): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query(
      "select * from public.create_client_organization_for_agency($1, $2, $3, $4)",
      [orgName, `agency-mgmt-client-${randomUUID()}`, agencyId, userId],
    );
    return r.rows[0];
  });
  return result.organization_id;
}

async function listRollup(
  userId: string,
  agencyId: string,
  roleKey: string,
): Promise<{ id: string; name: string }[]> {
  return withTenantContext({ userId, agencyId, roleKey }, async (client) => {
    const r = await client.query("select id, name from public.agency_rollup_organizations");
    return r.rows;
  });
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("create_agency_with_owner()", () => {
  it("creates exactly one agency and one active agency_owner membership", async () => {
    const userId = await createAuthUser("create-success");
    const { agencyId, membershipId } = await createAgencyWithOwner(userId, "Create Success Agency");
    expect(agencyId).toBeTruthy();
    expect(membershipId).toBeTruthy();

    const check = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select a.name, m.status, m.organization_id, r.key as role_key
         from public.agencies a
         join public.memberships m on m.agency_id = a.id
         join public.roles r on r.id = m.role_id
         where a.id = $1`,
        [agencyId],
      );
      return r.rows;
    });
    expect(check).toHaveLength(1);
    expect(check[0].status).toBe("active");
    expect(check[0].role_key).toBe("agency_owner");
    // No fake/home organization — the membership row is agency-scoped only.
    expect(check[0].organization_id).toBeNull();
  });

  it("agency owner resolves agency context via get_my_agency_context()", async () => {
    const userId = await createAuthUser("owner-resolves");
    const { agencyId } = await createAgencyWithOwner(userId, "Owner Resolves Agency");

    const context = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.get_my_agency_context()");
      return r.rows[0];
    });
    expect(context.agency_id).toBe(agencyId);
    expect(context.role_key).toBe("agency_owner");
  });

  it("a second, invited agency_admin also resolves agency context correctly", async () => {
    const ownerUserId = await createAuthUser("admin-owner");
    const { agencyId } = await createAgencyWithOwner(ownerUserId, "Admin Resolves Agency");

    const adminUserId = await createAuthUser("admin-resolves");
    await seedAgencyMembership(adminUserId, agencyId, "agency_admin");

    const context = await withTenantContext({ userId: adminUserId }, async (client) => {
      const r = await client.query("select * from public.get_my_agency_context()");
      return r.rows[0];
    });
    expect(context.agency_id).toBe(agencyId);
    expect(context.role_key).toBe("agency_admin");
  });

  it("rejects creating an agency on behalf of a different user (identity check)", async () => {
    const callerUserId = await createAuthUser("agency-identity-caller");
    const otherUserId = randomUUID();

    await expect(
      withTenantContext({ userId: callerUserId }, async (client) => {
        await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
          "Should Not Exist Agency",
          `agency-mgmt-rejected-${randomUUID()}`,
          otherUserId,
        ]);
      }),
    ).rejects.toThrow(/must match the authenticated caller/);
  });
});

describe("agency_rollup_organizations: cross-agency isolation", () => {
  it("agency A lists only its own client organizations, agency B lists only its own", async () => {
    const ownerA = await createAuthUser("rollup-owner-a");
    const { agencyId: agencyA } = await createAgencyWithOwner(ownerA, "Rollup Agency A");
    const orgA1 = await createClientOrg(ownerA, agencyA, "Rollup A Client 1");
    const orgA2 = await createClientOrg(ownerA, agencyA, "Rollup A Client 2");

    const ownerB = await createAuthUser("rollup-owner-b");
    const { agencyId: agencyB } = await createAgencyWithOwner(ownerB, "Rollup Agency B");
    const orgB1 = await createClientOrg(ownerB, agencyB, "Rollup B Client 1");

    const listA = await listRollup(ownerA, agencyA, "agency_owner");
    expect(listA.map((o) => o.id).sort()).toEqual([orgA1, orgA2].sort());

    const listB = await listRollup(ownerB, agencyB, "agency_owner");
    expect(listB.map((o) => o.id)).toEqual([orgB1]);
  });

  it("agency A cannot read agency B's organizations through a direct-id path (base table RLS, not the rollup view)", async () => {
    const ownerA = await createAuthUser("direct-owner-a");
    const { agencyId: agencyA } = await createAgencyWithOwner(ownerA, "Direct Path Agency A");

    const ownerB = await createAuthUser("direct-owner-b");
    const { agencyId: agencyB } = await createAgencyWithOwner(ownerB, "Direct Path Agency B");
    const orgB = await createClientOrg(ownerB, agencyB, "Direct Path B Client");

    // Agency A's context set (current_agency), but querying organizations
    // directly rather than through agency_rollup_organizations — the base
    // table's own RLS (id = current_org()) governs here, and current_org()
    // was never set at all in this agency-level context, so this must
    // return zero rows regardless of agency_id matching or not matching.
    const directRead = await withTenantContext(
      { userId: ownerA, agencyId: agencyA, roleKey: "agency_owner" },
      async (client) => {
        const r = await client.query("select id from public.organizations where id = $1", [orgB]);
        return r.rows;
      },
    );
    expect(directRead).toHaveLength(0);
  });

  it("agency A cannot write to agency B's organization through a direct-id path", async () => {
    const ownerA = await createAuthUser("direct-write-owner-a");
    const { agencyId: agencyA } = await createAgencyWithOwner(ownerA, "Direct Write Agency A");

    const ownerB = await createAuthUser("direct-write-owner-b");
    const { agencyId: agencyB } = await createAgencyWithOwner(ownerB, "Direct Write Agency B");
    const orgB = await createClientOrg(ownerB, agencyB, "Direct Write B Client");

    const updateResult = await withTenantContext(
      { userId: ownerA, agencyId: agencyA, roleKey: "agency_owner" },
      async (client) => {
        return client.query("update public.organizations set name = $1 where id = $2", [
          "HACKED BY AGENCY A",
          orgB,
        ]);
      },
    );
    expect(updateResult.rowCount).toBe(0);

    const stillIntact = await seedAsAdmin(async (client) => {
      const r = await client.query("select name from public.organizations where id = $1", [orgB]);
      return r.rows[0].name;
    });
    expect(stillIntact).toBe("Direct Write B Client");
  });

  it("a freshly created agency with zero client organizations returns an empty rollup, not an error", async () => {
    const owner = await createAuthUser("empty-rollup-owner");
    const { agencyId } = await createAgencyWithOwner(owner, "Empty Rollup Agency");

    const list = await listRollup(owner, agencyId, "agency_owner");
    expect(list).toEqual([]);
  });
});

describe("create_client_organization_for_agency()", () => {
  it("an agency_owner can create a client organization", async () => {
    const owner = await createAuthUser("client-create-owner");
    const { agencyId } = await createAgencyWithOwner(owner, "Client Create Owner Agency");
    const orgId = await createClientOrg(owner, agencyId, "Owner-Created Client");

    const check = await seedAsAdmin(async (client) => {
      const r = await client.query("select agency_id, name from public.organizations where id = $1", [
        orgId,
      ]);
      return r.rows[0];
    });
    expect(check.agency_id).toBe(agencyId);
    expect(check.name).toBe("Owner-Created Client");
  });

  it("an agency_admin can also create a client organization", async () => {
    const owner = await createAuthUser("client-create-admin-owner");
    const { agencyId } = await createAgencyWithOwner(owner, "Client Create Admin Agency");
    const admin = await createAuthUser("client-create-admin");
    await seedAgencyMembership(admin, agencyId, "agency_admin");

    const orgId = await createClientOrg(admin, agencyId, "Admin-Created Client");
    const check = await seedAsAdmin(async (client) => {
      const r = await client.query("select agency_id from public.organizations where id = $1", [orgId]);
      return r.rows[0];
    });
    expect(check.agency_id).toBe(agencyId);
  });

  it("no membership row is created for the agency user in the new client org (access flows through the agency, not an implicit org membership)", async () => {
    const owner = await createAuthUser("no-implicit-membership-owner");
    const { agencyId } = await createAgencyWithOwner(owner, "No Implicit Membership Agency");
    const orgId = await createClientOrg(owner, agencyId, "No Implicit Membership Client");

    const memberships = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select id from public.memberships where user_id = $1 and organization_id = $2",
        [owner, orgId],
      );
      return r.rows;
    });
    expect(memberships).toHaveLength(0);
  });

  it("rejects an ordinary org_admin who has no agency membership at all", async () => {
    const orgUserId = await createAuthUser("org-only-rejected");
    await withTenantContext({ userId: orgUserId }, async (client) => {
      await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "Org Only Rejected Co",
        `agency-mgmt-org-only-${randomUUID()}`,
        orgUserId,
      ]);
    });

    const someAgencyOwner = await createAuthUser("some-agency-owner-for-rejection");
    const { agencyId } = await createAgencyWithOwner(someAgencyOwner, "Rejection Target Agency");

    await expect(
      withTenantContext({ userId: orgUserId }, async (client) => {
        await client.query("select * from public.create_client_organization_for_agency($1, $2, $3, $4)", [
          "Should Not Exist",
          `agency-mgmt-rejected-org-${randomUUID()}`,
          agencyId,
          orgUserId,
        ]);
      }),
    ).rejects.toThrow(/not an active agency_owner\/agency_admin/);

    const orphan = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.organizations where name = $1", [
        "Should Not Exist",
      ]);
      return r.rows;
    });
    expect(orphan).toHaveLength(0);
  });

  it("rejects agency A's owner attempting to create a client org under agency B", async () => {
    const ownerA = await createAuthUser("cross-agency-owner-a");
    await createAgencyWithOwner(ownerA, "Cross Agency Creator A");

    const ownerB = await createAuthUser("cross-agency-owner-b");
    const { agencyId: agencyB } = await createAgencyWithOwner(ownerB, "Cross Agency Target B");

    await expect(
      withTenantContext({ userId: ownerA }, async (client) => {
        await client.query("select * from public.create_client_organization_for_agency($1, $2, $3, $4)", [
          "Cross Agency Should Not Exist",
          `agency-mgmt-cross-${randomUUID()}`,
          agencyB,
          ownerA,
        ]);
      }),
    ).rejects.toThrow(/not an active agency_owner\/agency_admin/);

    const orphan = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.organizations where name = $1", [
        "Cross Agency Should Not Exist",
      ]);
      return r.rows;
    });
    expect(orphan).toHaveLength(0);
  });

  it("a duplicate slug rolls back cleanly — no orphaned organization row, global slug uniqueness preserved", async () => {
    const owner = await createAuthUser("client-slug-owner");
    const { agencyId } = await createAgencyWithOwner(owner, "Client Slug Agency");
    const slug = `agency-mgmt-dup-${randomUUID()}`;

    await withTenantContext({ userId: owner }, async (client) => {
      await client.query("select * from public.create_client_organization_for_agency($1, $2, $3, $4)", [
        "First Client",
        slug,
        agencyId,
        owner,
      ]);
    });

    await expect(
      withTenantContext({ userId: owner }, async (client) => {
        await client.query("select * from public.create_client_organization_for_agency($1, $2, $3, $4)", [
          "Second Client Same Slug",
          slug,
          agencyId,
          owner,
        ]);
      }),
    ).rejects.toThrow();

    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, name from public.organizations where slug = $1", [slug]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("First Client");
  });
});

describe("memberships_agency_self_select RLS policy", () => {
  it("a user can read their own agency-scoped membership row via ordinary authenticated access, not only via get_my_agency_context()", async () => {
    const owner = await createAuthUser("self-select-owner");
    const { agencyId } = await createAgencyWithOwner(owner, "Self Select Agency");

    const rows = await withTenantContext({ userId: owner }, async (client) => {
      const r = await client.query(
        "select agency_id from public.memberships where agency_id is not null and user_id = $1",
        [owner],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].agency_id).toBe(agencyId);
  });

  it("a user cannot read another user's agency-scoped membership row via the same direct path", async () => {
    const ownerA = await createAuthUser("self-select-a");
    await createAgencyWithOwner(ownerA, "Self Select Agency A");
    const ownerB = await createAuthUser("self-select-b");
    await createAgencyWithOwner(ownerB, "Self Select Agency B");

    const rows = await withTenantContext({ userId: ownerA }, async (client) => {
      const r = await client.query(
        "select id from public.memberships where agency_id is not null and user_id = $1",
        [ownerB],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("agency deletion behavior (ADR-005 addendum)", () => {
  it("deleting an agency leaves its client organizations intact and sets their agency_id to null", async () => {
    const owner = await createAuthUser("deletion-owner");
    const { agencyId } = await createAgencyWithOwner(owner, "Deletion Test Agency");
    const orgId = await createClientOrg(owner, agencyId, "Surviving Client Org");

    await seedAsAdmin(async (client) => {
      await client.query("delete from public.agencies where id = $1", [agencyId]);
    });

    const org = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, name, agency_id from public.organizations where id = $1", [
        orgId,
      ]);
      return r.rows[0];
    });
    expect(org).toBeTruthy();
    expect(org.name).toBe("Surviving Client Org");
    expect(org.agency_id).toBeNull();
  });

  it("deleting an agency deletes its agency-scoped memberships", async () => {
    const owner = await createAuthUser("deletion-membership-owner");
    const { agencyId, membershipId } = await createAgencyWithOwner(owner, "Deletion Membership Agency");

    await seedAsAdmin(async (client) => {
      await client.query("delete from public.agencies where id = $1", [agencyId]);
    });

    const membership = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.memberships where id = $1", [membershipId]);
      return r.rows;
    });
    expect(membership).toHaveLength(0);
  });

  it("a surviving standalone organization keeps its own organization-level memberships untouched", async () => {
    const owner = await createAuthUser("deletion-org-membership-owner");
    const { agencyId } = await createAgencyWithOwner(owner, "Deletion Org Membership Agency");
    const orgId = await createClientOrg(owner, agencyId, "Org Membership Survives Client");

    // create_client_organization_for_agency() deliberately creates no
    // membership for the creator (see its own migration comment) — seed one
    // directly to prove organization-scoped rows are untouched by agency
    // deletion regardless.
    const orgUser = await createAuthUser("deletion-org-user");
    const orgAdminRoleId = await roleIdFor("org_admin");
    const membershipId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active') returning id",
        [orgUser, orgId, orgAdminRoleId],
      );
      const row = r.rows[0];
      if (!row) throw new Error("membership insert returned no row");
      return row.id;
    });

    await seedAsAdmin(async (client) => {
      await client.query("delete from public.agencies where id = $1", [agencyId]);
    });

    const membership = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.memberships where id = $1", [membershipId]);
      return r.rows;
    });
    expect(membership).toHaveLength(1);
  });
});
