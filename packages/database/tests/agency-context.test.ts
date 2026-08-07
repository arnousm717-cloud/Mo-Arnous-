import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
// Deliberately the PRODUCTION helper, matching signup-flow.test.ts's
// reasoning — these tests verify real commit behavior and real RLS-adjacent
// resolution, not the test-only always-rollback helper.
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * M1.4 foundation checkpoint tests (ADR-005): the memberships schema change
 * (nullable organization_id, nullable agency_id, exactly-one-scope CHECK)
 * and get_my_agency_context() — the agency-scoped counterpart to M1.3's
 * get_my_membership_context(), deliberately kept as a separate function
 * rather than overloading that one.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `agency-context-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createAgency(name: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.agencies (name, slug) values ($1, $2) returning id",
      [name, `agency-context-${randomUUID()}`],
    );
    const row = r.rows[0];
    if (!row) throw new Error("agency insert returned no row");
    return row.id;
  });
}

async function roleIdFor(key: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>("select id from public.roles where key = $1", [key]);
    const row = r.rows[0];
    if (!row) throw new Error(`no seeded role for key ${key}`);
    return row.id;
  });
}

/** Directly inserts an agency-scoped membership row — create_agency_with_owner()
 * doesn't exist yet (a later M1.4 step, out of scope for this foundation
 * checkpoint), so fixtures go through the admin bypass, the same way
 * rls-isolation.test.ts's fixtures always have. */
async function seedAgencyMembership(userId: string, agencyId: string, roleKey: string): Promise<void> {
  const roleId = await roleIdFor(roleKey);
  await seedAsAdmin(async (client) => {
    await client.query(
      "insert into public.memberships (user_id, agency_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, agencyId, roleId],
    );
  });
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("existing organization-context path is unaffected (regression)", () => {
  it("an org-only user resolves get_my_membership_context() exactly as before, and get_my_agency_context() returns zero rows", async () => {
    const userId = await createAuthUser("org-only");
    const slug = `agency-ctx-org-${randomUUID()}`;
    await withTenantContext({ userId }, async (client) => {
      await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "Org Only Co",
        slug,
        userId,
      ]);
    });

    const membershipContext = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.get_my_membership_context()");
      return r.rows[0];
    });
    expect(membershipContext.role_key).toBe("org_admin");
    expect(membershipContext.organization_id).toBeTruthy();

    const agencyContext = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.get_my_agency_context()");
      return r.rows;
    });
    expect(agencyContext).toHaveLength(0);
  });
});

describe("pure agency-level users (no organization membership at all)", () => {
  it("a pure agency_owner resolves agency context, and get_my_membership_context() returns zero rows (default_organization_id stays null)", async () => {
    const userId = await createAuthUser("pure-owner");
    const agencyId = await createAgency("Pure Owner Agency");
    await seedAgencyMembership(userId, agencyId, "agency_owner");

    const agencyContext = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.get_my_agency_context()");
      return r.rows[0];
    });
    expect(agencyContext.agency_id).toBe(agencyId);
    expect(agencyContext.role_key).toBe("agency_owner");

    const membershipContext = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.get_my_membership_context()");
      return r.rows;
    });
    expect(membershipContext).toHaveLength(0);

    const defaultOrg = await seedAsAdmin(async (client) => {
      const r = await client.query("select default_organization_id from public.users where id = $1", [
        userId,
      ]);
      return r.rows[0].default_organization_id;
    });
    expect(defaultOrg).toBeNull();
  });

  it("a pure agency_admin resolves agency context the same way", async () => {
    const userId = await createAuthUser("pure-admin");
    const agencyId = await createAgency("Pure Admin Agency");
    await seedAgencyMembership(userId, agencyId, "agency_admin");

    const agencyContext = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.get_my_agency_context()");
      return r.rows[0];
    });
    expect(agencyContext.agency_id).toBe(agencyId);
    expect(agencyContext.role_key).toBe("agency_admin");
  });
});

describe("a user with both an agency-level and an organization-level membership", () => {
  it("resolves each context correctly and independently, never merged or conflated", async () => {
    const userId = await createAuthUser("dual-scope");
    const agencyId = await createAgency("Dual Scope Agency");
    await seedAgencyMembership(userId, agencyId, "agency_owner");

    const slug = `agency-ctx-dual-${randomUUID()}`;
    const orgResult = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "Dual Scope Org",
        slug,
        userId,
      ]);
      return r.rows[0];
    });

    const agencyContext = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.get_my_agency_context()");
      return r.rows[0];
    });
    expect(agencyContext.agency_id).toBe(agencyId);
    expect(agencyContext.role_key).toBe("agency_owner");

    const membershipContext = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.get_my_membership_context()");
      return r.rows[0];
    });
    expect(membershipContext.organization_id).toBe(orgResult.organization_id);
    expect(membershipContext.role_key).toBe("org_admin");

    // Neither call leaked the other scope's identifier into its result.
    expect(agencyContext.organization_id).toBeUndefined();
    expect(membershipContext.agency_id).not.toBe(agencyId);
  });
});

describe("memberships_exactly_one_scope CHECK constraint", () => {
  it("rejects a row with both organization_id and agency_id set", async () => {
    // A fresh user with NO pre-existing membership row at all, and a bare
    // admin-inserted organization (not via create_organization_with_owner(),
    // which would itself create a competing org-scoped membership row) —
    // isolates this test to the CHECK constraint alone, so it can't
    // accidentally instead trip the pre-existing unique(user_id,
    // organization_id) constraint and produce a misleading pass/fail.
    const userId = await createAuthUser("both-set");
    const agencyId = await createAgency("Rejected Both Agency");
    const orgId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.organizations (name, slug) values ($1, $2) returning id",
        ["Rejected Both Org", `agency-ctx-both-${randomUUID()}`],
      );
      const row = r.rows[0];
      if (!row) throw new Error("organization insert returned no row");
      return row.id;
    });
    const roleId = await roleIdFor("org_admin");

    await expect(
      seedAsAdmin(async (client) => {
        await client.query(
          "insert into public.memberships (user_id, organization_id, agency_id, role_id, status) values ($1, $2, $3, $4, 'active')",
          [userId, orgId, agencyId, roleId],
        );
      }),
    ).rejects.toThrow(/memberships_exactly_one_scope/);
  });

  it("rejects a row with neither organization_id nor agency_id set", async () => {
    const userId = await createAuthUser("neither-set");
    const roleId = await roleIdFor("org_admin");

    await expect(
      seedAsAdmin(async (client) => {
        await client.query(
          "insert into public.memberships (user_id, organization_id, agency_id, role_id, status) values ($1, null, null, $2, 'active')",
          [userId, roleId],
        );
      }),
    ).rejects.toThrow(/memberships_exactly_one_scope/);
  });

  it("rejects a duplicate agency membership for the same (user, agency) pair", async () => {
    const userId = await createAuthUser("dup-agency");
    const agencyId = await createAgency("Duplicate Membership Agency");
    await seedAgencyMembership(userId, agencyId, "agency_owner");

    await expect(seedAgencyMembership(userId, agencyId, "agency_admin")).rejects.toThrow(
      /memberships_user_agency_unique/,
    );
  });
});

describe("get_my_agency_context() cannot be spoofed", () => {
  it("ignores an attacker-supplied app.current_agency session value and resolves only the caller's real membership", async () => {
    const userA = await createAuthUser("spoof-real");
    const agencyA = await createAgency("Real Agency A");
    await seedAgencyMembership(userA, agencyA, "agency_owner");

    const agencyB = await createAgency("Attacker-Targeted Agency B");

    // withTenantContext sets app.current_agency from ctx.agencyId — the same
    // session variable current_agency() reads. get_my_agency_context() must
    // ignore it entirely and resolve purely from auth.uid() against the real
    // memberships table, since it takes no parameters at all (see migration
    // 20260807120300).
    const agencyContext = await withTenantContext(
      { userId: userA, agencyId: agencyB },
      async (client) => {
        const r = await client.query("select * from public.get_my_agency_context()");
        return r.rows[0];
      },
    );
    expect(agencyContext.agency_id).toBe(agencyA);
    expect(agencyContext.agency_id).not.toBe(agencyB);
  });
});
