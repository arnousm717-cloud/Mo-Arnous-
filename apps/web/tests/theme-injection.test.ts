import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool, withTenantContext } from "@ai-revenue-os/database";
import { PLATFORM_DEFAULT_THEME, resolveThemeForOrganization } from "@ai-revenue-os/tenancy";
import { buildThemeStyleTag } from "../app/theme-css";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminPool = getPool();

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  const client = await adminPool.connect();
  try {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `theme-injection-${label}-${userId}@example.test`,
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
      `theme-injection-${randomUUID()}`,
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
      [name, `theme-injection-client-${randomUUID()}`, agencyId, userId],
    );
    return r.rows[0];
  });
  return result.organization_id as string;
}

afterAll(async () => {
  await closePool();
});

describe("theme resolution feeding the app shell (docs/07-UI-UX-System.md §2)", () => {
  it("a non-agency (standalone) organization resolves the platform default theme", async () => {
    const userId = await createAuthUser("standalone");
    const orgId = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "Theme Injection Standalone Org",
        `theme-injection-standalone-${randomUUID()}`,
        userId,
      ]);
      return r.rows[0].organization_id as string;
    });

    const theme = await resolveThemeForOrganization({ userId, organizationId: orgId });
    expect(theme.source).toBe("platform-default");
    expect(theme.primaryColorLight).toBe(PLATFORM_DEFAULT_THEME.primaryColorLight);
  });

  it("a client organization inherits its agency's real theme", async () => {
    const owner = await createAuthUser("agency-theme-owner");
    const agencyId = await createAgencyWithOwner(owner, "Theme Injection Agency");
    await withTenantContext({ userId: owner, agencyId, roleKey: "agency_owner" }, async (client) => {
      await client.query(
        "insert into public.brand_themes (agency_id, primary_color_light, primary_color_dark, font_family) values ($1, $2, $3, $4)",
        [agencyId, "#112233", "#445566", "Custom Font, sans-serif"],
      );
    });
    const orgId = await createClientOrg(owner, agencyId, "Theme Injection Client");

    const theme = await resolveThemeForOrganization({ userId: owner, organizationId: orgId });
    expect(theme.source).toBe("agency");
    expect(theme.primaryColorLight).toBe("#112233");
    expect(theme.primaryColorDark).toBe("#445566");
    expect(theme.fontFamily).toBe("Custom Font, sans-serif");
  });
});

describe("buildThemeStyleTag(): server-rendered CSS variable injection", () => {
  it("emits both the light (:root default) and dark (media query) variable blocks with the correct respective values", () => {
    const css = buildThemeStyleTag({
      source: "agency",
      logoUrl: null,
      faviconUrl: null,
      primaryColorLight: "#AAA111",
      primaryColorDark: "#BBB222",
      secondaryColorLight: "#CCC333",
      secondaryColorDark: "#DDD444",
      accentColorLight: "#EEE555",
      accentColorDark: "#FFF666",
      fontFamily: "Test Font, sans-serif",
    });

    // Light values as :root defaults.
    expect(css).toContain("--primary: #AAA111;");
    expect(css).toContain("--secondary: #CCC333;");
    expect(css).toContain("--accent: #EEE555;");
    expect(css).toContain("--font-sans: Test Font, sans-serif;");

    // Dark values behind the media query.
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("--primary: #BBB222;");
    expect(css).toContain("--secondary: #DDD444;");
    expect(css).toContain("--accent: #FFF666;");

    // Only the four documented overridable tokens — nothing else invented.
    expect(css).not.toContain("--destructive");
    expect(css).not.toContain("--success");
    expect(css).not.toContain("--warning");
    expect(css).not.toContain("--ai-surface");
    expect(css).not.toContain("--context-band");
  });

  it("never crashes for the platform default theme — the no-theme-at-all case", () => {
    expect(() => buildThemeStyleTag({ ...PLATFORM_DEFAULT_THEME, source: "platform-default" })).not.toThrow();
    const css = buildThemeStyleTag({ ...PLATFORM_DEFAULT_THEME, source: "platform-default" });
    expect(css).toContain(PLATFORM_DEFAULT_THEME.primaryColorLight);
    expect(css).toContain(PLATFORM_DEFAULT_THEME.primaryColorDark);
  });

  it("a real agency theme's resolved values flow through to the exact CSS emitted", async () => {
    const owner = await createAuthUser("css-flow-owner");
    const agencyId = await createAgencyWithOwner(owner, "Theme Injection CSS Flow Agency");
    await withTenantContext({ userId: owner, agencyId, roleKey: "agency_owner" }, async (client) => {
      await client.query("insert into public.brand_themes (agency_id, accent_color_light) values ($1, $2)", [
        agencyId,
        "#00FF00",
      ]);
    });
    const orgId = await createClientOrg(owner, agencyId, "CSS Flow Client");

    const theme = await resolveThemeForOrganization({ userId: owner, organizationId: orgId });
    const css = buildThemeStyleTag(theme);

    expect(css).toContain("--accent: #00FF00;");
  });
});

/**
 * "Server-rendered output contains resolved values without requiring
 * client hydration" is, by construction, an architectural property rather
 * than something with a runtime test in this project: apps/web/app/layout.tsx
 * is an async Server Component (no "use client" directive, no useState/
 * useEffect anywhere in it) whose <style>{themeStyle}</style> content is
 * plain text computed during the server render itself — there is no
 * client-side step that could introduce a flash, because there is no
 * client-side code involved in producing this output at all. This project
 * has no component-rendering test harness (no jsdom/testing-library) to
 * assert that at runtime; buildThemeStyleTag()'s tests above cover the
 * value-correctness half of the claim, and this comment records the
 * structural half for anyone auditing the claim later.
 */
