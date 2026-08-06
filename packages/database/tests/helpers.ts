import { Pool, type PoolClient } from "pg";

// Local Supabase dev stack only — the well-known, publicly-documented default
// connection string every local `supabase start` uses. Never valid against a
// real (staging/prod) project, and never read from an env var pointing at one.
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const adminPool = new Pool({ connectionString: LOCAL_DB_URL });

export interface TenantContext {
  organizationId?: string;
  agencyId?: string;
  roleKey?: string;
  userId?: string;
}

/**
 * Opens a connection acting as the `authenticated` Postgres role (which does
 * NOT bypass RLS, unlike `postgres`/`service_role`) with the given
 * tenant-context session variables set exactly the way API middleware would
 * set them per request — via set_config(..., true), transaction-local.
 * Callers must wrap usage in a transaction and roll back, since SET ROLE
 * and set_config(..., true) are both scoped to the current transaction.
 */
export async function withTenantContext<T>(
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await adminPool.connect();
  let failed = false;
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    // PostgREST, for every real request, sets the Postgres session role AND
    // request.jwt.claims together as a pair — auth.role()/auth.uid() read the
    // JWT claim, not the session role, so the two must never be set separately
    // here. sub is included only when a specific user is being simulated;
    // omitting it (rather than omitting the whole claims object) still lets
    // auth.role() resolve correctly for tests that only care about "is this
    // caller authenticated at all," not "as whom."
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
    return result;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // Always end the transaction before returning the connection to the
    // pool — a client released mid-transaction (or mid-aborted-transaction)
    // poisons every subsequent test that borrows it from the pool. On any
    // failure, force-destroy the connection (release(true)) rather than
    // trust rollback alone to have left it clean.
    try {
      await client.query("rollback");
    } catch {
      // rollback itself can fail if the connection is already broken —
      // release(true) below handles that case regardless.
    }
    client.release(failed);
  }
}

/** Seeds fixture data using the unrestricted `postgres` role (bypasses RLS by design — this is setup, not the thing under test). */
export async function seedAsAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

export async function cleanupFixtures(): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("delete from public.memberships where true");
    await client.query("delete from public.users where true");
    await client.query("delete from public.organizations where true");
    await client.query("delete from public.agencies where true");
  } finally {
    client.release();
  }
}
