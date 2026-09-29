import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

// Same well-known local Supabase CLI default connection string used
// across every package's test suite — never valid against a real project.
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const adminPool = new Pool({ connectionString: LOCAL_DB_URL });

/** Real, committed transaction — for fixture setup, mirroring every
 * other package's own seedAsAdmin exactly. */
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

export async function seedOrg(name = "AI Agents Repository Test Org"): Promise<string> {
  return seedAsAdmin(async (client) => {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      [name, `ai-agents-repo-org-${randomUUID()}`],
    );
    return org.rows[0]!.id;
  });
}

/** Real `auth.users` row (the pre-existing `on_auth_user_created` sync
 * trigger populates `public.users` from it) — needed because
 * `agent_runs.triggered_by` is a real FK to `public.users(id)`. Mirrors
 * `packages/crm/tests/helpers.ts`'s own `createOrgWithActiveMember`
 * precedent for the identical auth.users-insert step. No membership row
 * is created — `enqueueAgentRun` itself never checks role/membership,
 * that is the Staff route's own (already-authorized-by-the-time-it-calls-
 * this-function) responsibility. */
export async function seedUser(): Promise<string> {
  return seedAsAdmin(async (client) => {
    const userId = randomUUID();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [userId, `ai-agents-repo-user-${userId}@example.test`]);
    return userId;
  });
}

/** Seeds one agent_runs row directly, bypassing claimAgentRun/the
 * (not-yet-built) enqueue route entirely — controlled fixture setup for
 * testing the claim/complete/fail/terminalize state machine against a
 * KNOWN starting state, exactly mirroring
 * packages/brain/tests/embedding-recovery.test.ts's own precedent of
 * seeding workflow_runs rows directly rather than only ever reaching
 * every state through the functions under test. */
export async function seedAgentRun(
  organizationId: string,
  overrides: {
    agentKey?: string;
    status?: "queued" | "running" | "succeeded" | "failed";
    attemptCount?: number;
    error?: string | null;
  } = {},
): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      `insert into public.agent_runs (organization_id, agent_key, input, status, attempt_count, error)
       values ($1, $2, '{}'::jsonb, $3, $4, $5)
       returning id`,
      [organizationId, overrides.agentKey ?? "sales_agent", overrides.status ?? "queued", overrides.attemptCount ?? 1, overrides.error ?? null],
    );
    return r.rows[0]!.id;
  });
}

/** Rewinds started_at into the past by an exact, server-computed
 * interval — the same technique already proven precise by
 * packages/brain/tests/embedding-recovery.test.ts's own
 * rewindCompletedAt (`now() - make_interval(...)`, evaluated in
 * Postgres, never a wall-clock sleep). Used for CLAIM_LEASE_SECONDS
 * boundary tests. */
export async function rewindStartedAt(runId: string, secondsAgo: number): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query("update public.agent_runs set started_at = now() - make_interval(secs => $1) where id = $2", [secondsAgo, runId]);
  });
}

/** Rewinds completed_at into the past by an exact, server-computed
 * interval. Used for RETRY_BACKOFF_SECONDS boundary tests. */
export async function rewindCompletedAt(runId: string, secondsAgo: number): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query("update public.agent_runs set completed_at = now() - make_interval(secs => $1) where id = $2", [secondsAgo, runId]);
  });
}

export interface AgentRunRow {
  id: string;
  organization_id: string;
  agent_key: string;
  triggered_by: string | null;
  input: unknown;
  status: string;
  attempt_count: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  created_at: string;
}

export async function readAgentRun(runId: string): Promise<AgentRunRow> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<AgentRunRow>("select * from public.agent_runs where id = $1", [runId]);
    return r.rows[0]!;
  });
}

/** Used by the direct-repository-bypass proof tests to confirm a
 * rejected enqueueAgentRun call left zero trace in the table — a
 * validation error must roll back cleanly, never leave a partial row. */
export async function readAgentRunCountForOrg(organizationId: string): Promise<number> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ n: string }>(
      "select count(*)::int as n from public.agent_runs where organization_id = $1",
      [organizationId],
    );
    return Number(r.rows[0]?.n ?? 0);
  });
}
