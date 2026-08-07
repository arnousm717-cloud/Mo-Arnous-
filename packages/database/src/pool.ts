import { Pool } from "pg";

// Lazily created, module-scoped singleton — one pool per server process,
// reused across requests. Never created at import time: throwing only when
// actually connecting to means test/build environments that never touch the
// database don't need DATABASE_URL set at all.
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. In every real environment this must point through Supavisor " +
          "(the pooler connection string, port 6543 for transaction mode) — never a direct " +
          "connection to Postgres, which would exhaust the connection limit under serverless " +
          "traffic (docs/02-Software-Architecture.md §2).",
      );
    }
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

/** For tests only — allows a clean shutdown between test files. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
