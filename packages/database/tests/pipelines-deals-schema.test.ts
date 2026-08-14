import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.2A schema/constraint coverage (docs/13-Technical-Design-
 * Review.md "Milestone 2.2A"). Mirrors companies-contacts-schema.test.ts
 * exactly in style. pipelines/pipeline_stages/deals all cascade-delete
 * along with their organization, so cleanupFixtures()'s existing
 * `delete from organizations` already tears these down too — no
 * dedicated cleanup needed here.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
}

let fx: Fixture;

async function seedOrgs(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Pipelines Schema Test Org A', $1) returning id",
      [`pipelines-schema-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Pipelines Schema Test Org B', $1) returning id",
      [`pipelines-schema-test-org-b-${randomUUID()}`],
    );
    return { orgAId: orgA.rows[0]!.id, orgBId: orgB.rows[0]!.id };
  });
}

/** Seeds a pipeline with N stages directly (bypassing seed_default_pipeline,
 * which always seeds a fixed 5-stage "Sales Pipeline") for tests that need
 * a specific, minimal same-org pipeline/stage fixture. */
async function seedPipeline(
  client: import("pg").PoolClient,
  organizationId: string,
  opts: { isDefault?: boolean; name?: string } = {},
): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.pipelines (organization_id, name, is_default) values ($1, $2, $3) returning id",
    [organizationId, opts.name ?? "Test Pipeline", opts.isDefault ?? false],
  );
  return r.rows[0]!.id;
}

async function seedStage(
  client: import("pg").PoolClient,
  organizationId: string,
  pipelineId: string,
  opts: { sortOrder?: number; isWon?: boolean; isLost?: boolean; name?: string } = {},
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order, is_won_stage, is_lost_stage)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      organizationId,
      pipelineId,
      opts.name ?? "Test Stage",
      opts.sortOrder ?? 10,
      opts.isWon ?? false,
      opts.isLost ?? false,
    ],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedOrgs();
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("pipelines: basic schema", () => {
  it("a pipeline can be created with just organization_id and name", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.pipelines (organization_id, name) values ($1, $2) returning id, organization_id, name, is_default, deleted_at",
        [fx.orgAId, "Acme Pipeline"],
      );
      return r.rows[0];
    });
    expect(row.name).toBe("Acme Pipeline");
    expect(row.organization_id).toBe(fx.orgAId);
    expect(row.is_default).toBe(false);
    expect(row.deleted_at).toBeNull();
  });

  it("name is required", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.pipelines (organization_id) values ($1)", [fx.orgAId]);
      }),
    ).rejects.toThrow(/null value in column "name"/i);
  });
});

describe("pipelines: at-most-one-active-default invariant", () => {
  it("a second active default pipeline in the same organization is rejected", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await seedPipeline(client, fx.orgAId, { isDefault: true, name: "First Default" });
        await client.query(
          "insert into public.pipelines (organization_id, name, is_default) values ($1, $2, true)",
          [fx.orgAId, "Second Default"],
        );
      }),
    ).rejects.toThrow(/pipelines_org_active_default_idx|duplicate key/i);
  });

  it("a new active default is allowed once the previous one is soft-deleted", async () => {
    const secondId = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const firstId = await seedPipeline(client, fx.orgAId, { isDefault: true, name: "Soon Deleted Default" });
      await client.query("update public.pipelines set deleted_at = now() where id = $1", [firstId]);
      const r = await client.query(
        "insert into public.pipelines (organization_id, name, is_default) values ($1, $2, true) returning id",
        [fx.orgAId, "Replacement Default"],
      );
      return r.rows[0].id;
    });
    expect(secondId).toBeTruthy();
  });

  it("two different organizations can each have their own active default pipeline", async () => {
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await seedPipeline(client, fx.orgAId, { isDefault: true, name: "Org A Default" });
    });
    await withTenantContext({ organizationId: fx.orgBId }, async (client) => {
      await seedPipeline(client, fx.orgBId, { isDefault: true, name: "Org B Default" });
    });
  });
});

describe("pipeline_stages: basic schema and checks", () => {
  it("a stage can be created with valid fields", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const r = await client.query(
        `insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order, probability)
         values ($1, $2, $3, $4, $5) returning name, sort_order, probability, is_won_stage, is_lost_stage, deleted_at`,
        [fx.orgAId, pipelineId, "Discovery", 10, 25],
      );
      return r.rows[0];
    });
    expect(row.name).toBe("Discovery");
    expect(row.sort_order).toBe(10);
    expect(row.probability).toBe(25);
    expect(row.is_won_stage).toBe(false);
    expect(row.is_lost_stage).toBe(false);
    expect(row.deleted_at).toBeNull();
  });

  it("probability is nullable", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const r = await client.query(
        "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, $3, $4) returning probability",
        [fx.orgAId, pipelineId, "No Probability Stage", 10],
      );
      return r.rows[0];
    });
    expect(row.probability).toBeNull();
  });

  it.each([-1, 101])("rejects a probability of %i outside 0..100", async (bad) => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineId = await seedPipeline(client, fx.orgAId);
        await client.query(
          "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order, probability) values ($1, $2, $3, $4, $5)",
          [fx.orgAId, pipelineId, "Bad Probability Stage", 10, bad],
        );
      }),
    ).rejects.toThrow(/pipeline_stages_probability_range|violates check constraint/i);
  });

  it.each([0, 100])("accepts a boundary probability of %i", async (boundary) => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const r = await client.query(
        "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order, probability) values ($1, $2, $3, $4, $5) returning probability",
        [fx.orgAId, pipelineId, "Boundary Stage", 10, boundary],
      );
      return r.rows[0];
    });
    expect(row.probability).toBe(boundary);
  });

  it("rejects a stage flagged as both won and lost", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineId = await seedPipeline(client, fx.orgAId);
        await client.query(
          `insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order, is_won_stage, is_lost_stage)
           values ($1, $2, $3, $4, true, true)`,
          [fx.orgAId, pipelineId, "Contradiction Stage", 10],
        );
      }),
    ).rejects.toThrow(/pipeline_stages_not_won_and_lost|violates check constraint/i);
  });

  it("accepts a stage flagged as won only, and one flagged as lost only", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const won = await client.query(
        "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order, is_won_stage) values ($1, $2, $3, $4, true) returning is_won_stage, is_lost_stage",
        [fx.orgAId, pipelineId, "Won Stage", 10],
      );
      const lost = await client.query(
        "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order, is_lost_stage) values ($1, $2, $3, $4, true) returning is_won_stage, is_lost_stage",
        [fx.orgAId, pipelineId, "Lost Stage", 20],
      );
      return [won.rows[0], lost.rows[0]];
    });
    expect(rows[0]).toEqual({ is_won_stage: true, is_lost_stage: false });
    expect(rows[1]).toEqual({ is_won_stage: false, is_lost_stage: true });
  });
});

describe("pipeline_stages: cross-tenant pipeline FK (same-org success, cross-org failure)", () => {
  it("a stage can be created for a pipeline in its own organization", async () => {
    const stageId = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      return seedStage(client, fx.orgAId, pipelineId);
    });
    expect(stageId).toBeTruthy();
  });

  it("a stage cannot be created for a pipeline belonging to a different organization", async () => {
    const pipelineInOrgB = await seedAsAdmin(async (client) => seedPipeline(client, fx.orgBId));
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, $3, $4)",
          [fx.orgAId, pipelineInOrgB, "Cross Org Stage Attempt", 10],
        );
      }),
    ).rejects.toThrow(/pipeline_stages_pipeline_org_fk|foreign key/i);
  });
});

describe("deals: basic schema and defaults", () => {
  it("a deal can be created with only the required fields, and defaults apply", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const stageId = await seedStage(client, fx.orgAId, pipelineId);
      const r = await client.query(
        `insert into public.deals (organization_id, pipeline_id, stage_id)
         values ($1, $2, $3)
         returning currency, status, amount, probability, expected_close_date, owner_id, company_id, primary_contact_id, deleted_at`,
        [fx.orgAId, pipelineId, stageId],
      );
      return r.rows[0];
    });
    expect(row.currency).toBe("EUR");
    expect(row.status).toBe("open");
    expect(row.amount).toBeNull();
    expect(row.probability).toBeNull();
    expect(row.expected_close_date).toBeNull();
    expect(row.owner_id).toBeNull();
    expect(row.company_id).toBeNull();
    expect(row.primary_contact_id).toBeNull();
    expect(row.deleted_at).toBeNull();
  });

  it("pipeline_id is required", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineId = await seedPipeline(client, fx.orgAId);
        const stageId = await seedStage(client, fx.orgAId, pipelineId);
        await client.query("insert into public.deals (organization_id, stage_id) values ($1, $2)", [
          fx.orgAId,
          stageId,
        ]);
      }),
    ).rejects.toThrow(/null value in column "pipeline_id"/i);
  });

  it("stage_id is required", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineId = await seedPipeline(client, fx.orgAId);
        await client.query("insert into public.deals (organization_id, pipeline_id) values ($1, $2)", [
          fx.orgAId,
          pipelineId,
        ]);
      }),
    ).rejects.toThrow(/null value in column "stage_id"/i);
  });

  it.each(["eur", "EU", "EURO", "12A"])("rejects malformed/lowercase currency %s", async (bad) => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineId = await seedPipeline(client, fx.orgAId);
        const stageId = await seedStage(client, fx.orgAId, pipelineId);
        await client.query(
          "insert into public.deals (organization_id, pipeline_id, stage_id, currency) values ($1, $2, $3, $4)",
          [fx.orgAId, pipelineId, stageId, bad],
        );
      }),
    ).rejects.toThrow(/deals_currency_format|violates check constraint/i);
  });

  it("accepts a valid uppercase 3-letter currency other than the default", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const stageId = await seedStage(client, fx.orgAId, pipelineId);
      const r = await client.query(
        "insert into public.deals (organization_id, pipeline_id, stage_id, currency) values ($1, $2, $3, $4) returning currency",
        [fx.orgAId, pipelineId, stageId, "USD"],
      );
      return r.rows[0];
    });
    expect(row.currency).toBe("USD");
  });

  it.each([-1, 101])("rejects a deal probability of %i outside 0..100", async (bad) => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineId = await seedPipeline(client, fx.orgAId);
        const stageId = await seedStage(client, fx.orgAId, pipelineId);
        await client.query(
          "insert into public.deals (organization_id, pipeline_id, stage_id, probability) values ($1, $2, $3, $4)",
          [fx.orgAId, pipelineId, stageId, bad],
        );
      }),
    ).rejects.toThrow(/deals_probability_range|violates check constraint/i);
  });

  it("rejects a status outside open/won/lost", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineId = await seedPipeline(client, fx.orgAId);
        const stageId = await seedStage(client, fx.orgAId, pipelineId);
        await client.query(
          "insert into public.deals (organization_id, pipeline_id, stage_id, status) values ($1, $2, $3, $4)",
          [fx.orgAId, pipelineId, stageId, "abandoned"],
        );
      }),
    ).rejects.toThrow(/deals_status_allowed|violates check constraint/i);
  });

  it.each(["open", "won", "lost"])("accepts the approved status value %s", async (status) => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const stageId = await seedStage(client, fx.orgAId, pipelineId);
      const r = await client.query(
        "insert into public.deals (organization_id, pipeline_id, stage_id, status) values ($1, $2, $3, $4) returning status",
        [fx.orgAId, pipelineId, stageId, status],
      );
      return r.rows[0];
    });
    expect(row.status).toBe(status);
  });
});

describe("deals: status-derivation boundary (documented 2.2A/2.2B split)", () => {
  it("direct SQL CAN create a schema-valid deal whose status contradicts its stage's won/lost flags — no trigger enforces consistency in 2.2A", async () => {
    // Deliberately proves the gap, not a bug: deals.status is a plain
    // CHECK-constrained column with no FK/trigger tying it to
    // pipeline_stages.is_won_stage/is_lost_stage. Deriving/enforcing that
    // relationship is the future 2.2B domain layer's responsibility
    // (packages/crm), never this schema (docs/13 Milestone 2.2A
    // "Status-derivation boundary").
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const wonStageId = await seedStage(client, fx.orgAId, pipelineId, { isWon: true, name: "Won Stage" });
      const r = await client.query(
        "insert into public.deals (organization_id, pipeline_id, stage_id, status) values ($1, $2, $3, 'open') returning status",
        [fx.orgAId, pipelineId, wonStageId],
      );
      return r.rows[0];
    });
    expect(row.status).toBe("open");
  });
});

describe("deals: composite-FK relationships (same-org success, cross-org/wrong-pipeline failure)", () => {
  it("a deal can reference a company, a contact, a pipeline, and a stage all in its own organization", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const company = await client.query<{ id: string }>(
        "insert into public.companies (organization_id, name) values ($1, $2) returning id",
        [fx.orgAId, "Deal Test Co"],
      );
      const contact = await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
        [fx.orgAId, "Deal Test Contact"],
      );
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const stageId = await seedStage(client, fx.orgAId, pipelineId);
      const r = await client.query(
        `insert into public.deals (organization_id, company_id, primary_contact_id, pipeline_id, stage_id)
         values ($1, $2, $3, $4, $5) returning company_id, primary_contact_id, pipeline_id, stage_id`,
        [fx.orgAId, company.rows[0]!.id, contact.rows[0]!.id, pipelineId, stageId],
      );
      return r.rows[0];
    });
    expect(row.company_id).toBeTruthy();
    expect(row.primary_contact_id).toBeTruthy();
  });

  it("a deal cannot reference a company belonging to a different organization", async () => {
    const companyInOrgB = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.companies (organization_id, name) values ($1, $2) returning id",
        [fx.orgBId, "Org B Co For Deal"],
      );
      return r.rows[0]!.id;
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineId = await seedPipeline(client, fx.orgAId);
        const stageId = await seedStage(client, fx.orgAId, pipelineId);
        await client.query(
          "insert into public.deals (organization_id, company_id, pipeline_id, stage_id) values ($1, $2, $3, $4)",
          [fx.orgAId, companyInOrgB, pipelineId, stageId],
        );
      }),
    ).rejects.toThrow(/deals_company_org_fk|foreign key/i);
  });

  it("a deal cannot reference a contact belonging to a different organization", async () => {
    const contactInOrgB = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
        [fx.orgBId, "Org B Contact For Deal"],
      );
      return r.rows[0]!.id;
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineId = await seedPipeline(client, fx.orgAId);
        const stageId = await seedStage(client, fx.orgAId, pipelineId);
        await client.query(
          "insert into public.deals (organization_id, primary_contact_id, pipeline_id, stage_id) values ($1, $2, $3, $4)",
          [fx.orgAId, contactInOrgB, pipelineId, stageId],
        );
      }),
    ).rejects.toThrow(/deals_contact_org_fk|foreign key/i);
  });

  it("a deal cannot reference a pipeline belonging to a different organization", async () => {
    const pipelineInOrgB = await seedAsAdmin(async (client) => seedPipeline(client, fx.orgBId));
    const stageInOrgB = await seedAsAdmin(async (client) => seedStage(client, fx.orgBId, pipelineInOrgB));
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3)", [
          fx.orgAId,
          pipelineInOrgB,
          stageInOrgB,
        ]);
      }),
    ).rejects.toThrow(/deals_pipeline_org_fk|foreign key/i);
  });

  it("a deal cannot reference a stage belonging to a different organization", async () => {
    const ownPipeline = await seedAsAdmin(async (client) => seedPipeline(client, fx.orgAId));
    const pipelineInOrgB = await seedAsAdmin(async (client) => seedPipeline(client, fx.orgBId));
    const stageInOrgB = await seedAsAdmin(async (client) => seedStage(client, fx.orgBId, pipelineInOrgB));
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3)", [
          fx.orgAId,
          ownPipeline,
          stageInOrgB,
        ]);
      }),
    ).rejects.toThrow(/deals_stage_org_fk|foreign key/i);
  });

  it("a deal cannot reference a stage that belongs to a different pipeline in the SAME organization", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineOne = await seedPipeline(client, fx.orgAId, { name: "Pipeline One" });
        const pipelineTwo = await seedPipeline(client, fx.orgAId, { name: "Pipeline Two" });
        const stageOnPipelineTwo = await seedStage(client, fx.orgAId, pipelineTwo);
        await client.query("insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3)", [
          fx.orgAId,
          pipelineOne,
          stageOnPipelineTwo,
        ]);
      }),
    ).rejects.toThrow(/deals_stage_pipeline_fk|foreign key/i);
  });

  it("nullable company_id and primary_contact_id are both accepted", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const stageId = await seedStage(client, fx.orgAId, pipelineId);
      const r = await client.query(
        "insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3) returning company_id, primary_contact_id",
        [fx.orgAId, pipelineId, stageId],
      );
      return r.rows[0];
    });
    expect(row.company_id).toBeNull();
    expect(row.primary_contact_id).toBeNull();
  });
});

describe("deals: hard-delete FK behavior", () => {
  it("hard-deleting a company sets only company_id to NULL on its deals, leaving organization_id/pipeline_id/stage_id intact", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const company = await client.query<{ id: string }>(
        "insert into public.companies (organization_id, name) values ($1, $2) returning id",
        [fx.orgAId, "About To Be Hard Deleted (Deal FK)"],
      );
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const stageId = await seedStage(client, fx.orgAId, pipelineId);
      const deal = await client.query<{ id: string }>(
        "insert into public.deals (organization_id, company_id, pipeline_id, stage_id) values ($1, $2, $3, $4) returning id",
        [fx.orgAId, company.rows[0]!.id, pipelineId, stageId],
      );
      await client.query("delete from public.companies where id = $1", [company.rows[0]!.id]);
      const after = await client.query(
        "select organization_id, company_id, pipeline_id, stage_id from public.deals where id = $1",
        [deal.rows[0]!.id],
      );
      expect(after.rows[0].company_id).toBeNull();
      expect(after.rows[0].organization_id).toBe(fx.orgAId);
      expect(after.rows[0].pipeline_id).toBe(pipelineId);
      expect(after.rows[0].stage_id).toBe(stageId);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a pipeline still referenced by a deal cannot be hard-deleted (ON DELETE RESTRICT)", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const stageId = await seedStage(client, fx.orgAId, pipelineId);
      await client.query("insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3)", [
        fx.orgAId,
        pipelineId,
        stageId,
      ]);
      await expect(client.query("delete from public.pipelines where id = $1", [pipelineId])).rejects.toThrow(
        /deals_pipeline_org_fk|foreign key|violates/i,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a stage still referenced by a deal cannot be hard-deleted (ON DELETE RESTRICT)", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const stageId = await seedStage(client, fx.orgAId, pipelineId);
      await client.query("insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3)", [
        fx.orgAId,
        pipelineId,
        stageId,
      ]);
      await expect(client.query("delete from public.pipeline_stages where id = $1", [stageId])).rejects.toThrow(
        /deals_stage_org_fk|deals_stage_pipeline_fk|foreign key|violates/i,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("hard-deleting a pipeline cascades to its own stages (no orphaned pipeline_stages) when no deal references them", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const stageId = await seedStage(client, fx.orgAId, pipelineId);
      await client.query("delete from public.pipelines where id = $1", [pipelineId]);
      const remaining = await client.query("select id from public.pipeline_stages where id = $1", [stageId]);
      expect(remaining.rows).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("pipelines/pipeline_stages/deals: updated_at trigger", () => {
  it("advances updated_at when a pipeline row is updated", async () => {
    const inserted = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.pipelines (organization_id, name) values ($1, $2) returning id, updated_at",
        [fx.orgAId, "Timestamp Pipeline"],
      );
      return r.rows[0];
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "update public.pipelines set name = $1 where id = $2 returning updated_at",
        ["Timestamp Pipeline Renamed", inserted.id],
      );
      return r.rows[0];
    });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(inserted.updated_at).getTime());
  });

  it("advances updated_at when a pipeline_stages row is updated", async () => {
    const pipelineId = await seedAsAdmin(async (client) => seedPipeline(client, fx.orgAId));
    const inserted = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, $3, $4) returning id, updated_at",
        [fx.orgAId, pipelineId, "Timestamp Stage", 10],
      );
      return r.rows[0];
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "update public.pipeline_stages set name = $1 where id = $2 returning updated_at",
        ["Timestamp Stage Renamed", inserted.id],
      );
      return r.rows[0];
    });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(inserted.updated_at).getTime());
  });

  it("advances updated_at when a deals row is updated", async () => {
    const { pipelineId, stageId } = await seedAsAdmin(async (client) => {
      const pipelineId = await seedPipeline(client, fx.orgAId);
      const stageId = await seedStage(client, fx.orgAId, pipelineId);
      return { pipelineId, stageId };
    });
    const inserted = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3) returning id, updated_at",
        [fx.orgAId, pipelineId, stageId],
      );
      return r.rows[0];
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await seedAsAdmin(async (client) => {
      const r = await client.query("update public.deals set amount = $1 where id = $2 returning updated_at", [
        1000,
        inserted.id,
      ]);
      return r.rows[0];
    });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(inserted.updated_at).getTime());
  });
});

describe("soft delete", () => {
  it("a soft-deleted pipeline row remains physically present after a real commit — never a physical DELETE", async () => {
    const pipeline = await seedAsAdmin(async (client) => {
      const id = await seedPipeline(client, fx.orgAId, { name: "Soft Deleted Pipeline" });
      await client.query("update public.pipelines set deleted_at = now() where id = $1", [id]);
      return { id };
    });
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, deleted_at from public.pipelines where id = $1", [pipeline.id]);
      return r.rows[0];
    });
    expect(row).toBeDefined();
    expect(row.deleted_at).not.toBeNull();
  });

  it("deleted_at can be cleared (restore) via an ordinary UPDATE", async () => {
    const pipeline = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const id = await seedPipeline(client, fx.orgAId, { name: "Restore Test Pipeline" });
      await client.query("update public.pipelines set deleted_at = now() where id = $1", [id]);
      const restored = await client.query(
        "update public.pipelines set deleted_at = null where id = $1 returning deleted_at",
        [id],
      );
      return restored.rows[0];
    });
    expect(pipeline.deleted_at).toBeNull();
  });

  it("RLS itself does not hide a soft-deleted pipeline from an ordinary SELECT within the same organization", async () => {
    const pipeline = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const id = await seedPipeline(client, fx.orgAId, { name: "Visible Despite Soft Delete" });
      await client.query("update public.pipelines set deleted_at = now() where id = $1", [id]);
      const selected = await client.query("select id, deleted_at from public.pipelines where id = $1", [id]);
      return selected.rows[0];
    });
    expect(pipeline).toBeDefined();
    expect(pipeline.deleted_at).not.toBeNull();
  });

  it("no DELETE grant exists on pipelines/pipeline_stages/deals for authenticated (an ordinary session genuinely cannot physically DELETE)", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const pipelineId = await seedPipeline(client, fx.orgAId);
        await client.query("delete from public.pipelines where id = $1", [pipelineId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("contacts prerequisite: composite UNIQUE(organization_id, id)", () => {
  it("the contacts_organization_id_id_key unique constraint exists", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select conname from pg_constraint
         where conrelid = 'public.contacts'::regclass and conname = 'contacts_organization_id_id_key'`,
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it("no regression: an ordinary contact insert/select still works exactly as before", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id, first_name",
        [fx.orgAId, "No Regression Contact"],
      );
      return r.rows[0];
    });
    expect(row.first_name).toBe("No Regression Contact");
  });
});
