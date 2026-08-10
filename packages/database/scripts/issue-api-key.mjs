// Internal-only API key issuance (M1.7 Decision B). Deliberately a
// human-run script, not an HTTP route — there is no platform-operator auth
// mechanism built yet to gate a route with, and the M1.7 TDR
// (docs/13-Technical-Design-Review.md) explicitly warns against "make it
// public for now, lock down later." Matches the existing
// pooling-spike.mjs precedent: connects directly via DATABASE_URL, run by
// a person with real database access, never reachable from apps/web.
//
// Usage:
//
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
//     node scripts/issue-api-key.mjs --org <organization-uuid> --name "n8n workflow X" [--env test|live]
//
// The plaintext key is printed to stdout EXACTLY ONCE, here, and nowhere
// else — it is never logged again, never stored, and this script does not
// write it to any file. Copy it immediately; there is no way to retrieve
// it again after this process exits (only key_hash/key_prefix persist).

import pg from "pg";
import { generateApiKey } from "../../auth/src/api-keys.ts";

const { Pool } = pg;

function parseArgs(argv) {
  const args = { env: "test" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--org") args.org = argv[++i];
    else if (argv[i] === "--name") args.name = argv[++i];
    else if (argv[i] === "--env") args.env = argv[++i];
  }
  return args;
}

async function main() {
  const { org, name, env } = parseArgs(process.argv.slice(2));

  if (!org || !name) {
    console.error("Usage: node scripts/issue-api-key.mjs --org <organization-uuid> --name \"<key name>\" [--env test|live]");
    process.exit(1);
  }
  if (env !== "test" && env !== "live") {
    console.error("--env must be 'test' or 'live'");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Set DATABASE_URL before running this (see this file's own usage comment).");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  try {
    const orgRow = await pool.query("select id from public.organizations where id = $1", [org]);
    if (orgRow.rows.length === 0) {
      console.error(`No organization found with id ${org} — refusing to issue a key for a nonexistent organization.`);
      process.exit(1);
    }

    const { plaintext, keyHash, keyPrefix } = generateApiKey(env);

    const inserted = await pool.query(
      "insert into public.api_keys (organization_id, name, key_hash, key_prefix) values ($1, $2, $3, $4) returning id",
      [org, name, keyHash, keyPrefix],
    );

    console.log(`Issued api_keys row ${inserted.rows[0].id} for organization ${org}.`);
    console.log("");
    console.log("Plaintext key (shown exactly once — copy it now, it cannot be retrieved again):");
    console.log(plaintext);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // Never include the plaintext key in an error path — at this point in
  // the control flow it either hasn't been generated yet, or has already
  // been printed via the single, deliberate console.log above.
  console.error("Failed to issue API key:", err.message);
  process.exit(1);
});
