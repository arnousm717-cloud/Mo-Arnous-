import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";

/**
 * RLS isolation suite (docs/10-CLAUDE.md §5, docs/13-Technical-Design-Review.md M1.2).
 * The single most important test category on this platform: a bug here means
 * one tenant can read or write another tenant's data. Runs against a real
 * local Postgres instance — never mocked.
 */

interface Fixture {
  agencyAId: string;
  orgAId: string;
  userAId: string;
  orgBId: string;
  userBId: string;
  orgAdminRoleId: string;
}

let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgAdminRole = await client.query<{ id: string }>(
      "select id from public.roles where key = 'org_admin'",
    );
    const orgAdminRoleId = orgAdminRole.rows[0]!.id;

    const agencyA = await client.query<{ id: string }>(
      "insert into public.agencies (name, slug) values ('Agency A', $1) returning id",
      [`agency-a-${randomUUID()}`],
    );

    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug, agency_id) values ('Org A', $1, $2) returning id",
      [`org-a-${randomUUID()}`, agencyA.rows[0]!.id],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Org B', $1) returning id",
      [`org-b-${randomUUID()}`],
    );

    const userAId = randomUUID();
    const userBId = randomUUID();
    await client.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [
      userAId,
      `user-a-${userAId}@example.test`,
      userBId,
      `user-b-${userBId}@example.test`,
    ]);
    await client.query(
      "insert into public.users (id, email) values ($1, $2), ($3, $4)",
      [userAId, `user-a-${userAId}@example.test`, userBId, `user-b-${userBId}@example.test`],
    );

    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
      [userAId, orgA.rows[0]!.id, orgAdminRoleId],
    );
    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
      [userBId, orgB.rows[0]!.id, orgAdminRoleId],
    );

    return {
      agencyAId: agencyA.rows[0]!.id,
      orgAId: orgA.rows[0]!.id,
      userAId,
      orgBId: orgB.rows[0]!.id,
      userBId,
      orgAdminRoleId,
    };
  });
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedFixture();
});

afterEach(async () => {
  // withTenantContext always rolls back its own transaction, so fixtures
  // persist across tests within this file — nothing to reset here.
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
});

describe("current_org() / current_agency() / current_role_key()", () => {
  it("return null when no session context is set", async () => {
    const result = await withTenantContext({}, async (client) => {
      const r = await client.query(
        "select current_org() as org, current_agency() as agency, current_role_key() as role",
      );
      return r.rows[0];
    });
    expect(result.org).toBeNull();
    expect(result.agency).toBeNull();
    expect(result.role).toBeNull();
  });

  it("return the configured value once set_config runs", async () => {
    const result = await withTenantContext(
      { organizationId: fx.orgAId, agencyId: fx.agencyAId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "select current_org() as org, current_agency() as agency, current_role_key() as role",
        );
        return r.rows[0];
      },
    );
    expect(result.org).toBe(fx.orgAId);
    expect(result.agency).toBe(fx.agencyAId);
    expect(result.role).toBe("org_admin");
  });

  it("does not leak a value set in a different connection/transaction (proxy for pooled-connection reuse)", async () => {
    // Simulates two different requests sharing a pooled connection sequentially —
    // the first request's tenant context must never bleed into the second's.
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select current_org() as org");
      expect(r.rows[0].org).toBe(fx.orgAId);
    });
    // A fresh withTenantContext call is a fresh connection+transaction, exactly
    // like a new pooled request. With no context set, it must read back null,
    // not the previous test's org id.
    await withTenantContext({}, async (client) => {
      const r = await client.query("select current_org() as org");
      expect(r.rows[0].org).toBeNull();
    });
  });
});

describe("organizations: cross-tenant isolation", () => {
  it("a member of org A can select org A", async () => {
    const rows = await withTenantContext(
      { organizationId: fx.orgAId, userId: fx.userAId },
      async (client) => {
        const r = await client.query("select id from public.organizations where id = $1", [fx.orgAId]);
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
  });

  it("a member of org A cannot select org B — the core isolation guarantee", async () => {
    const rows = await withTenantContext(
      { organizationId: fx.orgAId, userId: fx.userAId },
      async (client) => {
        const r = await client.query("select id from public.organizations where id = $1", [fx.orgBId]);
        return r.rows;
      },
    );
    expect(rows).toHaveLength(0);
  });

  it("a member of org A cannot update org B's row", async () => {
    const rowCount = await withTenantContext(
      { organizationId: fx.orgAId, userId: fx.userAId },
      async (client) => {
        const r = await client.query("update public.organizations set name = 'hacked' where id = $1", [
          fx.orgBId,
        ]);
        return r.rowCount;
      },
    );
    expect(rowCount).toBe(0);

    // Confirm org B's name was genuinely untouched, verified as admin.
    const check = await seedAsAdmin(async (client) => {
      const r = await client.query("select name from public.organizations where id = $1", [fx.orgBId]);
      return r.rows[0]?.name;
    });
    expect(check).toBe("Org B");
  });

  it("any authenticated user can insert a new organization (bootstrapping case — no current_org required)", async () => {
    // Deliberately no RETURNING here: Postgres requires the SELECT policy to
    // also pass for INSERT...RETURNING (reading the row back is a read), and
    // a brand-new org's id can never satisfy id = current_org() yet — that's
    // exactly the bootstrapping gap this policy exists to bridge. This means
    // M1.3's atomic signup transaction cannot be a plain client-issued INSERT
    // if it needs the new id back; it needs a SECURITY DEFINER function that
    // creates the org and its first membership together and returns the id
    // from a privileged context, not a client-facing INSERT...RETURNING.
    // withTenantContext always rolls back (by design, so tests never leave
    // residue), so success here is judged by rowCount alone: a policy denial
    // throws ("new row violates row-level security policy"), it doesn't
    // silently return 0 — there is nothing to additionally verify from a
    // separate connection, since the insert is never meant to be committed.
    const newOrgSlug = `bootstrap-${randomUUID()}`;
    const rowCount = await withTenantContext({ userId: fx.userAId }, async (client) => {
      const r = await client.query(
        "insert into public.organizations (name, slug) values ('Bootstrapped Org', $1)",
        [newOrgSlug],
      );
      return r.rowCount;
    });
    expect(rowCount).toBe(1);
  });

  it("an unauthenticated context (no role set beyond anon-equivalent) cannot select any organization", async () => {
    const rows = await withTenantContext({}, async (client) => {
      const r = await client.query("select id from public.organizations where id in ($1, $2)", [
        fx.orgAId,
        fx.orgBId,
      ]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("memberships: cross-tenant isolation", () => {
  it("org A's context sees org A's memberships, not org B's", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select organization_id from public.memberships");
      return r.rows;
    });
    expect(rows.every((r: { organization_id: string }) => r.organization_id === fx.orgAId)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("org B's context never sees org A's membership rows", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgBId }, async (client) => {
      const r = await client.query("select organization_id from public.memberships where organization_id = $1", [
        fx.orgAId,
      ]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("users: self-scoping (not organization-scoped)", () => {
  it("a user can select their own row", async () => {
    const rows = await withTenantContext({ userId: fx.userAId }, async (client) => {
      const r = await client.query("select id from public.users where id = $1", [fx.userAId]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it("a user cannot select another user's row", async () => {
    const rows = await withTenantContext({ userId: fx.userAId }, async (client) => {
      const r = await client.query("select id from public.users where id = $1", [fx.userBId]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("roles: readable by any authenticated caller, not writable via RLS", () => {
  it("an authenticated caller with no tenant context can still read the role list", async () => {
    const rows = await withTenantContext({}, async (client) => {
      const r = await client.query("select key from public.roles");
      return r.rows;
    });
    expect(rows.length).toBe(6);
  });

  it("an authenticated caller cannot modify an existing role — no UPDATE grant exists at all, stronger than an RLS-only denial", async () => {
    // Deliberately not an insert: inserting a bogus key would be blocked by the
    // CHECK constraint regardless of RLS, which would make this test pass for
    // the wrong reason. Updating an existing, valid row isolates the actual
    // authorization layer being tested — here, that's the table grant itself
    // (no UPDATE privilege given to `authenticated` at all), which throws
    // rather than silently affecting zero rows the way an RLS-only denial would.
    await expect(
      withTenantContext({}, async (client) => {
        await client.query("update public.roles set description = 'tampered' where key = 'org_admin'");
      }),
    ).rejects.toThrow(/permission denied/);

    const check = await seedAsAdmin(async (client) => {
      const r = await client.query("select description from public.roles where key = 'org_admin'");
      return r.rows[0]?.description;
    });
    expect(check).not.toBe("tampered");
  });
});
