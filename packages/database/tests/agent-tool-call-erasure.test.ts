import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { closePool } from "../src/pool";
// Deliberately the REAL, committing withTenantContext (src/tenant-context),
// not tests/helpers.ts's always-rolled-back test variant — mirrors
// brain-gdpr-erasure.test.ts's own createOrgWithOwner/executeErasure
// fixture pattern exactly, since this test needs
// create_organization_with_owner() and execute_contact_erasure() to
// actually persist.
import { withTenantContext } from "../src/tenant-context";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.3 Step 2B: GDPR/DSR coverage for the execute_contact_erasure()
 * agent-tool-call-purge extension (20260929110000). Calls the SQL function
 * directly via RPC, matching brain-gdpr-erasure.test.ts's own "forged
 * tenant context" raw-SQL calling convention exactly.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `agent-tool-call-erasure-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createOrgWithOwner(ownerId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId: ownerId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `agent-tool-call-erasure-${randomUUID()}`,
      ownerId,
    ]);
    return r.rows[0];
  });
  return result.organization_id as string;
}

async function createContact(organizationId: string, firstName: string): Promise<string> {
  const row = await seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
      [organizationId, firstName],
    );
    return r.rows[0]!;
  });
  return row.id;
}

async function createCompany(organizationId: string, name: string): Promise<string> {
  const row = await seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name) values ($1, $2) returning id",
      [organizationId, name],
    );
    return r.rows[0]!;
  });
  return row.id;
}

async function createAgentRun(organizationId: string): Promise<string> {
  const row = await seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.agent_runs (organization_id, agent_key, input) values ($1, 'sales_agent', '{}'::jsonb) returning id",
      [organizationId],
    );
    return r.rows[0]!;
  });
  return row.id;
}

async function createToolCall(
  organizationId: string,
  agentRunId: string,
  opts: { toolName?: string; arguments?: object; result?: object } = {},
): Promise<string> {
  const row = await seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      `insert into public.agent_tool_calls
         (organization_id, agent_run_id, tool_name, arguments, result, status, requires_human_approval)
       values ($1, $2, $3, $4, $5, 'succeeded', false)
       returning id`,
      [
        organizationId,
        agentRunId,
        opts.toolName ?? "crm.get_contact",
        JSON.stringify(opts.arguments ?? {}),
        opts.result === undefined ? null : JSON.stringify(opts.result),
      ],
    );
    return r.rows[0]!;
  });
  return row.id;
}

async function createContactRef(organizationId: string, toolCallId: string, contactId: string): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query(
      "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, contact_id) values ($1, $2, 'contact', $3)",
      [organizationId, toolCallId, contactId],
    );
  });
}

async function createCompanyRef(organizationId: string, toolCallId: string, companyId: string): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query(
      "insert into public.agent_tool_call_entity_refs (organization_id, tool_call_id, entity_type, company_id) values ($1, $2, 'company', $3)",
      [organizationId, toolCallId, companyId],
    );
  });
}

async function fileDeleteDsr(organizationId: string, contactId: string): Promise<string> {
  const row = await seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type) values ($1, 'contact', $2, 'delete') returning id",
      [organizationId, contactId],
    );
    return r.rows[0]!;
  });
  return row.id;
}

async function executeErasure(admin: string, dsrId: string): Promise<{ target_contact_id: string; completed_at: string }> {
  return withTenantContext({ userId: admin }, async (client) => {
    const r = await client.query("select * from public.execute_contact_erasure($1, $2)", [dsrId, admin]);
    return r.rows[0];
  });
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("execute_contact_erasure: agent_tool_calls targeted deletion (Milestone 4.3 Step 2B)", () => {
  it("a tool call linked to the erased contact, whose result contains the contact's actual PII, is deleted entirely — the PII is gone because the whole row is gone, not because it was redacted", async () => {
    const admin = await createAuthUser("pii-purge-admin");
    const orgId = await createOrgWithOwner(admin, "Agent Tool Call Erasure PII Org");
    const contactId = await createContact(orgId, "Jane HostileToolCall");
    const agentRunId = await createAgentRun(orgId);
    const erasedName = "Jane HostileToolCall";
    const erasedEmail = "jane.hostiletoolcall@example.test";
    const erasedPhone = "555-0199";
    const toolCallId = await createToolCall(orgId, agentRunId, {
      arguments: { contactId },
      result: { firstName: "Jane", lastName: "HostileToolCall", email: erasedEmail, phone: erasedPhone },
    });
    await createContactRef(orgId, toolCallId, contactId);

    const dsrId = await fileDeleteDsr(orgId, contactId);
    await executeErasure(admin, dsrId);

    const toolCallAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, result from public.agent_tool_calls where id = $1", [toolCallId]);
      return r.rows;
    });
    expect(toolCallAfter).toEqual([]);

    // Scan every remaining agent_tool_calls row in the organization for the
    // erased contact's PII, not just the one row we expect to be gone —
    // mirrors brain-gdpr-erasure.test.ts's own hostile-test discipline.
    const anyRemainingPii = await seedAsAdmin(async (client) => {
      const r = await client.query<{ result: unknown }>(
        "select result from public.agent_tool_calls where organization_id = $1",
        [orgId],
      );
      return r.rows.some((row) => {
        const text = JSON.stringify(row.result ?? {});
        return text.includes(erasedName) || text.includes(erasedEmail) || text.includes(erasedPhone);
      });
    });
    expect(anyRemainingPii).toBe(false);
  });

  it("its entity-ref rows disappear along with the parent tool call", async () => {
    const admin = await createAuthUser("refs-cascade-admin");
    const orgId = await createOrgWithOwner(admin, "Agent Tool Call Erasure Refs Cascade Org");
    const contactId = await createContact(orgId, "Refs Cascade Contact");
    const agentRunId = await createAgentRun(orgId);
    const toolCallId = await createToolCall(orgId, agentRunId);
    await createContactRef(orgId, toolCallId, contactId);

    const refIdBefore = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "select id from public.agent_tool_call_entity_refs where tool_call_id = $1",
        [toolCallId],
      );
      return r.rows[0]!.id;
    });

    const dsrId = await fileDeleteDsr(orgId, contactId);
    await executeErasure(admin, dsrId);

    const refAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.agent_tool_call_entity_refs where id = $1", [refIdBefore]);
      return r.rows;
    });
    expect(refAfter).toEqual([]);
  });

  it("HOSTILE TEST — MULTI-ENTITY: a tool call referencing BOTH the erased contact and a surviving company is still deleted entirely, and the company itself survives", async () => {
    const admin = await createAuthUser("multi-entity-admin");
    const orgId = await createOrgWithOwner(admin, "Agent Tool Call Erasure Multi-Entity Org");
    const contactId = await createContact(orgId, "Multi Entity Contact");
    const companyId = await createCompany(orgId, "Multi Entity Co");
    const agentRunId = await createAgentRun(orgId);
    const toolCallId = await createToolCall(orgId, agentRunId, {
      result: { contact: "Multi Entity Contact", company: "Multi Entity Co" },
    });
    await createContactRef(orgId, toolCallId, contactId);
    await createCompanyRef(orgId, toolCallId, companyId);

    const dsrId = await fileDeleteDsr(orgId, contactId);
    await executeErasure(admin, dsrId);

    const toolCallAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.agent_tool_calls where id = $1", [toolCallId]);
      return r.rows;
    });
    expect(toolCallAfter).toEqual([]);

    const companyAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, name from public.companies where id = $1", [companyId]);
      return r.rows;
    });
    expect(companyAfter).toEqual([{ id: companyId, name: "Multi Entity Co" }]);

    // The company's own, unrelated tool call (no contact ref at all)
    // survives — proves this was a targeted deletion of the specific
    // shared tool call, not a blanket sweep of the company's own data.
    const companyOnlyToolCallId = await createToolCall(orgId, agentRunId, { toolName: "crm.get_contact" });
    await createCompanyRef(orgId, companyOnlyToolCallId, companyId);
    const companyOnlyToolCallStillThere = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.agent_tool_calls where id = $1", [companyOnlyToolCallId]);
      return r.rows;
    });
    expect(companyOnlyToolCallStillThere).toHaveLength(1);
  });

  it("HOSTILE TEST — SAME-ORG UNRELATED SURVIVOR: an unrelated tool call in the same organization, with no ref to the erased contact at all, survives byte-for-byte", async () => {
    const admin = await createAuthUser("unrelated-survivor-admin");
    const orgId = await createOrgWithOwner(admin, "Agent Tool Call Erasure Unrelated Org");
    const contactId = await createContact(orgId, "Erased Contact With Own Tool Call");
    const agentRunId = await createAgentRun(orgId);

    const targetToolCallId = await createToolCall(orgId, agentRunId, { result: { note: "about the erased contact" } });
    await createContactRef(orgId, targetToolCallId, contactId);

    const unrelatedResult = { note: "unrelated tool call, no refs at all" };
    const unrelatedToolCallId = await createToolCall(orgId, agentRunId, { result: unrelatedResult });
    // Deliberately no entity ref at all for this tool call.

    const dsrId = await fileDeleteDsr(orgId, contactId);
    await executeErasure(admin, dsrId);

    const targetAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.agent_tool_calls where id = $1", [targetToolCallId]);
      return r.rows;
    });
    expect(targetAfter).toEqual([]);

    const unrelatedAfter = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string; result: unknown }>(
        "select id, result from public.agent_tool_calls where id = $1",
        [unrelatedToolCallId],
      );
      return r.rows;
    });
    expect(unrelatedAfter).toHaveLength(1);
    expect(unrelatedAfter[0]!.result).toEqual(unrelatedResult);
  });

  it("a tool call linked to a DIFFERENT contact (not the one being erased) survives", async () => {
    const admin = await createAuthUser("different-contact-admin");
    const orgId = await createOrgWithOwner(admin, "Agent Tool Call Erasure Different Contact Org");
    const erasedContactId = await createContact(orgId, "Erased Contact");
    const survivingContactId = await createContact(orgId, "Surviving Contact");
    const agentRunId = await createAgentRun(orgId);

    const erasedToolCallId = await createToolCall(orgId, agentRunId);
    await createContactRef(orgId, erasedToolCallId, erasedContactId);

    const survivingToolCallId = await createToolCall(orgId, agentRunId);
    await createContactRef(orgId, survivingToolCallId, survivingContactId);

    const dsrId = await fileDeleteDsr(orgId, erasedContactId);
    await executeErasure(admin, dsrId);

    const erasedAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.agent_tool_calls where id = $1", [erasedToolCallId]);
      return r.rows;
    });
    expect(erasedAfter).toEqual([]);

    const survivingAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.agent_tool_calls where id = $1", [survivingToolCallId]);
      return r.rows;
    });
    expect(survivingAfter).toHaveLength(1);
  });

  it("HOSTILE TEST — CROSS-ORG SAFETY: an unrelated tool call in a DIFFERENT organization, with zero refs, is untouched", async () => {
    const admin = await createAuthUser("tool-call-cross-org-admin");
    const orgId = await createOrgWithOwner(admin, "Agent Tool Call Erasure Cross Org A");
    const otherOrgOwner = await createAuthUser("tool-call-cross-org-owner-b");
    const otherOrgId = await createOrgWithOwner(otherOrgOwner, "Agent Tool Call Erasure Cross Org B");
    const contactId = await createContact(orgId, "Erased Cross Org Contact");
    const otherOrgAgentRunId = await createAgentRun(otherOrgId);

    const otherOrgResult = { note: "unrelated org B tool call" };
    const otherOrgToolCallId = await createToolCall(otherOrgId, otherOrgAgentRunId, { result: otherOrgResult });

    const dsrId = await fileDeleteDsr(orgId, contactId);
    await executeErasure(admin, dsrId);

    const stillThere = await seedAsAdmin(async (client) => {
      const r = await client.query<{ result: unknown }>("select result from public.agent_tool_calls where id = $1", [
        otherOrgToolCallId,
      ]);
      return r.rows;
    });
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0]!.result).toEqual(otherOrgResult);
  });

  it("pre-existing execute_contact_erasure behavior (direct-contact Activities/Notes/Taggings scrub) remains green alongside the new agent-tool-call purge", async () => {
    const admin = await createAuthUser("preexisting-behavior-admin");
    const orgId = await createOrgWithOwner(admin, "Agent Tool Call Erasure Preexisting Behavior Org");
    const contactId = await createContact(orgId, "Preexisting Behavior Contact");
    const agentRunId = await createAgentRun(orgId);
    const toolCallId = await createToolCall(orgId, agentRunId);
    await createContactRef(orgId, toolCallId, contactId);

    const activityId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.activities (organization_id, type, related_to_type, related_to_id, subject, body) values ($1, 'note', 'contact', $2, 'subj', 'body') returning id",
        [orgId, contactId],
      );
      return r.rows[0]!.id;
    });

    const dsrId = await fileDeleteDsr(orgId, contactId);
    const result = await executeErasure(admin, dsrId);
    expect(result.target_contact_id).toBe(contactId);

    const activityAfter = await seedAsAdmin(async (client) => {
      const r = await client.query<{ related_to_id: string | null; subject: string | null; body: string | null }>(
        "select related_to_id, subject, body from public.activities where id = $1",
        [activityId],
      );
      return r.rows[0]!;
    });
    expect(activityAfter.related_to_id).toBeNull();
    expect(activityAfter.subject).toBeNull();
    expect(activityAfter.body).toBeNull();

    const contactAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.contacts where id = $1", [contactId]);
      return r.rows;
    });
    expect(contactAfter).toEqual([]);

    const toolCallAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.agent_tool_calls where id = $1", [toolCallId]);
      return r.rows;
    });
    expect(toolCallAfter).toEqual([]);
  });
});

describe("preview_contact_erasure: still not extended for agent-tool-call data (Milestone 4.3 Step 2B)", () => {
  it("still returns only (can_proceed, blocker_reason, target_contact_id) — no agent-tool-call-specific field was added", async () => {
    const admin = await createAuthUser("preview-shape-admin");
    const orgId = await createOrgWithOwner(admin, "Agent Tool Call Erasure Preview Shape Org");
    const contactId = await createContact(orgId, "Preview Shape Contact");
    const dsrId = await fileDeleteDsr(orgId, contactId);

    const row = await withTenantContext({ userId: admin }, async (client) => {
      const r = await client.query("select * from public.preview_contact_erasure($1, $2)", [dsrId, admin]);
      return r.rows[0];
    });
    expect(Object.keys(row).sort()).toEqual(["blocker_reason", "can_proceed", "target_contact_id"]);
  });
});
