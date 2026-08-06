// One-off spike, not part of the permanent test suite: verifies that the
// request-scoped tenant-context mechanism (set_config(..., true), read via
// current_org()) does NOT leak between logically separate "requests" when
// they share a physical connection under Supavisor's transaction-mode
// pooling. This is the specific, unverified assumption flagged as M1.2's
// GO-condition in docs/13-Technical-Design-Review.md — it can only be
// tested against a real Supabase Cloud project, never local Docker Postgres,
// because local dev does not run Supavisor at all.
//
// Usage (run this yourself — it reads the password from an env var so it
// never has to be pasted anywhere, including here):
//
//   SUPAVISOR_URL="postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:6543/postgres" \
//     node scripts/pooling-spike.mjs
//
// Find the exact pooler connection string in the Supabase dashboard:
// Project Settings -> Database -> Connection Pooling -> "Transaction" mode,
// port 6543. Copy it verbatim and substitute your actual database password
// in place of [YOUR-PASSWORD].

import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.SUPAVISOR_URL;
if (!connectionString) {
  console.error("Set SUPAVISOR_URL to the pooler connection string (Transaction mode, port 6543) before running this.");
  process.exit(1);
}

const pool = new Pool({ connectionString, max: 5 });

const ITERATIONS = 200;
let leaks = 0;
let confirmedSet = 0;

async function simulateOneRequest(orgId) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (orgId) {
      // Simulates a real request that IS acting on behalf of a specific org.
      await client.query("select set_config('app.current_org', $1, true)", [orgId]);
      const r = await client.query("select current_org() as org");
      if (r.rows[0].org === orgId) confirmedSet++;
    } else {
      // Simulates a request that sets NO tenant context at all — the case
      // that would expose a leak, if a previous request's set_config value
      // survived on the same physical connection despite is_local=true and
      // an intervening commit/rollback.
      const r = await client.query("select current_org() as org");
      if (r.rows[0].org !== null) {
        leaks++;
        console.error(`LEAK DETECTED on iteration: current_org() returned ${r.rows[0].org} when nothing was set this request.`);
      }
    }
    await client.query("rollback");
  } finally {
    client.release();
  }
}

console.log(`Running ${ITERATIONS} alternating simulated requests against Supavisor...`);

for (let i = 0; i < ITERATIONS; i++) {
  // Alternate: one request sets a tenant context, the next sets none at all —
  // maximizes the chance of catching a leak if connections are reused
  // between them under pooling, which is exactly what transaction-mode
  // pooling is expected to do.
  const fakeOrgId = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
  await simulateOneRequest(i % 2 === 0 ? fakeOrgId : null);
}

await pool.end();

console.log(`\nDone. ${confirmedSet}/${ITERATIONS / 2} context-setting requests confirmed correct.`);
console.log(`Leaks detected: ${leaks}`);
process.exit(leaks > 0 ? 1 : 0);
