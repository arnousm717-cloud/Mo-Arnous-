// Milestone 4.1 Phase 2: Brain backfill/bootstrap CLI entry point (Detailed
// Design §L). Deliberately a human/operator-run script, not an HTTP route
// or API — matches issue-api-key.mjs's own established precedent for
// internal-only, no-platform-operator-auth-mechanism-yet operations.
// bootstrapBrainForOrganization itself is tenant-scoped, idempotent, and
// resumable (packages/brain/src/backfill.ts) — this script is only a thin
// invocation wrapper, never a second projection implementation.
//
// Usage:
//
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
//     node scripts/brain-backfill.mjs --org <organization-uuid>
//
//   DATABASE_URL="..." node scripts/brain-backfill.mjs --all

import pg from "pg";
import { bootstrapBrainForOrganization } from "../../brain/src/backfill.ts";

const { Pool } = pg;

function parseArgs(argv) {
  const args = { all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org") args.org = argv[++i];
    else if (argv[i] === "--all") args.all = true;
  }
  return args;
}

async function main() {
  const { org, all } = parseArgs(process.argv.slice(2));

  if (!org && !all) {
    console.error("Usage: node scripts/brain-backfill.mjs --org <organization-uuid> | --all");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Set DATABASE_URL before running this (see this file's own usage comment).");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  let organizationIds;
  try {
    if (org) {
      const orgRow = await pool.query("select id from public.organizations where id = $1", [org]);
      if (orgRow.rows.length === 0) {
        console.error(`No organization found with id ${org}.`);
        process.exit(1);
      }
      organizationIds = [org];
    } else {
      const allRows = await pool.query("select id from public.organizations order by created_at asc");
      organizationIds = allRows.rows.map((r) => r.id);
    }
  } finally {
    await pool.end();
  }

  for (const organizationId of organizationIds) {
    console.log(`Backfilling Brain profiles for organization ${organizationId}...`);
    const reports = await bootstrapBrainForOrganization({ organizationId });
    for (const report of reports) {
      console.log(
        `  ${report.entityType}: processed=${report.processed} created=${report.profilesCreated} updated=${report.profilesUpdated} historyRows=${report.historyRowsWritten}`,
      );
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Brain backfill failed:", err.message);
  process.exit(1);
});
