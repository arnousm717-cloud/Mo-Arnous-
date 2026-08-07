/**
 * WCAG 2.x contrast checking and hue-preserving auto-adjustment
 * (docs/07-UI-UX-System.md §2: "the editor doesn't hard-block theme
 * creation outright — it offers an automatically-adjusted variant").
 *
 * Pure functions, no I/O, no framework dependency — deliberately kept
 * provider-agnostic so this logic is reusable wherever a color needs
 * validating, not just from a future theme-editor UI.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const HEX_PATTERN = /^#([0-9a-fA-F]{6})$/;

export function hexToRgb(hex: string): Rgb {
  const match = HEX_PATTERN.exec(hex);
  if (!match) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const value = match[1] as string;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function toHexByte(n: number): string {
  return Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`.toUpperCase();
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** WCAG relative luminance (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const linearize = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const rLin = linearize(r);
  const gLin = linearize(g);
  const bLin = linearize(b);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/** WCAG contrast ratio between two colors, always >= 1. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA thresholds: 4.5:1 for normal text, 3:1 for large text/UI components. */
export const WCAG_AA_NORMAL_TEXT_RATIO = 4.5;
export const WCAG_AA_LARGE_TEXT_RATIO = 3;

export function meetsWcagAA(
  foregroundHex: string,
  backgroundHex: string,
  minRatio: number = WCAG_AA_NORMAL_TEXT_RATIO,
): boolean {
  return contrastRatio(foregroundHex, backgroundHex) >= minRatio;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rNorm) {
      h = 60 * (((gNorm - bNorm) / delta) % 6);
    } else if (max === gNorm) {
      h = 60 * ((bNorm - rNorm) / delta + 2);
    } else {
      h = 60 * ((rNorm - gNorm) / delta + 4);
    }
  }
  if (h < 0) h += 360;

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;
  if (h < 60) {
    [rPrime, gPrime, bPrime] = [c, x, 0];
  } else if (h < 120) {
    [rPrime, gPrime, bPrime] = [x, c, 0];
  } else if (h < 180) {
    [rPrime, gPrime, bPrime] = [0, c, x];
  } else if (h < 240) {
    [rPrime, gPrime, bPrime] = [0, x, c];
  } else if (h < 300) {
    [rPrime, gPrime, bPrime] = [x, 0, c];
  } else {
    [rPrime, gPrime, bPrime] = [c, 0, x];
  }

  return {
    r: (rPrime + m) * 255,
    g: (gPrime + m) * 255,
    b: (bPrime + m) * 255,
  };
}

export interface ContrastAdjustmentResult {
  color: string;
  adjusted: boolean;
}

/**
 * Returns foregroundHex unchanged if it already meets minRatio against
 * backgroundHex ("avoid modifying already-compliant colors unnecessarily").
 * Otherwise searches for the smallest possible change to the color's HSL
 * lightness — hue and saturation are never touched — that brings it into
 * compliance, always moving toward whichever end of the lightness scale
 * increases contrast against the given background (darker against a light
 * background, lighter against a dark one).
 *
 * Binary search relies on relative luminance increasing monotonically with
 * HSL lightness for a fixed hue/saturation, which holds for the standard
 * HSL model used here.
 */
export function ensureContrast(
  foregroundHex: string,
  backgroundHex: string,
  minRatio: number = WCAG_AA_NORMAL_TEXT_RATIO,
): ContrastAdjustmentResult {
  if (contrastRatio(foregroundHex, backgroundHex) >= minRatio) {
    return { color: foregroundHex.toUpperCase(), adjusted: false };
  }

  const original = rgbToHsl(hexToRgb(foregroundHex));
  const backgroundLuminance = relativeLuminance(hexToRgb(backgroundHex));
  // Darkening the foreground increases contrast against a lighter
  // background; lightening it increases contrast against a darker one.
  const goDarker = backgroundLuminance > relativeLuminance(hexToRgb(foregroundHex));

  const contrastAtLightness = (l: number): number =>
    contrastRatio(rgbToHex(hslToRgb({ h: original.h, s: original.s, l })), backgroundHex);

  let lo = goDarker ? 0 : original.l;
  let hi = goDarker ? original.l : 100;

  // Guard: if even the most extreme lightness (pure black/white at this
  // hue/saturation) can't reach minRatio, that extreme is the best
  // available answer — still an improvement over the original, never worse.
  const extreme = goDarker ? lo : hi;
  if (contrastAtLightness(extreme) < minRatio) {
    return { color: rgbToHex(hslToRgb({ h: original.h, s: original.s, l: extreme })), adjusted: true };
  }

  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    const passes = contrastAtLightness(mid) >= minRatio;
    if (goDarker) {
      // Want the LARGEST l (closest to original) that still passes.
      if (passes) lo = mid;
      else hi = mid;
    } else {
      // Want the SMALLEST l (closest to original) that still passes.
      if (passes) hi = mid;
      else lo = mid;
    }
  }

  const finalLightness = goDarker ? lo : hi;
  return {
    color: rgbToHex(hslToRgb({ h: original.h, s: original.s, l: finalLightness })),
    adjusted: true,
  };
}
