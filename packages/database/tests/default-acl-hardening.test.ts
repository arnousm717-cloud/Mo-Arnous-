import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Regression coverage for the default-ACL hardening migration
 * (20260811110000_harden_default_table_privileges.sql), a release-blocking
 * security fix. Two problems this migration closes, both discovered during
 * the default-ACL review that followed the M1.4-M1.7 Cloud migration
 * recovery: (1) anon/authenticated held full CRUD on every table via
 * Cloud's own default ACL, broader than any migration ever declared; (2)
 * a consequence of (1) that was empirically proven ACTIVELY EXPLOITABLE —
 * agency_rollup_organizations (security_invoker = false) let any role
 * holding INSERT on the view bypass organizations' own INSERT policy
 * entirely, since a view's WHERE clause never filters INSERT.
 *
 * These tests run against local's own naturally-clean default ACL (local
 * never had the Cloud-specific over-grant bootstrap in the first place),
 * so they prove the migration's END STATE is correct regardless of what
 * the starting grant state was — matching the migration's own
 * strip-then-regrant design, which is idempotent/self-correcting by
 * construction, not merely a diff against one specific starting point.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `acl-hardening-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createAgencyWithOwner(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
      name,
      `acl-hardening-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.agency_id as string;
}

async function createClientOrg(userId: string, agencyId: string, orgName: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query(
      "select * from public.create_client_organization_for_agency($1, $2, $3, $4)",
      [orgName, `acl-hardening-client-${randomUUID()}`, agencyId, userId],
    );
    return r.rows[0];
  });
  return result.organization_id as string;
}

/**
 * Runs as the raw `anon` Postgres role directly — deliberately not via
 * withTenantContext, which always sets `authenticated` first (there is no
 * legitimate anon session in this codebase's own request-handling code to
 * model, so this is a direct role simulation, same technique used to
 * empirically prove the exploit during the review that preceded this fix).
 * Always rolled back — this must never durably write anything.
 */
async function asAnon<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    await client.query("set local role anon");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("agency_rollup_organizations: INSERT bypass closed (release-blocking finding)", () => {
  it("anon cannot INSERT through the view", async () => {
    await expect(
      asAnon(async (client) => {
        await client.query("insert into public.agency_rollup_organizations (name, slug) values ($1, $2)", [
          "anon-exploit-attempt",
          `anon-exploit-${randomUUID()}`,
        ]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an authenticated caller with zero legitimate agency context cannot INSERT through the view", async () => {
    const userId = await createAuthUser("unauthorized-insert");
    await expect(
      withTenantContext({ userId }, async (client) => {
        await client.query("insert into public.agency_rollup_organizations (name, slug) values ($1, $2)", [
          "unauthorized-exploit-attempt",
          `unauthorized-exploit-${randomUUID()}`,
        ]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("no row reaches organizations from either denied attempt", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select id from public.organizations where name in ('anon-exploit-attempt', 'unauthorized-exploit-attempt')",
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("legitimate SELECT through the view still works for an actual agency_owner", async () => {
    const ownerId = await createAuthUser("legit-select-owner");
    const agencyId = await createAgencyWithOwner(ownerId, "ACL Hardening Legit Agency");
    const clientOrgId = await createClientOrg(ownerId, agencyId, "ACL Hardening Legit Client");

    const rows = await withTenantContext(
      { userId: ownerId, agencyId, roleKey: "agency_owner" },
      async (client) => {
        const r = await client.query("select id, name from public.agency_rollup_organizations");
        return r.rows;
      },
    );
    expect(rows.map((r) => r.id)).toContain(clientOrgId);
  });
});

describe("base-table RLS behavior unchanged by the grant fix", () => {
  it("an authenticated caller updating a row outside their org still affects 0 rows (not a permission error) — proves the grant itself is intact, RLS is still what's doing the filtering", async () => {
    const ownerA = await createAuthUser("rls-unchanged-a");
    const orgA = await withTenantContext({ userId: ownerA }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "ACL Hardening RLS Org A",
        `acl-hardening-rls-a-${randomUUID()}`,
        ownerA,
      ]);
      return r.rows[0].organization_id as string;
    });
    const ownerB = await createAuthUser("rls-unchanged-b");
    const orgB = await withTenantContext({ userId: ownerB }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "ACL Hardening RLS Org B",
        `acl-hardening-rls-b-${randomUUID()}`,
        ownerB,
      ]);
      return r.rows[0].organization_id as string;
    });

    const rowCount = await withTenantContext(
      { userId: ownerA, organizationId: orgA },
      async (client) => {
        const r = await client.query("update public.organizations set name = 'hacked' where id = $1", [orgB]);
        return r.rowCount;
      },
    );
    expect(rowCount).toBe(0);
  });
});

describe("api_keys: SELECT allowed, INSERT denied at the grant level", () => {
  it("an org_admin can SELECT their own org's api_keys", async () => {
    const userId = await createAuthUser("apikeys-select-allowed");
    const organizationId = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "ACL Hardening API Keys Org",
        `acl-hardening-apikeys-${randomUUID()}`,
        userId,
      ]);
      return r.rows[0].organization_id as string;
    });

    const rows = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("select id from public.api_keys where organization_id = $1", [
          organizationId,
        ]);
        return r.rows;
      },
    );
    expect(rows).toEqual([]); // no keys seeded — the point is the SELECT itself doesn't error
  });

  it("an ordinary session cannot INSERT into api_keys — permission denied at the grant level", async () => {
    const userId = await createAuthUser("apikeys-insert-denied");
    const organizationId = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "ACL Hardening API Keys Deny Org",
        `acl-hardening-apikeys-deny-${randomUUID()}`,
        userId,
      ]);
      return r.rows[0].organization_id as string;
    });

    await expect(
      withTenantContext({ userId, organizationId, roleKey: "org_admin" }, async (client) => {
        await client.query(
          "insert into public.api_keys (organization_id, name, key_hash, key_prefix) values ($1, 'x', 'y', 'arev_test_')",
          [organizationId],
        );
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("future tables inherit zero anon/authenticated privileges", () => {
  it("a simulated future-migration table gets no grants for either role", async () => {
    await seedAsAdmin(async (client) => {
      await client.query("create table public._acl_hardening_future_probe (id uuid primary key default gen_random_uuid())");
    });
    try {
      const rows = await seedAsAdmin(async (client) => {
        const r = await client.query(
          `select grantee, privilege_type from information_schema.role_table_grants
           where table_schema = 'public' and table_name = '_acl_hardening_future_probe'
             and grantee in ('anon', 'authenticated')`,
        );
        return r.rows;
      });
      expect(rows, JSON.stringify(rows, null, 2)).toEqual([]);
    } finally {
      await seedAsAdmin(async (client) => {
        await client.query("drop table public._acl_hardening_future_probe");
      });
    }
  });
});

describe("exact privilege matrix matches the intended repository grants", () => {
  it("anon has zero grants on every table in the public schema", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select table_name, privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and grantee = 'anon'`,
      );
      return r.rows;
    });
    expect(rows, JSON.stringify(rows, null, 2)).toEqual([]);
  });

  it("authenticated's grants match the declared matrix exactly, table by table", async () => {
    const expected: Record<string, string[]> = {
      roles: ["SELECT"],
      agencies: ["SELECT"],
      organizations: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      users: ["INSERT", "SELECT", "UPDATE"],
      memberships: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      agency_rollup_organizations: ["SELECT"],
      custom_domains: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      brand_themes: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      consent_records: ["INSERT", "SELECT"],
      data_subject_requests: ["INSERT", "SELECT", "UPDATE"],
      audit_logs: ["INSERT", "SELECT"],
      data_retention_policies: ["SELECT"],
      data_subject_request_breaches: ["SELECT"],
      api_keys: ["SELECT"],
      events: [],
      event_deliveries: [],
      webhook_events_seen: [],
    };

    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and grantee = 'authenticated'
           and table_name = any($1::text[])`,
        [Object.keys(expected)],
      );
      return r.rows;
    });

    const actual: Record<string, string[]> = {};
    for (const table of Object.keys(expected)) actual[table] = [];
    for (const row of rows) {
      actual[row.table_name]?.push(row.privilege_type);
    }
    for (const table of Object.keys(expected)) {
      actual[table]?.sort();
    }

    expect(actual).toEqual(expected);
  });
});
