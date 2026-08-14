import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  adminPool,
  createOrgWithRole,
  createPureAgencyActor,
  createUnaffiliatedUser,
  seedPipeline,
  seedPipelineStage,
  seedDeal,
} from "./crm-api-fixtures";
import { handleListPipelineStages, handleCreatePipelineStage } from "../app/api/v1/pipelines/[id]/stages/handlers";
import {
  handleGetPipelineStage,
  handleUpdatePipelineStage,
  handleDeletePipelineStage,
} from "../app/api/v1/pipelines/[id]/stages/[stageId]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function rowCount(sql: string, params: unknown[]): Promise<number> {
  const r = await adminPool.query(sql, params);
  return r.rows[0].n;
}

afterAll(async () => {
  await closePool();
});

describe("pipeline stages API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleListPipelineStages(null, randomUUID())).status).toBe(401);
    expect((await handleCreatePipelineStage(null, randomUUID(), {}, null)).status).toBe(401);
    expect((await handleGetPipelineStage(null, randomUUID(), randomUUID())).status).toBe(401);
    expect((await handleUpdatePipelineStage(null, randomUUID(), randomUUID(), {}, null)).status).toBe(401);
    expect((await handleDeletePipelineStage(null, randomUUID(), randomUUID())).status).toBe(401);
  });
});

describe("pipeline stages API: RBAC (authorizes under pipelines:*, no pipeline_stages:* keys)", () => {
  it("org_admin has full CRUD", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    const created = await handleCreatePipelineStage(userId, pipelineId, { name: "Lead", sortOrder: 10 }, null);
    expect(created.status).toBe(201);
    const { stage } = await created.json();

    expect((await handleGetPipelineStage(userId, pipelineId, stage.id)).status).toBe(200);
    expect((await handleUpdatePipelineStage(userId, pipelineId, stage.id, { name: "Renamed" }, null)).status).toBe(200);
    expect((await handleDeletePipelineStage(userId, pipelineId, stage.id)).status).toBe(200);
  });

  it("org_member: GET allowed, POST/PATCH/DELETE all denied", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const pipelineId = await seedPipeline(organizationId);
    const stageId = await seedPipelineStage(organizationId, pipelineId);

    expect((await handleListPipelineStages(userId, pipelineId)).status).toBe(200);
    expect((await handleGetPipelineStage(userId, pipelineId, stageId)).status).toBe(200);
    expect((await handleCreatePipelineStage(userId, pipelineId, { name: "X", sortOrder: 1 }, null)).status).toBe(403);
    expect((await handleUpdatePipelineStage(userId, pipelineId, stageId, { name: "X" }, null)).status).toBe(403);
    expect((await handleDeletePipelineStage(userId, pipelineId, stageId)).status).toBe(403);
  });

  it("org_viewer: GET allowed, all mutations denied", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const pipelineId = await seedPipeline(organizationId);
    const stageId = await seedPipelineStage(organizationId, pipelineId);

    expect((await handleListPipelineStages(userId, pipelineId)).status).toBe(200);
    expect((await handleGetPipelineStage(userId, pipelineId, stageId)).status).toBe(200);
    expect((await handleCreatePipelineStage(userId, pipelineId, { name: "X", sortOrder: 1 }, null)).status).toBe(403);
    expect((await handleUpdatePipelineStage(userId, pipelineId, stageId, { name: "X" }, null)).status).toBe(403);
    expect((await handleDeletePipelineStage(userId, pipelineId, stageId)).status).toBe(403);
  });

  it("a pure agency actor gets 403 on every verb", async () => {
    const userId = await createPureAgencyActor();
    expect((await handleListPipelineStages(userId, randomUUID())).status).toBe(403);
    expect((await handleCreatePipelineStage(userId, randomUUID(), {}, null)).status).toBe(403);
    expect((await handleGetPipelineStage(userId, randomUUID(), randomUUID())).status).toBe(403);
  });

  it("an authenticated user with no org membership at all gets 403", async () => {
    const userId = await createUnaffiliatedUser();
    expect((await handleListPipelineStages(userId, randomUUID())).status).toBe(403);
  });
});

describe("pipeline stages API: nested-parent semantics (LIST/GET/CREATE against a nonexistent or cross-org pipeline)", () => {
  it("LIST returns 404 for a nonexistent pipeline id", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleListPipelineStages(userId, randomUUID())).status).toBe(404);
  });

  it("LIST returns 404 for a cross-org pipeline id", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-stages-list");
    const orgB = await createOrgWithRole("org_admin", "org-b-stages-list");
    const pipelineB = await seedPipeline(orgB.organizationId);
    expect((await handleListPipelineStages(orgA.userId, pipelineB)).status).toBe(404);
  });

  it("CREATE returns 404 for a nonexistent pipeline id", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreatePipelineStage(userId, randomUUID(), { name: "X", sortOrder: 1 }, null);
    expect(res.status).toBe(404);
  });

  it("CREATE returns 404 for a cross-org pipeline id", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-stages-create");
    const orgB = await createOrgWithRole("org_admin", "org-b-stages-create");
    const pipelineB = await seedPipeline(orgB.organizationId);
    const res = await handleCreatePipelineStage(orgA.userId, pipelineB, { name: "X", sortOrder: 1 }, null);
    expect(res.status).toBe(404);
  });
});

describe("pipeline stages API: adversarial nested-stage IDOR safety", () => {
  it("GET /pipelines/A/stages/B where B actually belongs to pipeline C (same org) returns the SAME 404 as a genuinely nonexistent stage — never a distinguishing message", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineA = await seedPipeline(organizationId, { name: "Pipeline A" });
    const pipelineC = await seedPipeline(organizationId, { name: "Pipeline C" });
    const stageB = await seedPipelineStage(organizationId, pipelineC, { name: "Belongs To C" });

    const wrongParent = await handleGetPipelineStage(userId, pipelineA, stageB);
    const genuinelyMissing = await handleGetPipelineStage(userId, pipelineA, randomUUID());
    expect(wrongParent.status).toBe(404);
    expect(genuinelyMissing.status).toBe(404);
    const wrongParentBody = await wrongParent.json();
    expect(wrongParentBody).toEqual(await genuinelyMissing.json());
    expect(wrongParentBody).toEqual({ error: "Not found" });
  });

  it("GET /pipelines/A/stages/B where B belongs to a pipeline in a DIFFERENT organization entirely returns the same 404", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-idor-get");
    const orgB = await createOrgWithRole("org_admin", "org-b-idor-get");
    const pipelineA = await seedPipeline(orgA.organizationId);
    const pipelineB = await seedPipeline(orgB.organizationId);
    const stageB = await seedPipelineStage(orgB.organizationId, pipelineB);

    const res = await handleGetPipelineStage(orgA.userId, pipelineA, stageB);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("PATCH /pipelines/A/stages/B where B belongs to pipeline C returns 404, and does not mutate B", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineA = await seedPipeline(organizationId, { name: "Pipeline A" });
    const pipelineC = await seedPipeline(organizationId, { name: "Pipeline C" });
    const stageB = await seedPipelineStage(organizationId, pipelineC, { name: "Original Name" });

    const res = await handleUpdatePipelineStage(userId, pipelineA, stageB, { name: "Hijacked" }, null);
    expect(res.status).toBe(404);

    const stillOriginal = await handleGetPipelineStage(userId, pipelineC, stageB);
    expect((await stillOriginal.json()).stage.name).toBe("Original Name");
  });

  it("DELETE /pipelines/A/stages/B where B belongs to pipeline C returns 404, and does not soft-delete B", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineA = await seedPipeline(organizationId, { name: "Pipeline A" });
    const pipelineC = await seedPipeline(organizationId, { name: "Pipeline C" });
    const stageB = await seedPipelineStage(organizationId, pipelineC);

    const res = await handleDeletePipelineStage(userId, pipelineA, stageB);
    expect(res.status).toBe(404);

    const stillActive = await handleGetPipelineStage(userId, pipelineC, stageB);
    expect(stillActive.status).toBe(200);
    expect((await stillActive.json()).stage.deletedAt).toBeNull();
  });

  it("cross-org wrong-parent PATCH/DELETE also both return 404 with no distinguishing detail", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-idor-mutate");
    const orgB = await createOrgWithRole("org_admin", "org-b-idor-mutate");
    const pipelineA = await seedPipeline(orgA.organizationId);
    const pipelineB = await seedPipeline(orgB.organizationId);
    const stageB = await seedPipelineStage(orgB.organizationId, pipelineB);

    const patchRes = await handleUpdatePipelineStage(orgA.userId, pipelineA, stageB, { name: "X" }, null);
    const deleteRes = await handleDeletePipelineStage(orgA.userId, pipelineA, stageB);
    expect(patchRes.status).toBe(404);
    expect(deleteRes.status).toBe(404);
    expect(await patchRes.json()).toEqual({ error: "Not found" });
    expect(await deleteRes.json()).toEqual({ error: "Not found" });
  });
});

describe("pipeline stages API: create/list/single/update/soft-delete", () => {
  it("create -> 201, get -> 200, update -> 200, delete -> 200 with deletedAt, then GET -> 404", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    const created = await handleCreatePipelineStage(userId, pipelineId, { name: "Lead", sortOrder: 10 }, null);
    expect(created.status).toBe(201);
    const { stage } = await created.json();
    expect(stage.pipelineId).toBe(pipelineId);

    const got = await handleGetPipelineStage(userId, pipelineId, stage.id);
    expect(got.status).toBe(200);

    const updated = await handleUpdatePipelineStage(userId, pipelineId, stage.id, { probability: 40 }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).stage.probability).toBe(40);

    const deleted = await handleDeletePipelineStage(userId, pipelineId, stage.id);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).stage.deletedAt).not.toBeNull();

    expect((await handleGetPipelineStage(userId, pipelineId, stage.id)).status).toBe(404);
  });

  it("LIST returns stages ordered by sort_order", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    await seedPipelineStage(organizationId, pipelineId, { name: "Second", sortOrder: 20 });
    await seedPipelineStage(organizationId, pipelineId, { name: "First", sortOrder: 10 });

    const res = await handleListPipelineStages(userId, pipelineId);
    expect(res.status).toBe(200);
    const { stages } = await res.json();
    expect(stages.map((s: { name: string }) => s.name)).toEqual(["First", "Second"]);
  });

  it("invalid probability -> 400", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    const res = await handleCreatePipelineStage(
      userId,
      pipelineId,
      { name: "Bad Probability", sortOrder: 10, probability: 150 },
      null,
    );
    expect(res.status).toBe(400);
  });

  it("won and lost both true -> 400", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    const res = await handleCreatePipelineStage(
      userId,
      pipelineId,
      { name: "Contradiction", sortOrder: 10, isWonStage: true, isLostStage: true },
      null,
    );
    expect(res.status).toBe(400);
  });
});

describe("pipeline stages API: status cascade after classification change", () => {
  it("PATCH changing isWonStage cascades deals.status for referenced deals", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    const stageId = await seedPipelineStage(organizationId, pipelineId, { name: "Negotiation" });
    const dealId = await seedDeal(organizationId, pipelineId, stageId);

    const updated = await handleUpdatePipelineStage(userId, pipelineId, stageId, { isWonStage: true }, null);
    expect(updated.status).toBe(200);

    const dealStatus = await adminPool.query("select status from public.deals where id = $1", [dealId]);
    expect(dealStatus.rows[0].status).toBe("won");
  });
});

describe("pipeline stages API: mass assignment", () => {
  it("a body pipelineId claiming a DIFFERENT pipeline than the URL has no effect — stage is always created under the URL's pipelineId", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineA = await seedPipeline(organizationId, { name: "Pipeline A" });
    const pipelineC = await seedPipeline(organizationId, { name: "Pipeline C" });

    const res = await handleCreatePipelineStage(
      userId,
      pipelineA,
      { name: "Body Injection Attempt", sortOrder: 10, pipelineId: pipelineC },
      null,
    );
    expect(res.status).toBe(201);
    const { stage } = await res.json();
    expect(stage.pipelineId).toBe(pipelineA);
    expect(stage.pipelineId).not.toBe(pipelineC);
  });

  it("body organizationId/organization_id/id/deletedAt/createdAt/updatedAt injection has no effect", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    const forgedId = randomUUID();
    const res = await handleCreatePipelineStage(
      userId,
      pipelineId,
      {
        name: "Forged",
        sortOrder: 10,
        organizationId: randomUUID(),
        organization_id: randomUUID(),
        id: forgedId,
        deletedAt: new Date().toISOString(),
        deleted_at: new Date().toISOString(),
      },
      null,
    );
    expect(res.status).toBe(201);
    const { stage } = await res.json();
    expect(stage.organizationId).toBe(organizationId);
    expect(stage.id).not.toBe(forgedId);
    expect(stage.deletedAt).toBeNull();
  });
});

describe("pipeline stages API: idempotency", () => {
  it("POST replays the exact response for the same key + payload, callback runs only once", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    const key = randomUUID();
    const first = await handleCreatePipelineStage(userId, pipelineId, { name: "Idem Stage", sortOrder: 10 }, key);
    const second = await handleCreatePipelineStage(userId, pipelineId, { name: "Idem Stage", sortOrder: 10 }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());

    const n = await rowCount(
      "select count(*)::int as n from public.pipeline_stages where pipeline_id = $1 and name = 'Idem Stage'",
      [pipelineId],
    );
    expect(n).toBe(1);
  });

  it("POST same key + different payload -> 409", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    const key = randomUUID();
    await handleCreatePipelineStage(userId, pipelineId, { name: "Original", sortOrder: 10 }, key);
    const conflict = await handleCreatePipelineStage(userId, pipelineId, { name: "Different", sortOrder: 20 }, key);
    expect(conflict.status).toBe(409);
  });

  it("PATCH replays the exact response for the same key + payload", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    const stageId = await seedPipelineStage(organizationId, pipelineId);
    const key = randomUUID();
    const first = await handleUpdatePipelineStage(userId, pipelineId, stageId, { name: "Renamed" }, key);
    const second = await handleUpdatePipelineStage(userId, pipelineId, stageId, { name: "Renamed" }, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });
});
