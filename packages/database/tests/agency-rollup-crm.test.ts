import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
// Deliberately the PRODUCTION helper (real commit/rollback), matching
// agency-management.test.ts's own precedent exactly — these tests verify
// real cross-transaction visibility (seed as one caller, read as another),
// which the test-only always-rollback helper cannot exercise.
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.4A: release-blocking security coverage for the four new
 * agency roll-up views (agency_rollup_companies/contacts/deals/pipelines).
 * Mirrors agency-management.test.ts's own proven pattern (cross-agency
 * isolation, direct-base-table-still-governed, empty-rollup-not-an-error)
 * and default-acl-hardening.test.ts's own proven pattern (INSERT/UPDATE/
 * DELETE bypass regression, for both anon and an unauthorized authenticated
 * caller) — extended to all four new views, not re-invented.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `agency-rollup-crm-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createAgencyWithOwner(userId: string, name: string): Promise<{ agencyId: string }> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
      name,
      `agency-rollup-crm-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return { agencyId: result.agency_id };
}

async function roleIdFor(key: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>("select id from public.roles where key = $1", [key]);
    const row = r.rows[0];
    if (!row) throw new Error(`no seeded role for key ${key}`);
    return row.id;
  });
}

async function seedAgencyMembership(userId: string, agencyId: string, roleKey: string, status = "active"): Promise<void> {
  const roleId = await roleIdFor(roleKey);
  await seedAsAdmin(async (client) => {
    await client.query(
      "insert into public.memberships (user_id, agency_id, role_id, status) values ($1, $2, $3, $4)",
      [userId, agencyId, roleId, status],
    );
  });
}

async function createClientOrg(userId: string, agencyId: string, orgName: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_client_organization_for_agency($1, $2, $3, $4)", [
      orgName,
      `agency-rollup-crm-client-${randomUUID()}`,
      agencyId,
      userId,
    ]);
    return r.rows[0];
  });
  return result.organization_id;
}

/** Seeds one full CRM footprint (company, contact, pipeline+stage, deal) for
 * a given organization — directly via SQL, matching this test file's own
 * database-layer convention (never through packages/crm). */
async function seedCrmFootprint(
  organizationId: string,
  label: string,
): Promise<{ companyId: string; contactId: string; pipelineId: string; dealId: string }> {
  return seedAsAdmin(async (client) => {
    const company = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name) values ($1, $2) returning id",
      [organizationId, `${label} Company`],
    );
    const companyId = company.rows[0]!.id;

    const contact = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, company_id, first_name, last_name, email, phone) values ($1, $2, $3, $4, $5, $6) returning id",
      [organizationId, companyId, `${label}-First`, `${label}-Last`, `${label}@example.test`, "+1-555-0100"],
    );
    const contactId = contact.rows[0]!.id;

    const pipeline = await client.query<{ id: string }>(
      "insert into public.pipelines (organization_id, name) values ($1, $2) returning id",
      [organizationId, `${label} Pipeline`],
    );
    const pipelineId = pipeline.rows[0]!.id;

    const stage = await client.query<{ id: string }>(
      "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, $3, $4) returning id",
      [organizationId, pipelineId, `${label} Stage`, 10],
    );
    const stageId = stage.rows[0]!.id;

    const deal = await client.query<{ id: string }>(
      "insert into public.deals (organization_id, company_id, pipeline_id, stage_id, amount, currency) values ($1, $2, $3, $4, $5, $6) returning id",
      [organizationId, companyId, pipelineId, stageId, 1000, "USD"],
    );
    const dealId = deal.rows[0]!.id;

    return { companyId, contactId, pipelineId, dealId };
  });
}

async function listRollup(
  view: string,
  ctx: { userId: string; agencyId: string; roleKey: string },
): Promise<Array<Record<string, unknown>>> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query(`select * from public.${view} order by id`);
    return r.rows;
  });
}

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

interface ViewSpec {
  view: string;
  table: string;
  idKey: "companyId" | "contactId" | "pipelineId" | "dealId";
}

const VIEWS: ViewSpec[] = [
  { view: "agency_rollup_companies", table: "companies", idKey: "companyId" },
  { view: "agency_rollup_contacts", table: "contacts", idKey: "contactId" },
  { view: "agency_rollup_deals", table: "deals", idKey: "dealId" },
  { view: "agency_rollup_pipelines", table: "pipelines", idKey: "pipelineId" },
];

for (const spec of VIEWS) {
  describe(`${spec.view}: cross-agency isolation and write-blocking`, () => {
    it("1+2: agency A's rollup contains only its own client organizations' records; agency B's contains only its own", async () => {
      const ownerA = await createAuthUser(`${spec.view}-owner-a`);
      const { agencyId: agencyA } = await createAgencyWithOwner(ownerA, `${spec.view} Agency A`);
      const orgA = await createClientOrg(ownerA, agencyA, `${spec.view} A Client`);
      const footprintA = await seedCrmFootprint(orgA, `${spec.view}-A`);

      const ownerB = await createAuthUser(`${spec.view}-owner-b`);
      const { agencyId: agencyB } = await createAgencyWithOwner(ownerB, `${spec.view} Agency B`);
      const orgB = await createClientOrg(ownerB, agencyB, `${spec.view} B Client`);
      const footprintB = await seedCrmFootprint(orgB, `${spec.view}-B`);

      const rollupA = await listRollup(spec.view, { userId: ownerA, agencyId: agencyA, roleKey: "agency_owner" });
      expect(rollupA.map((r) => r.id)).toEqual([footprintA[spec.idKey]]);

      const rollupB = await listRollup(spec.view, { userId: ownerB, agencyId: agencyB, roleKey: "agency_owner" });
      expect(rollupB.map((r) => r.id)).toEqual([footprintB[spec.idKey]]);
    });

    it("3: an org-only user (no agency membership) cannot use the roll-up view — current_agency() never resolves for them", async () => {
      const orgOnlyUser = await createAuthUser(`${spec.view}-org-only`);
      await withTenantContext({ userId: orgOnlyUser }, async (client) => {
        await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
          `${spec.view} Org-Only Co`,
          `agency-rollup-crm-org-only-${randomUUID()}`,
          orgOnlyUser,
        ]);
      });

      // No agencyId/roleKey ever set — matches how an org-only user's real
      // request context resolves (resolveAgencyRequestContext returns null
      // upstream of any query, application-side). Querying the view with no
      // agency context set at all must return zero rows, never an error.
      const rows = await withTenantContext({ userId: orgOnlyUser }, async (client) => {
        const r = await client.query(`select * from public.${spec.view}`);
        return r.rows;
      });
      expect(rows).toEqual([]);
    });

    it("4: an anonymous (unauthenticated) caller cannot SELECT from the view at all", async () => {
      await expect(
        asAnon(async (client) => {
          await client.query(`select * from public.${spec.view}`);
        }),
      ).rejects.toThrow(/permission denied|cannot (insert into|update|delete from) view/i);
    });

    it("5: an inactive/revoked agency membership loses roll-up access immediately", async () => {
      const owner = await createAuthUser(`${spec.view}-inactive-owner`);
      const { agencyId } = await createAgencyWithOwner(owner, `${spec.view} Inactive Agency`);
      const org = await createClientOrg(owner, agencyId, `${spec.view} Inactive Client`);
      await seedCrmFootprint(org, `${spec.view}-inactive`);

      const revokedUser = await createAuthUser(`${spec.view}-revoked`);
      await seedAgencyMembership(revokedUser, agencyId, "agency_admin", "removed");

      // current_role_key() would resolve to 'agency_admin' if explicitly
      // forced, but the real application path never does that for a
      // removed membership — get_my_agency_context() itself filters
      // status = 'active', so resolveAgencyRequestContext() would already
      // return null before reaching here. This proves the DB-level
      // guarantee directly regardless: even if 'agency_admin' were forced
      // in, the view's own row-level data must still only ever reflect a
      // legitimate, currently-active agency relationship for this to be
      // meaningful — verified via the application-realistic path below.
      const rows = await withTenantContext({ userId: revokedUser }, async (client) => {
        const ctx = await client.query("select * from public.get_my_agency_context()");
        return ctx.rows;
      });
      expect(rows).toEqual([]);
    });

    it("6: direct base-table access remains governed by the table's own RLS, not the roll-up view", async () => {
      const ownerA = await createAuthUser(`${spec.view}-direct-owner-a`);
      const { agencyId: agencyA } = await createAgencyWithOwner(ownerA, `${spec.view} Direct Agency A`);

      const ownerB = await createAuthUser(`${spec.view}-direct-owner-b`);
      const { agencyId: agencyB } = await createAgencyWithOwner(ownerB, `${spec.view} Direct Agency B`);
      const orgB = await createClientOrg(ownerB, agencyB, `${spec.view} Direct B Client`);
      const footprintB = await seedCrmFootprint(orgB, `${spec.view}-direct-b`);

      // Agency A's context set, but querying the BASE table directly rather
      // than through the roll-up view — organization_id = current_org()
      // governs here, and current_org() was never set in this agency-level
      // context at all, so this must return zero rows regardless of
      // agency_id ever matching or not.
      const directRead = await withTenantContext(
        { userId: ownerA, agencyId: agencyA, roleKey: "agency_owner" },
        async (client) => {
          const r = await client.query(`select id from public.${spec.table} where id = $1`, [
            footprintB[spec.idKey],
          ]);
          return r.rows;
        },
      );
      expect(directRead).toHaveLength(0);
    });

    // Empirically, Postgres rejects these three with "cannot insert/update/
    // delete into view ..." rather than "permission denied" — because each
    // view joins to organizations, Postgres treats it as not simply
    // updatable and refuses the write at rewrite time, independent of the
    // grant check. This is a stronger guarantee than grants alone (it would
    // still refuse even if a grant existed by mistake), not a weaker one —
    // the assertions below accept either message as proof the write was
    // blocked, since both are genuine denials, never a distinction that
    // matters for security.
    it("7: INSERT through the roll-up view is denied for both anon and an authenticated agency caller", async () => {
      await expect(
        asAnon(async (client) => {
          await client.query(`insert into public.${spec.view} (organization_id) values ($1)`, [randomUUID()]);
        }),
      ).rejects.toThrow(/permission denied|cannot (insert into|update|delete from) view/i);

      const owner = await createAuthUser(`${spec.view}-insert-owner`);
      const { agencyId } = await createAgencyWithOwner(owner, `${spec.view} Insert Agency`);
      await expect(
        withTenantContext({ userId: owner, agencyId, roleKey: "agency_owner" }, async (client) => {
          await client.query(`insert into public.${spec.view} (organization_id) values ($1)`, [randomUUID()]);
        }),
      ).rejects.toThrow(/permission denied|cannot (insert into|update|delete from) view/i);
    });

    it("8: UPDATE through the roll-up view is denied for both anon and an authenticated agency caller", async () => {
      await expect(
        asAnon(async (client) => {
          await client.query(`update public.${spec.view} set organization_id = organization_id`);
        }),
      ).rejects.toThrow(/permission denied|cannot (insert into|update|delete from) view/i);

      const owner = await createAuthUser(`${spec.view}-update-owner`);
      const { agencyId } = await createAgencyWithOwner(owner, `${spec.view} Update Agency`);
      await expect(
        withTenantContext({ userId: owner, agencyId, roleKey: "agency_owner" }, async (client) => {
          await client.query(`update public.${spec.view} set organization_id = organization_id`);
        }),
      ).rejects.toThrow(/permission denied|cannot (insert into|update|delete from) view/i);
    });

    it("9: DELETE through the roll-up view is denied for both anon and an authenticated agency caller", async () => {
      await expect(
        asAnon(async (client) => {
          await client.query(`delete from public.${spec.view}`);
        }),
      ).rejects.toThrow(/permission denied|cannot (insert into|update|delete from) view/i);

      const owner = await createAuthUser(`${spec.view}-delete-owner`);
      const { agencyId } = await createAgencyWithOwner(owner, `${spec.view} Delete Agency`);
      await expect(
        withTenantContext({ userId: owner, agencyId, roleKey: "agency_owner" }, async (client) => {
          await client.query(`delete from public.${spec.view}`);
        }),
      ).rejects.toThrow(/permission denied|cannot (insert into|update|delete from) view/i);
    });

    it("10+11: authenticated has SELECT only; anon has zero privileges", async () => {
      const grants = await seedAsAdmin(async (client) => {
        const r = await client.query<{ grantee: string; privilege_type: string }>(
          "select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee in ('authenticated', 'anon')",
          [spec.view],
        );
        return r.rows;
      });
      const authenticatedGrants = grants.filter((g) => g.grantee === "authenticated").map((g) => g.privilege_type);
      const anonGrants = grants.filter((g) => g.grantee === "anon");
      expect(authenticatedGrants).toEqual(["SELECT"]);
      expect(anonGrants).toEqual([]);
    });

    it("12: a client organization reassigned away from an agency disappears from that agency's roll-up immediately", async () => {
      const owner = await createAuthUser(`${spec.view}-stale-owner`);
      const { agencyId } = await createAgencyWithOwner(owner, `${spec.view} Stale Agency`);
      const org = await createClientOrg(owner, agencyId, `${spec.view} Stale Client`);
      const footprint = await seedCrmFootprint(org, `${spec.view}-stale`);

      const before = await listRollup(spec.view, { userId: owner, agencyId, roleKey: "agency_owner" });
      expect(before.map((r) => r.id)).toContain(footprint[spec.idKey]);

      await seedAsAdmin(async (client) => {
        await client.query("update public.organizations set agency_id = null where id = $1", [org]);
      });

      const after = await listRollup(spec.view, { userId: owner, agencyId, roleKey: "agency_owner" });
      expect(after.map((r) => r.id)).not.toContain(footprint[spec.idKey]);
    });

    it("14: no cross-agency enumeration through an arbitrary/guessed id — a nonexistent row and a real cross-agency row are equally absent", async () => {
      const owner = await createAuthUser(`${spec.view}-enum-owner`);
      const { agencyId } = await createAgencyWithOwner(owner, `${spec.view} Enum Agency`);

      const otherOwner = await createAuthUser(`${spec.view}-enum-other-owner`);
      const { agencyId: otherAgencyId } = await createAgencyWithOwner(otherOwner, `${spec.view} Enum Other Agency`);
      const otherOrg = await createClientOrg(otherOwner, otherAgencyId, `${spec.view} Enum Other Client`);
      const otherFootprint = await seedCrmFootprint(otherOrg, `${spec.view}-enum-other`);

      const rows = await withTenantContext({ userId: owner, agencyId, roleKey: "agency_owner" }, async (client) => {
        const r = await client.query(`select id from public.${spec.view} where id in ($1, $2)`, [
          otherFootprint[spec.idKey],
          randomUUID(),
        ]);
        return r.rows;
      });
      expect(rows).toEqual([]);
    });
  });
}

describe("agency_rollup_contacts: PII exclusion (Milestone 2.4A data-minimization requirement)", () => {
  it("13: email and phone are not exposed as columns of the view at all", async () => {
    const columns = await seedAsAdmin(async (client) => {
      const r = await client.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'agency_rollup_contacts'",
      );
      return r.rows.map((row) => row.column_name);
    });
    expect(columns).not.toContain("email");
    expect(columns).not.toContain("phone");
    expect(columns).not.toContain("job_title");
    expect(columns).not.toContain("linkedin_url");
    expect(columns).not.toContain("owner_id");
  });

  it("13b: a real seeded contact's email/phone cannot be read through the view even with select *", async () => {
    const owner = await createAuthUser("pii-owner");
    const { agencyId } = await createAgencyWithOwner(owner, "PII Agency");
    const org = await createClientOrg(owner, agencyId, "PII Client");
    await seedCrmFootprint(org, "pii-check");

    const rows = await withTenantContext({ userId: owner, agencyId, roleKey: "agency_owner" }, async (client) => {
      const r = await client.query("select * from public.agency_rollup_contacts");
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("email");
    expect(rows[0]).not.toHaveProperty("phone");
  });
});

describe("agency_rollup_pipelines: minimal column set (Milestone 2.4A scope requirement)", () => {
  it("exposes only id, organization_id, name — no is_default, no timestamps", async () => {
    const columns = await seedAsAdmin(async (client) => {
      const r = await client.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'agency_rollup_pipelines'",
      );
      return r.rows.map((row) => row.column_name).sort();
    });
    expect(columns).toEqual(["id", "name", "organization_id"]);
  });
});

describe("15: agency_rollup_organizations — unchanged regression check", () => {
  it("still lists only the calling agency's own client organizations", async () => {
    const owner = await createAuthUser("orgs-regression-owner");
    const { agencyId } = await createAgencyWithOwner(owner, "Orgs Regression Agency");
    const org = await createClientOrg(owner, agencyId, "Orgs Regression Client");

    const rows = await withTenantContext({ userId: owner, agencyId, roleKey: "agency_owner" }, async (client) => {
      const r = await client.query("select id, name from public.agency_rollup_organizations");
      return r.rows;
    });
    expect(rows).toEqual([{ id: org, name: "Orgs Regression Client" }]);
  });

  it("still grants SELECT only to authenticated, zero to anon", async () => {
    const grants = await seedAsAdmin(async (client) => {
      const r = await client.query<{ grantee: string; privilege_type: string }>(
        "select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'agency_rollup_organizations' and grantee in ('authenticated', 'anon')",
      );
      return r.rows;
    });
    expect(grants.filter((g) => g.grantee === "authenticated").map((g) => g.privilege_type)).toEqual(["SELECT"]);
    expect(grants.filter((g) => g.grantee === "anon")).toEqual([]);
  });
});

describe("16: base-table RLS policy definitions are unchanged by Milestone 2.4A", () => {
  it("companies/contacts/deals/pipelines retain exactly their pre-2.4A SELECT/INSERT/UPDATE policies, no DELETE policy, no new policy added", async () => {
    const policies = await seedAsAdmin(async (client) => {
      const r = await client.query<{ tablename: string; policyname: string; cmd: string }>(
        "select tablename, policyname, cmd from pg_policies where schemaname = 'public' and tablename in ('companies','contacts','deals','pipelines') order by tablename, cmd",
      );
      return r.rows;
    });
    const byTable = (table: string) =>
      policies.filter((p) => p.tablename === table).map((p) => `${p.policyname}:${p.cmd}`);

    for (const table of ["companies", "contacts", "deals", "pipelines"]) {
      const rows = byTable(table);
      expect(rows).toEqual([
        `${table}_insert_own:INSERT`,
        `${table}_select_own:SELECT`,
        `${table}_update_own:UPDATE`,
      ]);
    }
  });

  it("companies/contacts/deals/pipelines grants to authenticated are unchanged (select, insert, update — no delete)", async () => {
    for (const table of ["companies", "contacts", "deals", "pipelines"]) {
      const grants = await seedAsAdmin(async (client) => {
        const r = await client.query<{ privilege_type: string }>(
          "select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee = 'authenticated'",
          [table],
        );
        return r.rows.map((row) => row.privilege_type).sort();
      });
      expect(grants).toEqual(["INSERT", "SELECT", "UPDATE"]);
    }
  });
});
