import { withTenantContext } from "@ai-revenue-os/database";

/**
 * Server-side theme resolution (docs/07-UI-UX-System.md §2): three layers,
 * resolved in order of specificity — platform default -> agency theme ->
 * per-organization override. Layer 3 is dormant (no data source exists for
 * it yet — "optional, later phase" per docs/07 §2) but the resolver already
 * accepts it, so wiring it up later is additive, not a rework (this is the
 * exact concern the M1.4 TDR's Engineering risk row #1 named).
 *
 * Only --primary/--secondary/--accent and the logo/favicon/font are
 * overridable — --destructive/--success/--warning/--ai-surface/
 * --context-band are platform-fixed everywhere and deliberately have no
 * representation here at all.
 */

export interface ThemeOverride {
  logoUrl?: string | null;
  faviconUrl?: string | null;
  primaryColorLight?: string;
  primaryColorDark?: string;
  secondaryColorLight?: string;
  secondaryColorDark?: string;
  accentColorLight?: string;
  accentColorDark?: string;
  fontFamily?: string;
}

export type ThemeSource = "platform-default" | "agency" | "organization-override";

export interface ResolvedTheme {
  source: ThemeSource;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColorLight: string;
  primaryColorDark: string;
  secondaryColorLight: string;
  secondaryColorDark: string;
  accentColorLight: string;
  accentColorDark: string;
  fontFamily: string;
}

/** docs/07-UI-UX-System.md §3's exact platform default palette values. */
export const PLATFORM_DEFAULT_THEME: Omit<ResolvedTheme, "source"> = {
  logoUrl: null,
  faviconUrl: null,
  primaryColorLight: "#3B5BFD",
  primaryColorDark: "#5B7BFF",
  secondaryColorLight: "#0F1420",
  secondaryColorDark: "#1E2433",
  accentColorLight: "#0EA5A0",
  accentColorDark: "#14C8C2",
  fontFamily: "Inter, sans-serif",
};

/**
 * Pure merge of the three layers — no I/O, directly unit-testable without a
 * database, including the dormant third layer (pass a fake
 * organizationOverride in a test to prove precedence works, even though no
 * real caller populates it yet).
 */
export function resolveTheme(layers: {
  agencyTheme?: ThemeOverride | null;
  organizationOverride?: ThemeOverride | null;
}): ResolvedTheme {
  const withAgency = { ...PLATFORM_DEFAULT_THEME, ...stripUndefined(layers.agencyTheme) };
  const withOverride = { ...withAgency, ...stripUndefined(layers.organizationOverride) };

  const source: ThemeSource = layers.organizationOverride
    ? "organization-override"
    : layers.agencyTheme
      ? "agency"
      : "platform-default";

  return { ...withOverride, source };
}

function stripUndefined(override: ThemeOverride | null | undefined): Partial<ResolvedTheme> {
  if (!override) return {};
  const entries = Object.entries(override).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<ResolvedTheme>;
}

interface BrandThemeRow {
  logo_url: string | null;
  favicon_url: string | null;
  primary_color_light: string;
  primary_color_dark: string;
  secondary_color_light: string;
  secondary_color_dark: string;
  accent_color_light: string;
  accent_color_dark: string;
  font_family: string;
}

function rowToOverride(row: BrandThemeRow): ThemeOverride {
  return {
    logoUrl: row.logo_url,
    faviconUrl: row.favicon_url,
    primaryColorLight: row.primary_color_light,
    primaryColorDark: row.primary_color_dark,
    secondaryColorLight: row.secondary_color_light,
    secondaryColorDark: row.secondary_color_dark,
    accentColorLight: row.accent_color_light,
    accentColorDark: row.accent_color_dark,
    fontFamily: row.font_family,
  };
}

/**
 * Resolves the theme for a given organization: reads brand_themes for the
 * agency that owns it (via the brand_themes_via_own_organization_select RLS
 * policy — never a client-supplied agency id), falling back cleanly to the
 * platform default when the organization has no agency, or the agency has
 * no theme row yet. Layer 3 (organization override) is always null here —
 * no data source for it exists yet.
 */
export async function resolveThemeForOrganization(ctx: {
  userId: string;
  organizationId: string;
}): Promise<ResolvedTheme> {
  const row = await withTenantContext(ctx, async (client) => {
    const r = await client.query<BrandThemeRow>(
      `select bt.logo_url, bt.favicon_url,
              bt.primary_color_light, bt.primary_color_dark,
              bt.secondary_color_light, bt.secondary_color_dark,
              bt.accent_color_light, bt.accent_color_dark,
              bt.font_family
       from public.brand_themes bt
       join public.organizations o on o.agency_id = bt.agency_id
       where o.id = $1`,
      [ctx.organizationId],
    );
    return r.rows[0] ?? null;
  });

  return resolveTheme({
    agencyTheme: row ? rowToOverride(row) : null,
    organizationOverride: null,
  });
}

/** Resolves an agency's own theme directly (for agency-side theme
 * management, not org-facing rendering) — falls back to the platform
 * default when the agency has no brand_themes row yet. */
export async function resolveThemeForAgency(ctx: {
  userId: string;
  agencyId: string;
}): Promise<ResolvedTheme> {
  const row = await withTenantContext(ctx, async (client) => {
    const r = await client.query<BrandThemeRow>(
      `select logo_url, favicon_url,
              primary_color_light, primary_color_dark,
              secondary_color_light, secondary_color_dark,
              accent_color_light, accent_color_dark,
              font_family
       from public.brand_themes
       where agency_id = $1`,
      [ctx.agencyId],
    );
    return r.rows[0] ?? null;
  });

  return resolveTheme({
    agencyTheme: row ? rowToOverride(row) : null,
    organizationOverride: null,
  });
}
