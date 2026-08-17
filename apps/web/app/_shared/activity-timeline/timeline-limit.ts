/**
 * Milestone 2.3E. Split out from section.tsx deliberately — a pure,
 * JSX-free utility, importable from a test file (or anywhere else)
 * without pulling in React/JSX parsing at all. Mirrors the existing
 * owner-option.ts/owner-options.ts split precedent (pure helpers kept
 * out of the file with real framework-specific side effects).
 */

export const DEFAULT_TIMELINE_LIMIT = 10;
export const TIMELINE_LIMIT_INCREMENT = 10;
export const MAX_TIMELINE_LIMIT = 100;

export function parseTimelineLimit(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : DEFAULT_TIMELINE_LIMIT;
  if (!Number.isInteger(parsed) || parsed < DEFAULT_TIMELINE_LIMIT) {
    return DEFAULT_TIMELINE_LIMIT;
  }
  return Math.min(parsed, MAX_TIMELINE_LIMIT);
}
