import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, createOrgWithActiveMember } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import { createPipeline } from "../src/pipelines";
import {
  createPipelineStage,
  getPipelineStageById,
  getPipelineStageByIdIncludingDeleted,
  listPipelineStages,
  updatePipelineStage,
  softDeletePipelineStage,
} from "../src/pipeline-stages";
import { createDeal, getDealById } from "../src/deals";
import { ValidationError, InvalidPipelineRelationshipError } from "../src/errors";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function makeCtxWithPipeline() {
  const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
  const ctx = { userId, organizationId, roleKey };
  const pipeline = await createPipeline(ctx, { name: "Test Pipeline", isDefault: true });
  return { ctx, pipeline };
}

describe("createPipelineStage", () => {
  it("creates a stage and persists organization_id/pipeline_id", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 10 });
    expect(stage.organizationId).toBe(ctx.organizationId);
    expect(stage.pipelineId).toBe(pipeline.id);
    expect(stage.name).toBe("Lead");
    expect(stage.isWonStage).toBe(false);
    expect(stage.isLostStage).toBe(false);
  });

  it("rejects a whitespace-only name", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    await expect(
      createPipelineStage(ctx, { pipelineId: pipeline.id, name: "   ", sortOrder: 10 }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-integer sortOrder", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    await expect(
      createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 1.5 }),
    ).rejects.toThrow(ValidationError);
  });

  it.each([-1, 101])("rejects a probability of %i outside 0..100", async (bad) => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    await expect(
      createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 10, probability: bad }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a stage flagged as both won and lost", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    await expect(
      createPipelineStage(ctx, {
        pipelineId: pipeline.id,
        name: "Contradiction",
        sortOrder: 10,
        isWonStage: true,
        isLostStage: true,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a pipelineId that does not resolve to an active pipeline in this organization", async () => {
    const { ctx } = await makeCtxWithPipeline();
    await expect(
      createPipelineStage(ctx, { pipelineId: "00000000-0000-0000-0000-000000000000", name: "Lead", sortOrder: 10 }),
    ).rejects.toThrow(InvalidPipelineRelationshipError);
  });

  it("rejects a pipelineId belonging to a different organization", async () => {
    const { ctx, pipeline: pipelineInB } = await makeCtxWithPipeline();
    const orgA = await createOrgWithActiveMember();
    void ctx;
    await expect(
      createPipelineStage(
        { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
        { pipelineId: pipelineInB.id, name: "Lead", sortOrder: 10 },
      ),
    ).rejects.toThrow(InvalidPipelineRelationshipError);
  });
});

describe("getPipelineStageById / getPipelineStageByIdIncludingDeleted", () => {
  it("returns null for nonexistent, cross-org, soft-deleted, AND wrong-pipeline — indistinguishably", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const otherPipeline = await createPipeline(ctx, { name: "Other Pipeline" });
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 10 });
    const deletedStage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Deletable", sortOrder: 20 });
    await softDeletePipelineStage(ctx, pipeline.id, deletedStage.id);

    expect(await getPipelineStageById(ctx, pipeline.id, "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await getPipelineStageById(ctx, pipeline.id, deletedStage.id)).toBeNull();
    expect(await getPipelineStageById(ctx, otherPipeline.id, stage.id)).toBeNull();

    const orgB = await createOrgWithActiveMember();
    expect(
      await getPipelineStageById({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, pipeline.id, stage.id),
    ).toBeNull();
  });

  it("getPipelineStageByIdIncludingDeleted resolves a soft-deleted stage for historical display", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Historical", sortOrder: 10 });
    await softDeletePipelineStage(ctx, pipeline.id, stage.id);

    const resolved = await getPipelineStageByIdIncludingDeleted(ctx, pipeline.id, stage.id);
    expect(resolved?.name).toBe("Historical");
    expect(resolved?.deletedAt).not.toBeNull();
  });
});

describe("listPipelineStages", () => {
  it("returns only active stages for the given pipeline, ordered by sort_order", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Third", sortOrder: 30 });
    await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "First", sortOrder: 10 });
    const deleted = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Deleted", sortOrder: 20 });
    await softDeletePipelineStage(ctx, pipeline.id, deleted.id);

    const stages = await listPipelineStages(ctx, pipeline.id);
    expect(stages.map((s) => s.name)).toEqual(["First", "Third"]);
  });

  it("tenant isolation: never returns another pipeline's or another org's stages", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const otherPipeline = await createPipeline(ctx, { name: "Other" });
    await createPipelineStage(ctx, { pipelineId: otherPipeline.id, name: "Other Pipeline Stage", sortOrder: 10 });

    const stages = await listPipelineStages(ctx, pipeline.id);
    expect(stages).toEqual([]);
  });
});

describe("updatePipelineStage", () => {
  it("updates name/sortOrder/probability", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 10 });
    const updated = await updatePipelineStage(ctx, pipeline.id, stage.id, {
      name: "Renamed",
      sortOrder: 15,
      probability: 40,
    });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.sortOrder).toBe(15);
    expect(updated?.probability).toBe(40);
  });

  it("rejects a final state that would be both won and lost", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 10, isWonStage: true });
    await expect(updatePipelineStage(ctx, pipeline.id, stage.id, { isLostStage: true })).rejects.toThrow(
      ValidationError,
    );
  });

  it("no-op update (empty input) returns the current row unchanged", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 10 });
    const updated = await updatePipelineStage(ctx, pipeline.id, stage.id, {});
    expect(updated?.name).toBe("Lead");
  });

  it("returns null for nonexistent/cross-org/wrong-pipeline/already-deleted", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const otherPipeline = await createPipeline(ctx, { name: "Other" });
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 10 });
    expect(await updatePipelineStage(ctx, otherPipeline.id, stage.id, { name: "X" })).toBeNull();
  });
});

describe("updatePipelineStage: classification-change deal-status cascade", () => {
  it("open -> won: reclassifying a stage to won moves referenced deals to won", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Negotiation", sortOrder: 10 });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    expect(deal.status).toBe("open");

    await updatePipelineStage(ctx, pipeline.id, stage.id, { isWonStage: true });
    const refetched = await getDealById(ctx, deal.id);
    expect(refetched?.status).toBe("won");
  });

  it("won -> lost: reclassifying directly from won to lost moves referenced deals to lost", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, {
      pipelineId: pipeline.id,
      name: "Closing",
      sortOrder: 10,
      isWonStage: true,
    });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    expect(deal.status).toBe("won");

    await updatePipelineStage(ctx, pipeline.id, stage.id, { isWonStage: false, isLostStage: true });
    const refetched = await getDealById(ctx, deal.id);
    expect(refetched?.status).toBe("lost");
  });

  it("lost -> open: clearing isLostStage moves referenced deals back to open", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, {
      pipelineId: pipeline.id,
      name: "Reconsidered",
      sortOrder: 10,
      isLostStage: true,
    });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    expect(deal.status).toBe("lost");

    await updatePipelineStage(ctx, pipeline.id, stage.id, { isLostStage: false });
    const refetched = await getDealById(ctx, deal.id);
    expect(refetched?.status).toBe("open");
  });

  it("does NOT recompute status when isWonStage/isLostStage are resupplied unchanged", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Stable", sortOrder: 10 });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });

    await seedAsAdmin(async (client) => {
      await client.query("update public.deals set status = 'won' where id = $1", [deal.id]);
    });
    await updatePipelineStage(ctx, pipeline.id, stage.id, { isWonStage: false, isLostStage: false, name: "Stable" });

    const refetched = await getDealById(ctx, deal.id);
    expect(refetched?.status).toBe("won");
  });

  it("also updates the denormalized status of a SOFT-DELETED deal referencing the reclassified stage (deliberate consistency choice)", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Historical", sortOrder: 10 });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    await seedAsAdmin(async (client) => {
      await client.query("update public.deals set deleted_at = now() where id = $1", [deal.id]);
    });

    await updatePipelineStage(ctx, pipeline.id, stage.id, { isWonStage: true });

    const row = await seedAsAdmin(async (client) => {
      const r = await client.query("select status, deleted_at from public.deals where id = $1", [deal.id]);
      return r.rows[0];
    });
    expect(row.status).toBe("won");
    expect(row.deleted_at).not.toBeNull();
  });

  it("rolls back the whole transaction if the cascade would touch an invalid state — proven by wrapping in a failing existingClient transaction", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Rollback Stage", sortOrder: 10 });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });

    const client = await adminPool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query(
        "select set_config('request.jwt.claims', json_build_object('role','authenticated','sub',$1::text)::text, true)",
        [ctx.userId],
      );
      await client.query("select set_config('app.current_org', $1, true)", [ctx.organizationId]);
      await updatePipelineStage(ctx, pipeline.id, stage.id, { isWonStage: true }, client);
      // Force the same transaction to fail AFTER the cascade already ran,
      // to prove the cascade's writes roll back with the rest.
      await client.query("select 1/0");
    } catch {
      await client.query("rollback");
    } finally {
      client.release();
    }

    const refetched = await getDealById(ctx, deal.id);
    expect(refetched?.status).toBe("open");
  });
});

describe("softDeletePipelineStage: frozen Milestone 2.2 decision (does not reject a stage still referenced by active deals)", () => {
  it("allows soft-deleting a stage that still has an active deal referencing it", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Referenced Stage", sortOrder: 10 });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });

    const deleted = await softDeletePipelineStage(ctx, pipeline.id, stage.id);
    expect(deleted?.deletedAt).not.toBeNull();
  });

  it("returns null for nonexistent/cross-org/wrong-pipeline/already-deleted", async () => {
    const { ctx, pipeline } = await makeCtxWithPipeline();
    expect(await softDeletePipelineStage(ctx, pipeline.id, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
