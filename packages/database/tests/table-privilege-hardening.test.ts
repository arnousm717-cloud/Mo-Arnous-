import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Regression test for a platform-wide security fix discovered during M1.7's
 * mandated security review (not part of M1.7's own feature scope — a gap
 * present on every table since M1.2). The Supabase CLI's local bootstrap
 * applies a default ACL granting TRUNCATE/REFERENCES/TRIGGER on every new
 * table to `authenticated`/`anon`. RLS does not filter TRUNCATE at all —
 * a role with TRUNCATE granted can wipe an entire tenant-scoped table
 * regardless of any RLS policy, with no per-row scoping possible. Fixed by
 * migration 20260811100000_revoke_dangerous_default_table_privileges.sql,
 * which both revokes the existing grants and corrects the default ACL so
 * future migrations' tables don't reacquire them. This test exists so a
 * future `supabase db reset` against a differently-configured Supabase
 * instance (or a Supabase CLI version change altering its own defaults)
 * cannot silently reintroduce this without a test failing.
 */

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("no table grants TRUNCATE/REFERENCES/TRIGGER to authenticated or anon", () => {
  it("information_schema shows zero such grants across the entire public schema", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select table_name, grantee, privilege_type
         from information_schema.role_table_grants
         where table_schema = 'public'
           and grantee in ('authenticated', 'anon')
           and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')`,
      );
      return r.rows;
    });
    expect(rows, JSON.stringify(rows, null, 2)).toEqual([]);
  });

  it("a table created by a future migration (simulated) does not inherit these grants either — the default ACL itself is fixed, not just existing tables", async () => {
    await seedAsAdmin(async (client) => {
      await client.query("create table public._privilege_hardening_probe (id uuid primary key default gen_random_uuid())");
    });
    try {
      const rows = await seedAsAdmin(async (client) => {
        const r = await client.query(
          `select grantee, privilege_type from information_schema.role_table_grants
           where table_schema = 'public' and table_name = '_privilege_hardening_probe'
             and grantee in ('authenticated', 'anon')`,
        );
        return r.rows;
      });
      expect(rows, JSON.stringify(rows, null, 2)).toEqual([]);
    } finally {
      await seedAsAdmin(async (client) => {
        await client.query("drop table public._privilege_hardening_probe");
      });
    }
  });

  it("an authenticated session genuinely cannot TRUNCATE a real tenant table (permission denied, not merely discouraged)", async () => {
    await expect(
      withTenantContext({}, async (client) => {
        await client.query("truncate public.consent_records");
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
