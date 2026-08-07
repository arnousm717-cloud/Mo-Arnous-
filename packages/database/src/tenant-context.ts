import type { PoolClient } from "pg";
import { getPool } from "./pool";

/**
 * Tenant-context resolution (docs/03-Database-Architecture.md §5, ADR-004).
 *
 * Every request that touches tenant data goes through this function. It
 * opens a transaction, sets the request-scoped Postgres session variables
 * RLS policies read (app.current_org, app.current_agency, app.current_role,
 * request.jwt.claims), runs the caller's queries, and commits — or rolls
 * back on any error, always releasing the connection in a clean state so a
 * failure never poisons a later request sharing the same pooled connection.
 *
 * This is the same mechanism validated in M1.2 (RLS isolation suite,
 * Supavisor pooling spike) — nothing here is new logic, it's that
 * validated pattern promoted from test harness to the real application path.
 */

export interface RequestContext {
  organizationId?: string;
  agencyId?: string;
  roleKey?: string;
  userId?: string;
}

export async function withTenantContext<T>(
  ctx: RequestContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    // Paired together deliberately — auth.uid()/auth.role() read
    // request.jwt.claims, not the Postgres session role, so the two must
    // never be set independently (this exact bug was found and fixed
    // in M1.2's test harness before it ever reached application code).
    await client.query(
      "select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', $1::text)::text, true)",
      [ctx.userId ?? null],
    );
    if (ctx.organizationId) {
      await client.query("select set_config('app.current_org', $1, true)", [ctx.organizationId]);
    }
    if (ctx.agencyId) {
      await client.query("select set_config('app.current_agency', $1, true)", [ctx.agencyId]);
    }
    if (ctx.roleKey) {
      await client.query("select set_config('app.current_role', $1, true)", [ctx.roleKey]);
    }
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    failed = true;
    try {
      await client.query("rollback");
    } catch {
      // Rollback itself can fail if the connection is already broken —
      // release(true) below discards it regardless of whether this succeeded.
    }
    throw err;
  } finally {
    client.release(failed);
  }
}
