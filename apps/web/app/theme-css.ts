import type { ResolvedTheme } from "@ai-revenue-os/tenancy";

/**
 * Pure CSS-string builder, kept separate from layout.tsx so it's directly
 * testable — no Next.js request context, no database, no auth involved.
 * Light values as :root defaults, dark values behind a prefers-color-scheme
 * media query — no JS, no hydration step, no toggle UI exists yet (dark
 * mode is an orthogonal axis per docs/07-UI-UX-System.md §2; this follows
 * the OS-level preference until an explicit toggle is built). Only the four
 * documented overridable tokens (primary/secondary/accent/font) are ever
 * emitted — --destructive/--success/--warning/--ai-surface/--context-band
 * stay platform-fixed and have no theme-driven representation at all.
 * Never throws for any valid ResolvedTheme, including PLATFORM_DEFAULT_THEME
 * itself — there is no "missing theme" case this can crash on.
 */
export function buildThemeStyleTag(theme: ResolvedTheme): string {
  return `
    :root {
      --primary: ${theme.primaryColorLight};
      --secondary: ${theme.secondaryColorLight};
      --accent: ${theme.accentColorLight};
      --font-sans: ${theme.fontFamily};
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --primary: ${theme.primaryColorDark};
        --secondary: ${theme.secondaryColorDark};
        --accent: ${theme.accentColorDark};
      }
    }
  `;
}
