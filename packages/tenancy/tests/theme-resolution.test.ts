import { describe, expect, it } from "vitest";
import { PLATFORM_DEFAULT_THEME, resolveTheme } from "../src/theme";

/**
 * Pure resolveTheme() tests — no database needed. Covers all three layers
 * of docs/07-UI-UX-System.md §2's resolution model, including the dormant
 * third layer (M1.4 TDR's required test: "Theme-resolution unit tests (all
 * 3 layers, even with 1 dormant)").
 */
describe("resolveTheme(): three-layer resolution", () => {
  it("falls back to the platform default when no agency theme exists", () => {
    const result = resolveTheme({});
    expect(result.source).toBe("platform-default");
    expect(result.primaryColorLight).toBe(PLATFORM_DEFAULT_THEME.primaryColorLight);
    expect(result.secondaryColorDark).toBe(PLATFORM_DEFAULT_THEME.secondaryColorDark);
    expect(result.fontFamily).toBe(PLATFORM_DEFAULT_THEME.fontFamily);
  });

  it("an agency theme overrides the platform default", () => {
    const result = resolveTheme({
      agencyTheme: {
        primaryColorLight: "#FF0000",
        primaryColorDark: "#CC0000",
        logoUrl: "https://example.test/logo.png",
      },
    });
    expect(result.source).toBe("agency");
    expect(result.primaryColorLight).toBe("#FF0000");
    expect(result.primaryColorDark).toBe("#CC0000");
    expect(result.logoUrl).toBe("https://example.test/logo.png");
    // Fields the agency theme didn't override still fall through to the
    // platform default, not to some blank/undefined value.
    expect(result.secondaryColorLight).toBe(PLATFORM_DEFAULT_THEME.secondaryColorLight);
    expect(result.accentColorDark).toBe(PLATFORM_DEFAULT_THEME.accentColorDark);
  });

  it("the dormant organization-override layer takes precedence over the agency theme when present", () => {
    // No real caller populates organizationOverride yet (docs/07 §2: layer
    // 3 is "optional, later phase") — this proves the *resolver itself*
    // already gets the precedence right, so wiring up a real data source
    // for it later is additive, not a rework.
    const result = resolveTheme({
      agencyTheme: { primaryColorLight: "#FF0000" },
      organizationOverride: { primaryColorLight: "#00FF00" },
    });
    expect(result.source).toBe("organization-override");
    expect(result.primaryColorLight).toBe("#00FF00");
  });

  it("an organization override falls back through to the agency theme, not the platform default, for fields it doesn't set", () => {
    const result = resolveTheme({
      agencyTheme: { primaryColorLight: "#FF0000", secondaryColorLight: "#AAAAAA" },
      organizationOverride: { primaryColorLight: "#00FF00" },
    });
    expect(result.primaryColorLight).toBe("#00FF00"); // org override wins here
    expect(result.secondaryColorLight).toBe("#AAAAAA"); // falls through to agency, not platform default
  });

  it("an explicit null agencyTheme (agency exists but has no theme row) resolves the same as no agency theme at all", () => {
    const result = resolveTheme({ agencyTheme: null });
    expect(result.source).toBe("platform-default");
    expect(result).toEqual({ ...PLATFORM_DEFAULT_THEME, source: "platform-default" });
  });
});
