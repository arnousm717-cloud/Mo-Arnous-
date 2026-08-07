import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  ensureContrast,
  meetsWcagAA,
  rgbToHsl,
  hexToRgb,
  WCAG_AA_NORMAL_TEXT_RATIO,
} from "../src/contrast";

/**
 * Real WCAG 2.x contrast math, tested against known reference values (black
 * on white = 21:1 is the textbook maximum) — not just internal
 * self-consistency. M1.4 TDR requirement: "needs a test with a genuinely
 * non-compliant color — a compliant-only test leaves the fallback path
 * unverified."
 */
describe("contrastRatio() / meetsWcagAA()", () => {
  it("black on white is the maximum possible ratio, 21:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
  });

  it("identical colors have a ratio of exactly 1", () => {
    expect(contrastRatio("#3B5BFD", "#3B5BFD")).toBeCloseTo(1, 5);
  });

  it("is symmetric — argument order doesn't matter", () => {
    expect(contrastRatio("#3B5BFD", "#FFFFFF")).toBeCloseTo(contrastRatio("#FFFFFF", "#3B5BFD"), 10);
  });

  it("a genuinely failing pair (light gray on white) does not meet WCAG AA", () => {
    // #CCCCCC on #FFFFFF is a well-known real-world failing case,
    // ~1.6:1 — nowhere near the 4.5:1 normal-text threshold.
    expect(meetsWcagAA("#CCCCCC", "#FFFFFF")).toBe(false);
    expect(contrastRatio("#CCCCCC", "#FFFFFF")).toBeLessThan(WCAG_AA_NORMAL_TEXT_RATIO);
  });

  it("a genuinely compliant pair (black on white) meets WCAG AA", () => {
    expect(meetsWcagAA("#000000", "#FFFFFF")).toBe(true);
  });
});

describe("ensureContrast(): auto-adjust fallback", () => {
  it("a genuinely non-compliant color is corrected until it passes", () => {
    const background = "#FFFFFF";
    const failingForeground = "#CCCCCC";
    expect(meetsWcagAA(failingForeground, background)).toBe(false);

    const result = ensureContrast(failingForeground, background);

    expect(result.adjusted).toBe(true);
    expect(meetsWcagAA(result.color, background)).toBe(true);
  });

  it("preserves hue as much as reasonably possible — only lightness changes", () => {
    // A genuinely hued failing color, not a true gray (r=g=b), since hue is
    // undefined at zero saturation and wouldn't meaningfully test this.
    const background = "#FFFFFF";
    const failingBlue = "#AAB4FF"; // light, desaturated-ish blue — fails on white
    expect(meetsWcagAA(failingBlue, background)).toBe(false);

    const result = ensureContrast(failingBlue, background);
    const originalHsl = rgbToHsl(hexToRgb(failingBlue));
    const adjustedHsl = rgbToHsl(hexToRgb(result.color));

    expect(adjustedHsl.h).toBeCloseTo(originalHsl.h, 0);
    expect(adjustedHsl.s).toBeCloseTo(originalHsl.s, 0);
    expect(result.adjusted).toBe(true);
  });

  it("darkens a foreground that's too light for a light background", () => {
    const result = ensureContrast("#CCCCCC", "#FFFFFF");
    const originalLightness = rgbToHsl(hexToRgb("#CCCCCC")).l;
    const adjustedLightness = rgbToHsl(hexToRgb(result.color)).l;
    expect(adjustedLightness).toBeLessThan(originalLightness);
  });

  it("lightens a foreground that's too dark for a dark background", () => {
    const background = "#0B0E14"; // platform dark background
    const failingForeground = "#1A1F2E"; // close to the dark background, fails
    expect(meetsWcagAA(failingForeground, background)).toBe(false);

    const result = ensureContrast(failingForeground, background);
    const originalLightness = rgbToHsl(hexToRgb(failingForeground)).l;
    const adjustedLightness = rgbToHsl(hexToRgb(result.color)).l;

    expect(adjustedLightness).toBeGreaterThan(originalLightness);
    expect(meetsWcagAA(result.color, background)).toBe(true);
  });

  it("an already-compliant color is returned unchanged — never modified unnecessarily", () => {
    const background = "#FFFFFF";
    const compliantForeground = "#000000";
    expect(meetsWcagAA(compliantForeground, background)).toBe(true);

    const result = ensureContrast(compliantForeground, background);

    expect(result.adjusted).toBe(false);
    expect(result.color).toBe(compliantForeground.toUpperCase());
  });

  it("a borderline-but-already-compliant color is not needlessly mangled", () => {
    // Find a color right at/above the threshold and confirm it passes through untouched.
    const background = "#FFFFFF";
    const borderline = "#767676"; // a commonly-cited ~4.5:1-on-white reference gray
    expect(meetsWcagAA(borderline, background)).toBe(true);

    const result = ensureContrast(borderline, background);
    expect(result.adjusted).toBe(false);
    expect(result.color).toBe(borderline.toUpperCase());
  });
});
