import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.1B RLS/privilege adversarial coverage (docs/13-Technical-
 * Design-Review.md "Milestone 2.1"). Mirrors the exact style of
 * rls-isolation.test.ts / table-privilege-hardening.test.ts — real
 * Postgres, never mocked, org A vs org B, and a direct
 * information_schema check for the effective privilege set rather than
 * trusting "should inherit defaults" without proof.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
  companyAId: string;
  companyBId: string;
  contactAId: string;
  contactBId: string;
}

let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('RLS Test Org A', $1) returning id",
      [`rls-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('RLS Test Org B', $1) returning id",
      [`rls-test-org-b-${randomUUID()}`],
    );
    const companyA = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name) values ($1, $2) returning id",
      [orgA.rows[0]!.id, "Org A Company"],
    );
    const companyB = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name) values ($1, $2) returning id",
      [orgB.rows[0]!.id, "Org B Company"],
    );
    const contactA = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
      [orgA.rows[0]!.id, "Org A Contact"],
    );
    const contactB = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
      [orgB.rows[0]!.id, "Org B Contact"],
    );
    return {
      orgAId: orgA.rows[0]!.id,
      orgBId: orgB.rows[0]!.id,
      companyAId: companyA.rows[0]!.id,
      companyBId: companyB.rows[0]!.id,
      contactAId: contactA.rows[0]!.id,
      contactBId: contactB.rows[0]!.id,
    };
  });
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedFixture();
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("companies/contacts RLS: cross-tenant SELECT/UPDATE isolation", () => {
  it("org A cannot SELECT org B's company", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.companies where id = $1", [fx.companyBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's company", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.companies set name = 'Hijacked' where id = $1 returning id", [
        fx.companyBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
    const stillIntact = await seedAsAdmin(async (client) => {
      const r = await client.query("select name from public.companies where id = $1", [fx.companyBId]);
      return r.rows[0];
    });
    expect(stillIntact.name).toBe("Org B Company");
  });

  it("org A cannot soft-delete org B's company", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.companies set deleted_at = now() where id = $1 returning id", [
        fx.companyBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
    const stillActive = await seedAsAdmin(async (client) => {
      const r = await client.query("select deleted_at from public.companies where id = $1", [fx.companyBId]);
      return r.rows[0];
    });
    expect(stillActive.deleted_at).toBeNull();
  });

  it("org A cannot SELECT org B's contact", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.contacts where id = $1", [fx.contactBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's contact", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "update public.contacts set first_name = 'Hijacked' where id = $1 returning id",
        [fx.contactBId],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot soft-delete org B's contact", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.contacts set deleted_at = now() where id = $1 returning id", [
        fx.contactBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
    const stillActive = await seedAsAdmin(async (client) => {
      const r = await client.query("select deleted_at from public.contacts where id = $1", [fx.contactBId]);
      return r.rows[0];
    });
    expect(stillActive.deleted_at).toBeNull();
  });
});

describe("companies/contacts RLS: WITH CHECK prevents organization_id spoofing/mutation", () => {
  it("INSERT cannot spoof organization_id to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.companies (organization_id, name) values ($1, $2)", [
          fx.orgBId,
          "Spoofed Insert",
        ]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("UPDATE cannot move a company from org A to org B", async () => {
    // Seeded via seedAsAdmin (real commit) — withTenantContext always
    // rolls back, so a row created in one call wouldn't exist for a later
    // call's UPDATE to even find (which would make this test pass for the
    // wrong reason — "no such row" rather than "RLS blocked the move").
    const company = await seedAsAdmin(async (client) => {
      const r = await client.query("insert into public.companies (organization_id, name) values ($1, $2) returning id", [
        fx.orgAId,
        "Attempted Move",
      ]);
      return r.rows[0];
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("update public.companies set organization_id = $1 where id = $2", [
          fx.orgBId,
          company.id,
        ]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("UPDATE cannot move a contact from org A to org B", async () => {
    const contact = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
        [fx.orgAId, "Attempted Move Contact"],
      );
      return r.rows[0];
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("update public.contacts set organization_id = $1 where id = $2", [fx.orgBId, contact.id]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });
});

describe("companies/contacts RLS: cross-tenant company_id assignment", () => {
  it("org A cannot attach an org-A contact to an org-B company, even under a fully RLS-scoped session", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.contacts (organization_id, company_id, first_name) values ($1, $2, $3)",
          [fx.orgAId, fx.companyBId, "Cross Org Under RLS"],
        );
      }),
      // Blocked by the composite FK before RLS's own row-visibility rules
      // are even relevant here — company B is invisible to org A's session
      // regardless, but the FK is what makes this structurally impossible
      // rather than merely inconvenient.
    ).rejects.toThrow(/contacts_company_org_fk|foreign key/i);
  });
});

describe("companies/contacts privileges: effective grants match the approved design", () => {
  it("authenticated has exactly SELECT/INSERT/UPDATE on companies — no DELETE, no TRUNCATE/REFERENCES/TRIGGER", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'companies' and grantee = 'authenticated'
         order by privilege_type`,
      );
      return r.rows.map((row) => row.privilege_type);
    });
    expect(rows).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("authenticated has exactly SELECT/INSERT/UPDATE on contacts — no DELETE, no TRUNCATE/REFERENCES/TRIGGER", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'contacts' and grantee = 'authenticated'
         order by privilege_type`,
      );
      return r.rows.map((row) => row.privilege_type);
    });
    expect(rows).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("anon has zero grants on companies", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'companies' and grantee = 'anon'`,
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("anon has zero grants on contacts", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'contacts' and grantee = 'anon'`,
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("an authenticated session genuinely cannot physically DELETE a company row (permission denied, not merely discouraged)", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.companies where id = $1", [fx.companyAId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an authenticated session genuinely cannot physically DELETE a contact row", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.contacts where id = $1", [fx.contactAId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an authenticated session genuinely cannot TRUNCATE companies", async () => {
    await expect(
      withTenantContext({}, async (client) => {
        await client.query("truncate public.companies");
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an authenticated session genuinely cannot TRUNCATE contacts", async () => {
    await expect(
      withTenantContext({}, async (client) => {
        await client.query("truncate public.contacts");
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
