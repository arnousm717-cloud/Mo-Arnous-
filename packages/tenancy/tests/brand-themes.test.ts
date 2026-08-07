import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenantContext } from "@ai-revenue-os/database";
import { resolveThemeForAgency, resolveThemeForOrganization } from "../src/theme";

// Same well-known local Supabase CLI demo keys used throughout this
// monorepo's test suites — never valid against a real project.
const API_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface Tenant {
  userId: string;
  agencyId: string;
}

async function createAuthUser(label: string): Promise<string> {
  const email = `brand-themes-${label}-${randomUUID()}@example.test`;
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
      `brand-themes-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.agency_id as string;
}

async function createClientOrg(userId: string, agencyId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query(
      "select * from public.create_client_organization_for_agency($1, $2, $3, $4)",
      [name, `brand-themes-client-${randomUUID()}`, agencyId, userId],
    );
    return r.rows[0];
  });
  return result.organization_id as string;
}

async function createTenant(label: string): Promise<Tenant> {
  const userId = await createAuthUser(label);
  const agencyId = await createAgencyWithOwner(userId, `Brand Themes ${label} Agency`);
  return { userId, agencyId };
}

async function insertBrandTheme(
  userId: string,
  agencyId: string,
  overrides: Record<string, string> = {},
): Promise<void> {
  const columns = Object.keys(overrides);
  const values = Object.values(overrides);
  const columnsSql = ["agency_id", ...columns].join(", ");
  const placeholders = ["$1", ...columns.map((_, i) => `$${i + 2}`)].join(", ");

  await withTenantContext({ userId, agencyId, roleKey: "agency_owner" }, async (client) => {
    await client.query(
      `insert into public.brand_themes (${columnsSql}) values (${placeholders})`,
      [agencyId, ...values],
    );
  });
}

const cleanupUserIds: string[] = [];

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await adminClient.auth.admin.deleteUser(id);
  }
  await closePool();
});

describe("resolveThemeForOrganization(): DB-backed fallback and agency inheritance", () => {
  it("falls back to the platform default when the organization belongs to no agency", async () => {
    const userId = await createAuthUser("standalone-org");
    cleanupUserIds.push(userId);
    const orgId = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "Standalone Org",
        `brand-themes-standalone-${randomUUID()}`,
        userId,
      ]);
      return r.rows[0].organization_id as string;
    });

    const theme = await resolveThemeForOrganization({ userId, organizationId: orgId });
    expect(theme.source).toBe("platform-default");
  });

  it("falls back to the platform default when the agency exists but has no brand_themes row yet", async () => {
    const tenant = await createTenant("no-theme-yet");
    cleanupUserIds.push(tenant.userId);
    const orgId = await createClientOrg(tenant.userId, tenant.agencyId, "No Theme Yet Client");

    const theme = await resolveThemeForOrganization({ userId: tenant.userId, organizationId: orgId });
    expect(theme.source).toBe("platform-default");
  });

  it("an organization inherits its agency's real brand theme", async () => {
    const tenant = await createTenant("real-theme");
    cleanupUserIds.push(tenant.userId);
    await insertBrandTheme(tenant.userId, tenant.agencyId, {
      primary_color_light: "#123456",
      font_family: "Custom Sans, sans-serif",
    });
    const orgId = await createClientOrg(tenant.userId, tenant.agencyId, "Real Theme Client");

    const theme = await resolveThemeForOrganization({ userId: tenant.userId, organizationId: orgId });
    expect(theme.source).toBe("agency");
    expect(theme.primaryColorLight).toBe("#123456");
    expect(theme.fontFamily).toBe("Custom Sans, sans-serif");
  });
});

describe("brand_themes: unique-per-agency and cross-agency isolation", () => {
  it("a second brand_themes row for the same agency is rejected by the DB constraint", async () => {
    const tenant = await createTenant("unique-constraint");
    cleanupUserIds.push(tenant.userId);
    await insertBrandTheme(tenant.userId, tenant.agencyId);

    await expect(insertBrandTheme(tenant.userId, tenant.agencyId)).rejects.toThrow();
  });

  it("agency A cannot read agency B's brand_themes row directly", async () => {
    const tenantA = await createTenant("isolation-a");
    cleanupUserIds.push(tenantA.userId);
    const tenantB = await createTenant("isolation-b");
    cleanupUserIds.push(tenantB.userId);
    await insertBrandTheme(tenantB.userId, tenantB.agencyId, { primary_color_light: "#B00B00" });

    const rows = await withTenantContext(
      { userId: tenantA.userId, agencyId: tenantA.agencyId, roleKey: "agency_owner" },
      async (client) => {
        const r = await client.query("select id from public.brand_themes where agency_id = $1", [
          tenantB.agencyId,
        ]);
        return r.rows;
      },
    );
    expect(rows).toHaveLength(0);
  });

  it("agency A's own theme resolution never returns agency B's colors, even for orgs under agency A", async () => {
    const tenantA = await createTenant("resolution-isolation-a");
    cleanupUserIds.push(tenantA.userId);
    const tenantB = await createTenant("resolution-isolation-b");
    cleanupUserIds.push(tenantB.userId);
    await insertBrandTheme(tenantA.userId, tenantA.agencyId, { primary_color_light: "#AAAAAA" });
    await insertBrandTheme(tenantB.userId, tenantB.agencyId, { primary_color_light: "#BBBBBB" });
    const orgA = await createClientOrg(tenantA.userId, tenantA.agencyId, "Isolation A Client");

    const theme = await resolveThemeForOrganization({ userId: tenantA.userId, organizationId: orgA });
    expect(theme.primaryColorLight).toBe("#AAAAAA");
    expect(theme.primaryColorLight).not.toBe("#BBBBBB");
  });

  it("resolveThemeForAgency resolves the caller's own agency theme directly", async () => {
    const tenant = await createTenant("agency-side-resolution");
    cleanupUserIds.push(tenant.userId);
    await insertBrandTheme(tenant.userId, tenant.agencyId, { primary_color_light: "#654321" });

    const theme = await resolveThemeForAgency({ userId: tenant.userId, agencyId: tenant.agencyId });
    expect(theme.source).toBe("agency");
    expect(theme.primaryColorLight).toBe("#654321");
  });
});

describe("brand_themes_hex_colors CHECK constraint", () => {
  it("rejects a malformed hex color", async () => {
    const tenant = await createTenant("bad-hex");
    cleanupUserIds.push(tenant.userId);

    await expect(
      insertBrandTheme(tenant.userId, tenant.agencyId, { primary_color_light: "not-a-color" }),
    ).rejects.toThrow(/brand_themes_hex_colors/);
  });
});
