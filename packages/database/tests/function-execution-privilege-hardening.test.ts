import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Regression coverage for 20260812140000_harden_function_execution_privileges.sql,
 * a release-blocking security fix closing two independent, systemic root
 * causes found during the Milestone 2.1C staging verification and the
 * subsequent repository-wide function-privilege audit:
 *
 * ROOT CAUSE 1 — every function in this schema had EXECUTE granted to
 * PUBLIC by default (PostgreSQL's own compiled-in default for CREATE
 * FUNCTION, never once revoked in this repository's history), including
 * the two private helpers whose own doc comments falsely claimed they were
 * "not granted to authenticated."
 *
 * ROOT CAUSE 2 — every caller-identity guard of the shape
 * `p_caller_user_id is null or p_caller_user_id <> auth.uid()` is
 * NULL-unsafe: `<>` against a NULL auth.uid() (the anon/unauthenticated
 * case) evaluates to NULL, and PL/pgSQL's IF treats a NULL condition as
 * "do not raise" — so an unauthenticated caller supplying any non-null id
 * parameter impersonated that id. Mirrors the exact style of
 * default-acl-hardening.test.ts / table-privilege-hardening.test.ts: real
 * Postgres, real role simulation, never mocked.
 */

const PRIVATE_HELPERS = ["_validate_user_erasure", "_validate_contact_erasure"] as const;

const AUTHENTICATED_ONLY_RPCS = [
  "create_organization_with_owner",
  "create_agency_with_owner",
  "create_client_organization_for_agency",
  "preview_user_erasure",
  "execute_user_erasure",
  "preview_contact_erasure",
  "execute_contact_erasure",
] as const;

/** Dummy args matching each RPC's real signature, so anon's call fails on the
 * grant (permission denied) rather than on function overload resolution
 * ("function does not exist") — Postgres resolves overloads before checking
 * privileges, so a wrong arg count would give a false-positive-looking
 * rejection for the wrong reason. */
function dummyArgsFor(fnName: (typeof AUTHENTICATED_ONLY_RPCS)[number]): unknown[] {
  switch (fnName) {
    case "create_organization_with_owner":
    case "create_agency_with_owner":
      return [randomUUID(), randomUUID(), randomUUID()];
    case "create_client_organization_for_agency":
      return [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    case "preview_user_erasure":
    case "execute_user_erasure":
    case "preview_contact_erasure":
    case "execute_contact_erasure":
      return [randomUUID(), randomUUID()];
  }
}

const RLS_SUPPORT_FUNCTIONS = [
  "current_org",
  "current_agency",
  "current_role_key",
  "get_my_membership_context",
  "get_my_agency_context",
] as const;

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `fn-priv-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function userExists(userId: string): Promise<boolean> {
  const rows = await seedAsAdmin(async (client) => {
    const r = await client.query("select 1 from auth.users where id = $1", [userId]);
    return r.rows;
  });
  return rows.length > 0;
}

/** Runs as the raw `anon` Postgres role directly, always rolled back. */
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

/**
 * Runs as `authenticated` with request.jwt.claims explicitly missing a
 * `sub` — auth.uid() resolves NULL exactly as it does for a genuinely
 * unauthenticated request that still somehow reaches an authenticated-
 * grade connection (the precise precondition the NULL-unsafe guard bug
 * required). Equivalent to withTenantContext({}, fn) since userId is
 * optional there, but named explicitly here so every exploit test states
 * its precondition in the test body rather than relying on an implicit
 * default.
 */
async function asAuthenticatedNoIdentity<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  return withTenantContext({}, fn);
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("private helpers: never callable directly by anon or authenticated", () => {
  for (const fnName of PRIVATE_HELPERS) {
    it(`anon cannot execute ${fnName}`, async () => {
      await expect(
        asAnon(async (client) => {
          await client.query(`select public.${fnName}($1, $2)`, [randomUUID(), randomUUID()]);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it(`authenticated cannot execute ${fnName}`, async () => {
      await expect(
        withTenantContext({ userId: randomUUID() }, async (client) => {
          await client.query(`select public.${fnName}($1, $2)`, [randomUUID(), randomUUID()]);
        }),
      ).rejects.toThrow(/permission denied/i);
    });
  }
});

describe("authenticated-only RPCs: anon denied at the grant level, authenticated allowed", () => {
  for (const fnName of AUTHENTICATED_ONLY_RPCS) {
    it(`anon cannot execute ${fnName} (rejected before any guard logic runs)`, async () => {
      const args = dummyArgsFor(fnName);
      const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
      await expect(
        asAnon(async (client) => {
          await client.query(`select public.${fnName}(${placeholders})`, args);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it(`authenticated has EXECUTE on ${fnName} (grant preserved by CREATE OR REPLACE)`, async () => {
      const granted = await seedAsAdmin(async (client) => {
        const r = await client.query<{ x: boolean }>(
          `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as x
           from pg_proc p where p.proname = $1`,
          [fnName],
        );
        return r.rows[0]?.x;
      });
      expect(granted).toBe(true);
    });
  }
});

describe("RLS-support functions: anon denied, authenticated allowed (no explicit grant existed pre-fix)", () => {
  for (const fnName of RLS_SUPPORT_FUNCTIONS) {
    it(`anon cannot execute ${fnName}`, async () => {
      await expect(
        asAnon(async (client) => {
          await client.query(`select public.${fnName}()`);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it(`authenticated can execute ${fnName} without error`, async () => {
      await expect(
        withTenantContext({}, async (client) => {
          await client.query(`select public.${fnName}()`);
        }),
      ).resolves.not.toThrow();
    });
  }
});

describe("future functions inherit zero PUBLIC/anon/authenticated execute by default", () => {
  it("a simulated future-migration function gets no grants for either role", async () => {
    await seedAsAdmin(async (client) => {
      await client.query(
        "create function public._fn_priv_hardening_future_probe() returns void language sql as $$ select 1 $$",
      );
    });
    try {
      const result = await seedAsAdmin(async (client) => {
        const r = await client.query<{ anon: boolean; authenticated: boolean }>(
          `select
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
           from pg_proc p where p.proname = '_fn_priv_hardening_future_probe'`,
        );
        return r.rows[0];
      });
      expect(result).toEqual({ anon: false, authenticated: false });
    } finally {
      await seedAsAdmin(async (client) => {
        await client.query("drop function public._fn_priv_hardening_future_probe()");
      });
    }
  });
});

describe("exact function privilege matrix matches the intended repository grants", () => {
  it("anon has zero EXECUTE on every function this migration touches", async () => {
    const allFns = [...PRIVATE_HELPERS, ...AUTHENTICATED_ONLY_RPCS, ...RLS_SUPPORT_FUNCTIONS];
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ proname: string }>(
        `select p.proname from pg_proc p
         where p.proname = any($1::text[])
           and has_function_privilege('anon', p.oid, 'EXECUTE')`,
        [allFns],
      );
      return r.rows;
    });
    expect(rows, JSON.stringify(rows, null, 2)).toEqual([]);
  });

  it("authenticated's EXECUTE grants match the declared matrix exactly", async () => {
    const expected: Record<string, boolean> = {};
    for (const fn of PRIVATE_HELPERS) expected[fn] = false;
    for (const fn of AUTHENTICATED_ONLY_RPCS) expected[fn] = true;
    for (const fn of RLS_SUPPORT_FUNCTIONS) expected[fn] = true;

    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ proname: string; x: boolean }>(
        `select p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = any($1::text[])`,
        [Object.keys(expected)],
      );
      return r.rows;
    });

    const actual: Record<string, boolean> = {};
    for (const row of rows) actual[row.proname] = row.x;
    expect(actual).toEqual(expected);
  });
});

describe("NULL-auth impersonation exploit regression: create_organization_with_owner", () => {
  it("an unauthenticated caller supplying a real user's id can no longer create an org on their behalf", async () => {
    const victim = await createAuthUser("create-org-victim");
    const orgName = `NULL-Auth Exploit Org ${randomUUID()}`;

    await expect(
      asAuthenticatedNoIdentity(async (client) => {
        await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
          orgName,
          `null-auth-exploit-${randomUUID()}`,
          victim,
        ]);
      }),
    ).rejects.toThrow(/p_user_id must match the authenticated caller/i);

    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.organizations where name = $1", [orgName]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("an unauthenticated caller supplying an arbitrary non-existent id is also rejected (not merely a foreign-key failure)", async () => {
    await expect(
      asAuthenticatedNoIdentity(async (client) => {
        await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
          "Should Never Exist",
          `null-auth-exploit-nonexistent-${randomUUID()}`,
          randomUUID(),
        ]);
      }),
    ).rejects.toThrow(/p_user_id must match the authenticated caller/i);
  });
});

describe("NULL-auth impersonation exploit regression: create_agency_with_owner", () => {
  it("an unauthenticated caller supplying a real user's id can no longer create an agency on their behalf", async () => {
    const victim = await createAuthUser("create-agency-victim");
    const agencyName = `NULL-Auth Exploit Agency ${randomUUID()}`;

    await expect(
      asAuthenticatedNoIdentity(async (client) => {
        await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
          agencyName,
          `null-auth-exploit-agency-${randomUUID()}`,
          victim,
        ]);
      }),
    ).rejects.toThrow(/p_user_id must match the authenticated caller/i);

    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.agencies where name = $1", [agencyName]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("NULL-auth impersonation exploit regression: create_client_organization_for_agency", () => {
  it("an unauthenticated caller impersonating a real agency_owner can no longer create a client org under their agency", async () => {
    const owner = await createAuthUser("client-org-owner");
    const agencyId = await withTenantContext({ userId: owner }, async (client) => {
      const r = await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
        "NULL-Auth Client Org Test Agency",
        `null-auth-client-agency-${randomUUID()}`,
        owner,
      ]);
      return r.rows[0].agency_id as string;
    });

    const orgName = `NULL-Auth Exploit Client Org ${randomUUID()}`;
    await expect(
      asAuthenticatedNoIdentity(async (client) => {
        await client.query("select * from public.create_client_organization_for_agency($1, $2, $3, $4)", [
          orgName,
          `null-auth-client-org-${randomUUID()}`,
          agencyId,
          owner,
        ]);
      }),
    ).rejects.toThrow(/p_user_id must match the authenticated caller/i);

    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.organizations where name = $1", [orgName]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("NULL-auth impersonation exploit regression: user erasure (preview + execute)", () => {
  async function seedErasureFixture() {
    const admin = await createAuthUser("user-erasure-admin");
    const secondAdmin = await createAuthUser("user-erasure-second-admin");
    const target = await createAuthUser("user-erasure-target");

    // Built via direct SQL inserts under seedAsAdmin (a real, committed
    // transaction), not the create_organization_with_owner RPC under
    // withTenantContext — withTenantContext always rolls back its own
    // transaction, so a row created there is invisible to the separate,
    // later seedAsAdmin calls below (the exact test-methodology bug fixed
    // during Milestone 2.1B).
    const { orgId, dsrId } = await seedAsAdmin(async (client) => {
      const org = await client.query<{ id: string }>(
        "insert into public.organizations (name, slug) values ($1, $2) returning id",
        ["NULL-Auth User Erasure Org", `null-auth-user-erasure-${randomUUID()}`],
      );
      const orgId = org.rows[0]!.id;

      const adminRole = await client.query<{ id: string }>("select id from public.roles where key = 'org_admin'");
      // Two org_admins so the target is never the sole admin — isolates the
      // guard-bypass regression from the unrelated sole-admin blocker.
      await client.query(
        "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
        [admin, orgId, adminRole.rows[0]!.id],
      );
      await client.query(
        "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
        [secondAdmin, orgId, adminRole.rows[0]!.id],
      );
      const memberRole = await client.query<{ id: string }>("select id from public.roles where key = 'org_member'");
      await client.query(
        "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
        [target, orgId, memberRole.rows[0]!.id],
      );

      const dsr = await client.query<{ id: string }>(
        `insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type)
         values ($1, 'user', $2, 'delete') returning id`,
        [orgId, target],
      );
      return { orgId, dsrId: dsr.rows[0]!.id };
    });

    return { admin, target, orgId, dsrId };
  }

  it("preview_user_erasure rejects an unauthenticated caller impersonating a real org_admin", async () => {
    const { admin, dsrId } = await seedErasureFixture();

    await expect(
      asAuthenticatedNoIdentity(async (client) => {
        await client.query("select * from public.preview_user_erasure($1, $2)", [dsrId, admin]);
      }),
    ).rejects.toThrow(/p_caller_user_id must match the authenticated caller/i);
  });

  it("execute_user_erasure rejects an unauthenticated caller impersonating a real org_admin, and the target user survives", async () => {
    const { admin, target, dsrId } = await seedErasureFixture();

    await expect(
      asAuthenticatedNoIdentity(async (client) => {
        await client.query("select * from public.execute_user_erasure($1, $2)", [dsrId, admin]);
      }),
    ).rejects.toThrow(/p_caller_user_id must match the authenticated caller/i);

    expect(await userExists(target)).toBe(true);

    const status = await seedAsAdmin(async (client) => {
      const r = await client.query("select status from public.data_subject_requests where id = $1", [dsrId]);
      return r.rows[0]?.status;
    });
    expect(status).toBe("pending");
  });
});

describe("NULL-auth impersonation exploit regression: contact erasure (preview + execute)", () => {
  async function seedContactErasureFixture() {
    const admin = await createAuthUser("contact-erasure-admin");

    // Direct SQL inserts under one seedAsAdmin call (real, committed
    // transaction) — see seedErasureFixture above for why withTenantContext
    // cannot be used for fixture setup here.
    const { contactId, dsrId } = await seedAsAdmin(async (client) => {
      const org = await client.query<{ id: string }>(
        "insert into public.organizations (name, slug) values ($1, $2) returning id",
        ["NULL-Auth Contact Erasure Org", `null-auth-contact-erasure-${randomUUID()}`],
      );
      const orgId = org.rows[0]!.id;

      const adminRole = await client.query<{ id: string }>("select id from public.roles where key = 'org_admin'");
      await client.query(
        "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
        [admin, orgId, adminRole.rows[0]!.id],
      );

      const contact = await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, first_name) values ($1, 'NULL-Auth Exploit Target') returning id",
        [orgId],
      );
      const contactId = contact.rows[0]!.id;

      const dsr = await client.query<{ id: string }>(
        `insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type)
         values ($1, 'contact', $2, 'delete') returning id`,
        [orgId, contactId],
      );
      return { orgId, contactId, dsrId: dsr.rows[0]!.id };
    });

    return { admin, contactId, dsrId };
  }

  it("preview_contact_erasure rejects an unauthenticated caller impersonating a real org_admin", async () => {
    const { admin, dsrId } = await seedContactErasureFixture();

    await expect(
      asAuthenticatedNoIdentity(async (client) => {
        await client.query("select * from public.preview_contact_erasure($1, $2)", [dsrId, admin]);
      }),
    ).rejects.toThrow(/p_caller_user_id must match the authenticated caller/i);
  });

  it("execute_contact_erasure rejects an unauthenticated caller impersonating a real org_admin, and the contact survives", async () => {
    const { admin, contactId, dsrId } = await seedContactErasureFixture();

    await expect(
      asAuthenticatedNoIdentity(async (client) => {
        await client.query("select * from public.execute_contact_erasure($1, $2)", [dsrId, admin]);
      }),
    ).rejects.toThrow(/p_caller_user_id must match the authenticated caller/i);

    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.contacts where id = $1", [contactId]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);

    const status = await seedAsAdmin(async (client) => {
      const r = await client.query("select status from public.data_subject_requests where id = $1", [dsrId]);
      return r.rows[0]?.status;
    });
    expect(status).toBe("pending");
  });
});

describe("legitimate authenticated flows are unaffected by the NULL-safe guard rewrite", () => {
  it("a genuinely authenticated caller can still create an organization for themselves", async () => {
    const userId = await createAuthUser("legit-create-org");
    const orgName = `Legit Post-Fix Org ${randomUUID()}`;

    const orgId = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        orgName,
        `legit-post-fix-${randomUUID()}`,
        userId,
      ]);
      return r.rows[0].organization_id as string;
    });
    expect(orgId).toBeTruthy();
  });

  it("a genuinely authenticated caller still cannot create an org on behalf of a DIFFERENT real user", async () => {
    const caller = await createAuthUser("legit-caller-mismatch");
    const otherUser = await createAuthUser("legit-other-user-mismatch");

    await expect(
      withTenantContext({ userId: caller }, async (client) => {
        await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
          "Mismatch Org",
          `legit-mismatch-${randomUUID()}`,
          otherUser,
        ]);
      }),
    ).rejects.toThrow(/p_user_id must match the authenticated caller/i);
  });
});
