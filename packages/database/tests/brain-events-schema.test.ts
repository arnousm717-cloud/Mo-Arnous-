import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { closePool } from "../src/pool";
// The REAL, committing withTenantContext — see visitor-identification-schema.test.ts's
// own comment for why: `authenticated` has zero grants on public.events
// (M1.7), so the transaction that ran the SECURITY DEFINER function cannot
// read the result back on its own client; verification happens from a
// separate seedAsAdmin (postgres-role) connection, which only sees
// committed data.
import { withTenantContext as withCommittingTenantContext } from "../src/tenant-context";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.1 Phase 2: emit_contact_event / emit_company_event /
 * emit_deal_event hostile direct-invocation hardening, mirroring
 * emit_visitor_identified_event()'s own test suite exactly in style and
 * intent (visitor-identification-schema.test.ts).
 */

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function seedOrg(): Promise<string> {
  return seedAsAdmin(async (client) => {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      ["Brain Events Test Org", `brain-events-test-org-${randomUUID()}`],
    );
    return org.rows[0]!.id;
  });
}

async function seedContact(organizationId: string, deleted = false): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, deleted_at) values ($1, $2, $3) returning id",
      [organizationId, "Test Contact", deleted ? new Date().toISOString() : null],
    );
    return r.rows[0]!.id;
  });
}

async function seedCompany(organizationId: string, deleted = false): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name, deleted_at) values ($1, $2, $3) returning id",
      [organizationId, "Test Co", deleted ? new Date().toISOString() : null],
    );
    return r.rows[0]!.id;
  });
}

async function seedDeal(organizationId: string, deleted = false): Promise<string> {
  return seedAsAdmin(async (client) => {
    const pipeline = await client.query<{ id: string }>(
      "insert into public.pipelines (organization_id, name, is_default) values ($1, 'Test Pipeline', true) returning id",
      [organizationId],
    );
    const stage = await client.query<{ id: string }>(
      "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, 'Lead', 10) returning id",
      [organizationId, pipeline.rows[0]!.id],
    );
    const r = await client.query<{ id: string }>(
      "insert into public.deals (organization_id, pipeline_id, stage_id, deleted_at) values ($1, $2, $3, $4) returning id",
      [organizationId, pipeline.rows[0]!.id, stage.rows[0]!.id, deleted ? new Date().toISOString() : null],
    );
    return r.rows[0]!.id;
  });
}

async function eventCountFor(organizationId: string, eventType: string, idKey: string, id: string): Promise<number> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ count: string }>(
      `select count(*)::text as count from public.events
       where organization_id = $1 and event_type = $2 and payload->>$3 = $4`,
      [organizationId, eventType, idKey, id],
    );
    return Number(r.rows[0]!.count);
  });
}

describe("emit_contact_event()", () => {
  it("valid contact.created call inserts exactly one event with organization_id/contact_id-only payload", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await client.query("select public.emit_contact_event($1, $2)", [contactId, "contact.created"]);
    });
    expect(await eventCountFor(orgId, "contact.created", "contact_id", contactId)).toBe(1);

    const row = await seedAsAdmin((client) =>
      client.query("select payload, organization_id from public.events where event_type = 'contact.created' and payload->>'contact_id' = $1", [contactId]),
    );
    expect(Object.keys(row.rows[0]!.payload).sort()).toEqual(["contact_id", "organization_id"]);
    expect(row.rows[0]!.organization_id).toBe(orgId);
  });

  it("nonexistent contact -> no event, no exception", async () => {
    const orgId = await seedOrg();
    const fakeId = randomUUID();
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await expect(client.query("select public.emit_contact_event($1, $2)", [fakeId, "contact.created"])).resolves.toBeDefined();
    });
    expect(await eventCountFor(orgId, "contact.created", "contact_id", fakeId)).toBe(0);
  });

  it("invalid event_type is rejected — no event for an out-of-allowlist string", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId);
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await expect(client.query("select public.emit_contact_event($1, $2)", [contactId, "contact.exploded"])).resolves.toBeDefined();
    });
    expect(await eventCountFor(orgId, "contact.exploded", "contact_id", contactId)).toBe(0);
    expect(await eventCountFor(orgId, "contact.created", "contact_id", contactId)).toBe(0);
  });

  it("contact.created for an already-deleted row is rejected (state mismatch)", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId, true);
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await client.query("select public.emit_contact_event($1, $2)", [contactId, "contact.created"]);
    });
    expect(await eventCountFor(orgId, "contact.created", "contact_id", contactId)).toBe(0);
  });

  it("contact.deleted for a still-active row is rejected (state mismatch)", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId, false);
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await client.query("select public.emit_contact_event($1, $2)", [contactId, "contact.deleted"]);
    });
    expect(await eventCountFor(orgId, "contact.deleted", "contact_id", contactId)).toBe(0);
  });

  it("contact.deleted for an actually-deleted row succeeds", async () => {
    const orgId = await seedOrg();
    const contactId = await seedContact(orgId, true);
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await client.query("select public.emit_contact_event($1, $2)", [contactId, "contact.deleted"]);
    });
    expect(await eventCountFor(orgId, "contact.deleted", "contact_id", contactId)).toBe(1);
  });

  it("cross-tenant: caller's own org context cannot forge an event for another org's contact", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const contactInB = await seedContact(orgB);
    await withCommittingTenantContext({ organizationId: orgA }, async (client) => {
      await expect(client.query("select public.emit_contact_event($1, $2)", [contactInB, "contact.created"])).resolves.toBeDefined();
    });
    expect(await eventCountFor(orgA, "contact.created", "contact_id", contactInB)).toBe(0);
    expect(await eventCountFor(orgB, "contact.created", "contact_id", contactInB)).toBe(0);
  });

  it("EXECUTE grant is present for authenticated", async () => {
    const r = await seedAsAdmin((client) =>
      client.query<{ has_execute: boolean }>(
        "select has_function_privilege('authenticated', 'public.emit_contact_event(uuid, text)', 'execute') as has_execute",
      ),
    );
    expect(r.rows[0]!.has_execute).toBe(true);
  });
});

describe("emit_company_event()", () => {
  it("valid company.created call inserts exactly one event", async () => {
    const orgId = await seedOrg();
    const companyId = await seedCompany(orgId);
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await client.query("select public.emit_company_event($1, $2)", [companyId, "company.created"]);
    });
    expect(await eventCountFor(orgId, "company.created", "company_id", companyId)).toBe(1);
  });

  it("company.deleted for a still-active row is rejected", async () => {
    const orgId = await seedOrg();
    const companyId = await seedCompany(orgId, false);
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await client.query("select public.emit_company_event($1, $2)", [companyId, "company.deleted"]);
    });
    expect(await eventCountFor(orgId, "company.deleted", "company_id", companyId)).toBe(0);
  });

  it("cross-tenant forgery is rejected", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const companyInB = await seedCompany(orgB);
    await withCommittingTenantContext({ organizationId: orgA }, async (client) => {
      await client.query("select public.emit_company_event($1, $2)", [companyInB, "company.created"]);
    });
    expect(await eventCountFor(orgA, "company.created", "company_id", companyInB)).toBe(0);
  });
});

describe("emit_deal_event()", () => {
  it("valid deal.created call inserts exactly one event", async () => {
    const orgId = await seedOrg();
    const dealId = await seedDeal(orgId);
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await client.query("select public.emit_deal_event($1, $2)", [dealId, "deal.created"]);
    });
    expect(await eventCountFor(orgId, "deal.created", "deal_id", dealId)).toBe(1);
  });

  it("deal.deleted for an actually-deleted row succeeds", async () => {
    const orgId = await seedOrg();
    const dealId = await seedDeal(orgId, true);
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await client.query("select public.emit_deal_event($1, $2)", [dealId, "deal.deleted"]);
    });
    expect(await eventCountFor(orgId, "deal.deleted", "deal_id", dealId)).toBe(1);
  });

  it("cross-tenant forgery is rejected", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const dealInB = await seedDeal(orgB);
    await withCommittingTenantContext({ organizationId: orgA }, async (client) => {
      await client.query("select public.emit_deal_event($1, $2)", [dealInB, "deal.created"]);
    });
    expect(await eventCountFor(orgA, "deal.created", "deal_id", dealInB)).toBe(0);
  });
});

describe("public.events: no direct authenticated INSERT grant introduced by Phase 2", () => {
  it("authenticated still cannot INSERT into public.events directly", async () => {
    const orgId = await seedOrg();
    await withCommittingTenantContext({ organizationId: orgId }, async (client) => {
      await expect(
        client.query("insert into public.events (event_type, organization_id, payload) values ('contact.created', $1, '{}'::jsonb)", [orgId]),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
