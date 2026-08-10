import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M1.7 TDR manual QA item: "Attempt to access internal key issuance from an
 * unauthenticated/tenant context, confirm denial." There is no HTTP route
 * at all for key issuance (M1.7 Decision B) — the automated equivalent of
 * that manual check is proving no application source file under
 * apps/web/app references the issuance script, matching the
 * role-check-coverage.test.ts pattern already established for can()
 * bypass detection in M1.5.
 */

const repoRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not locate repo root (pnpm-workspace.yaml not found)");
    dir = parent;
  }
  return dir;
})();

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(fullPath, files);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("issue-api-key.mjs is unreachable from any apps/web route (M1.7 Decision B)", () => {
  it("no file under apps/web/app references issue-api-key", () => {
    const webAppRoot = join(repoRoot, "apps", "web", "app");
    const offenders: string[] = [];

    if (existsSync(webAppRoot)) {
      for (const file of walk(webAppRoot)) {
        const content = readFileSync(file, "utf-8");
        if (content.includes("issue-api-key")) {
          offenders.push(file);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the issuance script requires DATABASE_URL directly — it is not an HTTP handler and exports no route-callable shape", () => {
    const scriptPath = join(repoRoot, "packages", "database", "scripts", "issue-api-key.mjs");
    const content = readFileSync(scriptPath, "utf-8");
    // No Next.js route-handler export names (GET/POST/etc.) anywhere in the
    // file — a cheap, direct check that this could never accidentally be
    // picked up as a route.ts-style module.
    expect(content).not.toMatch(/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/);
    expect(content).toContain("process.env.DATABASE_URL");
  });
});
