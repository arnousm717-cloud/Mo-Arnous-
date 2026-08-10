import { Pool } from "pg";

// Same well-known local Supabase CLI default connection string used across
// every package's test suite — never valid against a real project. Needed
// here specifically for direct, unscoped (RLS-bypassing) database
// inspection: proving a row is actually gone requires a connection that
// isn't itself subject to the RLS policy that would hide it either way.
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const adminPool = new Pool({ connectionString: LOCAL_DB_URL });

export async function seedAsAdmin<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function rowExistsIn(table: string, column: string, value: string): Promise<boolean> {
  return seedAsAdmin(async (client) => {
    const r = await client.query(`select 1 from ${table} where ${column} = $1`, [value]);
    return r.rows.length > 0;
  });
}
