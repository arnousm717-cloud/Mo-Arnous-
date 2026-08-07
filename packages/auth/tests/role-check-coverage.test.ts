import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M1.5's TDR exit criterion: "an automated (even simple grep-based) check
 * confirms no handler bypasses the facade" — this is that check, run as a
 * normal test rather than a manual audit. It scans every non-test
 * application source file for the six seeded role-key string literals
 * (docs/03-Database-Architecture.md §2.1's roles.key CHECK constraint) —
 * finding one anywhere outside packages/auth/src/permissions.ts (the one
 * file allowed to know what the role keys are) is a strong signal of a
 * direct role comparison bypassing can(), the exact class of bug this
 * milestone exists to make structurally rare, not just discouraged.
 *
 * Deliberately excluded: test files (fixtures legitimately construct real
 * role-key strings), .sql migrations (RLS/SECURITY DEFINER role checks are
 * a separate, intentional enforcement layer — see ADR-005/docs/08 §2, "RBAC
 * must NOT replace or weaken RLS"), and node_modules/.next/build output.
 */

const ROLE_KEYS = ["agency_owner", "agency_admin", "org_admin", "org_member", "org_viewer", "portal_customer"];

const repoRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not locate repo root (pnpm-workspace.yaml not found)");
    dir = parent;
  }
  return dir;
})();

const SCAN_ROOTS = [join(repoRoot, "apps", "web", "app"), join(repoRoot, "packages", "auth", "src"), join(repoRoot, "packages", "tenancy", "src")];

const ALLOWED_FILE = join(repoRoot, "packages", "auth", "src", "permissions.ts");

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(fullPath, files);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("role-key string literals never appear outside packages/auth/src/permissions.ts (route/handler coverage check)", () => {
  it("no application source file (excluding tests and permissions.ts itself) contains a raw role-key string literal", () => {
    const offenders: { file: string; role: string }[] = [];

    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walk(root)) {
        if (file === ALLOWED_FILE) continue;
        const content = readFileSync(file, "utf-8");
        for (const role of ROLE_KEYS) {
          if (content.includes(`"${role}"`) || content.includes(`'${role}'`)) {
            offenders.push({ file: relative(repoRoot, file), role });
          }
        }
      }
    }

    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it("sanity check: the scan itself actually finds role-key literals when they're present (proves the check isn't silently vacuous)", () => {
    // permissions.ts is deliberately excluded above — confirm it DOES
    // contain every role key, so we know the pattern-match itself works
    // and the empty result above is a real "nothing found", not a broken
    // scan finding nothing because nothing was ever checked.
    const content = readFileSync(ALLOWED_FILE, "utf-8");
    for (const role of ROLE_KEYS) {
      expect(content.includes(`"${role}"`) || content.includes(`'${role}'`)).toBe(true);
    }
  });
});
