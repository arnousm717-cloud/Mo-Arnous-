import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  adminPool,
  createOrgWithRole,
  createPureAgencyActor,
  createUnaffiliatedUser,
  setMembershipStatus,
  seedCompany,
  seedContact,
  seedPipeline,
  seedPipelineStage,
  seedPipelineWithStage,
  seedDeal,
} from "./crm-api-fixtures";
import { decideDealsConsoleAccess } from "../app/deals/access";
import { dealDisplayLabel } from "../app/deals/deal-display";
import { listActiveContactOptions } from "../app/_shared/contact-options";
import { resolveContactDisplayName } from "../app/_shared/contact-display";
import { listActivePipelineOptions, listActiveStageOptions } from "../app/_shared/pipeline-options";
import { resolvePipelineDisplayName, resolveStageDisplayName } from "../app/_shared/pipeline-display";
import { createDealForResolvedContext } from "../app/deals/create-logic";
import { updateDealForResolvedContext } from "../app/deals/[id]/update-logic";
import { deleteDealForResolvedContext } from "../app/deals/[id]/delete-logic";
import { handleGetDeal } from "../app/api/v1/deals/[id]/handlers";
import { handleDeleteCompany } from "../app/api/v1/companies/[id]/handlers";
import { handleDeleteContact } from "../app/api/v1/contacts/[id]/handlers";
import { handleDeletePipeline } from "../app/api/v1/pipelines/[id]/handlers";
import { handleDeletePipelineStage } from "../app/api/v1/pipelines/[id]/stages/[stageId]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.2E. Mirrors contacts-console.test.ts's shape and same
 * non-duplication reasoning: handleListDeals/handleGetDeal's own list/
 * pagination/filter/404/tenancy/RBAC behavior is already exhaustively
 * covered by deals-api.test.ts (30 tests, unmodified, re-run as part of
 * full regression) — DealsPage/the detail page call those exact
 * functions with no additional logic beyond URL/param assembly. What's
 * new here — decideDealsConsoleAccess, the four relationship display/
 * options helpers, and the form-to-body translation for five
 * relationship fields (company/contact/owner/pipeline/stage) — gets full
 * dedicated coverage.
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

describe("decideDealsConsoleAccess()", () => {
  it("unauthenticated -> /login", () => {
    expect(decideDealsConsoleAccess(null, null)).toEqual({ kind: "redirect", to: "/login" });
  });

  it("authenticated with no org context -> /dashboard", () => {
    expect(decideDealsConsoleAccess(randomUUID(), null)).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it.each(["org_admin", "org_member", "org_viewer"] as const)("%s is allowed through", (roleKey) => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const decision = decideDealsConsoleAccess(userId, { organizationId, roleKey });
    expect(decision).toEqual({ kind: "allow", orgContext: { userId, organizationId, roleKey } });
  });

  it.each(["agency_owner", "agency_admin", "portal_customer"] as const)(
    "%s is redirected to /dashboard — no direct Deals UI access",
    (roleKey) => {
      const userId = randomUUID();
      const organizationId = randomUUID();
      const decision = decideDealsConsoleAccess(userId, { organizationId, roleKey });
      expect(decision).toEqual({ kind: "redirect", to: "/dashboard" });
    },
  );
});

describe("dealDisplayLabel()", () => {
  it("prefers the company name", () => {
    expect(dealDisplayLabel("abcdefgh-0000-0000-0000-000000000000", "Acme Co", "Ada Lovelace")).toBe("Acme Co");
  });

  it("falls back to the contact name when no company", () => {
    expect(dealDisplayLabel("abcdefgh-0000-0000-0000-000000000000", null, "Ada Lovelace")).toBe("Ada Lovelace");
  });

  it("falls back to a short id-derived label when neither exists — never a full raw UUID", () => {
    const label = dealDisplayLabel("abcdefgh-0000-0000-0000-000000000000", null, null);
    expect(label).toBe("Deal abcdefgh");
    expect(label).not.toBe("abcdefgh-0000-0000-0000-000000000000");
  });
});

describe("listActivePipelineOptions() / listActiveStageOptions()", () => {
  it("excludes a soft-deleted pipeline from the choices", async () => {
    const admin = await createOrgWithRole("org_admin", "pipeline-opts-admin");
    const activeId = await seedPipeline(admin.organizationId, { name: "Active Pipeline" });
    const deletedId = await seedPipeline(admin.organizationId, { name: "Deleted Pipeline" });
    await handleDeletePipeline(admin.userId, deletedId);

    const options = await listActivePipelineOptions(admin);
    const ids = options.map((o) => o.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(deletedId);
  });

  it("excludes a soft-deleted stage from the choices, scoped correctly per pipeline", async () => {
    const admin = await createOrgWithRole("org_admin", "stage-opts-admin");
    const pipelineId = await seedPipeline(admin.organizationId);
    const activeStageId = await seedPipelineStage(admin.organizationId, pipelineId, { name: "Active Stage" });
    const deletedStageId = await seedPipelineStage(admin.organizationId, pipelineId, { name: "Deleted Stage" });
    await handleDeletePipelineStage(admin.userId, pipelineId, deletedStageId);

    const options = await listActiveStageOptions(admin, [pipelineId]);
    const ids = options.map((o) => o.id);
    expect(ids).toContain(activeStageId);
    expect(ids).not.toContain(deletedStageId);
    expect(options.every((o) => o.pipelineId === pipelineId)).toBe(true);
  });
});

describe("listActiveContactOptions()", () => {
  it("excludes a soft-deleted contact from the choices", async () => {
    const admin = await createOrgWithRole("org_admin", "contact-opts-admin");
    const activeId = await seedContact(admin.organizationId, { firstName: "Active" });
    const deletedId = await seedContact(admin.organizationId, { firstName: "Deleted" });
    await handleDeleteContact(admin.userId, deletedId);

    const options = await listActiveContactOptions(admin);
    const ids = options.map((o) => o.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(deletedId);
  });
});

describe("createDealForResolvedContext()", () => {
  it("creates the deal, ignoring forged organizationId/id/status", async () => {
    const admin = await createOrgWithRole("org_admin", "create-success-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const result = await createDealForResolvedContext(
      admin.userId,
      formData({
        idempotencyKey: randomUUID(),
        pipelineId,
        stageId,
        organizationId: randomUUID(),
        id: randomUUID(),
        status: "won",
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.createdId).toBeTruthy();

    const response = await handleGetDeal(admin.userId, result.createdId!);
    const body = (await response.json()) as { deal: { organizationId: string; status: string } };
    expect(body.deal.organizationId).toBe(admin.organizationId);
    expect(body.deal.status).toBe("open"); // forged status ignored, derived from stage
  });

  it("missing pipeline/stage is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "create-missing-pipeline-admin");
    const result = await createDealForResolvedContext(admin.userId, formData({ idempotencyKey: randomUUID() }));
    expect(result.error).toBeTruthy();
    expect(result.createdId).toBeUndefined();
  });

  it("an invalid owner produces a safe error, not a leak", async () => {
    const admin = await createOrgWithRole("org_admin", "create-invalid-owner-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const result = await createDealForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), pipelineId, stageId, ownerId: randomUUID() }),
    );
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/relation|syntax|constraint/i);
  });

  it("a cross-org company relationship produces a safe error, not a leak", async () => {
    const admin = await createOrgWithRole("org_admin", "create-cross-org-company-admin");
    const otherOrg = await createOrgWithRole("org_admin", "create-cross-org-company-other");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const otherCompanyId = await seedCompany(otherOrg.organizationId);

    const result = await createDealForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), pipelineId, stageId, companyId: otherCompanyId }),
    );
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/relation|syntax|constraint/i);
  });

  it("a cross-org contact relationship produces a safe error, not a leak", async () => {
    const admin = await createOrgWithRole("org_admin", "create-cross-org-contact-admin");
    const otherOrg = await createOrgWithRole("org_admin", "create-cross-org-contact-other");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const otherContactId = await seedContact(otherOrg.organizationId);

    const result = await createDealForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), pipelineId, stageId, primaryContactId: otherContactId }),
    );
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/relation|syntax|constraint/i);
  });

  it("a wrong-pipeline stage is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "create-wrong-pipeline-stage-admin");
    const { pipelineId } = await seedPipelineWithStage(admin.organizationId);
    const otherPipelineId = await seedPipeline(admin.organizationId, { name: "Other" });
    const otherStageId = await seedPipelineStage(admin.organizationId, otherPipelineId);

    const result = await createDealForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), pipelineId, stageId: otherStageId }),
    );
    expect(result.error).toBeTruthy();
  });

  it("status is derived from a won-flagged stage, never client-settable", async () => {
    const admin = await createOrgWithRole("org_admin", "create-status-derived-admin");
    const pipelineId = await seedPipeline(admin.organizationId, { isDefault: true });
    const wonStageId = await seedPipelineStage(admin.organizationId, pipelineId, { name: "Won", isWonStage: true });

    const result = await createDealForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), pipelineId, stageId: wonStageId, status: "open" }),
    );
    expect(result.createdId).toBeTruthy();
    const response = await handleGetDeal(admin.userId, result.createdId!);
    const body = (await response.json()) as { deal: { status: string } };
    expect(body.deal.status).toBe("won");
  });

  it("an unauthorized mutation (org_viewer) is rejected", async () => {
    const viewer = await createOrgWithRole("org_viewer", "create-unauthorized-viewer");
    const { pipelineId, stageId } = await seedPipelineWithStage(viewer.organizationId);
    const result = await createDealForResolvedContext(
      viewer.userId,
      formData({ idempotencyKey: randomUUID(), pipelineId, stageId }),
    );
    expect(result.error).toBeTruthy();
  });

  it("the same idempotency key reused for a retry returns the same created deal, not a duplicate", async () => {
    const admin = await createOrgWithRole("org_admin", "create-idempotent-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const key = randomUUID();
    const first = await createDealForResolvedContext(admin.userId, formData({ idempotencyKey: key, pipelineId, stageId }));
    const second = await createDealForResolvedContext(admin.userId, formData({ idempotencyKey: key, pipelineId, stageId }));
    expect(first.createdId).toBe(second.createdId);

    const r = await adminPool.query(
      "select count(*)::int as n from public.deals where organization_id = $1 and pipeline_id = $2",
      [admin.organizationId, pipelineId],
    );
    expect(r.rows[0].n).toBe(1);
  });

  it("the same key reused for a genuinely different payload is a conflict, not a silent second write", async () => {
    const admin = await createOrgWithRole("org_admin", "create-conflict-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const key = randomUUID();
    const first = await createDealForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, pipelineId, stageId, amount: "100" }),
    );
    expect(first.createdId).toBeTruthy();

    const second = await createDealForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, pipelineId, stageId, amount: "200" }),
    );
    expect(second.error).toBeTruthy();
    expect(second.createdId).toBeUndefined();
  });
});

describe("updateDealForResolvedContext()", () => {
  it("updates the touched field and leaves untouched relationships at their existing value", async () => {
    const admin = await createOrgWithRole("org_admin", "update-success-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);

    const result = await updateDealForResolvedContext(
      admin.userId,
      dealId,
      formData({
        idempotencyKey: randomUUID(),
        companyId: "",
        originalCompanyId: "",
        primaryContactId: "",
        originalPrimaryContactId: "",
        ownerId: "",
        originalOwnerId: "",
        pipelineId,
        originalPipelineId: pipelineId,
        stageId,
        originalStageId: stageId,
        amount: "500",
        currency: "EUR",
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.updatedId).toBe(dealId);

    const r = await adminPool.query("select amount from public.deals where id = $1", [dealId]);
    expect(r.rows[0].amount).toBe("500");
  });

  it("moving to a won-flagged stage in the same pipeline updates derived status", async () => {
    const admin = await createOrgWithRole("org_admin", "update-stage-move-admin");
    const pipelineId = await seedPipeline(admin.organizationId, { isDefault: true });
    const openStageId = await seedPipelineStage(admin.organizationId, pipelineId, { name: "Open", sortOrder: 10 });
    const wonStageId = await seedPipelineStage(admin.organizationId, pipelineId, {
      name: "Won",
      sortOrder: 20,
      isWonStage: true,
    });
    const dealId = await seedDeal(admin.organizationId, pipelineId, openStageId);

    const result = await updateDealForResolvedContext(
      admin.userId,
      dealId,
      formData({
        idempotencyKey: randomUUID(),
        pipelineId,
        originalPipelineId: pipelineId,
        stageId: wonStageId,
        originalStageId: openStageId,
      }),
    );
    expect(result.updatedId).toBe(dealId);

    const r = await adminPool.query("select status, stage_id from public.deals where id = $1", [dealId]);
    expect(r.rows[0].status).toBe("won");
    expect(r.rows[0].stage_id).toBe(wonStageId);
  });

  it("changing pipeline together with a compatible stage succeeds and re-derives status", async () => {
    const admin = await createOrgWithRole("org_admin", "update-pipeline-change-admin");
    const { pipelineId: originalPipelineId, stageId: originalStageId } = await seedPipelineWithStage(admin.organizationId);
    const newPipelineId = await seedPipeline(admin.organizationId, { name: "New Pipeline" });
    const newStageId = await seedPipelineStage(admin.organizationId, newPipelineId, {
      name: "New Lost",
      isLostStage: true,
    });
    const dealId = await seedDeal(admin.organizationId, originalPipelineId, originalStageId);

    const result = await updateDealForResolvedContext(
      admin.userId,
      dealId,
      formData({
        idempotencyKey: randomUUID(),
        pipelineId: newPipelineId,
        originalPipelineId,
        stageId: newStageId,
        originalStageId,
      }),
    );
    expect(result.error).toBeUndefined();

    const r = await adminPool.query("select pipeline_id, stage_id, status from public.deals where id = $1", [dealId]);
    expect(r.rows[0].pipeline_id).toBe(newPipelineId);
    expect(r.rows[0].stage_id).toBe(newStageId);
    expect(r.rows[0].status).toBe("lost");
  });

  it("an unauthorized mutation (org_viewer) is rejected", async () => {
    const viewer = await createOrgWithRole("org_viewer", "update-unauthorized-viewer");
    const { pipelineId, stageId } = await seedPipelineWithStage(viewer.organizationId);
    const dealId = await seedDeal(viewer.organizationId, pipelineId, stageId);
    const result = await updateDealForResolvedContext(
      viewer.userId,
      dealId,
      formData({ idempotencyKey: randomUUID(), amount: "1" }),
    );
    expect(result.error).toBeTruthy();
  });

  it("the same idempotency key reused for a retry replays the same result", async () => {
    const admin = await createOrgWithRole("org_admin", "update-idempotent-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);
    const key = randomUUID();
    const first = await updateDealForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: key, amount: "77" }));
    const second = await updateDealForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: key, amount: "77" }));
    expect(first.updatedId).toBe(second.updatedId);
  });

  it("the same key reused for a genuinely different payload is a conflict", async () => {
    const admin = await createOrgWithRole("org_admin", "update-conflict-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);
    const key = randomUUID();
    await updateDealForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: key, amount: "10" }));
    const conflict = await updateDealForResolvedContext(admin.userId, dealId, formData({ idempotencyKey: key, amount: "20" }));
    expect(conflict.error).toBeTruthy();
  });
});

describe("Deal relationship safety: linked company/contact/pipeline/stage later soft-deleted", () => {
  it("an existing deal remains readable and keeps its stored companyId after the company is soft-deleted", async () => {
    const admin = await createOrgWithRole("org_admin", "deal-linked-company-deleted-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const companyId = await seedCompany(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId, { companyId });

    await handleDeleteCompany(admin.userId, companyId);

    const response = await handleGetDeal(admin.userId, dealId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deal: { companyId: string | null } };
    expect(body.deal.companyId).toBe(companyId);
  });

  it("an unrelated edit succeeds after the linked company is soft-deleted — the Milestone 2.1 regression class this design closes", async () => {
    const admin = await createOrgWithRole("org_admin", "deal-unrelated-edit-company-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const companyId = await seedCompany(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId, { companyId });
    await handleDeleteCompany(admin.userId, companyId);

    const result = await updateDealForResolvedContext(
      admin.userId,
      dealId,
      formData({
        idempotencyKey: randomUUID(),
        companyId,
        originalCompanyId: companyId,
        amount: "42",
      }),
    );
    expect(result.error).toBeUndefined();

    const r = await adminPool.query("select amount, company_id from public.deals where id = $1", [dealId]);
    expect(r.rows[0].amount).toBe("42");
    expect(r.rows[0].company_id).toBe(companyId);
  });

  it("a NEW reassignment to the soft-deleted company still fails", async () => {
    const admin = await createOrgWithRole("org_admin", "deal-reassign-deleted-company-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const deletedCompanyId = await seedCompany(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);
    await handleDeleteCompany(admin.userId, deletedCompanyId);

    const result = await updateDealForResolvedContext(
      admin.userId,
      dealId,
      formData({ idempotencyKey: randomUUID(), companyId: deletedCompanyId, originalCompanyId: "" }),
    );
    expect(result.error).toBeTruthy();
  });

  it("an unrelated edit succeeds after the linked contact is soft-deleted", async () => {
    const admin = await createOrgWithRole("org_admin", "deal-unrelated-edit-contact-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const contact = await seedContact(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);
    await adminPool.query("update public.deals set primary_contact_id = $1 where id = $2", [contact, dealId]);
    await handleDeleteContact(admin.userId, contact);

    const result = await updateDealForResolvedContext(
      admin.userId,
      dealId,
      formData({
        idempotencyKey: randomUUID(),
        primaryContactId: contact,
        originalPrimaryContactId: contact,
        amount: "19",
      }),
    );
    expect(result.error).toBeUndefined();

    const r = await adminPool.query("select amount, primary_contact_id from public.deals where id = $1", [dealId]);
    expect(r.rows[0].amount).toBe("19");
    expect(r.rows[0].primary_contact_id).toBe(contact);
  });

  it("a NEW reassignment to the soft-deleted contact still fails", async () => {
    const admin = await createOrgWithRole("org_admin", "deal-reassign-deleted-contact-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const deletedContact = await seedContact(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);
    await handleDeleteContact(admin.userId, deletedContact);

    const result = await updateDealForResolvedContext(
      admin.userId,
      dealId,
      formData({ idempotencyKey: randomUUID(), primaryContactId: deletedContact, originalPrimaryContactId: "" }),
    );
    expect(result.error).toBeTruthy();
  });

  it("an unrelated edit succeeds after the pipeline is soft-deleted (non-default pipeline, per domain semantics)", async () => {
    const admin = await createOrgWithRole("org_admin", "deal-unrelated-edit-pipeline-admin");
    await seedPipeline(admin.organizationId, { isDefault: true }); // keeps an active default so the other can be deleted
    const nonDefaultPipelineId = await seedPipeline(admin.organizationId, { name: "Non Default" });
    const stageId = await seedPipelineStage(admin.organizationId, nonDefaultPipelineId);
    const dealId = await seedDeal(admin.organizationId, nonDefaultPipelineId, stageId);
    await handleDeletePipeline(admin.userId, nonDefaultPipelineId);

    const result = await updateDealForResolvedContext(
      admin.userId,
      dealId,
      formData({
        idempotencyKey: randomUUID(),
        pipelineId: nonDefaultPipelineId,
        originalPipelineId: nonDefaultPipelineId,
        stageId,
        originalStageId: stageId,
        amount: "88",
      }),
    );
    expect(result.error).toBeUndefined();

    const r = await adminPool.query("select amount, pipeline_id from public.deals where id = $1", [dealId]);
    expect(r.rows[0].amount).toBe("88");
    expect(r.rows[0].pipeline_id).toBe(nonDefaultPipelineId);
  });

  it("an unrelated edit succeeds after the stage is soft-deleted (frozen Milestone 2.2 decision)", async () => {
    const admin = await createOrgWithRole("org_admin", "deal-unrelated-edit-stage-admin");
    const pipelineId = await seedPipeline(admin.organizationId, { isDefault: true });
    const stageId = await seedPipelineStage(admin.organizationId, pipelineId, { name: "Soon Deleted" });
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);
    await handleDeletePipelineStage(admin.userId, pipelineId, stageId);

    const result = await updateDealForResolvedContext(
      admin.userId,
      dealId,
      formData({
        idempotencyKey: randomUUID(),
        pipelineId,
        originalPipelineId: pipelineId,
        stageId,
        originalStageId: stageId,
        amount: "99",
      }),
    );
    expect(result.error).toBeUndefined();

    const r = await adminPool.query("select amount, stage_id from public.deals where id = $1", [dealId]);
    expect(r.rows[0].amount).toBe("99");
    expect(r.rows[0].stage_id).toBe(stageId);
  });

  it("pipeline_id/stage_id remain unchanged after an unrelated edit, even though soft-deleted", async () => {
    const admin = await createOrgWithRole("org_admin", "deal-relationship-unchanged-admin");
    const pipelineId = await seedPipeline(admin.organizationId, { isDefault: true });
    const stageId = await seedPipelineStage(admin.organizationId, pipelineId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);

    const before = await adminPool.query("select pipeline_id, stage_id from public.deals where id = $1", [dealId]);

    const result = await updateDealForResolvedContext(
      admin.userId,
      dealId,
      formData({ idempotencyKey: randomUUID(), amount: "1" }),
    );
    expect(result.error).toBeUndefined();

    const after = await adminPool.query("select pipeline_id, stage_id from public.deals where id = $1", [dealId]);
    expect(after.rows[0].pipeline_id).toBe(before.rows[0].pipeline_id);
    expect(after.rows[0].stage_id).toBe(before.rows[0].stage_id);
  });
});

describe("deleteDealForResolvedContext()", () => {
  it("org_admin can soft-delete", async () => {
    const admin = await createOrgWithRole("org_admin", "delete-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);

    const result = await deleteDealForResolvedContext(admin.userId, dealId);
    expect(result.deleted).toBe(true);

    const r = await adminPool.query("select deleted_at from public.deals where id = $1", [dealId]);
    expect(r.rows[0].deleted_at).not.toBeNull();
  });

  it("org_member is denied", async () => {
    const member = await createOrgWithRole("org_member", "delete-member");
    const { pipelineId, stageId } = await seedPipelineWithStage(member.organizationId);
    const dealId = await seedDeal(member.organizationId, pipelineId, stageId);

    const result = await deleteDealForResolvedContext(member.userId, dealId);
    expect(result.error).toBeTruthy();

    const r = await adminPool.query("select deleted_at from public.deals where id = $1", [dealId]);
    expect(r.rows[0].deleted_at).toBeNull();
  });

  it("is soft-delete only — no physical row removal", async () => {
    const admin = await createOrgWithRole("org_admin", "delete-soft-only-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);
    await deleteDealForResolvedContext(admin.userId, dealId);

    const r = await adminPool.query("select id from public.deals where id = $1", [dealId]);
    expect(r.rows).toHaveLength(1); // row still physically present
  });

  it("a subsequent read excludes the deleted deal from the active view", async () => {
    const admin = await createOrgWithRole("org_admin", "delete-excluded-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const dealId = await seedDeal(admin.organizationId, pipelineId, stageId);
    await deleteDealForResolvedContext(admin.userId, dealId);

    const response = await handleGetDeal(admin.userId, dealId);
    expect(response.status).toBe(404);
  });
});

describe("security: agency and unaffiliated actors get no Deals UI access", () => {
  it("a pure agency actor is denied at the console access decision", async () => {
    const userId = await createPureAgencyActor();
    expect(decideDealsConsoleAccess(userId, null)).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it("an authenticated user with no membership at all is denied create", async () => {
    const userId = await createUnaffiliatedUser();
    const result = await createDealForResolvedContext(
      userId,
      formData({ idempotencyKey: randomUUID(), pipelineId: randomUUID(), stageId: randomUUID() }),
    );
    expect(result.error).toBeTruthy();
  });

  it("a demoted actor cannot replay a stale create with continued authority", async () => {
    const admin = await createOrgWithRole("org_admin", "demoted-admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);
    const key = randomUUID();
    const first = await createDealForResolvedContext(admin.userId, formData({ idempotencyKey: key, pipelineId, stageId }));
    expect(first.createdId).toBeTruthy();

    await setMembershipStatus(admin.userId, admin.organizationId, "removed");
    const replay = await createDealForResolvedContext(admin.userId, formData({ idempotencyKey: key, pipelineId, stageId }));
    expect(replay.error).toBeTruthy();
    expect(replay.createdId).toBeUndefined();
  });
});

describe("resolveContactDisplayName() / resolvePipelineDisplayName() / resolveStageDisplayName()", () => {
  it("resolveContactDisplayName returns the plain name for an active contact, and '<name> (deleted)' for a soft-deleted one, never the raw id", async () => {
    const admin = await createOrgWithRole("org_admin", "display-contact-admin");
    const activeId = await seedContact(admin.organizationId, { firstName: "Active Contact" });
    const deletedId = await seedContact(admin.organizationId, { firstName: "Staging Deleted Contact" });
    await handleDeleteContact(admin.userId, deletedId);

    const options = await listActiveContactOptions(admin);
    const activeLabel = await resolveContactDisplayName(admin, activeId, options);
    expect(activeLabel).toBe("Active Contact");

    const deletedLabel = await resolveContactDisplayName(admin, deletedId, options);
    expect(deletedLabel).toBe("Staging Deleted Contact (deleted)");
    expect(deletedLabel).not.toBe(deletedId);
  });

  it("resolveContactDisplayName falls back to 'Erased contact' for a physically absent id (Milestone 2.3F: only reachable via GDPR contact erasure, never ordinary soft-delete)", async () => {
    const admin = await createOrgWithRole("org_admin", "display-contact-unresolvable-admin");
    const options = await listActiveContactOptions(admin);
    const label = await resolveContactDisplayName(admin, randomUUID(), options);
    expect(label).toBe("Erased contact");
    expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it("resolvePipelineDisplayName returns '<name> (deleted)' for a soft-deleted pipeline, never the raw id", async () => {
    const admin = await createOrgWithRole("org_admin", "display-pipeline-admin");
    const pipelineId = await seedPipeline(admin.organizationId, { name: "Staging Deleted Pipeline" });
    // Needs a default elsewhere so this one is deletable.
    await seedPipeline(admin.organizationId, { isDefault: true });
    await handleDeletePipeline(admin.userId, pipelineId);

    const options = await listActivePipelineOptions(admin);
    const label = await resolvePipelineDisplayName(admin, pipelineId, options);
    expect(label).toBe("Staging Deleted Pipeline (deleted)");
    expect(label).not.toBe(pipelineId);
  });

  it("resolveStageDisplayName returns '<name> (deleted)' for a soft-deleted stage, never the raw id", async () => {
    const admin = await createOrgWithRole("org_admin", "display-stage-admin");
    const pipelineId = await seedPipeline(admin.organizationId, { isDefault: true });
    const stageId = await seedPipelineStage(admin.organizationId, pipelineId, { name: "Staging Deleted Stage" });
    await handleDeletePipelineStage(admin.userId, pipelineId, stageId);

    const options = await listActiveStageOptions(admin, [pipelineId]);
    const label = await resolveStageDisplayName(admin, pipelineId, stageId, options);
    expect(label).toBe("Staging Deleted Stage (deleted)");
    expect(label).not.toBe(stageId);
  });

  it("never exposes another organization's deleted pipeline name — cross-org resolves to the generic fallback", async () => {
    const admin = await createOrgWithRole("org_admin", "display-cross-org-pipeline-admin");
    const otherOrg = await createOrgWithRole("org_admin", "display-cross-org-pipeline-other");
    const otherPipelineId = await seedPipeline(otherOrg.organizationId, { name: "Other Org Secret Pipeline" });
    await seedPipeline(otherOrg.organizationId, { isDefault: true });
    await handleDeletePipeline(otherOrg.userId, otherPipelineId);

    const options = await listActivePipelineOptions(admin);
    const label = await resolvePipelineDisplayName(admin, otherPipelineId, options);
    expect(label).toBe("Deleted pipeline");
    expect(label).not.toContain("Other Org Secret Pipeline");
  });
});
