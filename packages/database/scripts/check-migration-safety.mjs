// M1.9 migration-safety CI gate (docs/13-Technical-Design-Review.md
// §M1.9). Reads every migration file under supabase/migrations and
// classifies it with classifyMigrationSql() — reused unchanged, no
// detection logic duplicated here.
//
// Purely local file analysis: no database connection, no network request,
// no environment variable is ever read, no credential of any kind is
// required. Exits 0 only when every migration is either free of
// destructive top-level statements or carries a valid, committed override.
// Exits non-zero otherwise, identifying the offending file and the exact
// destructive categories found — never the full migration text, never
// anything beyond what the finding itself needs to be actionable.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMigrationSql } from "../src/migration-safety.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../supabase/migrations");

function main() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let unsafeCount = 0;

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = readFileSync(fullPath, "utf8");
    const result = classifyMigrationSql(sql);

    if (result.malformed) {
      unsafeCount += 1;
      console.error(`UNSAFE  ${file} — could not be safely analyzed: ${result.malformedReason}`);
      continue;
    }

    if (result.findings.length === 0) {
      continue;
    }

    const categories = [...new Set(result.findings.map((f) => f.category))].join(", ");

    if (result.overridePresent) {
      // Always visible, even when it passes — an override must never be a
      // silent pass.
      console.log(`OVERRIDDEN  ${file} — destructive categories: ${categories} — reason: ${result.overrideReason}`);
      continue;
    }

    unsafeCount += 1;
    console.error(`UNSAFE  ${file} — destructive categories: ${categories}`);
    for (const finding of result.findings) {
      console.error(`  [${finding.category}] ${finding.statement}`);
    }
  }

  if (unsafeCount > 0) {
    console.error("");
    console.error(
      `Migration safety gate failed: ${unsafeCount} migration(s) contain an unreviewed destructive operation.`,
    );
    console.error(
      'If this is genuinely intentional, add both of the following as comments in that migration file: ' +
        '"-- migration-safety: destructive-override" and "-- migration-safety-reason: <why this is safe>".',
    );
    process.exit(1);
  }

  console.log(`Migration safety gate passed: ${files.length} migration(s) checked.`);
}

main();
