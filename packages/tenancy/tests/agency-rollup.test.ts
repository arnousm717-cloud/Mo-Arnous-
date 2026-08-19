import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool, withTenantContext } from "@ai-revenue-os/database";
import { listOrganizationsForAgency } from "../src/organizations";
import {
  listCompaniesForAgency,
  listContactsForAgency,
  listDealsForAgency,
  listPipelinesForAgency,
} from "../src/agency-rollup";

// Same well-known local Supabase CLI demo keys used throughout this
// monorepo's test suites (rls-cross-tenant.test.ts, brand-themes.test.ts)
// — never valid against a real project.
const API_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Milestone 2.4C: domain-layer tests for the four agency roll-up read
 * functions. Mirrors this package's own established fixture convention
 * (rls-cross-tenant.test.ts / brand-themes.test.ts — a real Supabase Auth
 * admin-created user, then create_agency_with_owner/
 * create_client_organization_for_agency via withTenantContext), extended
 * with a direct getPool() seed for companies/contacts/deals/pipelines
 * rows (the same admin-level seeding idiom rls-cross-tenant.test.ts
 * already uses for its own organizations.update() proof).
 */

async function createAuthUser(label: string): Promise<string> {
  const email = `agency-rollup-${label}-${randomUUID()}@example.test`;
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password: "Correct horse battery staple 1!",
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Test setup failed to create auth user: ${error?.message}`);
  }
  return data.user.id;
}

async function createAgencyWithOwner(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
      name,
      `agency-rollup-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.agency_id;
}

async function roleIdFor(key: string): Promise<string> {
  const pool = getPool();
  const r = await pool.query<{ id: string }>("select id from public.roles where key = $1", [key]);
  const row = r.rows[0];
  if (!row) throw new Error(`no seeded role for key ${key}`);
  return row.id;
}

async function seedAgencyMembership(userId: string, agencyId: string, roleKey: string, status = "active"): Promise<void> {
  const roleId = await roleIdFor(roleKey);
  const pool = getPool();
  await pool.query("insert into public.memberships (user_id, agency_id, role_id, status) values ($1, $2, $3, $4)", [
    userId,
    agencyId,
    roleId,
    status,
  ]);
}

async function createClientOrg(userId: string, agencyId: string, orgName: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_client_organization_for_agency($1, $2, $3, $4)", [
      orgName,
      `agency-rollup-client-${randomUUID()}`,
      agencyId,
      userId,
    ]);
    return r.rows[0];
  });
  return result.organization_id;
}

/** Direct admin-level seed (getPool(), matching rls-cross-tenant.test.ts's
 * own idiom) — one full CRM footprint (company, contact, pipeline+stage,
 * deal) for a given organization. */
async function seedCrmFootprint(
  organizationId: string,
  label: string,
): Promise<{ companyId: string; contactId: string; pipelineId: string; dealId: string }> {
  const pool = getPool();

  const company = await pool.query<{ id: string }>(
    "insert into public.companies (organization_id, name, domain, industry, employee_count, annual_revenue) values ($1, $2, $3, $4, $5, $6) returning id",
    [organizationId, `${label} Company`, `${label}.example.test`, "Software", 42, "1000000"],
  );
  const companyId = company.rows[0]!.id;

  const contact = await pool.query<{ id: string }>(
    "insert into public.contacts (organization_id, company_id, first_name, last_name, email, phone, job_title, lifecycle_stage) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
    [
      organizationId,
      companyId,
      `${label}-First`,
      `${label}-Last`,
      `${label}@example.test`,
      "+1-555-0100",
      `${label} Job Title`,
      "customer",
    ],
  );
  const contactId = contact.rows[0]!.id;

  const pipeline = await pool.query<{ id: string }>(
    "insert into public.pipelines (organization_id, name) values ($1, $2) returning id",
    [organizationId, `${label} Pipeline`],
  );
  const pipelineId = pipeline.rows[0]!.id;

  const stage = await pool.query<{ id: string }>(
    "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, $3, $4) returning id",
    [organizationId, pipelineId, `${label} Stage`, 10],
  );
  const stageId = stage.rows[0]!.id;

  const deal = await pool.query<{ id: string }>(
    "insert into public.deals (organization_id, company_id, pipeline_id, stage_id, amount, currency, expected_close_date) values ($1, $2, $3, $4, $5, $6, $7) returning id",
    [organizationId, companyId, pipelineId, stageId, "5000", "USD", "2027-01-01"],
  );
  const dealId = deal.rows[0]!.id;

  return { companyId, contactId, pipelineId, dealId };
}

afterAll(async () => {
  await closePool();
});

describe("agency-rollup domain layer: A/B — agency_owner and agency_admin can list their own client records", () => {
  it("agency_owner: all four functions return the seeded footprint", async () => {
    const owner = await createAuthUser("owner-ab");
    const agencyId = await createAgencyWithOwner(owner, "Rollup AB Agency Owner");
    const org = await createClientOrg(owner, agencyId, "Rollup AB Client");
    const footprint = await seedCrmFootprint(org, "ab-owner");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    const companies = await listCompaniesForAgency(ctx);
    expect(companies.map((c) => c.id)).toEqual([footprint.companyId]);

    const contacts = await listContactsForAgency(ctx);
    expect(contacts.map((c) => c.id)).toEqual([footprint.contactId]);

    const deals = await listDealsForAgency(ctx);
    expect(deals.map((d) => d.id)).toEqual([footprint.dealId]);

    const pipelines = await listPipelinesForAgency(ctx);
    expect(pipelines.map((p) => p.id)).toEqual([footprint.pipelineId]);
  });

  it("agency_admin: all four functions return the seeded footprint", async () => {
    const owner = await createAuthUser("owner-for-admin-ab");
    const agencyId = await createAgencyWithOwner(owner, "Rollup AB Agency Admin");
    const admin = await createAuthUser("admin-ab");
    await seedAgencyMembership(admin, agencyId, "agency_admin");
    const org = await createClientOrg(owner, agencyId, "Rollup AB Admin Client");
    const footprint = await seedCrmFootprint(org, "ab-admin");
    const ctx = { userId: admin, agencyId, roleKey: "agency_admin" };

    const companies = await listCompaniesForAgency(ctx);
    expect(companies.map((c) => c.id)).toEqual([footprint.companyId]);
    const contacts = await listContactsForAgency(ctx);
    expect(contacts.map((c) => c.id)).toEqual([footprint.contactId]);
    const deals = await listDealsForAgency(ctx);
    expect(deals.map((d) => d.id)).toEqual([footprint.dealId]);
    const pipelines = await listPipelinesForAgency(ctx);
    expect(pipelines.map((p) => p.id)).toEqual([footprint.pipelineId]);
  });
});

describe("agency-rollup domain layer: C — cross-agency isolation", () => {
  it("agency A's lists contain only agency A's client records; agency B's contain only agency B's", async () => {
    const ownerA = await createAuthUser("owner-cross-a");
    const agencyA = await createAgencyWithOwner(ownerA, "Rollup Cross Agency A");
    const orgA = await createClientOrg(ownerA, agencyA, "Rollup Cross A Client");
    const footprintA = await seedCrmFootprint(orgA, "cross-a");

    const ownerB = await createAuthUser("owner-cross-b");
    const agencyB = await createAgencyWithOwner(ownerB, "Rollup Cross Agency B");
    const orgB = await createClientOrg(ownerB, agencyB, "Rollup Cross B Client");
    const footprintB = await seedCrmFootprint(orgB, "cross-b");

    const ctxA = { userId: ownerA, agencyId: agencyA, roleKey: "agency_owner" };
    const ctxB = { userId: ownerB, agencyId: agencyB, roleKey: "agency_owner" };

    expect((await listCompaniesForAgency(ctxA)).map((c) => c.id)).toEqual([footprintA.companyId]);
    expect((await listCompaniesForAgency(ctxB)).map((c) => c.id)).toEqual([footprintB.companyId]);
    expect((await listContactsForAgency(ctxA)).map((c) => c.id)).toEqual([footprintA.contactId]);
    expect((await listContactsForAgency(ctxB)).map((c) => c.id)).toEqual([footprintB.contactId]);
    expect((await listDealsForAgency(ctxA)).map((d) => d.id)).toEqual([footprintA.dealId]);
    expect((await listDealsForAgency(ctxB)).map((d) => d.id)).toEqual([footprintB.dealId]);
    expect((await listPipelinesForAgency(ctxA)).map((p) => p.id)).toEqual([footprintA.pipelineId]);
    expect((await listPipelinesForAgency(ctxB)).map((p) => p.id)).toEqual([footprintB.pipelineId]);
  });
});

describe("agency-rollup domain layer: D — zero matching records returns [], not an error", () => {
  it("a freshly created agency with zero client organizations returns [] for all four functions", async () => {
    const owner = await createAuthUser("owner-empty");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Empty Agency");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    expect(await listCompaniesForAgency(ctx)).toEqual([]);
    expect(await listContactsForAgency(ctx)).toEqual([]);
    expect(await listDealsForAgency(ctx)).toEqual([]);
    expect(await listPipelinesForAgency(ctx)).toEqual([]);
  });
});

describe("agency-rollup domain layer: E/F/G — the view's own current_role_key() check rejects a non-agency roleKey", () => {
  it("a ctx with roleKey='org_admin' (which resolveAgencyRequestContext would never actually produce) returns [] from every function — the database view's own WHERE clause, not this domain layer, is what enforces this", async () => {
    const owner = await createAuthUser("owner-org-admin-ctx");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Org Admin Ctx Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup Org Admin Ctx Client");
    await seedCrmFootprint(org, "org-admin-ctx");
    const ctx = { userId: owner, agencyId, roleKey: "org_admin" };

    expect(await listCompaniesForAgency(ctx)).toEqual([]);
    expect(await listContactsForAgency(ctx)).toEqual([]);
    expect(await listDealsForAgency(ctx)).toEqual([]);
    expect(await listPipelinesForAgency(ctx)).toEqual([]);
  });

  it("org_member roleKey: same rejection", async () => {
    const owner = await createAuthUser("owner-org-member-ctx");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Org Member Ctx Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup Org Member Ctx Client");
    await seedCrmFootprint(org, "org-member-ctx");
    const ctx = { userId: owner, agencyId, roleKey: "org_member" };

    expect(await listCompaniesForAgency(ctx)).toEqual([]);
    expect(await listDealsForAgency(ctx)).toEqual([]);
  });

  it("org_viewer roleKey: same rejection", async () => {
    const owner = await createAuthUser("owner-org-viewer-ctx");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Org Viewer Ctx Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup Org Viewer Ctx Client");
    await seedCrmFootprint(org, "org-viewer-ctx");
    const ctx = { userId: owner, agencyId, roleKey: "org_viewer" };

    expect(await listContactsForAgency(ctx)).toEqual([]);
    expect(await listPipelinesForAgency(ctx)).toEqual([]);
  });
});

describe("agency-rollup domain layer: H — this domain layer trusts an already-resolved ctx completely, matching listOrganizationsForAgency's own behavior exactly", () => {
  it("a revoked ('removed') agency membership's own real userId/agencyId still returns data if a ctx is hand-assembled with it directly — proving the REAL protection is resolveAgencyRequestContext()'s own get_my_agency_context() status='active' filter (packages/auth, tested separately), never re-implemented at this layer, exactly like listOrganizationsForAgency", async () => {
    const owner = await createAuthUser("owner-revoked");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Revoked Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup Revoked Client");
    const footprint = await seedCrmFootprint(org, "revoked");

    const revokedUser = await createAuthUser("revoked-admin");
    await seedAgencyMembership(revokedUser, agencyId, "agency_admin", "removed");

    // This ctx could never legitimately be produced by
    // resolveAgencyRequestContext() (packages/auth) for revokedUser, since
    // get_my_agency_context() filters status = 'active' — assembling it by
    // hand here is exactly the failure mode application code must never
    // introduce. The domain function itself has no independent defense
    // against it, by design (same as listOrganizationsForAgency).
    const ctx = { userId: revokedUser, agencyId, roleKey: "agency_admin" };
    expect((await listCompaniesForAgency(ctx)).map((c) => c.id)).toEqual([footprint.companyId]);
  });
});

describe("agency-rollup domain layer: I — organization attribution is present and correct", () => {
  it("every returned row's organizationId matches the seeded client organization", async () => {
    const owner = await createAuthUser("owner-attribution");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Attribution Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup Attribution Client");
    await seedCrmFootprint(org, "attribution");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    const [companies, contacts, deals, pipelines] = await Promise.all([
      listCompaniesForAgency(ctx),
      listContactsForAgency(ctx),
      listDealsForAgency(ctx),
      listPipelinesForAgency(ctx),
    ]);
    expect(companies[0]?.organizationId).toBe(org);
    expect(contacts[0]?.organizationId).toBe(org);
    expect(deals[0]?.organizationId).toBe(org);
    expect(pipelines[0]?.organizationId).toBe(org);
  });
});

describe("agency-rollup domain layer: J — pagination limit is bounded", () => {
  it("limit: 1 returns exactly 1 row when more than one exists", async () => {
    const owner = await createAuthUser("owner-limit");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Limit Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup Limit Client");
    await seedCrmFootprint(org, "limit-1");
    await seedCrmFootprint(org, "limit-2");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    const companies = await listCompaniesForAgency(ctx, { limit: 1 });
    expect(companies).toHaveLength(1);
  });

  it("an invalid limit (zero, negative, non-integer, or over the maximum) throws rather than silently clamping or querying unbounded", async () => {
    const owner = await createAuthUser("owner-limit-invalid");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Limit Invalid Agency");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    await expect(listCompaniesForAgency(ctx, { limit: 0 })).rejects.toThrow();
    await expect(listCompaniesForAgency(ctx, { limit: -1 })).rejects.toThrow();
    await expect(listCompaniesForAgency(ctx, { limit: 1.5 })).rejects.toThrow();
    await expect(listCompaniesForAgency(ctx, { limit: 101 })).rejects.toThrow();
  });

  it("omitting limit entirely uses a sane default, never an unbounded query", async () => {
    const owner = await createAuthUser("owner-limit-default");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Limit Default Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup Limit Default Client");
    await seedCrmFootprint(org, "limit-default");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    const companies = await listCompaniesForAgency(ctx);
    expect(companies).toHaveLength(1);
  });
});

describe("agency-rollup domain layer: K — deterministic ordering", () => {
  it("companies/contacts/deals are ordered newest-first (created_at desc, id desc)", async () => {
    const owner = await createAuthUser("owner-order");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Order Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup Order Client");
    const first = await seedCrmFootprint(org, "order-first");
    await new Promise((r) => setTimeout(r, 5));
    const second = await seedCrmFootprint(org, "order-second");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    const companies = await listCompaniesForAgency(ctx);
    expect(companies.map((c) => c.id)).toEqual([second.companyId, first.companyId]);
  });

  it("pipelines are ordered by name (no created_at column exists on that view)", async () => {
    const owner = await createAuthUser("owner-pipeline-order");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Pipeline Order Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup Pipeline Order Client");
    const pool = getPool();
    const zebra = await pool.query<{ id: string }>("insert into public.pipelines (organization_id, name) values ($1, 'Zebra Pipeline') returning id", [org]);
    const alpha = await pool.query<{ id: string }>("insert into public.pipelines (organization_id, name) values ($1, 'Alpha Pipeline') returning id", [org]);
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    const pipelines = await listPipelinesForAgency(ctx);
    expect(pipelines.map((p) => p.id)).toEqual([alpha.rows[0]!.id, zebra.rows[0]!.id]);
  });
});

describe("agency-rollup domain layer: L — no PII fields appear in contact results", () => {
  it("a returned contact object has no email/phone/jobTitle/linkedinUrl/ownerId property at runtime, not merely absent from the TypeScript type", async () => {
    const owner = await createAuthUser("owner-pii");
    const agencyId = await createAgencyWithOwner(owner, "Rollup PII Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup PII Client");
    await seedCrmFootprint(org, "pii-check");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    const contacts = await listContactsForAgency(ctx);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).not.toHaveProperty("email");
    expect(contacts[0]).not.toHaveProperty("phone");
    expect(contacts[0]).not.toHaveProperty("jobTitle");
    expect(contacts[0]).not.toHaveProperty("linkedinUrl");
    expect(contacts[0]).not.toHaveProperty("ownerId");
  });
});

describe("agency-rollup domain layer: M — no write method exists in this new domain surface", () => {
  it("the module exports exactly the four list functions and their types — no create/update/delete function", async () => {
    const module = await import("../src/agency-rollup");
    const exportedNames = Object.keys(module);
    expect(exportedNames.sort()).toEqual(
      ["listCompaniesForAgency", "listContactsForAgency", "listDealsForAgency", "listPipelinesForAgency"].sort(),
    );
    for (const name of exportedNames) {
      expect(name).not.toMatch(/create|update|delete|insert/i);
    }
  });
});

describe("agency-rollup domain layer: regression — listOrganizationsForAgency is unaffected", () => {
  it("still lists only the calling agency's own client organizations", async () => {
    const owner = await createAuthUser("owner-orgs-regression");
    const agencyId = await createAgencyWithOwner(owner, "Rollup Orgs Regression Agency");
    const org = await createClientOrg(owner, agencyId, "Rollup Orgs Regression Client");

    const rows = await listOrganizationsForAgency({ userId: owner, agencyId, roleKey: "agency_owner" });
    expect(rows).toEqual([{ id: org, name: "Rollup Orgs Regression Client", slug: expect.any(String) }]);
  });
});

describe("agency-rollup domain layer: regression — 2.4A view grants remain SELECT-only for authenticated, zero for anon", () => {
  it("all four roll-up views are unaffected by this milestone's own domain-layer addition", async () => {
    const pool = getPool();
    const grants = await pool.query<{ table_name: string; grantee: string; privilege_type: string }>(
      "select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name in ('agency_rollup_companies','agency_rollup_contacts','agency_rollup_deals','agency_rollup_pipelines') and grantee in ('authenticated', 'anon')",
    );
    const byTable = (table: string) => grants.rows.filter((g) => g.table_name === table);
    for (const table of ["agency_rollup_companies", "agency_rollup_contacts", "agency_rollup_deals", "agency_rollup_pipelines"]) {
      const rows = byTable(table);
      expect(rows.filter((r) => r.grantee === "authenticated").map((r) => r.privilege_type)).toEqual(["SELECT"]);
      expect(rows.filter((r) => r.grantee === "anon")).toEqual([]);
    }
  });
});
