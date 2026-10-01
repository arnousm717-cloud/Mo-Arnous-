import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.3 Step 2B: schema-level tests for agent_tool_call_entity_refs
 * (20260929100000) — real Postgres, direct SQL, no domain-layer calls (no
 * Tool Registry/executor exists yet, so nothing but test fixtures ever
 * writes here). Mirrors agent-tool-calls-schema.test.ts's own style.
 * Covers only the constraint/FK/RLS/grant/dedup surface — GDPR erasure
 * behavior is covered separately in agent-tool-call-erasure.test.ts.
 */

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function seedOrg(name = "Agent Tool Call Entity Refs Test Org"): Promise<string> {
  return seedAsAdmin(async (client) => {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      [name, `agent-tool-call-entity-refs-org-${randomUUID()}`],
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

async function seedToolCall(organizationId: string, agentRunId: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      `insert into public.agent_tool_calls
         (organization_id, agent_run_id, tool_name, arguments, status, requires_human_approval)
       values ($1, $2, 'crm.get_contact', '{}'::jsonb, 'succeeded', false)
       returning id`,
      [organizationId, agentRunId],
    );
    return r.rows[0]!.id;
  });
}

async function seedContact(organizationId: string, firstName = "Test"): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
      [organizationId, firstName],
    );
    return r.rows[0]!.id;
  });
}

async function seedCompany(organizationId: string, name = "Test Co"): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name) values ($1, $2) returning id",
      [organizationId, name],
    );
    return r.rows[0]!.id;
  });
}

/** Deals require a real pipeline + stage (both NOT NULL FKs) — seeded
 * directly, mirroring pipelines-deals-schema.test.ts's own minimal
 * seedPipeline/seedStage fixture pattern. */
async function seedDeal(organizationId: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const pipeline = await client.query<{ id: string }>(
      "insert into public.pipelines (organization_id, name) values ($1, 'Test Pipeline') returning id",
      [organizationId],
    );
    const stage = await client.query<{ id: string }>(
      "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, 'Test Stage', 10) returning id",
      [organizationId, pipeline.rows[0]!.id],
    );
    const deal = await client.query<{ id: string }>(
      "insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3) returning id",
      [organizationId, pipeline.rows[0]!.id, stage.rows[0]!.id],
    );
    return deal.rows[0]!.id;
  });
}

describe("agent_tool_call_entity_refs: valid single-entity refs accepted", () => {
  it("accepts a valid contact ref", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const contactId = await seedContact(organizationId);

    const result = await seedAsAdmin(async (client) =>
      client.query<{ id: string }>(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3) returning id",
        [organizationId, toolCallId, contactId],
      ),
    );
    expect(result.rows[0]!.id).toBeDefined();
  });

  it("accepts a valid company ref", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const companyId = await seedCompany(organizationId);

    const result = await seedAsAdmin(async (client) =>
      client.query<{ id: string }>(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, company_id) values ($1, $2, 'company', $3) returning id",
        [organizationId, toolCallId, companyId],
      ),
    );
    expect(result.rows[0]!.id).toBeDefined();
  });

  it("accepts a valid deal ref", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const dealId = await seedDeal(organizationId);

    const result = await seedAsAdmin(async (client) =>
      client.query<{ id: string }>(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, deal_id) values ($1, $2, 'deal', $3) returning id",
        [organizationId, toolCallId, dealId],
      ),
    );
    expect(result.rows[0]!.id).toBeDefined();
  });
});

describe("agent_tool_call_entity_refs: exactly one entity id required, matching entity_type", () => {
  it("rejects a ref with zero entity ids set", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type) values ($1, $2, 'contact')",
          [organizationId, toolCallId],
        ),
      ),
    ).rejects.toThrow(/violates check constraint "agent_tool_call_entity_refs_entity_match"/);
  });

  it("rejects a ref with two entity ids set (contact_id and company_id both populated)", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const contactId = await seedContact(organizationId);
    const companyId = await seedCompany(organizationId);

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id, company_id) values ($1, $2, 'contact', $3, $4)",
          [organizationId, toolCallId, contactId, companyId],
        ),
      ),
    ).rejects.toThrow(/violates check constraint "agent_tool_call_entity_refs_entity_match"/);
  });

  it("rejects entity_type='contact' with only company_id populated (mismatch)", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const companyId = await seedCompany(organizationId);

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, company_id) values ($1, $2, 'contact', $3)",
          [organizationId, toolCallId, companyId],
        ),
      ),
    ).rejects.toThrow(/violates check constraint "agent_tool_call_entity_refs_entity_match"/);
  });

  it("rejects an entity_type outside the frozen {contact, company, deal} vocabulary", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const contactId = await seedContact(organizationId);

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'visitor', $3)",
          [organizationId, toolCallId, contactId],
        ),
      ),
    ).rejects.toThrow(/violates check constraint/);
  });
});

describe("agent_tool_call_entity_refs: deduplication (partial unique indexes)", () => {
  it("rejects a duplicate contact ref on the same tool call", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const contactId = await seedContact(organizationId);

    await seedAsAdmin(async (client) =>
      client.query(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
        [organizationId, toolCallId, contactId],
      ),
    );

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
          [organizationId, toolCallId, contactId],
        ),
      ),
    ).rejects.toThrow(/violates unique constraint "agent_tool_call_entity_refs_contact_uidx"/);
  });

  it("rejects a duplicate company ref on the same tool call", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const companyId = await seedCompany(organizationId);

    await seedAsAdmin(async (client) =>
      client.query(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, company_id) values ($1, $2, 'company', $3)",
        [organizationId, toolCallId, companyId],
      ),
    );

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, company_id) values ($1, $2, 'company', $3)",
          [organizationId, toolCallId, companyId],
        ),
      ),
    ).rejects.toThrow(/violates unique constraint "agent_tool_call_entity_refs_company_uidx"/);
  });

  it("rejects a duplicate deal ref on the same tool call", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const dealId = await seedDeal(organizationId);

    await seedAsAdmin(async (client) =>
      client.query(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, deal_id) values ($1, $2, 'deal', $3)",
        [organizationId, toolCallId, dealId],
      ),
    );

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, deal_id) values ($1, $2, 'deal', $3)",
          [organizationId, toolCallId, dealId],
        ),
      ),
    ).rejects.toThrow(/violates unique constraint "agent_tool_call_entity_refs_deal_uidx"/);
  });

  it("allows the SAME tool call to reference a contact AND a company AND a deal simultaneously (different entity kinds, not a duplicate)", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const contactId = await seedContact(organizationId);
    const companyId = await seedCompany(organizationId);
    const dealId = await seedDeal(organizationId);

    await seedAsAdmin(async (client) => {
      await client.query(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
        [organizationId, toolCallId, contactId],
      );
      await client.query(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, company_id) values ($1, $2, 'company', $3)",
        [organizationId, toolCallId, companyId],
      );
      await client.query(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, deal_id) values ($1, $2, 'deal', $3)",
        [organizationId, toolCallId, dealId],
      );
    });

    const refs = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.agent_tool_call_entity_refs where tool_call_id = $1", [
        toolCallId,
      ]);
      return r.rows;
    });
    expect(refs).toHaveLength(3);
  });
});

describe("agent_tool_call_entity_refs: composite tenant-safety FKs reject cross-org linkage", () => {
  it("rejects a tool_call_id that belongs to a different organization", async () => {
    const orgA = await seedOrg("Entity Refs Cross Org Tool Call A");
    const orgB = await seedOrg("Entity Refs Cross Org Tool Call B");
    const agentRunIdInOrgA = await seedAgentRun(orgA);
    const toolCallIdInOrgA = await seedToolCall(orgA, agentRunIdInOrgA);
    const contactInOrgB = await seedContact(orgB);

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
          [orgB, toolCallIdInOrgA, contactInOrgB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint "agent_tool_call_entity_refs_tool_call_org_fk"/);
  });

  it("rejects a contact_id that belongs to a different organization", async () => {
    const orgA = await seedOrg("Entity Refs Cross Org Contact A");
    const orgB = await seedOrg("Entity Refs Cross Org Contact B");
    const agentRunId = await seedAgentRun(orgA);
    const toolCallId = await seedToolCall(orgA, agentRunId);
    const contactInOrgB = await seedContact(orgB);

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
          [orgA, toolCallId, contactInOrgB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint "agent_tool_call_entity_refs_contact_org_fk"/);
  });

  it("rejects a company_id that belongs to a different organization", async () => {
    const orgA = await seedOrg("Entity Refs Cross Org Company A");
    const orgB = await seedOrg("Entity Refs Cross Org Company B");
    const agentRunId = await seedAgentRun(orgA);
    const toolCallId = await seedToolCall(orgA, agentRunId);
    const companyInOrgB = await seedCompany(orgB);

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, company_id) values ($1, $2, 'company', $3)",
          [orgA, toolCallId, companyInOrgB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint "agent_tool_call_entity_refs_company_org_fk"/);
  });

  it("rejects a deal_id that belongs to a different organization", async () => {
    const orgA = await seedOrg("Entity Refs Cross Org Deal A");
    const orgB = await seedOrg("Entity Refs Cross Org Deal B");
    const agentRunId = await seedAgentRun(orgA);
    const toolCallId = await seedToolCall(orgA, agentRunId);
    const dealInOrgB = await seedDeal(orgB);

    await expect(
      seedAsAdmin(async (client) =>
        client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, deal_id) values ($1, $2, 'deal', $3)",
          [orgA, toolCallId, dealInOrgB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint "agent_tool_call_entity_refs_deal_org_fk"/);
  });
});

describe("agent_tool_call_entity_refs: cascade behavior", () => {
  it("deleting the parent agent_tool_calls row cascades its entity refs", async () => {
    const organizationId = await seedOrg();
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const contactId = await seedContact(organizationId);

    const refId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3) returning id",
        [organizationId, toolCallId, contactId],
      );
      return r.rows[0]!.id;
    });

    await seedAsAdmin(async (client) => {
      await client.query("delete from public.agent_tool_calls where id = $1", [toolCallId]);
    });

    const survives = await seedAsAdmin(async (client) => {
      const r = await client.query("select 1 from public.agent_tool_call_entity_refs where id = $1", [refId]);
      return r.rows.length > 0;
    });
    expect(survives).toBe(false);
  });
});

describe("agent_tool_call_entity_refs: RLS + grants", () => {
  it("own-org SELECT succeeds", async () => {
    const organizationId = await seedOrg("Entity Refs RLS Select-Own");
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const contactId = await seedContact(organizationId);
    const refId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3) returning id",
        [organizationId, toolCallId, contactId],
      );
      return r.rows[0]!.id;
    });

    const visible = await withTenantContext({ organizationId }, async (client) => {
      const r = await client.query("select 1 from public.agent_tool_call_entity_refs where id = $1", [refId]);
      return r.rows.length > 0;
    });
    expect(visible).toBe(true);
  });

  it("cross-org SELECT is denied", async () => {
    const orgA = await seedOrg("Entity Refs RLS Select Cross A");
    const orgB = await seedOrg("Entity Refs RLS Select Cross B");
    const agentRunId = await seedAgentRun(orgA);
    const toolCallId = await seedToolCall(orgA, agentRunId);
    const contactId = await seedContact(orgA);
    const refId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3) returning id",
        [orgA, toolCallId, contactId],
      );
      return r.rows[0]!.id;
    });

    const visible = await withTenantContext({ organizationId: orgB }, async (client) => {
      const r = await client.query("select 1 from public.agent_tool_call_entity_refs where id = $1", [refId]);
      return r.rows.length > 0;
    });
    expect(visible).toBe(false);
  });

  it("own-org INSERT succeeds via the authenticated role", async () => {
    const organizationId = await seedOrg("Entity Refs RLS Insert-Own");
    const agentRunId = await seedAgentRun(organizationId);
    const toolCallId = await seedToolCall(organizationId, agentRunId);
    const contactId = await seedContact(organizationId);

    const insertedId = await withTenantContext({ organizationId }, async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3) returning id",
        [organizationId, toolCallId, contactId],
      );
      return r.rows[0]!.id;
    });
    expect(insertedId).toBeDefined();
  });

  it("cross-org INSERT is denied via the authenticated role", async () => {
    const orgA = await seedOrg("Entity Refs RLS Insert Cross A");
    const orgB = await seedOrg("Entity Refs RLS Insert Cross B");
    const agentRunId = await seedAgentRun(orgA);
    const toolCallId = await seedToolCall(orgA, agentRunId);
    const contactId = await seedContact(orgA);

    await expect(
      withTenantContext({ organizationId: orgB }, async (client) => {
        await client.query(
          "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
          [orgA, toolCallId, contactId],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy/);
  });

  it("no UPDATE grant exists (append-only junction table)", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'agent_tool_call_entity_refs' and grantee = 'authenticated' and privilege_type = 'UPDATE'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("no DELETE grant exists (rows removed only via CASCADE or the trusted erasure function)", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'agent_tool_call_entity_refs' and grantee = 'authenticated' and privilege_type = 'DELETE'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("the anon role has no grant at all", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'agent_tool_call_entity_refs' and grantee = 'anon'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("agent_tool_call_entity_refs: indexes", () => {
  it("agent_tool_call_entity_refs_org_idx exists on (organization_id)", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'agent_tool_call_entity_refs' and indexname = 'agent_tool_call_entity_refs_org_idx'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("organization_id");
  });

  it.each(["contact", "company", "deal"])("agent_tool_call_entity_refs_%s_uidx exists", async (kind) => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'agent_tool_call_entity_refs' and indexname = $1`,
        [`agent_tool_call_entity_refs_${kind}_uidx`],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });
});

describe("data_retention_policies: Step 2B registration", () => {
  it.each(["agent_tool_calls", "agent_tool_call_entity_refs"])(
    "%s is registered as a platform-default 2555-day policy",
    async (dataType) => {
      const row = await seedAsAdmin(async (client) => {
        const r = await client.query<{ organization_id: string | null; retention_days: number }>(
          "select organization_id, retention_days from public.data_retention_policies where data_type = $1",
          [dataType],
        );
        return r.rows[0];
      });
      expect(row).toBeDefined();
      expect(row!.organization_id).toBeNull();
      expect(row!.retention_days).toBe(2555);
    },
  );
});
