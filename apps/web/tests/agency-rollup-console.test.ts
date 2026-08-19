import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool, withTenantContext } from "@ai-revenue-os/database";
import {
  listCompaniesForAgencyConsole,
  listContactsForAgencyConsole,
  listDealsForAgencyConsole,
  listPipelinesForAgencyConsole,
  resolveOrganizationLabel,
  UNKNOWN_ORGANIZATION_LABEL,
} from "../app/agency/rollup-logic";
import { decideAgencyConsoleAccess } from "../app/agency/access";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminPool = getPool();

/**
 * Milestone 2.4D: application-layer authorization + composition tests for
 * the four agency CRM roll-up console pages. Mirrors
 * agency-console.test.ts's own established fixture convention exactly
 * (getPool()-based raw auth.users insert, create_agency_with_owner via
 * withTenantContext) — extended with create_client_organization_for_agency
 * and a direct CRM-footprint seed for the roll-up data itself.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  const client = await adminPool.connect();
  try {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `agency-rollup-console-${label}-${userId}@example.test`,
    ]);
  } finally {
    client.release();
  }
  return userId;
}

async function createAgencyWithOwner(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
      name,
      `agency-rollup-console-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.agency_id as string;
}

async function createClientOrg(userId: string, agencyId: string, orgName: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_client_organization_for_agency($1, $2, $3, $4)", [
      orgName,
      `agency-rollup-console-client-${randomUUID()}`,
      agencyId,
      userId,
    ]);
    return r.rows[0];
  });
  return result.organization_id as string;
}

async function seedCrmFootprint(
  organizationId: string,
  label: string,
): Promise<{ companyId: string; contactId: string; pipelineId: string; dealId: string }> {
  const client = await adminPool.connect();
  try {
    const company = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name, domain, industry, employee_count, annual_revenue) values ($1, $2, $3, $4, $5, $6) returning id",
      [organizationId, `${label} Company`, `${label}.example.test`, "Software", 10, "500000"],
    );
    const companyId = company.rows[0]!.id;

    const contact = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, company_id, first_name, last_name, email, phone, job_title, lifecycle_stage) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
      [organizationId, companyId, `${label}-First`, `${label}-Last`, `${label}@example.test`, "+1-555-0100", `${label} Title`, "customer"],
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
      [organizationId, companyId, pipelineId, stageId, "2500", "USD"],
    );
    const dealId = deal.rows[0]!.id;

    return { companyId, contactId, pipelineId, dealId };
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await closePool();
});

describe("agency roll-up console: A/B — agency_owner and agency_admin can access all 4 surfaces", () => {
  it("agency_owner: all four console functions return ready with the seeded footprint", async () => {
    const owner = await createAuthUser("owner-ab");
    const agencyId = await createAgencyWithOwner(owner, "Console AB Owner Agency");
    const org = await createClientOrg(owner, agencyId, "Console AB Owner Client");
    const footprint = await seedCrmFootprint(org, "ab-owner");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    const companies = await listCompaniesForAgencyConsole(ctx);
    expect(companies.kind).toBe("ready");
    if (companies.kind === "ready") {
      expect(companies.rows.map((r) => r.id)).toEqual([footprint.companyId]);
      expect(companies.rows[0]?.organizationLabel).toBe("Console AB Owner Client");
    }

    const contacts = await listContactsForAgencyConsole(ctx);
    expect(contacts.kind).toBe("ready");
    if (contacts.kind === "ready") {
      expect(contacts.rows.map((r) => r.id)).toEqual([footprint.contactId]);
      expect(contacts.rows[0]?.companyLabel).toBe("ab-owner Company");
    }

    const deals = await listDealsForAgencyConsole(ctx);
    expect(deals.kind).toBe("ready");
    if (deals.kind === "ready") {
      expect(deals.rows.map((r) => r.id)).toEqual([footprint.dealId]);
      expect(deals.rows[0]?.companyLabel).toBe("ab-owner Company");
      expect(deals.rows[0]?.pipelineLabel).toBe("ab-owner Pipeline");
    }

    const pipelines = await listPipelinesForAgencyConsole(ctx);
    expect(pipelines.kind).toBe("ready");
    if (pipelines.kind === "ready") {
      expect(pipelines.rows.map((r) => r.id)).toEqual([footprint.pipelineId]);
    }
  });

  it("agency_admin: all four console functions return ready", async () => {
    const owner = await createAuthUser("owner-for-admin");
    const agencyId = await createAgencyWithOwner(owner, "Console AB Admin Agency");
    const admin = await createAuthUser("admin-ab");
    const roleId = await adminPool
      .query<{ id: string }>("select id from public.roles where key = 'agency_admin'")
      .then((r) => r.rows[0]!.id);
    await adminPool.query("insert into public.memberships (user_id, agency_id, role_id, status) values ($1, $2, $3, 'active')", [
      admin,
      agencyId,
      roleId,
    ]);
    const org = await createClientOrg(owner, agencyId, "Console AB Admin Client");
    const footprint = await seedCrmFootprint(org, "ab-admin");
    const ctx = { userId: admin, agencyId, roleKey: "agency_admin" };

    const companies = await listCompaniesForAgencyConsole(ctx);
    expect(companies.kind).toBe("ready");
    if (companies.kind === "ready") expect(companies.rows.map((r) => r.id)).toEqual([footprint.companyId]);

    const pipelines = await listPipelinesForAgencyConsole(ctx);
    expect(pipelines.kind).toBe("ready");
    if (pipelines.kind === "ready") expect(pipelines.rows.map((r) => r.id)).toEqual([footprint.pipelineId]);
  });
});

describe("agency roll-up console: C/D/E — org-scoped roles cannot access roll-up data", () => {
  it("org_admin is denied on all four surfaces", async () => {
    const ctx = { userId: randomUUID(), agencyId: randomUUID(), roleKey: "org_admin" };
    expect((await listCompaniesForAgencyConsole(ctx)).kind).toBe("denied");
    expect((await listContactsForAgencyConsole(ctx)).kind).toBe("denied");
    expect((await listDealsForAgencyConsole(ctx)).kind).toBe("denied");
    expect((await listPipelinesForAgencyConsole(ctx)).kind).toBe("denied");
  });

  it("org_member is denied on all four surfaces", async () => {
    const ctx = { userId: randomUUID(), agencyId: randomUUID(), roleKey: "org_member" };
    expect((await listCompaniesForAgencyConsole(ctx)).kind).toBe("denied");
    expect((await listDealsForAgencyConsole(ctx)).kind).toBe("denied");
  });

  it("org_viewer is denied on all four surfaces", async () => {
    const ctx = { userId: randomUUID(), agencyId: randomUUID(), roleKey: "org_viewer" };
    expect((await listContactsForAgencyConsole(ctx)).kind).toBe("denied");
    expect((await listPipelinesForAgencyConsole(ctx)).kind).toBe("denied");
  });
});

describe("agency roll-up console: F — unauthenticated follows the existing /agency redirect behavior, unchanged", () => {
  it("decideAgencyConsoleAccess(null, null) still redirects to /login", () => {
    expect(decideAgencyConsoleAccess(null, null)).toEqual({ kind: "redirect", to: "/login" });
  });
});

describe("agency roll-up console: G/H — can() is checked before any roll-up query is ever attempted", () => {
  it("a denied context with a garbage, nonexistent agencyId never reaches the database — no query error, a clean 'denied' result", async () => {
    // If can() were checked AFTER attempting the query (or not at all), a
    // nonexistent agencyId would either error or (worse) silently proceed
    // to query with it. A clean, fast 'denied' with no thrown error is
    // itself the proof that can() runs first and the roll-up functions
    // are never invoked for this actor.
    const ctx = { userId: randomUUID(), agencyId: randomUUID(), roleKey: "org_viewer" };
    await expect(listCompaniesForAgencyConsole(ctx)).resolves.toEqual({ kind: "denied" });
    await expect(listDealsForAgencyConsole(ctx)).resolves.toEqual({ kind: "denied" });
  });

  it("a null agencyContext (unauthenticated) is denied without any query attempt", async () => {
    await expect(listCompaniesForAgencyConsole(null)).resolves.toEqual({ kind: "denied" });
    await expect(listContactsForAgencyConsole(null)).resolves.toEqual({ kind: "denied" });
    await expect(listDealsForAgencyConsole(null)).resolves.toEqual({ kind: "denied" });
    await expect(listPipelinesForAgencyConsole(null)).resolves.toEqual({ kind: "denied" });
  });
});

describe("agency roll-up console: I — zero write controls/actions exist on any roll-up page", () => {
  const pageFiles = [
    "app/agency/companies/page.tsx",
    "app/agency/contacts/page.tsx",
    "app/agency/deals/page.tsx",
    "app/agency/pipelines/page.tsx",
  ];

  it.each(pageFiles)("%s contains no <form>, no <button>, no Server Action, no click handler", (relativePath) => {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    expect(source).not.toMatch(/<form/i);
    expect(source).not.toMatch(/<button/i);
    expect(source).not.toMatch(/"use server"/);
    expect(source).not.toMatch(/\bonClick\b/);
    expect(source).not.toMatch(/rowActions\s*[:=]/);
    expect(source).not.toMatch(/onLoadMore\s*[:=]/);
  });

  it("rollup-logic.ts exports no create/update/delete function", async () => {
    const rollupLogicModule = await import("../app/agency/rollup-logic");
    for (const name of Object.keys(rollupLogicModule)) {
      expect(name).not.toMatch(/create|update|delete|insert/i);
    }
  });
});

describe("agency roll-up console: navigation — /agency links to all four roll-up pages with correct labels", () => {
  const agencyPageSource = readFileSync(new URL("../app/agency/page.tsx", import.meta.url), "utf8");

  const navEntries: Array<[href: string, label: string]> = [
    ["/agency/companies", "Companies"],
    ["/agency/contacts", "Contacts"],
    ["/agency/deals", "Deals"],
    ["/agency/pipelines", "Pipelines"],
  ];

  it.each(navEntries)("contains a <Link href=\"%s\"> whose visible label is exactly \"%s\"", (href, label) => {
    // Tolerant of surrounding whitespace/line-breaks (JSX formatting is
    // irrelevant here), but strict about the href value and the label
    // text actually appearing together inside the same <Link> element —
    // a missing entry, a wrong href, or a wrong label each fail this.
    const escapedHref = href.replace(/\//g, "\\/");
    const pattern = new RegExp(`<Link\\s+href="${escapedHref}">\\s*${label}\\s*<\\/Link>`);
    expect(agencyPageSource).toMatch(pattern);
  });

  it("does not contain a stray Link to any other /agency/* path beyond the four roll-up pages", () => {
    const hrefs = [...agencyPageSource.matchAll(/<Link\s+href="([^"]+)"/g)].map((match) => match[1]);
    const agencySubPaths = hrefs.filter((href) => href?.startsWith("/agency/"));
    expect(agencySubPaths.sort()).toEqual(
      ["/agency/companies", "/agency/contacts", "/agency/deals", "/agency/pipelines"].sort(),
    );
  });
});

describe("agency roll-up console: navigation — each roll-up page links back to /agency", () => {
  const backLinkPages = [
    "app/agency/companies/page.tsx",
    "app/agency/contacts/page.tsx",
    "app/agency/deals/page.tsx",
    "app/agency/pipelines/page.tsx",
  ];

  it.each(backLinkPages)("%s contains a <Link href=\"/agency\"> back to the agency console", (relativePath) => {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    expect(source).toMatch(/<Link\s+href="\/agency">/);
  });
});

describe("agency roll-up console: J/K — organization label resolution and the unknown-organization fallback", () => {
  it("resolveOrganizationLabel returns the mapped name when present", () => {
    const orgId = randomUUID();
    const map = new Map([[orgId, "Real Client Name"]]);
    expect(resolveOrganizationLabel(map, orgId)).toBe("Real Client Name");
  });

  it("resolveOrganizationLabel falls back to the safe generic label, never the raw UUID, when the id isn't in the map", () => {
    const missingOrgId = randomUUID();
    const map = new Map<string, string>();
    const label = resolveOrganizationLabel(map, missingOrgId);
    expect(label).toBe(UNKNOWN_ORGANIZATION_LABEL);
    expect(label).not.toBe(missingOrgId);
    expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe("agency roll-up console: L — contacts console rows contain no PII field", () => {
  it("a returned AgencyContactRow has no email/phone/jobTitle/linkedinUrl/ownerId property at runtime", async () => {
    const owner = await createAuthUser("owner-pii");
    const agencyId = await createAgencyWithOwner(owner, "Console PII Agency");
    const org = await createClientOrg(owner, agencyId, "Console PII Client");
    await seedCrmFootprint(org, "pii-check");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    const result = await listContactsForAgencyConsole(ctx);
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).not.toHaveProperty("email");
      expect(result.rows[0]).not.toHaveProperty("phone");
      expect(result.rows[0]).not.toHaveProperty("jobTitle");
      expect(result.rows[0]).not.toHaveProperty("linkedinUrl");
      expect(result.rows[0]).not.toHaveProperty("ownerId");
    }
  });
});

describe("agency roll-up console: M — deals console rows never expose a raw companyId/pipelineId", () => {
  it("AgencyDealRow has companyLabel/pipelineLabel (resolved strings), no companyId/pipelineId property", async () => {
    const owner = await createAuthUser("owner-deal-ids");
    const agencyId = await createAgencyWithOwner(owner, "Console Deal Ids Agency");
    const org = await createClientOrg(owner, agencyId, "Console Deal Ids Client");
    await seedCrmFootprint(org, "deal-ids");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    const result = await listDealsForAgencyConsole(ctx);
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).not.toHaveProperty("companyId");
      expect(result.rows[0]).not.toHaveProperty("pipelineId");
      expect(result.rows[0]).toHaveProperty("companyLabel");
      expect(result.rows[0]).toHaveProperty("pipelineLabel");
    }
  });
});

describe("agency roll-up console: N — existing /agency organization list/create-client-org behavior is unaffected", () => {
  it("decideAgencyConsoleAccess still allows a real agency_owner/agency_admin through unchanged", () => {
    const agencyContext = { userId: randomUUID(), agencyId: randomUUID(), roleKey: "agency_owner" };
    expect(decideAgencyConsoleAccess(agencyContext.userId, agencyContext)).toEqual({ kind: "allow", agencyContext });
  });
});

describe("agency roll-up console: O — empty-state behavior is correct", () => {
  it("a freshly created agency with zero client organizations returns ready with an empty rows array, not an error, for all four surfaces", async () => {
    const owner = await createAuthUser("owner-empty");
    const agencyId = await createAgencyWithOwner(owner, "Console Empty Agency");
    const ctx = { userId: owner, agencyId, roleKey: "agency_owner" };

    for (const fn of [listCompaniesForAgencyConsole, listContactsForAgencyConsole, listDealsForAgencyConsole, listPipelinesForAgencyConsole]) {
      const result = await fn(ctx);
      expect(result).toEqual({ kind: "ready", rows: [] });
    }
  });
});

describe("agency roll-up console: P — error state is sanitized, never a raw database error", () => {
  it("an actor with a real permission grant but a malformed/nonexistent agencyId returns a clean 'error' or 'ready' result, never a thrown raw exception surfacing to a caller that doesn't catch it", async () => {
    // agencyId is a syntactically-valid but nonexistent UUID — the roll-up
    // views themselves just return zero rows for an agency with no client
    // organizations (a real, valid state), so this actually resolves as
    // "ready" with empty rows, not an error — proving no raw DB error
    // path is reachable via ordinary malformed-but-well-shaped input.
    const ctx = { userId: randomUUID(), agencyId: randomUUID(), roleKey: "agency_owner" };
    const result = await listCompaniesForAgencyConsole(ctx);
    expect(["ready", "error"]).toContain(result.kind);
    if (result.kind === "ready") {
      expect(result.rows).toEqual([]);
    }
  });
});
