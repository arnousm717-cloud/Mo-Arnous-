import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.2 Step 1: schema-level tests for the agent_runs database
 * foundation (20260910090000) — real Postgres, direct SQL, no domain-
 * layer calls (packages/ai-agents does not exist yet). Mirrors
 * brain-embeddings-schema.test.ts's own style exactly. Covers only the
 * constraint/FK/RLS/grant surface — no claim/lease/retry runtime
 * behavior, which is explicitly out of scope for this step.
 */

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function seedOrg(name = "Agent Runs Schema Test Org"): Promise<string> {
  return seedAsAdmin(async (client) => {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      [name, `agent-runs-schema-org-${randomUUID()}`],
    );
    return org.rows[0]!.id;
  });
}

/** Mirrors compliance-schema.test.ts's own createAuthUser helper exactly
 * — inserting into auth.users alone is sufficient to satisfy a
 * public.users(id) FK (a database trigger populates public.users). */
async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `agent-runs-schema-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function insertAgentRun(
  organizationId: string,
  overrides: { agentKey?: string; triggeredBy?: string | null; input?: object; status?: string; attemptCount?: number } = {},
) {
  return seedAsAdmin(async (client) =>
    client.query<{ id: string }>(
      `insert into public.agent_runs (organization_id, agent_key, triggered_by, input${overrides.status ? ", status" : ""}${
        overrides.attemptCount !== undefined ? ", attempt_count" : ""
      })
       values ($1, $2, $3, $4${overrides.status ? ", $5" : ""}${overrides.attemptCount !== undefined ? `, $${overrides.status ? 6 : 5}` : ""})
       returning id`,
      [
        organizationId,
        overrides.agentKey ?? "sales_agent",
        overrides.triggeredBy ?? null,
        JSON.stringify(overrides.input ?? { contactId: randomUUID() }),
        ...(overrides.status ? [overrides.status] : []),
        ...(overrides.attemptCount !== undefined ? [overrides.attemptCount] : []),
      ],
    ),
  );
}

describe("agent_runs: table exists and basic insert succeeds", () => {
  it("a fully-specified insert succeeds and returns an id", async () => {
    const organizationId = await seedOrg();
    const result = await insertAgentRun(organizationId);
    expect(result.rows[0]!.id).toBeDefined();
  });
});

describe("agent_runs: organization_id is required and FK-enforced", () => {
  it("rejects a null organization_id", async () => {
    await expect(
      seedAsAdmin(async (client) =>
        client.query("insert into public.agent_runs (organization_id, agent_key, input) values (null, 'sales_agent', '{}'::jsonb)"),
      ),
    ).rejects.toThrow(/null value in column "organization_id"/);
  });

  it("rejects an organization_id that does not reference a real organization", async () => {
    await expect(
      seedAsAdmin(async (client) =>
        client.query("insert into public.agent_runs (organization_id, agent_key, input) values ($1, 'sales_agent', '{}'::jsonb)", [
          randomUUID(),
        ]),
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it("deleting the owning organization removes its agent_runs rows (ON DELETE CASCADE)", async () => {
    const organizationId = await seedOrg();
    const inserted = await insertAgentRun(organizationId);
    const runId = inserted.rows[0]!.id;

    await seedAsAdmin(async (client) => {
      await client.query("delete from public.organizations where id = $1", [organizationId]);
    });

    const survives = await seedAsAdmin(async (client) => {
      const r = await client.query("select 1 from public.agent_runs where id = $1", [runId]);
      return r.rows.length > 0;
    });
    expect(survives).toBe(false);
  });
});

describe("agent_runs: agent_key is required", () => {
  it("rejects a null agent_key", async () => {
    const organizationId = await seedOrg();
    await expect(
      seedAsAdmin(async (client) =>
        client.query("insert into public.agent_runs (organization_id, agent_key, input) values ($1, null, '{}'::jsonb)", [organizationId]),
      ),
    ).rejects.toThrow(/null value in column "agent_key"/);
  });
});

describe("agent_runs: status defaults to 'queued' and is a closed vocabulary", () => {
  it("an insert omitting status defaults to 'queued'", async () => {
    const organizationId = await seedOrg();
    const inserted = await insertAgentRun(organizationId);
    const status = await seedAsAdmin(async (client) => {
      const r = await client.query<{ status: string }>("select status from public.agent_runs where id = $1", [inserted.rows[0]!.id]);
      return r.rows[0]!.status;
    });
    expect(status).toBe("queued");
  });

  it("rejects a status outside the closed vocabulary", async () => {
    const organizationId = await seedOrg();
    await expect(insertAgentRun(organizationId, { status: "bogus" })).rejects.toThrow(/violates check constraint/);
  });

  it.each(["queued", "running", "succeeded", "failed"])("accepts the documented status '%s'", async (status) => {
    const organizationId = await seedOrg();
    await expect(insertAgentRun(organizationId, { status })).resolves.toBeDefined();
  });
});

describe("agent_runs: attempt_count defaults to 1 and must be positive", () => {
  it("an insert omitting attempt_count defaults to 1", async () => {
    const organizationId = await seedOrg();
    const inserted = await insertAgentRun(organizationId);
    const attemptCount = await seedAsAdmin(async (client) => {
      const r = await client.query<{ attempt_count: number }>("select attempt_count from public.agent_runs where id = $1", [
        inserted.rows[0]!.id,
      ]);
      return r.rows[0]!.attempt_count;
    });
    expect(attemptCount).toBe(1);
  });

  it("rejects attempt_count = 0", async () => {
    const organizationId = await seedOrg();
    await expect(insertAgentRun(organizationId, { attemptCount: 0 })).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a negative attempt_count", async () => {
    const organizationId = await seedOrg();
    await expect(insertAgentRun(organizationId, { attemptCount: -1 })).rejects.toThrow(/violates check constraint/);
  });
});

describe("agent_runs: input is required", () => {
  it("rejects a null input", async () => {
    const organizationId = await seedOrg();
    await expect(
      seedAsAdmin(async (client) =>
        client.query("insert into public.agent_runs (organization_id, agent_key, input) values ($1, 'sales_agent', null)", [organizationId]),
      ),
    ).rejects.toThrow(/null value in column "input"/);
  });
});

describe("agent_runs: created_at is populated automatically", () => {
  it("a fresh insert has a non-null created_at close to now", async () => {
    const organizationId = await seedOrg();
    const before = Date.now();
    const inserted = await insertAgentRun(organizationId);
    const createdAt = await seedAsAdmin(async (client) => {
      const r = await client.query<{ created_at: Date }>("select created_at from public.agent_runs where id = $1", [inserted.rows[0]!.id]);
      return r.rows[0]!.created_at;
    });
    expect(createdAt).toBeDefined();
    expect(new Date(createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("agent_runs: triggered_by references public.users, ON DELETE SET NULL", () => {
  it("accepts a real user id", async () => {
    const organizationId = await seedOrg();
    const userId = await createAuthUser("triggered-by-valid");
    await expect(insertAgentRun(organizationId, { triggeredBy: userId })).resolves.toBeDefined();
  });

  it("rejects a triggered_by that does not reference a real user", async () => {
    const organizationId = await seedOrg();
    await expect(insertAgentRun(organizationId, { triggeredBy: randomUUID() })).rejects.toThrow(/violates foreign key constraint/);
  });

  it("deleting the triggering user sets triggered_by to NULL rather than removing the row (matches audit_logs.actor_user_id)", async () => {
    const organizationId = await seedOrg();
    const userId = await createAuthUser("triggered-by-erasure");
    const inserted = await insertAgentRun(organizationId, { triggeredBy: userId });
    const runId = inserted.rows[0]!.id;

    await seedAsAdmin(async (client) => {
      await client.query("delete from auth.users where id = $1", [userId]);
    });

    const row = await seedAsAdmin(async (client) => {
      const r = await client.query<{ triggered_by: string | null }>("select triggered_by from public.agent_runs where id = $1", [runId]);
      return r.rows[0];
    });
    expect(row).toBeDefined();
    expect(row!.triggered_by).toBeNull();
  });
});

describe("agent_runs: RLS — tenant isolation", () => {
  it("tenant A can SELECT its own row via the authenticated role", async () => {
    const organizationId = await seedOrg("Agent Runs RLS Org A Select-Own");
    const inserted = await insertAgentRun(organizationId);

    const visible = await withTenantContext({ organizationId }, async (client) => {
      const r = await client.query("select 1 from public.agent_runs where id = $1", [inserted.rows[0]!.id]);
      return r.rows.length > 0;
    });
    expect(visible).toBe(true);
  });

  it("tenant B cannot SELECT tenant A's row", async () => {
    const orgA = await seedOrg("Agent Runs RLS Org A");
    const orgB = await seedOrg("Agent Runs RLS Org B");
    const inserted = await insertAgentRun(orgA);

    const visible = await withTenantContext({ organizationId: orgB }, async (client) => {
      const r = await client.query("select 1 from public.agent_runs where id = $1", [inserted.rows[0]!.id]);
      return r.rows.length > 0;
    });
    expect(visible).toBe(false);
  });

  it("tenant B cannot UPDATE tenant A's row", async () => {
    const orgA = await seedOrg("Agent Runs RLS Org A Update");
    const orgB = await seedOrg("Agent Runs RLS Org B Update");
    const inserted = await insertAgentRun(orgA);

    const affected = await withTenantContext({ organizationId: orgB }, async (client) => {
      const r = await client.query("update public.agent_runs set error = 'hijacked' where id = $1", [inserted.rows[0]!.id]);
      return r.rowCount;
    });
    expect(affected).toBe(0);

    const stillUnchanged = await seedAsAdmin(async (client) => {
      const r = await client.query<{ error: string | null }>("select error from public.agent_runs where id = $1", [inserted.rows[0]!.id]);
      return r.rows[0]!.error;
    });
    expect(stillUnchanged).toBeNull();
  });

  it("an authenticated-role connection can INSERT a row scoped to its own organization", async () => {
    const organizationId = await seedOrg("Agent Runs RLS Insert-Own");
    const inserted = await withTenantContext({ organizationId }, async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.agent_runs (organization_id, agent_key, input) values ($1, 'sales_agent', '{}'::jsonb) returning id",
        [organizationId],
      );
      return r.rows[0]!.id;
    });
    expect(inserted).toBeDefined();
  });

  it("an authenticated-role connection cannot INSERT a row for a different organization", async () => {
    const orgA = await seedOrg("Agent Runs RLS Insert-Cross A");
    const orgB = await seedOrg("Agent Runs RLS Insert-Cross B");

    await expect(
      withTenantContext({ organizationId: orgB }, async (client) => {
        await client.query("insert into public.agent_runs (organization_id, agent_key, input) values ($1, 'sales_agent', '{}'::jsonb)", [orgA]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/);
  });
});

describe("agent_runs: no unauthenticated/anon access", () => {
  it("the anon role has no grant on agent_runs", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'agent_runs' and grantee = 'anon'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("authenticated has no DELETE grant (runs are never removed by application code)", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'agent_runs' and grantee = 'authenticated' and privilege_type = 'DELETE'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("agent_runs: index exists for tenant-scoped status queries", () => {
  it("agent_runs_org_status_idx exists on (organization_id, status)", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'agent_runs' and indexname = 'agent_runs_org_status_idx'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("organization_id");
    expect(rows[0]!.indexdef).toContain("status");
  });
});
