import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
// Deliberately the PRODUCTION helper, not the test-only one from ./helpers
// (which always rolls back by design) — these tests specifically verify
// create_organization_with_owner()'s real commit/rollback behavior, so they
// need the same commit-on-success semantics the actual application uses.
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

// src/pool.ts requires DATABASE_URL to be set (it throws otherwise, rather
// than silently defaulting anywhere — see its own comment on why). Set here,
// before the lazy pool is ever created, to the same well-known local-only
// default helpers.ts hardcodes — never valid against a real project.
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Atomic signup-transaction tests (docs/12-Implementation-Milestones.md M1.3,
 * docs/13-Technical-Design-Review.md M1.3's required failure-injection test).
 * Verifies create_organization_with_owner() (ADR-003, ADR-004) either fully
 * commits (organization + membership both exist) or fully rolls back
 * (neither exists) — never a partial state.
 */

async function createAuthUser(): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `signup-test-${userId}@example.test`,
    ]);
  });
  return userId;
}

afterAll(async () => {
  // Two distinct pools in play here: helpers.ts's adminPool, and src/pool.ts's
  // module-scoped singleton (used internally by withTenantContext) — both
  // must be closed or vitest hangs waiting for open connections to drain.
  await adminPool.end();
  await closePool();
});

describe("create_organization_with_owner: success path", () => {
  let userId: string;

  beforeEach(async () => {
    userId = await createAuthUser();
  });

  it("the auth.users trigger creates a matching public.users row", async () => {
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, email from public.users where id = $1", [userId]);
      return r.rows[0];
    });
    expect(row).toBeTruthy();
    expect(row.id).toBe(userId);
  });

  it("creates exactly one organization and one active org_admin membership", async () => {
    const slug = `signup-flow-${randomUUID()}`;
    const result = await withTenantContext({ userId }, async (client) => {
      const r = await client.query(
        "select * from public.create_organization_with_owner($1, $2, $3)",
        ["Signup Flow Org", slug, userId],
      );
      return r.rows[0];
    });
    expect(result.organization_id).toBeTruthy();
    expect(result.membership_id).toBeTruthy();

    const check = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select o.name, m.status, r.key as role_key
         from public.organizations o
         join public.memberships m on m.organization_id = o.id
         join public.roles r on r.id = m.role_id
         where o.id = $1`,
        [result.organization_id],
      );
      return r.rows;
    });
    expect(check).toHaveLength(1);
    expect(check[0].status).toBe("active");
    expect(check[0].role_key).toBe("org_admin");
  });

  it("get_my_membership_context() resolves the org/agency/role right after signup", async () => {
    const slug = `context-${randomUUID()}`;
    const orgId = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "Context Org",
        slug,
        userId,
      ]);
      return r.rows[0].organization_id;
    });

    const context = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.get_my_membership_context()");
      return r.rows[0];
    });
    expect(context.organization_id).toBe(orgId);
    expect(context.role_key).toBe("org_admin");
  });

  it("get_my_membership_context() returns zero rows for a user with no organization yet", async () => {
    const freshUserId = await createAuthUser();
    const rows = await withTenantContext({ userId: freshUserId }, async (client) => {
      const r = await client.query("select * from public.get_my_membership_context()");
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("create_organization_with_owner: atomicity under failure", () => {
  let userId: string;

  beforeEach(async () => {
    userId = await createAuthUser();
  });

  it("rejects creating an organization on behalf of a different user", async () => {
    const otherUserId = randomUUID();
    const slug = `rejected-${randomUUID()}`;
    await expect(
      withTenantContext({ userId }, async (client) => {
        await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
          "Should Not Exist",
          slug,
          otherUserId, // mismatched — function must reject this
        ]);
      }),
    ).rejects.toThrow(/must match the authenticated caller/);

    const orphan = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.organizations where slug = $1", [slug]);
      return r.rows;
    });
    expect(orphan).toHaveLength(0);
  });

  it("a duplicate slug rolls back the whole transaction — no orphaned organization row", async () => {
    const slug = `duplicate-${randomUUID()}`;

    // First call succeeds and commits for real (withTenantContext commits on
    // success — this is the production helper, not the test-only rollback one).
    await withTenantContext({ userId }, async (client) => {
      await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "First Org",
        slug,
        userId,
      ]);
    });

    const secondUserId = await createAuthUser();

    // Second call reuses the same slug, which violates organizations.slug's
    // unique constraint on the INSERT — the entire function must roll back,
    // not leave a membership row pointing at a half-created organization.
    await expect(
      withTenantContext({ userId: secondUserId }, async (client) => {
        await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
          "Second Org",
          slug,
          secondUserId,
        ]);
      }),
    ).rejects.toThrow();

    const memberships = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.memberships where user_id = $1", [
        secondUserId,
      ]);
      return r.rows;
    });
    expect(memberships).toHaveLength(0);
  });

  it("chaos: a failure AFTER the organization insert (during the membership insert) still rolls back the organization row", async () => {
    // The two tests above both fail before any row is written (auth check) or
    // on the very first insert (duplicate slug) — neither proves the harder
    // case the TDR's failure-injection requirement is actually about: a
    // failure once the transaction is already partway committed-in-progress,
    // with the organization row already inserted. A temporary trigger that
    // unconditionally rejects the *second* insert (membership) forces exactly
    // that ordering, without touching any seeded data other tests in this
    // file depend on (deleting the org_admin role, for instance, is blocked
    // by memberships already committed by earlier tests in this file).
    const slug = `chaos-${randomUUID()}`;
    try {
      await seedAsAdmin(async (client) => {
        await client.query(`
          create or replace function public._chaos_fail_membership_insert()
          returns trigger language plpgsql as $$
          begin
            raise exception 'chaos-injected failure: membership insert';
          end;
          $$;
          create trigger _chaos_membership_trigger
            before insert on public.memberships
            for each row execute function public._chaos_fail_membership_insert();
        `);
      });

      await expect(
        withTenantContext({ userId }, async (client) => {
          await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
            "Chaos Org",
            slug,
            userId,
          ]);
        }),
      ).rejects.toThrow(/chaos-injected failure/);
    } finally {
      await seedAsAdmin(async (client) => {
        await client.query(`
          drop trigger if exists _chaos_membership_trigger on public.memberships;
          drop function if exists public._chaos_fail_membership_insert();
        `);
      });
    }

    // The organization insert happened first and must have been rolled back
    // along with the later membership-insert failure — not left orphaned.
    const orphan = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.organizations where slug = $1", [slug]);
      return r.rows;
    });
    expect(orphan).toHaveLength(0);
  });
});
