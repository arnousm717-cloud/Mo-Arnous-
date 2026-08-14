import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  adminPool,
  createOrgWithRole,
  createPureAgencyActor,
  seedPipeline,
  seedPipelineStage,
  seedPipelineWithStage,
  seedDeal,
} from "./crm-api-fixtures";
import { moveDealToStageForResolvedContext } from "../app/deals/board/move-logic";
import { handleGetDeal } from "../app/api/v1/deals/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.2F §25. Stage move is an ordinary Deal PATCH
 * (handleUpdateDeal, unmodified) — its own general mass-assignment/
 * relationship/idempotency behavior is already exhaustively covered by
 * deals-api.test.ts and deals-console.test.ts, re-run unmodified as part
 * of full regression. This file covers only what move-logic.ts itself
 * adds: translating a board move (dealId + target stageId) into that
 * exact same PATCH path, nothing more.
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

describe("moveDealToStageForResolvedContext()", () => {
  it("an authorized move (org_admin) succeeds and updates the deal's stage", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-admin");
    const pipelineId = await seedPipeline(admin.organizationId);
    const fromStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "From", sortOrder: 0 });
    const toStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "To", sortOrder: 10 });
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);

    const result = await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: randomUUID(), stageId: toStage }));
    expect(result.error).toBeUndefined();
    expect(result.movedId).toBe(dealId);

    const response = await handleGetDeal(admin.userId, dealId);
    const body = (await response.json()) as { deal: { stageId: string } };
    expect(body.deal.stageId).toBe(toStage);
  });

  it("org_member (deals:update) can move a deal", async () => {
    const member = await createOrgWithRole("org_member", "board-move-member");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(member.organizationId, { stageName: "From" });
    const toStage = await seedPipelineStage(member.organizationId, pipelineId, { name: "To", sortOrder: 10 });
    const dealId = await seedDeal(member.organizationId, pipelineId, fromStage);

    const result = await moveDealToStageForResolvedContext(member.userId, dealId, formData({ idempotencyKey: randomUUID(), stageId: toStage }));
    expect(result.error).toBeUndefined();
    expect(result.movedId).toBe(dealId);
  });

  it("org_viewer cannot move a deal", async () => {
    const viewer = await createOrgWithRole("org_viewer", "board-move-viewer");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(viewer.organizationId, { stageName: "From" });
    const toStage = await seedPipelineStage(viewer.organizationId, pipelineId, { name: "To", sortOrder: 10 });
    const dealId = await seedDeal(viewer.organizationId, pipelineId, fromStage);

    const result = await moveDealToStageForResolvedContext(viewer.userId, dealId, formData({ idempotencyKey: randomUUID(), stageId: toStage }));
    expect(result.error).toBeTruthy();
    expect(result.movedId).toBeUndefined();
  });

  it("a pure agency actor cannot move a deal", async () => {
    const agencyUserId = await createPureAgencyActor();
    const admin = await createOrgWithRole("org_admin", "board-move-agency-target-org");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "From" });
    const toStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "To", sortOrder: 10 });
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);

    const result = await moveDealToStageForResolvedContext(agencyUserId, dealId, formData({ idempotencyKey: randomUUID(), stageId: toStage }));
    expect(result.error).toBeTruthy();
  });

  it("a wrong-pipeline stage is rejected as a destination", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-wrong-pipeline");
    const { pipelineId: pipelineA, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { pipelineName: "A" });
    const { stageId: stageInB } = await seedPipelineWithStage(admin.organizationId, { pipelineName: "B" });
    const dealId = await seedDeal(admin.organizationId, pipelineA, fromStage);

    const result = await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: randomUUID(), stageId: stageInB }));
    expect(result.error).toBeTruthy();
    expect(result.movedId).toBeUndefined();

    const response = await handleGetDeal(admin.userId, dealId);
    const body = (await response.json()) as { deal: { stageId: string } };
    expect(body.deal.stageId).toBe(fromStage);
  });

  it("a soft-deleted stage is rejected as a destination — it must not appear as a valid new target", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-deleted-stage");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "From" });
    const deletedStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "Gone", sortOrder: 10 });
    await adminPool.query("update public.pipeline_stages set deleted_at = now() where id = $1", [deletedStage]);
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);

    const result = await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: randomUUID(), stageId: deletedStage }));
    expect(result.error).toBeTruthy();
    expect(result.movedId).toBeUndefined();
  });

  it("a cross-org deal cannot be moved", async () => {
    const orgA = await createOrgWithRole("org_admin", "board-move-cross-org-a");
    const orgB = await createOrgWithRole("org_admin", "board-move-cross-org-b");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(orgB.organizationId, { stageName: "From" });
    const toStage = await seedPipelineStage(orgB.organizationId, pipelineId, { name: "To", sortOrder: 10 });
    const dealId = await seedDeal(orgB.organizationId, pipelineId, fromStage);

    const result = await moveDealToStageForResolvedContext(orgA.userId, dealId, formData({ idempotencyKey: randomUUID(), stageId: toStage }));
    expect(result.error).toBeTruthy();
    expect(result.movedId).toBeUndefined();
  });

  it("a cross-org stage id cannot be used as a destination even for the actor's own deal", async () => {
    const orgA = await createOrgWithRole("org_admin", "board-move-cross-org-stage-a");
    const orgB = await createOrgWithRole("org_admin", "board-move-cross-org-stage-b");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(orgA.organizationId, { stageName: "From" });
    const { stageId: stageInB } = await seedPipelineWithStage(orgB.organizationId, { stageName: "Other Org Stage" });
    const dealId = await seedDeal(orgA.organizationId, pipelineId, fromStage);

    const result = await moveDealToStageForResolvedContext(orgA.userId, dealId, formData({ idempotencyKey: randomUUID(), stageId: stageInB }));
    expect(result.error).toBeTruthy();
  });

  it("moving to a won-flagged stage derives status = won", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-won");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "From" });
    const wonStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "Won", sortOrder: 10, isWonStage: true });
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);

    await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: randomUUID(), stageId: wonStage }));
    const response = await handleGetDeal(admin.userId, dealId);
    const body = (await response.json()) as { deal: { status: string } };
    expect(body.deal.status).toBe("won");
  });

  it("moving to a lost-flagged stage derives status = lost", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-lost");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "From" });
    const lostStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "Lost", sortOrder: 10, isLostStage: true });
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);

    await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: randomUUID(), stageId: lostStage }));
    const response = await handleGetDeal(admin.userId, dealId);
    const body = (await response.json()) as { deal: { status: string } };
    expect(body.deal.status).toBe("lost");
  });

  it("moving back to an ordinary (unflagged) stage derives status = open", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-back-to-open");
    const { pipelineId, stageId: openStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "Open" });
    const wonStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "Won", sortOrder: 10, isWonStage: true });
    const dealId = await seedDeal(admin.organizationId, pipelineId, wonStage);
    await adminPool.query("update public.deals set status = 'won' where id = $1", [dealId]);

    await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: randomUUID(), stageId: openStage }));
    const response = await handleGetDeal(admin.userId, dealId);
    const body = (await response.json()) as { deal: { status: string } };
    expect(body.deal.status).toBe("open");
  });

  it("no direct status mutation is possible through this path — there is no code path for a status field at all", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-no-status-field");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "From" });
    const toStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "To", sortOrder: 10 });
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);

    await moveDealToStageForResolvedContext(
      admin.userId,
      dealId,
      formData({ idempotencyKey: randomUUID(), stageId: toStage, status: "won" }),
    );
    const response = await handleGetDeal(admin.userId, dealId);
    const body = (await response.json()) as { deal: { status: string } };
    expect(body.deal.status).toBe("open");
  });

  it("the same idempotency key reused for a retry replays the same result, not a second move", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-retry");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "From" });
    const toStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "To", sortOrder: 10 });
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);
    const key = randomUUID();

    const first = await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: key, stageId: toStage }));
    const second = await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: key, stageId: toStage }));
    expect(first.movedId).toBe(dealId);
    expect(second.movedId).toBe(dealId);
    expect(second.error).toBeUndefined();
  });

  it("the same key reused for a genuinely different target stage is a conflict, not a silent second write", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-conflict");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "From" });
    const stageB = await seedPipelineStage(admin.organizationId, pipelineId, { name: "B", sortOrder: 10 });
    const stageC = await seedPipelineStage(admin.organizationId, pipelineId, { name: "C", sortOrder: 20 });
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);
    const key = randomUUID();

    const first = await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: key, stageId: stageB }));
    const second = await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: key, stageId: stageC }));
    expect(first.movedId).toBe(dealId);
    expect(second.error).toBeTruthy();
    expect(second.movedId).toBeUndefined();

    // the conflicting second request never actually moved the deal
    const response = await handleGetDeal(admin.userId, dealId);
    const body = (await response.json()) as { deal: { stageId: string } };
    expect(body.deal.stageId).toBe(stageB);
  });

  it("authorization is rechecked before replay — a demoted actor cannot replay a stale move with continued authority", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-demoted");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "From" });
    const toStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "To", sortOrder: 10 });
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);
    const key = randomUUID();

    const first = await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: key, stageId: toStage }));
    expect(first.movedId).toBe(dealId);

    await adminPool.query(
      "update public.memberships set role_id = (select id from public.roles where key = 'org_viewer') where user_id = $1 and organization_id = $2",
      [admin.userId, admin.organizationId],
    );

    const replay = await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: key, stageId: toStage }));
    expect(replay.error).toBeTruthy();
  });

  it("a missing destination stageId is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-missing-stage");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "From" });
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);

    const result = await moveDealToStageForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: randomUUID() }));
    expect(result.error).toBeTruthy();
  });

  it("a missing idempotency key is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "board-move-missing-key");
    const { pipelineId, stageId: fromStage } = await seedPipelineWithStage(admin.organizationId, { stageName: "From" });
    const toStage = await seedPipelineStage(admin.organizationId, pipelineId, { name: "To", sortOrder: 10 });
    const dealId = await seedDeal(admin.organizationId, pipelineId, fromStage);

    const fd = new FormData();
    fd.set("stageId", toStage);
    const result = await moveDealToStageForResolvedContext(admin.userId, dealId, fd);
    expect(result.error).toBeTruthy();
  });
});
