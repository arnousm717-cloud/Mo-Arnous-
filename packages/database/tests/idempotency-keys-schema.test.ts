import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.1F-A schema/RLS coverage for public.idempotency_keys.
 * Mirrors companies-contacts-rls.test.ts's style: real Postgres, org A vs
 * org B, direct information_schema/pg_policies checks rather than trusting
 * "should be scoped" without proof.
 */

interface OrgFixture {
  organizationId: string;
  userId: string;
}

async function createOrgWithMember(): Promise<OrgFixture> {
  return seedAsAdmin(async (client) => {
    const userId = randomUUID();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `idem-schema-${userId}@example.test`,
    ]);
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      ["Idempotency Schema Test Org", `idem-schema-org-${randomUUID()}`],
    );
    const organizationId = org.rows[0]!.id;
    const role = await client.query<{ id: string }>("select id from public.roles where key = 'org_admin'");
    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, organizationId, role.rows[0]!.id],
    );
    return { organizationId, userId };
  });
}

async function insertRow(organizationId: string, keyHash = randomUUID()): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      `insert into public.idempotency_keys
         (organization_id, idempotency_key_hash, method, route, request_fingerprint, expires_at)
       values ($1, $2, 'POST', '/api/v1/companies', 'fp', now() + interval '24 hours')
       returning id`,
      [organizationId, keyHash],
    );
    return r.rows[0]!.id;
  });
}

/** Runs as the raw `anon` Postgres role, always rolled back. */
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

describe("public.idempotency_keys: table and constraints exist as designed", () => {
  it("the table exists with the required columns", async () => {
    const columns = await seedAsAdmin(async (client) => {
      const r = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'idempotency_keys'`,
      );
      return r.rows.map((row) => row.column_name).sort();
    });
    expect(columns).toEqual(
      [
        "id",
        "organization_id",
        "idempotency_key_hash",
        "method",
        "route",
        "request_fingerprint",
        "status",
        "response_status",
        "response_body",
        "created_at",
        "expires_at",
      ].sort(),
    );
  });

  it("uniqueness is per (organization_id, idempotency_key_hash) — the same hash is rejected within one org", async () => {
    const org = await createOrgWithMember();
    const sharedHash = randomUUID();
    await insertRow(org.organizationId, sharedHash);
    await expect(insertRow(org.organizationId, sharedHash)).rejects.toThrow(/duplicate key/i);
  });

  it("the same key hash is allowed across two different organizations", async () => {
    const orgA = await createOrgWithMember();
    const orgB = await createOrgWithMember();
    const sharedHash = randomUUID();
    await expect(insertRow(orgA.organizationId, sharedHash)).resolves.toBeTruthy();
    await expect(insertRow(orgB.organizationId, sharedHash)).resolves.toBeTruthy();
  });

  it("status is constrained to 'in_progress' or 'completed'", async () => {
    const org = await createOrgWithMember();
    await expect(
      seedAsAdmin(async (client) => {
        await client.query(
          `insert into public.idempotency_keys
             (organization_id, idempotency_key_hash, method, route, request_fingerprint, expires_at, status)
           values ($1, $2, 'POST', '/api/v1/companies', 'fp', now() + interval '24 hours', 'bogus')`,
          [org.organizationId, randomUUID()],
        );
      }),
    ).rejects.toThrow(/violates check constraint/i);
  });
});

describe("public.idempotency_keys: RLS isolation", () => {
  it("Org A cannot read Org B's idempotency row", async () => {
    const orgA = await createOrgWithMember();
    const orgB = await createOrgWithMember();
    const rowIdB = await insertRow(orgB.organizationId);

    const rows = await withTenantContext(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("select id from public.idempotency_keys where id = $1", [rowIdB]);
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("Org A can read its own idempotency row", async () => {
    const org = await createOrgWithMember();
    const rowId = await insertRow(org.organizationId);

    const rows = await withTenantContext(
      { userId: org.userId, organizationId: org.organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("select id from public.idempotency_keys where id = $1", [rowId]);
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
  });

  it("Org A cannot update Org B's idempotency row", async () => {
    const orgA = await createOrgWithMember();
    const orgB = await createOrgWithMember();
    const rowIdB = await insertRow(orgB.organizationId);

    const rowCount = await withTenantContext(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("update public.idempotency_keys set status = 'completed' where id = $1", [
          rowIdB,
        ]);
        return r.rowCount;
      },
    );
    expect(rowCount).toBe(0);
  });

  it("Org A cannot delete Org B's idempotency row", async () => {
    const orgA = await createOrgWithMember();
    const orgB = await createOrgWithMember();
    const rowIdB = await insertRow(orgB.organizationId);

    const rowCount = await withTenantContext(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("delete from public.idempotency_keys where id = $1", [rowIdB]);
        return r.rowCount;
      },
    );
    expect(rowCount).toBe(0);

    const stillThere = await seedAsAdmin(async (client) => {
      const r = await client.query("select 1 from public.idempotency_keys where id = $1", [rowIdB]);
      return r.rows;
    });
    expect(stillThere).toHaveLength(1);
  });
});

describe("public.idempotency_keys: grants", () => {
  it("anon has zero privileges on the table", async () => {
    await expect(
      asAnon(async (client) => {
        await client.query("select 1 from public.idempotency_keys limit 1");
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("authenticated has exactly SELECT, INSERT, UPDATE, DELETE — matching the approved grant list", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'idempotency_keys' and grantee = 'authenticated'`,
      );
      return r.rows.map((row) => row.privilege_type).sort();
    });
    expect(rows).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });

  it("anon has zero grants of any kind on the table", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'idempotency_keys' and grantee = 'anon'`,
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });
});
