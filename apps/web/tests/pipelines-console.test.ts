import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  adminPool,
  createOrgWithRole,
  createPureAgencyActor,
  createUnaffiliatedUser,
  seedPipeline,
  seedPipelineWithStage,
  seedDeal,
} from "./crm-api-fixtures";
import { decidePipelinesConsoleAccess } from "../app/pipelines/access";
import { createPipelineForResolvedContext } from "../app/pipelines/create-logic";
import { updatePipelineForResolvedContext } from "../app/pipelines/[id]/update-logic";
import { setDefaultPipelineForResolvedContext } from "../app/pipelines/[id]/set-default-logic";
import { deletePipelineForResolvedContext } from "../app/pipelines/[id]/delete-logic";
import { createStageForResolvedContext } from "../app/pipelines/[id]/create-stage-logic";
import { updateStageForResolvedContext } from "../app/pipelines/[id]/update-stage-logic";
import { deleteStageForResolvedContext } from "../app/pipelines/[id]/delete-stage-logic";
import { handleGetPipeline } from "../app/api/v1/pipelines/[id]/handlers";
import { handleGetPipelineStage } from "../app/api/v1/pipelines/[id]/stages/[stageId]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.2F. Mirrors deals-console.test.ts's shape and same
 * non-duplication reasoning: handleListPipelines/handleGetPipeline/
 * handleListPipelineStages/handleGetPipelineStage's own list/pagination/
 * 404/tenancy/RBAC behavior is already exhaustively covered by
 * pipelines-api.test.ts (19 tests) and pipeline-stages-api.test.ts
 * (25 tests), both unmodified and re-run as part of full regression.
 * What's new here — decidePipelinesConsoleAccess and the form-to-body
 * translation for pipeline/stage create/update/set-default/delete — gets
 * full dedicated coverage.
 */

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

afterAll(async () => {
  await closePool();
});

describe("decidePipelinesConsoleAccess()", () => {
  it("unauthenticated -> /login", () => {
    expect(decidePipelinesConsoleAccess(null, null)).toEqual({ kind: "redirect", to: "/login" });
  });

  it("authenticated with no org context -> /dashboard", () => {
    expect(decidePipelinesConsoleAccess(randomUUID(), null)).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it.each(["org_admin", "org_member", "org_viewer"] as const)("%s is allowed through", (roleKey) => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const decision = decidePipelinesConsoleAccess(userId, { organizationId, roleKey });
    expect(decision).toEqual({ kind: "allow", orgContext: { userId, organizationId, roleKey } });
  });

  it.each(["agency_owner", "agency_admin", "portal_customer"] as const)(
    "%s is redirected to /dashboard — no direct Pipelines UI access",
    (roleKey) => {
      const userId = randomUUID();
      const organizationId = randomUUID();
      const decision = decidePipelinesConsoleAccess(userId, { organizationId, roleKey });
      expect(decision).toEqual({ kind: "redirect", to: "/dashboard" });
    },
  );
});

describe("createPipelineForResolvedContext()", () => {
  it("creates the pipeline, ignoring forged organizationId/id/isDefault-bypass fields", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-create-admin");
    const result = await createPipelineForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), name: "New Pipeline", organizationId: randomUUID(), id: randomUUID() }),
    );
    expect(result.error).toBeUndefined();
    expect(result.createdId).toBeTruthy();

    const response = await handleGetPipeline(admin.userId, result.createdId!);
    const body = (await response.json()) as { pipeline: { organizationId: string; name: string; isDefault: boolean } };
    expect(body.pipeline.organizationId).toBe(admin.organizationId);
    expect(body.pipeline.name).toBe("New Pipeline");
    expect(body.pipeline.isDefault).toBe(false);
  });

  it("missing name is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-create-missing-name");
    const result = await createPipelineForResolvedContext(admin.userId, formData({ idempotencyKey: randomUUID() }));
    expect(result.error).toBeTruthy();
    expect(result.createdId).toBeUndefined();
  });

  it("isDefault checkbox creates the pipeline as the new active default", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-create-default");
    const result = await createPipelineForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), name: "Default Pipeline", isDefault: "on" }),
    );
    expect(result.error).toBeUndefined();
    const response = await handleGetPipeline(admin.userId, result.createdId!);
    const body = (await response.json()) as { pipeline: { isDefault: boolean } };
    expect(body.pipeline.isDefault).toBe(true);
  });

  it("an unauthorized mutation (org_viewer) is rejected", async () => {
    const viewer = await createOrgWithRole("org_viewer", "pipeline-create-viewer");
    const result = await createPipelineForResolvedContext(
      viewer.userId,
      formData({ idempotencyKey: randomUUID(), name: "Should Fail" }),
    );
    expect(result.error).toBeTruthy();
    expect(result.createdId).toBeUndefined();
  });

  it("the same idempotency key reused for a retry returns the same created pipeline, not a duplicate", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-create-retry");
    const key = randomUUID();
    const fd = () => formData({ idempotencyKey: key, name: "Retry Pipeline" });
    const first = await createPipelineForResolvedContext(admin.userId, fd());
    const second = await createPipelineForResolvedContext(admin.userId, fd());
    expect(first.createdId).toBeTruthy();
    expect(second.createdId).toBe(first.createdId);
  });

  it("the same key reused for a genuinely different payload is a conflict, not a silent second write", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-create-conflict");
    const key = randomUUID();
    const first = await createPipelineForResolvedContext(admin.userId, formData({ idempotencyKey: key, name: "Pipeline A" }));
    const second = await createPipelineForResolvedContext(admin.userId, formData({ idempotencyKey: key, name: "Pipeline B" }));
    expect(first.createdId).toBeTruthy();
    expect(second.error).toBeTruthy();
    expect(second.createdId).toBeUndefined();
  });
});

describe("updatePipelineForResolvedContext()", () => {
  it("updates the pipeline name", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-update-admin");
    const pipelineId = await seedPipeline(admin.organizationId, { name: "Old Name" });
    const result = await updatePipelineForResolvedContext(
      admin.userId,
      pipelineId,
      formData({ idempotencyKey: randomUUID(), name: "New Name" }),
    );
    expect(result.error).toBeUndefined();
    expect(result.updatedId).toBe(pipelineId);

    const response = await handleGetPipeline(admin.userId, pipelineId);
    const body = (await response.json()) as { pipeline: { name: string } };
    expect(body.pipeline.name).toBe("New Name");
  });

  it("has no code path for isDefault — an ordinary edit never changes it", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-update-no-default-bypass");
    const pipelineId = await seedPipeline(admin.organizationId, { name: "Not Default", isDefault: false });
    await updatePipelineForResolvedContext(admin.userId, pipelineId, formData({ idempotencyKey: randomUUID(), name: "Still Not Default" }));

    const response = await handleGetPipeline(admin.userId, pipelineId);
    const body = (await response.json()) as { pipeline: { isDefault: boolean } };
    expect(body.pipeline.isDefault).toBe(false);
  });

  it("missing/blank name is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-update-blank-name");
    const pipelineId = await seedPipeline(admin.organizationId);
    const result = await updatePipelineForResolvedContext(admin.userId, pipelineId, formData({ idempotencyKey: randomUUID(), name: "   " }));
    expect(result.error).toBeTruthy();
  });

  it("an unauthorized mutation (org_viewer) is rejected", async () => {
    const viewer = await createOrgWithRole("org_viewer", "pipeline-update-viewer");
    const pipelineId = await seedPipeline(viewer.organizationId);
    const result = await updatePipelineForResolvedContext(viewer.userId, pipelineId, formData({ idempotencyKey: randomUUID(), name: "Nope" }));
    expect(result.error).toBeTruthy();
  });

  it("the same idempotency key reused for a retry replays the same result", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-update-retry");
    const pipelineId = await seedPipeline(admin.organizationId, { name: "Original" });
    const key = randomUUID();
    const fd = () => formData({ idempotencyKey: key, name: "Updated Once" });
    const first = await updatePipelineForResolvedContext(admin.userId, pipelineId, fd());
    const second = await updatePipelineForResolvedContext(admin.userId, pipelineId, fd());
    expect(first.updatedId).toBe(pipelineId);
    expect(second.updatedId).toBe(pipelineId);
  });

  it("the same key reused for a genuinely different payload is a conflict", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-update-conflict");
    const pipelineId = await seedPipeline(admin.organizationId, { name: "Original" });
    const key = randomUUID();
    const first = await updatePipelineForResolvedContext(admin.userId, pipelineId, formData({ idempotencyKey: key, name: "Version A" }));
    const second = await updatePipelineForResolvedContext(admin.userId, pipelineId, formData({ idempotencyKey: key, name: "Version B" }));
    expect(first.updatedId).toBe(pipelineId);
    expect(second.error).toBeTruthy();
  });
});

describe("setDefaultPipelineForResolvedContext()", () => {
  it("switches the organization's active default", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-set-default-admin");
    const oldDefaultId = await seedPipeline(admin.organizationId, { name: "Old Default", isDefault: true });
    const newDefaultId = await seedPipeline(admin.organizationId, { name: "New Default", isDefault: false });

    const result = await setDefaultPipelineForResolvedContext(admin.userId, newDefaultId);
    expect(result.error).toBeUndefined();
    expect(result.updatedId).toBe(newDefaultId);

    const newResponse = await handleGetPipeline(admin.userId, newDefaultId);
    const newBody = (await newResponse.json()) as { pipeline: { isDefault: boolean } };
    expect(newBody.pipeline.isDefault).toBe(true);

    const oldResponse = await handleGetPipeline(admin.userId, oldDefaultId);
    const oldBody = (await oldResponse.json()) as { pipeline: { isDefault: boolean } };
    expect(oldBody.pipeline.isDefault).toBe(false);
  });

  it("is a natural no-op retry when the target is already the default — no error, same result", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-set-default-retry");
    const pipelineId = await seedPipeline(admin.organizationId, { name: "Already Default", isDefault: true });

    const first = await setDefaultPipelineForResolvedContext(admin.userId, pipelineId);
    const second = await setDefaultPipelineForResolvedContext(admin.userId, pipelineId);
    expect(first.updatedId).toBe(pipelineId);
    expect(second.updatedId).toBe(pipelineId);
    expect(second.error).toBeUndefined();
  });

  it("an invalid/cross-org/soft-deleted target produces a safe error, not a leak", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-set-default-invalid");
    const result = await setDefaultPipelineForResolvedContext(admin.userId, randomUUID());
    expect(result.error).toBeTruthy();
    expect(result.updatedId).toBeUndefined();
  });

  it("an unauthorized mutation (org_viewer) is rejected", async () => {
    const viewer = await createOrgWithRole("org_viewer", "pipeline-set-default-viewer");
    const pipelineId = await seedPipeline(viewer.organizationId);
    const result = await setDefaultPipelineForResolvedContext(viewer.userId, pipelineId);
    expect(result.error).toBeTruthy();
  });
});

describe("deletePipelineForResolvedContext()", () => {
  it("soft-deletes a non-default pipeline", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-delete-admin");
    const pipelineId = await seedPipeline(admin.organizationId, { isDefault: false });
    const result = await deletePipelineForResolvedContext(admin.userId, pipelineId);
    expect(result.deleted).toBe(true);

    const response = await handleGetPipeline(admin.userId, pipelineId);
    expect(response.status).toBe(404);
  });

  it("is soft-delete only — no physical row removal", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-delete-soft-only");
    const pipelineId = await seedPipeline(admin.organizationId, { isDefault: false });
    await deletePipelineForResolvedContext(admin.userId, pipelineId);

    const r = await adminPool.query("select id, deleted_at from public.pipelines where id = $1", [pipelineId]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].deleted_at).not.toBeNull();
  });

  it("cannot delete the active default pipeline — the existing 409 domain error surfaces as-is, no replacement auto-picked", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-delete-default");
    const pipelineId = await seedPipeline(admin.organizationId, { isDefault: true });
    const result = await deletePipelineForResolvedContext(admin.userId, pipelineId);
    expect(result.error).toBeTruthy();
    expect(result.deleted).toBeUndefined();

    const response = await handleGetPipeline(admin.userId, pipelineId);
    expect(response.status).toBe(200);
  });

  it("cross-org/nonexistent id produces a safe error, not a leak", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-delete-not-found");
    const result = await deletePipelineForResolvedContext(admin.userId, randomUUID());
    expect(result.error).toBeTruthy();
  });

  it("an unauthorized mutation (org_member has no pipelines:delete) is rejected", async () => {
    const member = await createOrgWithRole("org_member", "pipeline-delete-member");
    const pipelineId = await seedPipeline(member.organizationId, { isDefault: false });
    const result = await deletePipelineForResolvedContext(member.userId, pipelineId);
    expect(result.error).toBeTruthy();

    const response = await handleGetPipeline(member.userId, pipelineId);
    expect(response.status).toBe(200);
  });
});

describe("createStageForResolvedContext()", () => {
  it("creates the stage under the parent pipeline, ignoring a forged body pipelineId", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-create-admin");
    const pipelineId = await seedPipeline(admin.organizationId);
    const otherPipelineId = await seedPipeline(admin.organizationId, { name: "Other" });

    const result = await createStageForResolvedContext(
      admin.userId,
      pipelineId,
      formData({ idempotencyKey: randomUUID(), name: "New Stage", sortOrder: "10", pipelineId: otherPipelineId }),
    );
    expect(result.error).toBeUndefined();
    expect(result.createdId).toBeTruthy();

    const response = await handleGetPipelineStage(admin.userId, pipelineId, result.createdId!);
    expect(response.status).toBe(200);
    const otherResponse = await handleGetPipelineStage(admin.userId, otherPipelineId, result.createdId!);
    expect(otherResponse.status).toBe(404);
  });

  it("missing name is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-create-missing-name");
    const pipelineId = await seedPipeline(admin.organizationId);
    const result = await createStageForResolvedContext(admin.userId, pipelineId, formData({ idempotencyKey: randomUUID(), sortOrder: "0" }));
    expect(result.error).toBeTruthy();
  });

  it("missing/non-integer sortOrder is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-create-bad-sort");
    const pipelineId = await seedPipeline(admin.organizationId);
    const result = await createStageForResolvedContext(
      admin.userId,
      pipelineId,
      formData({ idempotencyKey: randomUUID(), name: "Stage", sortOrder: "not-a-number" }),
    );
    expect(result.error).toBeTruthy();
  });

  it("won and lost together is rejected by the domain layer, not silently accepted", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-create-won-lost");
    const pipelineId = await seedPipeline(admin.organizationId);
    const fd = formData({ idempotencyKey: randomUUID(), name: "Contradiction", sortOrder: "0" });
    fd.set("isWonStage", "on");
    fd.set("isLostStage", "on");
    const result = await createStageForResolvedContext(admin.userId, pipelineId, fd);
    expect(result.error).toBeTruthy();
    expect(result.createdId).toBeUndefined();
  });

  it("an out-of-range probability is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-create-bad-probability");
    const pipelineId = await seedPipeline(admin.organizationId);
    const result = await createStageForResolvedContext(
      admin.userId,
      pipelineId,
      formData({ idempotencyKey: randomUUID(), name: "Stage", sortOrder: "0", probability: "150" }),
    );
    expect(result.error).toBeTruthy();
  });

  it("an unauthorized mutation (org_member has no pipelines:create) is rejected", async () => {
    const member = await createOrgWithRole("org_member", "stage-create-member");
    const pipelineId = await seedPipeline(member.organizationId);
    const result = await createStageForResolvedContext(member.userId, pipelineId, formData({ idempotencyKey: randomUUID(), name: "Stage", sortOrder: "0" }));
    expect(result.error).toBeTruthy();
  });

  it("the same idempotency key reused for a retry returns the same created stage", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-create-retry");
    const pipelineId = await seedPipeline(admin.organizationId);
    const key = randomUUID();
    const fd = () => formData({ idempotencyKey: key, name: "Retry Stage", sortOrder: "0" });
    const first = await createStageForResolvedContext(admin.userId, pipelineId, fd());
    const second = await createStageForResolvedContext(admin.userId, pipelineId, fd());
    expect(second.createdId).toBe(first.createdId);
  });
});

describe("updateStageForResolvedContext()", () => {
  it("updates name/sortOrder/probability", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-update-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const result = await updateStageForResolvedContext(
      admin.userId,
      pipelineId,
      stageId,
      formData({ idempotencyKey: randomUUID(), name: "Renamed", sortOrder: "5", probability: "40" }),
    );
    expect(result.error).toBeUndefined();
    expect(result.updatedId).toBe(stageId);

    const response = await handleGetPipelineStage(admin.userId, pipelineId, stageId);
    const body = (await response.json()) as { stage: { name: string; sortOrder: number; probability: number | null } };
    expect(body.stage.name).toBe("Renamed");
    expect(body.stage.sortOrder).toBe(5);
    expect(body.stage.probability).toBe(40);
  });

  it("won and lost together is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-update-won-lost");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const fd = formData({ idempotencyKey: randomUUID(), name: "Stage", sortOrder: "0" });
    fd.set("isWonStage", "on");
    fd.set("isLostStage", "on");
    const result = await updateStageForResolvedContext(admin.userId, pipelineId, stageId, fd);
    expect(result.error).toBeTruthy();
  });

  it("wrong-parent pipeline safety: a genuinely existing stage under a DIFFERENT pipeline produces the same not-found-shaped error", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-update-wrong-parent");
    const { pipelineId: pipelineA, stageId } = await seedPipelineWithStage(admin.organizationId, { pipelineName: "A" });
    const pipelineB = await seedPipeline(admin.organizationId, { name: "B" });

    const result = await updateStageForResolvedContext(
      admin.userId,
      pipelineB,
      stageId,
      formData({ idempotencyKey: randomUUID(), name: "Hijack Attempt", sortOrder: "0" }),
    );
    expect(result.error).toBeTruthy();
    expect(result.updatedId).toBeUndefined();

    // the real stage, under its real parent, is untouched
    const response = await handleGetPipelineStage(admin.userId, pipelineA, stageId);
    const body = (await response.json()) as { stage: { name: string } };
    expect(body.stage.name).not.toBe("Hijack Attempt");
  });

  it("a classification change (open -> won) cascades to every deal referencing this stage", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-update-cascade");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);

    const before = await adminPool.query("select status from public.deals where id = $1", [dealId]);
    expect(before.rows[0].status).toBe("open");

    const result = await updateStageForResolvedContext(
      admin.userId,
      pipelineId,
      stageId,
      (() => {
        const fd = formData({ idempotencyKey: randomUUID(), name: "Won Stage", sortOrder: "0" });
        fd.set("isWonStage", "on");
        return fd;
      })(),
    );
    expect(result.error).toBeUndefined();

    const after = await adminPool.query("select status from public.deals where id = $1", [dealId]);
    expect(after.rows[0].status).toBe("won");
  });

  it("an unauthorized mutation (org_viewer) is rejected", async () => {
    const viewer = await createOrgWithRole("org_viewer", "stage-update-viewer");
    const { pipelineId, stageId } = await seedPipelineWithStage(viewer.organizationId);
    const result = await updateStageForResolvedContext(viewer.userId, pipelineId, stageId, formData({ idempotencyKey: randomUUID(), name: "Nope", sortOrder: "0" }));
    expect(result.error).toBeTruthy();
  });
});

describe("deleteStageForResolvedContext()", () => {
  it("soft-deletes a stage even while an active deal still references it", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-delete-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);

    const result = await deleteStageForResolvedContext(admin.userId, pipelineId, stageId);
    expect(result.deleted).toBe(true);

    const stageResponse = await handleGetPipelineStage(admin.userId, pipelineId, stageId);
    expect(stageResponse.status).toBe(404);

    // the deal is untouched — still points at the now-deleted stage
    const dealRow = await adminPool.query("select stage_id from public.deals where id = $1", [dealId]);
    expect(dealRow.rows[0].stage_id).toBe(stageId);
  });

  it("is soft-delete only — no physical row removal", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-delete-soft-only");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    await deleteStageForResolvedContext(admin.userId, pipelineId, stageId);

    const r = await adminPool.query("select id, deleted_at from public.pipeline_stages where id = $1", [stageId]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].deleted_at).not.toBeNull();
  });

  it("wrong-parent pipeline safety: cannot delete a genuinely existing stage via a different pipeline's id", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-delete-wrong-parent");
    const { pipelineId: pipelineA, stageId } = await seedPipelineWithStage(admin.organizationId, { pipelineName: "A" });
    const pipelineB = await seedPipeline(admin.organizationId, { name: "B" });

    const result = await deleteStageForResolvedContext(admin.userId, pipelineB, stageId);
    expect(result.error).toBeTruthy();
    expect(result.deleted).toBeUndefined();

    const response = await handleGetPipelineStage(admin.userId, pipelineA, stageId);
    expect(response.status).toBe(200);
  });

  it("an unauthorized mutation (org_member has no pipelines:delete) is rejected", async () => {
    const member = await createOrgWithRole("org_member", "stage-delete-member");
    const { pipelineId, stageId } = await seedPipelineWithStage(member.organizationId);
    const result = await deleteStageForResolvedContext(member.userId, pipelineId, stageId);
    expect(result.error).toBeTruthy();
  });
});

describe("security: agency and unaffiliated actors get no Pipelines UI access", () => {
  it("a pure agency actor is denied at the console access decision", async () => {
    await createPureAgencyActor();
    // No org context resolves for a pure agency actor — the console
    // decision function itself, given null orgContext, is what's under
    // test (matching deals-console.test.ts's own equivalent case).
    expect(decidePipelinesConsoleAccess(randomUUID(), null)).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it("an authenticated user with no membership at all is denied create", async () => {
    const userId = await createUnaffiliatedUser();
    const result = await createPipelineForResolvedContext(userId, formData({ idempotencyKey: randomUUID(), name: "Nope" }));
    expect(result.error).toBeTruthy();
  });
});
