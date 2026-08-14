import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.2A RLS/privilege adversarial coverage (docs/13-Technical-
 * Design-Review.md "Milestone 2.2A"). Mirrors companies-contacts-
 * rls.test.ts exactly in style: real Postgres, never mocked, org A vs
 * org B, and a direct information_schema check for the effective
 * privilege set rather than trusting "should inherit defaults" without
 * proof.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
  pipelineAId: string;
  pipelineBId: string;
  stageAId: string;
  stageBId: string;
  dealAId: string;
  dealBId: string;
}

let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Pipelines RLS Test Org A', $1) returning id",
      [`pipelines-rls-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Pipelines RLS Test Org B', $1) returning id",
      [`pipelines-rls-test-org-b-${randomUUID()}`],
    );
    const pipelineA = await client.query<{ id: string }>(
      "insert into public.pipelines (organization_id, name) values ($1, $2) returning id",
      [orgA.rows[0]!.id, "Org A Pipeline"],
    );
    const pipelineB = await client.query<{ id: string }>(
      "insert into public.pipelines (organization_id, name) values ($1, $2) returning id",
      [orgB.rows[0]!.id, "Org B Pipeline"],
    );
    const stageA = await client.query<{ id: string }>(
      "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, $3, $4) returning id",
      [orgA.rows[0]!.id, pipelineA.rows[0]!.id, "Org A Stage", 10],
    );
    const stageB = await client.query<{ id: string }>(
      "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, $3, $4) returning id",
      [orgB.rows[0]!.id, pipelineB.rows[0]!.id, "Org B Stage", 10],
    );
    const dealA = await client.query<{ id: string }>(
      "insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3) returning id",
      [orgA.rows[0]!.id, pipelineA.rows[0]!.id, stageA.rows[0]!.id],
    );
    const dealB = await client.query<{ id: string }>(
      "insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3) returning id",
      [orgB.rows[0]!.id, pipelineB.rows[0]!.id, stageB.rows[0]!.id],
    );
    return {
      orgAId: orgA.rows[0]!.id,
      orgBId: orgB.rows[0]!.id,
      pipelineAId: pipelineA.rows[0]!.id,
      pipelineBId: pipelineB.rows[0]!.id,
      stageAId: stageA.rows[0]!.id,
      stageBId: stageB.rows[0]!.id,
      dealAId: dealA.rows[0]!.id,
      dealBId: dealB.rows[0]!.id,
    };
  });
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedFixture();
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("pipelines/pipeline_stages/deals RLS: cross-tenant SELECT/UPDATE isolation", () => {
  it("org A cannot SELECT org B's pipeline", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.pipelines where id = $1", [fx.pipelineBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's pipeline", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.pipelines set name = 'Hijacked' where id = $1 returning id", [
        fx.pipelineBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
    const stillIntact = await seedAsAdmin(async (client) => {
      const r = await client.query("select name from public.pipelines where id = $1", [fx.pipelineBId]);
      return r.rows[0];
    });
    expect(stillIntact.name).toBe("Org B Pipeline");
  });

  it("org A cannot SELECT org B's pipeline stage", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.pipeline_stages where id = $1", [fx.stageBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's pipeline stage", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.pipeline_stages set name = 'Hijacked' where id = $1 returning id", [
        fx.stageBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot SELECT org B's deal", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.deals where id = $1", [fx.dealBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's deal", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.deals set amount = 999999 where id = $1 returning id", [
        fx.dealBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
    const stillIntact = await seedAsAdmin(async (client) => {
      const r = await client.query("select amount from public.deals where id = $1", [fx.dealBId]);
      return r.rows[0];
    });
    expect(stillIntact.amount).toBeNull();
  });

  it("org A cannot soft-delete org B's deal", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.deals set deleted_at = now() where id = $1 returning id", [
        fx.dealBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
    const stillActive = await seedAsAdmin(async (client) => {
      const r = await client.query("select deleted_at from public.deals where id = $1", [fx.dealBId]);
      return r.rows[0];
    });
    expect(stillActive.deleted_at).toBeNull();
  });
});

describe("pipelines/pipeline_stages/deals RLS: WITH CHECK prevents organization_id spoofing/mutation", () => {
  it("INSERT cannot spoof organization_id on a pipeline to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.pipelines (organization_id, name) values ($1, $2)", [
          fx.orgBId,
          "Spoofed Pipeline Insert",
        ]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("UPDATE cannot move a pipeline from org A to org B", async () => {
    const pipeline = await seedAsAdmin(async (client) => {
      const r = await client.query("insert into public.pipelines (organization_id, name) values ($1, $2) returning id", [
        fx.orgAId,
        "Attempted Move Pipeline",
      ]);
      return r.rows[0];
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("update public.pipelines set organization_id = $1 where id = $2", [
          fx.orgBId,
          pipeline.id,
        ]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("INSERT cannot spoof organization_id on a deal to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3)", [
          fx.orgBId,
          fx.pipelineAId,
          fx.stageAId,
        ]);
      }),
      // Rejected by RLS's WITH CHECK before the composite FKs are even
      // relevant here (pipeline/stage belong to org A, not org B).
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("UPDATE cannot move a deal from org A to org B", async () => {
    const deal = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.deals (organization_id, pipeline_id, stage_id) values ($1, $2, $3) returning id",
        [fx.orgAId, fx.pipelineAId, fx.stageAId],
      );
      return r.rows[0];
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("update public.deals set organization_id = $1 where id = $2", [fx.orgBId, deal.id]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });
});

describe("pipelines/pipeline_stages/deals privileges: effective grants match the approved design", () => {
  it.each(["pipelines", "pipeline_stages", "deals"])(
    "authenticated has exactly SELECT/INSERT/UPDATE on %s — no DELETE, no TRUNCATE/REFERENCES/TRIGGER",
    async (table) => {
      const rows = await seedAsAdmin(async (client) => {
        const r = await client.query<{ privilege_type: string }>(
          `select privilege_type from information_schema.role_table_grants
           where table_schema = 'public' and table_name = $1 and grantee = 'authenticated'
           order by privilege_type`,
          [table],
        );
        return r.rows.map((row) => row.privilege_type);
      });
      expect(rows).toEqual(["INSERT", "SELECT", "UPDATE"]);
    },
  );

  it.each(["pipelines", "pipeline_stages", "deals"])("anon has zero grants on %s", async (table) => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = $1 and grantee = 'anon'`,
        [table],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("an authenticated session genuinely cannot physically DELETE a pipeline row", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.pipelines where id = $1", [fx.pipelineAId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an authenticated session genuinely cannot physically DELETE a deal row", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.deals where id = $1", [fx.dealAId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it.each(["pipelines", "pipeline_stages", "deals"])(
    "an authenticated session genuinely cannot TRUNCATE %s",
    async (table) => {
      await expect(
        withTenantContext({}, async (client) => {
          await client.query(`truncate public.${table}`);
        }),
      ).rejects.toThrow(/permission denied/i);
    },
  );
});
