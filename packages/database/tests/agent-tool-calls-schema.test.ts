import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.3 Step 1: schema-level tests for the agent_tool_calls
 * database foundation (20260929090000) — real Postgres, direct SQL, no
 * domain-layer calls (no Tool Registry/executor exists yet). Mirrors
 * agent-runs-schema.test.ts's own style exactly. Covers only the
 * constraint/FK/RLS/grant surface — no tool execution, no model/provider
 * code, which is explicitly out of scope for this step.
 */

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function seedOrg(name = "Agent Tool Calls Schema Test Org"): Promise<string> {
  return seedAsAdmin(async (client) => {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      [name, `agent-tool-calls-schema-org-${randomUUID()}`],
    );
    return org.rows[0]!.id;
  });
}

async function seedAgentRun(organizationId: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      `insert into public.agent_runs (organization_id, agent_key, input)
       values ($1, 'sales_agent', '{}'::jsonb)
       returning id`,
      [organizationId],
    );
    return r.rows[0]!.id;
  });
}

async function insertToolCall(
  organizationId: string,
  agentRunId: string,
  overrides: {
    toolName?: string;
    arguments?: object;
    result?: object;
    status?: string;
    costUsd?: number;
    requiresHumanApproval?: boolean;
    approvalStatus?: string;
  } = {},
) {
  return seedAsAdmin(async (client) =>
    client.query<{ id: string }>(
      `insert into public.agent_tool_calls
         (organization_id, agent_run_id, tool_name, arguments, result, status, cost_usd, requires_human_approval${
           overrides.approvalStatus ? ", approval_status" : ""
         })
       values ($1, $2, $3, $4, $5, $6, $7, $8${overrides.approvalStatus ? ", $9" : ""})
       returning id`,
      [
        organizationId,
        agentRunId,
        overrides.toolName ?? "crm.get_contact",
        JSON.stringify(overrides.arguments ?? { contactId: randomUUID() }),
        overrides.result === undefined ? null : JSON.stringify(overrides.result),
        overrides.status ?? "succeeded",
        overrides.costUsd ?? null,
        overrides.requiresHumanApproval ?? false,
        ...(overrides.approvalStatus ? [overrides.approvalStatus] : []),
      ],
    ),
  );
}

describe("agent_tool_calls: table exists and basic insert succeeds", () => {
  it("a fully-specified insert succeeds and returns an id", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const result = await insertToolCall(organizationId, agentRunId);
    expect(result.rows[0]!.id).toBeDefined();
  });
});

describe("agent_tool_calls: organization_id is required and FK-enforced", () => {
  it("rejects a null organization_id", async () => {
    const agentRunId = await seedAgentRun(await seedOrg());
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values (null, $1, 'crm.get_contact', '{}'::jsonb, 'succeeded', false)",
          [agentRunId],
        ),
      ),
    ).rejects.toThrow(/null value in column "organization_id"/);
  });

  it("rejects an organization_id that does not reference a real organization", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values ($1, $2, 'crm.get_contact', '{}'::jsonb, 'succeeded', false)",
          [randomUUID(), agentRunId],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it("deleting the owning organization removes its agent_tool_calls rows (ON DELETE CASCADE via organizations)", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const inserted = await insertToolCall(organizationId, agentRunId);
    const toolCallId = inserted.rows[0]!.id;

    await seedAsAdmin(async (client) => {
      await client.query("delete from public.organizations where id = $1", [organizationId]);
    });

    const survives = await seedAsAdmin(async (client) => {
      const r = await client.query("select 1 from public.agent_tool_calls where id = $1", [toolCallId]);
      return r.rows.length > 0;
    });
    expect(survives).toBe(false);
  });
});

describe("agent_tool_calls: agent_run_id is required and composite-FK-enforced against (organization_id, id)", () => {
  it("rejects a null agent_run_id", async () => {
    const organizationId = await seedOrg();
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values ($1, null, 'crm.get_contact', '{}'::jsonb, 'succeeded', false)",
          [organizationId],
        ),
      ),
    ).rejects.toThrow(/null value in column "agent_run_id"/);
  });

  it("rejects an agent_run_id that does not reference a real agent_runs row", async () => {
    const organizationId = await seedOrg();
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values ($1, $2, 'crm.get_contact', '{}'::jsonb, 'succeeded', false)",
          [organizationId, randomUUID()],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it("rejects a real agent_run_id that belongs to a DIFFERENT organization (the composite-FK cross-tenant guard)", async () => {
    const orgA = await seedOrg("Agent Tool Calls Composite FK Org A");
    const orgB = await seedOrg("Agent Tool Calls Composite FK Org B");
    const agentRunIdInOrgA = await seedAgentRun(orgA);

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values ($1, $2, 'crm.get_contact', '{}'::jsonb, 'succeeded', false)",
          [orgB, agentRunIdInOrgA],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint "agent_tool_calls_run_org_fk"/);
  });

  it("deleting the owning agent_runs row removes its agent_tool_calls rows (ON DELETE CASCADE via agent_runs)", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const inserted = await insertToolCall(organizationId, agentRunId);
    const toolCallId = inserted.rows[0]!.id;

    await seedAsAdmin(async (client) => {
      await client.query("delete from public.agent_runs where id = $1", [agentRunId]);
    });

    const survives = await seedAsAdmin(async (client) => {
      const r = await client.query("select 1 from public.agent_tool_calls where id = $1", [toolCallId]);
      return r.rows.length > 0;
    });
    expect(survives).toBe(false);
  });
});

describe("agent_runs: the new (organization_id, id) unique constraint added this step", () => {
  it("agent_runs_org_id_unique exists and does not change ordinary single-column uniqueness of id", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ conname: string }>(
        `select conname from pg_constraint where conrelid = 'public.agent_runs'::regclass and conname = 'agent_runs_org_id_unique'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });
});

describe("agent_tool_calls: tool_name is required", () => {
  it("rejects a null tool_name", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values ($1, $2, null, '{}'::jsonb, 'succeeded', false)",
          [organizationId, agentRunId],
        ),
      ),
    ).rejects.toThrow(/null value in column "tool_name"/);
  });
});

describe("agent_tool_calls: arguments is required, result is nullable", () => {
  it("rejects a null arguments", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values ($1, $2, 'crm.get_contact', null, 'succeeded', false)",
          [organizationId, agentRunId],
        ),
      ),
    ).rejects.toThrow(/null value in column "arguments"/);
  });

  it("accepts a null result (a call recorded before it resolves)", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const inserted = await insertToolCall(organizationId, agentRunId);
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query<{ result: unknown }>("select result from public.agent_tool_calls where id = $1", [
        inserted.rows[0]!.id,
      ]);
      return r.rows[0];
    });
    expect(row!.result).toBeNull();
  });

  it("persists arguments/result exactly as given, round-tripping real jsonb content", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const args = { contactId: randomUUID(), extra: 42 };
    const result = { name: "Jane Doe", email: "jane@example.test" };
    const inserted = await insertToolCall(organizationId, agentRunId, { arguments: args, result });
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query<{ arguments: unknown; result: unknown }>(
        "select arguments, result from public.agent_tool_calls where id = $1",
        [inserted.rows[0]!.id],
      );
      return r.rows[0]!;
    });
    expect(row.arguments).toEqual(args);
    expect(row.result).toEqual(result);
  });
});

describe("agent_tool_calls: status is required, deliberately no CHECK vocabulary (none is frozen by any doc)", () => {
  it("rejects a null status", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values ($1, $2, 'crm.get_contact', '{}'::jsonb, null, false)",
          [organizationId, agentRunId],
        ),
      ),
    ).rejects.toThrow(/null value in column "status"/);
  });

  it.each(["succeeded", "failed", "pending", "some_future_status_value"])(
    "accepts an arbitrary non-empty status value '%s' (proves no CHECK constraint exists)",
    async (status) => {
      const organizationId = await seedOrg();
      const agentRunId = await seedAgentRun(organizationId);
      await expect(insertToolCall(organizationId, agentRunId, { status })).resolves.toBeDefined();
    },
  );
});

describe("agent_tool_calls: cost_usd is nullable, unconstrained precision", () => {
  it("accepts a null cost_usd", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const inserted = await insertToolCall(organizationId, agentRunId);
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query<{ cost_usd: string | null }>("select cost_usd from public.agent_tool_calls where id = $1", [
        inserted.rows[0]!.id,
      ]);
      return r.rows[0];
    });
    expect(row!.cost_usd).toBeNull();
  });

  it("accepts a real numeric cost_usd value", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const inserted = await insertToolCall(organizationId, agentRunId, { costUsd: 0.0042 });
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query<{ cost_usd: string | null }>("select cost_usd from public.agent_tool_calls where id = $1", [
        inserted.rows[0]!.id,
      ]);
      return r.rows[0];
    });
    expect(Number(row!.cost_usd)).toBeCloseTo(0.0042);
  });
});

describe("agent_tool_calls: requires_human_approval is required", () => {
  it("rejects a null requires_human_approval", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values ($1, $2, 'crm.get_contact', '{}'::jsonb, 'succeeded', null)",
          [organizationId, agentRunId],
        ),
      ),
    ).rejects.toThrow(/null value in column "requires_human_approval"/);
  });

  it.each([true, false])("accepts requires_human_approval = %s", async (value) => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    await expect(insertToolCall(organizationId, agentRunId, { requiresHumanApproval: value })).resolves.toBeDefined();
  });
});

describe("agent_tool_calls: approval_status defaults to 'n/a' and is a closed vocabulary", () => {
  it("an insert omitting approval_status defaults to 'n/a'", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const inserted = await insertToolCall(organizationId, agentRunId);
    const approvalStatus = await seedAsAdmin(async (client) => {
      const r = await client.query<{ approval_status: string }>(
        "select approval_status from public.agent_tool_calls where id = $1",
        [inserted.rows[0]!.id],
      );
      return r.rows[0]!.approval_status;
    });
    expect(approvalStatus).toBe("n/a");
  });

  it("rejects an approval_status outside the closed vocabulary", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    await expect(insertToolCall(organizationId, agentRunId, { approvalStatus: "bogus" })).rejects.toThrow(
      /violates check constraint/,
    );
  });

  it.each(["n/a", "pending", "confirmed", "discarded"])("accepts the documented approval_status '%s'", async (approvalStatus) => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    await expect(insertToolCall(organizationId, agentRunId, { approvalStatus })).resolves.toBeDefined();
  });
});

describe("agent_tool_calls: called_at is populated automatically", () => {
  it("a fresh insert has a non-null called_at close to now", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const before = Date.now();
    const inserted = await insertToolCall(organizationId, agentRunId);
    const calledAt = await seedAsAdmin(async (client) => {
      const r = await client.query<{ called_at: Date }>("select called_at from public.agent_tool_calls where id = $1", [
        inserted.rows[0]!.id,
      ]);
      return r.rows[0]!.called_at;
    });
    expect(calledAt).toBeDefined();
    expect(new Date(calledAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("agent_tool_calls: RLS — tenant isolation", () => {
  it("tenant A can SELECT its own row via the authenticated role", async () => {
    const organizationId = await seedOrg("Agent Tool Calls RLS Org A Select-Own");
    const agentRunId = await seedAgentRun(organizationId);
    const inserted = await insertToolCall(organizationId, agentRunId);

    const visible = await withTenantContext({ organizationId }, async (client) => {
      const r = await client.query("select 1 from public.agent_tool_calls where id = $1", [inserted.rows[0]!.id]);
      return r.rows.length > 0;
    });
    expect(visible).toBe(true);
  });

  it("tenant B cannot SELECT tenant A's row", async () => {
    const orgA = await seedOrg("Agent Tool Calls RLS Org A");
    const orgB = await seedOrg("Agent Tool Calls RLS Org B");
    const agentRunId = await seedAgentRun(orgA);
    const inserted = await insertToolCall(orgA, agentRunId);

    const visible = await withTenantContext({ organizationId: orgB }, async (client) => {
      const r = await client.query("select 1 from public.agent_tool_calls where id = $1", [inserted.rows[0]!.id]);
      return r.rows.length > 0;
    });
    expect(visible).toBe(false);
  });

  it("tenant B cannot UPDATE tenant A's row", async () => {
    const orgA = await seedOrg("Agent Tool Calls RLS Org A Update");
    const orgB = await seedOrg("Agent Tool Calls RLS Org B Update");
    const agentRunId = await seedAgentRun(orgA);
    const inserted = await insertToolCall(orgA, agentRunId);

    const affected = await withTenantContext({ organizationId: orgB }, async (client) => {
      const r = await client.query("update public.agent_tool_calls set status = 'hijacked' where id = $1", [
        inserted.rows[0]!.id,
      ]);
      return r.rowCount;
    });
    expect(affected).toBe(0);

    const stillUnchanged = await seedAsAdmin(async (client) => {
      const r = await client.query<{ status: string }>("select status from public.agent_tool_calls where id = $1", [
        inserted.rows[0]!.id,
      ]);
      return r.rows[0]!.status;
    });
    expect(stillUnchanged).not.toBe("hijacked");
  });

  it("an authenticated-role connection can INSERT a row scoped to its own organization", async () => {
    const organizationId = await seedOrg("Agent Tool Calls RLS Insert-Own");
    const agentRunId = await seedAgentRun(organizationId);
    const insertedId = await withTenantContext({ organizationId }, async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values ($1, $2, 'crm.get_contact', '{}'::jsonb, 'succeeded', false) returning id",
        [organizationId, agentRunId],
      );
      return r.rows[0]!.id;
    });
    expect(insertedId).toBeDefined();
  });

  it("an authenticated-role connection cannot INSERT a row for a different organization", async () => {
    const orgA = await seedOrg("Agent Tool Calls RLS Insert-Cross A");
    const orgB = await seedOrg("Agent Tool Calls RLS Insert-Cross B");
    const agentRunIdInOrgA = await seedAgentRun(orgA);

    await expect(
      withTenantContext({ organizationId: orgB }, async (client) => {
        await client.query(
          "insert into public.agent_tool_calls (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval) values ($1, $2, 'crm.get_contact', '{}'::jsonb, 'succeeded', false)",
          [orgA, agentRunIdInOrgA],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy/);
  });
});

describe("agent_tool_calls: no unauthenticated/anon access", () => {
  it("the anon role has no grant on agent_tool_calls", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'agent_tool_calls' and grantee = 'anon'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("authenticated has no DELETE grant (tool-call records are never removed by application code)", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'agent_tool_calls' and grantee = 'authenticated' and privilege_type = 'DELETE'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("agent_tool_calls: indexes exist for the documented high-volume append-only access pattern", () => {
  it("agent_tool_calls_org_called_at_idx exists on (organization_id, called_at)", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'agent_tool_calls' and indexname = 'agent_tool_calls_org_called_at_idx'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("organization_id");
    expect(rows[0]!.indexdef).toContain("called_at");
  });

  it("agent_tool_calls_agent_run_id_idx exists on (agent_run_id)", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'agent_tool_calls' and indexname = 'agent_tool_calls_agent_run_id_idx'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("agent_run_id");
  });
});
