import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, createOrgWithActiveMember, setMembershipStatus } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import { createCompany, softDeleteCompany } from "../src/companies";
import { createContact, softDeleteContact } from "../src/contacts";
import { createPipeline, softDeletePipeline } from "../src/pipelines";
import { createPipelineStage, softDeletePipelineStage } from "../src/pipeline-stages";
import { createDeal, getDealById, listDeals, updateDeal, softDeleteDeal } from "../src/deals";
import {
  ValidationError,
  InvalidOwnerError,
  InvalidCompanyRelationshipError,
  InvalidContactRelationshipError,
  InvalidPipelineRelationshipError,
  InvalidStageRelationshipError,
} from "../src/errors";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function makeCtxWithStage() {
  const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
  const ctx = { userId, organizationId, roleKey };
  const pipeline = await createPipeline(ctx, { name: "Test Pipeline", isDefault: true });
  const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 10 });
  return { ctx, pipeline, stage };
}

describe("createDeal", () => {
  it("creates a deal and persists organization_id from ctx", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    expect(deal.organizationId).toBe(ctx.organizationId);
    expect(deal.pipelineId).toBe(pipeline.id);
    expect(deal.stageId).toBe(stage.id);
  });

  it("defaults currency to EUR and status to open", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    expect(deal.currency).toBe("EUR");
    expect(deal.status).toBe("open");
  });

  it("requires pipelineId", async () => {
    const { ctx, stage } = await makeCtxWithStage();
    await expect(createDeal(ctx, { stageId: stage.id } as never)).rejects.toThrow(ValidationError);
  });

  it("requires stageId", async () => {
    const { ctx, pipeline } = await makeCtxWithStage();
    await expect(createDeal(ctx, { pipelineId: pipeline.id } as never)).rejects.toThrow(ValidationError);
  });

  it.each(["eur", "EU", "12A", "EURO"])("rejects malformed/lowercase currency %s", async (bad) => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    await expect(createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, currency: bad })).rejects.toThrow(
      ValidationError,
    );
  });

  it.each([-1, 101])("rejects a probability of %i outside 0..100", async (bad) => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    await expect(
      createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, probability: bad }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a negative amount", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    await expect(
      createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, amount: -100 }),
    ).rejects.toThrow(ValidationError);
  });

  it("accepts a non-negative amount as a number or numeric string", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, amount: "1500.50" });
    expect(deal.amount).toBe("1500.50");
  });

  it("rejects a malformed expectedCloseDate", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    await expect(
      createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, expectedCloseDate: "not-a-date" }),
    ).rejects.toThrow(ValidationError);
  });

  it("accepts nullable companyId and primaryContactId", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    expect(deal.companyId).toBeNull();
    expect(deal.primaryContactId).toBeNull();
  });

  describe("owner validation", () => {
    it("accepts a valid active-member owner", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, ownerId: ctx.userId });
      expect(deal.ownerId).toBe(ctx.userId);
    });

    it("rejects a nonexistent owner", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      await expect(
        createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, ownerId: randomUUID() }),
      ).rejects.toThrow(InvalidOwnerError);
    });
  });

  describe("company validation", () => {
    it("accepts a valid active company in the same organization", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      const company = await createCompany(ctx, { name: "Acme" });
      const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, companyId: company.id });
      expect(deal.companyId).toBe(company.id);
    });

    it("rejects a nonexistent company", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      await expect(
        createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, companyId: randomUUID() }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });

    it("rejects a company belonging to a different organization", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      const orgB = await createOrgWithActiveMember();
      const companyInB = await createCompany(
        { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
        { name: "Org B Co" },
      );
      await expect(
        createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, companyId: companyInB.id }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });

    it("rejects a soft-deleted company", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      const company = await createCompany(ctx, { name: "Soon Deleted" });
      await softDeleteCompany(ctx, company.id);
      await expect(
        createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, companyId: company.id }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });
  });

  describe("contact validation", () => {
    it("accepts a valid active contact in the same organization", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      const contact = await createContact(ctx, { firstName: "Ada" });
      const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, primaryContactId: contact.id });
      expect(deal.primaryContactId).toBe(contact.id);
    });

    it("rejects a nonexistent contact", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      await expect(
        createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, primaryContactId: randomUUID() }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });

    it("rejects a contact belonging to a different organization", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      const orgB = await createOrgWithActiveMember();
      const contactInB = await createContact(
        { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
        { firstName: "Org B Contact" },
      );
      await expect(
        createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, primaryContactId: contactInB.id }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });

    it("rejects a soft-deleted contact", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      const contact = await createContact(ctx, { firstName: "Soon Deleted" });
      await softDeleteContact(ctx, contact.id);
      await expect(
        createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, primaryContactId: contact.id }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });
  });

  describe("pipeline/stage validation", () => {
    it("rejects a pipelineId that does not resolve to an active pipeline in this organization", async () => {
      const { ctx, stage } = await makeCtxWithStage();
      await expect(createDeal(ctx, { pipelineId: randomUUID(), stageId: stage.id })).rejects.toThrow(
        InvalidPipelineRelationshipError,
      );
    });

    it("rejects a stageId that does not resolve to an active stage in this organization", async () => {
      const { ctx, pipeline } = await makeCtxWithStage();
      await expect(createDeal(ctx, { pipelineId: pipeline.id, stageId: randomUUID() })).rejects.toThrow(
        InvalidStageRelationshipError,
      );
    });

    it("rejects a stage that belongs to a DIFFERENT pipeline in the same organization", async () => {
      const { ctx, pipeline } = await makeCtxWithStage();
      const otherPipeline = await createPipeline(ctx, { name: "Other Pipeline" });
      const stageOnOtherPipeline = await createPipelineStage(ctx, {
        pipelineId: otherPipeline.id,
        name: "Wrong Pipeline Stage",
        sortOrder: 10,
      });
      await expect(
        createDeal(ctx, { pipelineId: pipeline.id, stageId: stageOnOtherPipeline.id }),
      ).rejects.toThrow(InvalidStageRelationshipError);
    });
  });

  describe("status derivation on create", () => {
    it("open stage -> status open", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
      expect(deal.status).toBe("open");
    });

    it("won-flagged stage -> status won", async () => {
      const { ctx, pipeline } = await makeCtxWithStage();
      const wonStage = await createPipelineStage(ctx, {
        pipelineId: pipeline.id,
        name: "Closed Won",
        sortOrder: 40,
        isWonStage: true,
      });
      const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: wonStage.id });
      expect(deal.status).toBe("won");
    });

    it("lost-flagged stage -> status lost", async () => {
      const { ctx, pipeline } = await makeCtxWithStage();
      const lostStage = await createPipelineStage(ctx, {
        pipelineId: pipeline.id,
        name: "Closed Lost",
        sortOrder: 50,
        isLostStage: true,
      });
      const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: lostStage.id });
      expect(deal.status).toBe("lost");
    });

    it("a caller cannot independently set status through the typed input — a smuggled status field is ignored", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      const deal = await createDeal(ctx, {
        pipelineId: pipeline.id,
        stageId: stage.id,
        // @ts-expect-error status is not part of CreateDealInput
        status: "won",
      });
      expect(deal.status).toBe("open");
    });

    it("no duplicate/unintended writes after a validation failure", async () => {
      const { ctx, pipeline, stage } = await makeCtxWithStage();
      await expect(
        createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, currency: "bogus" }),
      ).rejects.toThrow(ValidationError);
      const page = await listDeals(ctx, { pipelineId: pipeline.id });
      expect(page.items).toHaveLength(0);
    });
  });
});

describe("getDealById", () => {
  it("excludes a soft-deleted deal", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    await softDeleteDeal(ctx, deal.id);
    expect(await getDealById(ctx, deal.id)).toBeNull();
  });

  it("returns null identically for nonexistent and cross-org", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    const orgB = await createOrgWithActiveMember();
    const crossOrg = await getDealById({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, deal.id);
    const nonexistent = await getDealById(ctx, randomUUID());
    expect(crossOrg).toBeNull();
    expect(nonexistent).toBeNull();
  });
});

describe("listDeals", () => {
  it("supports cursor pagination", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });

    const page = await listDeals(ctx, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const secondPage = await listDeals(ctx, { limit: 2, cursor: page.nextCursor! });
    expect(secondPage.items).toHaveLength(1);
  });

  it("filters by pipelineId, stageId, ownerId, companyId, and status", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const otherPipeline = await createPipeline(ctx, { name: "Other" });
    const otherStage = await createPipelineStage(ctx, { pipelineId: otherPipeline.id, name: "Other Stage", sortOrder: 10 });
    const company = await createCompany(ctx, { name: "Filter Co" });

    const target = await createDeal(ctx, {
      pipelineId: pipeline.id,
      stageId: stage.id,
      ownerId: ctx.userId,
      companyId: company.id,
    });
    await createDeal(ctx, { pipelineId: otherPipeline.id, stageId: otherStage.id });

    const byPipeline = await listDeals(ctx, { pipelineId: pipeline.id });
    expect(byPipeline.items.map((d) => d.id)).toEqual([target.id]);

    const byStage = await listDeals(ctx, { stageId: stage.id });
    expect(byStage.items.map((d) => d.id)).toEqual([target.id]);

    const byOwner = await listDeals(ctx, { ownerId: ctx.userId });
    expect(byOwner.items.map((d) => d.id)).toEqual([target.id]);

    const byCompany = await listDeals(ctx, { companyId: company.id });
    expect(byCompany.items.map((d) => d.id)).toEqual([target.id]);

    const byStatus = await listDeals(ctx, { status: "open" });
    expect(byStatus.items.map((d) => d.id)).toContain(target.id);
  });

  it("tenant isolation: org A never sees org B's deals", async () => {
    const { ctx: ctxB, pipeline: pipelineB, stage: stageB } = await makeCtxWithStage();
    await createDeal(ctxB, { pipelineId: pipelineB.id, stageId: stageB.id });

    const { ctx: ctxA, pipeline: pipelineA, stage: stageA } = await makeCtxWithStage();
    await createDeal(ctxA, { pipelineId: pipelineA.id, stageId: stageA.id });

    const page = await listDeals(ctxA);
    expect(page.items.every((d) => d.organizationId === ctxA.organizationId)).toBe(true);
  });
});

describe("updateDeal: relationship partial-update semantics", () => {
  it("field omitted leaves the current value unchanged", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const company = await createCompany(ctx, { name: "Kept Co" });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, companyId: company.id });
    const updated = await updateDeal(ctx, deal.id, { amount: 500 });
    expect(updated?.companyId).toBe(company.id);
  });

  it("field explicitly null clears it (with revalidation of the change itself, which trivially passes for null)", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const company = await createCompany(ctx, { name: "To Be Cleared" });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, companyId: company.id });
    const updated = await updateDeal(ctx, deal.id, { companyId: null });
    expect(updated?.companyId).toBeNull();
  });

  it("field resupplied UNCHANGED is never revalidated — an unrelated edit succeeds even after the linked company is soft-deleted", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const company = await createCompany(ctx, { name: "Will Be Deleted" });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, companyId: company.id });
    await softDeleteCompany(ctx, company.id);

    // Resupplying the SAME companyId alongside an unrelated field change
    // must not fail merely because the company is now soft-deleted.
    const updated = await updateDeal(ctx, deal.id, { companyId: company.id, amount: 999 });
    expect(updated?.companyId).toBe(company.id);
    expect(updated?.amount).toBe("999");
  });

  it("an unrelated edit succeeds after the linked company is soft-deleted, even when companyId is omitted entirely", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const company = await createCompany(ctx, { name: "Deleted Co Omitted" });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, companyId: company.id });
    await softDeleteCompany(ctx, company.id);

    const updated = await updateDeal(ctx, deal.id, { amount: 123 });
    expect(updated?.companyId).toBe(company.id);
    expect(updated?.amount).toBe("123");
  });

  it("an unrelated edit succeeds after the linked contact is soft-deleted", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const contact = await createContact(ctx, { firstName: "Deleted Contact" });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, primaryContactId: contact.id });
    await softDeleteContact(ctx, contact.id);

    const updated = await updateDeal(ctx, deal.id, { amount: 456 });
    expect(updated?.primaryContactId).toBe(contact.id);
    expect(updated?.amount).toBe("456");
  });

  it("a NEW reassignment to a soft-deleted company FAILS", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    const company = await createCompany(ctx, { name: "Already Deleted" });
    await softDeleteCompany(ctx, company.id);

    await expect(updateDeal(ctx, deal.id, { companyId: company.id })).rejects.toThrow(
      InvalidCompanyRelationshipError,
    );
  });

  it("a NEW reassignment to a soft-deleted contact FAILS", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    const contact = await createContact(ctx, { firstName: "Already Deleted" });
    await softDeleteContact(ctx, contact.id);

    await expect(updateDeal(ctx, deal.id, { primaryContactId: contact.id })).rejects.toThrow(
      InvalidContactRelationshipError,
    );
  });

  it("ownerId: unchanged resupply after the owner's membership is removed still succeeds; a NEW assignment to that removed owner fails", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const other = await createOrgWithActiveMember();
    // Use a second, ordinary active member of the SAME org as owner.
    const teammate = await seedAsAdmin(async (client) => {
      const userId = randomUUID();
      await client.query("insert into auth.users (id, email) values ($1, $2)", [userId, `teammate-${userId}@example.test`]);
      const role = await client.query("select id from public.roles where key = 'org_member'");
      await client.query(
        "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
        [userId, ctx.organizationId, role.rows[0].id],
      );
      return userId;
    });
    void other;

    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, ownerId: teammate });
    await setMembershipStatus(teammate, ctx.organizationId, "removed");

    const unrelatedEdit = await updateDeal(ctx, deal.id, { ownerId: teammate, amount: 42 });
    expect(unrelatedEdit?.ownerId).toBe(teammate);

    const dealTwo = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    await expect(updateDeal(ctx, dealTwo.id, { ownerId: teammate })).rejects.toThrow(InvalidOwnerError);
  });

  it("no duplicate/unintended writes after an update validation failure", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, amount: 100 });
    await expect(updateDeal(ctx, deal.id, { probability: 500 })).rejects.toThrow(ValidationError);
    const refetched = await getDealById(ctx, deal.id);
    expect(refetched?.amount).toBe("100");
  });

  it("returns null for nonexistent/cross-org/already-deleted", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    await softDeleteDeal(ctx, deal.id);
    expect(await updateDeal(ctx, deal.id, { amount: 10 })).toBeNull();
  });
});

describe("updateDeal: pipeline/stage reassignment and status re-derivation", () => {
  it("moving to a different stage within the same pipeline re-derives status", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const wonStage = await createPipelineStage(ctx, {
      pipelineId: pipeline.id,
      name: "Won",
      sortOrder: 40,
      isWonStage: true,
    });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    expect(deal.status).toBe("open");

    const updated = await updateDeal(ctx, deal.id, { stageId: wonStage.id });
    expect(updated?.stageId).toBe(wonStage.id);
    expect(updated?.status).toBe("won");
  });

  it("resupplying the SAME stageId unchanged does not re-derive status even if the underlying flags changed since (no-op path)", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    await seedAsAdmin(async (client) => {
      await client.query("update public.deals set status = 'lost' where id = $1", [deal.id]);
    });
    const updated = await updateDeal(ctx, deal.id, { stageId: stage.id, amount: 10 });
    expect(updated?.status).toBe("lost");
  });

  it("rejects reassigning pipelineId without also supplying a compatible stageId", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const otherPipeline = await createPipeline(ctx, { name: "Other Pipeline" });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    await expect(updateDeal(ctx, deal.id, { pipelineId: otherPipeline.id })).rejects.toThrow(ValidationError);
  });

  it("allows reassigning pipelineId together with a valid stageId belonging to the new pipeline, re-deriving status", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const otherPipeline = await createPipeline(ctx, { name: "Other Pipeline" });
    const otherStageWon = await createPipelineStage(ctx, {
      pipelineId: otherPipeline.id,
      name: "Other Won",
      sortOrder: 10,
      isWonStage: true,
    });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });

    const updated = await updateDeal(ctx, deal.id, { pipelineId: otherPipeline.id, stageId: otherStageWon.id });
    expect(updated?.pipelineId).toBe(otherPipeline.id);
    expect(updated?.stageId).toBe(otherStageWon.id);
    expect(updated?.status).toBe("won");
  });

  it("rejects reassigning to a stage belonging to a DIFFERENT pipeline than the one supplied/current", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const otherPipeline = await createPipeline(ctx, { name: "Other Pipeline" });
    const otherStage = await createPipelineStage(ctx, { pipelineId: otherPipeline.id, name: "Other Stage", sortOrder: 10 });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });

    // stageId supplied but pipelineId NOT supplied — must belong to the
    // deal's CURRENT pipeline, not otherPipeline.
    await expect(updateDeal(ctx, deal.id, { stageId: otherStage.id })).rejects.toThrow(InvalidStageRelationshipError);
  });

  it("never leaves pipeline_id and stage_id disagreeing — a failed reassignment leaves the deal fully untouched", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    const otherPipeline = await createPipeline(ctx, { name: "Other Pipeline" });

    await expect(updateDeal(ctx, deal.id, { pipelineId: otherPipeline.id })).rejects.toThrow(ValidationError);

    const refetched = await getDealById(ctx, deal.id);
    expect(refetched?.pipelineId).toBe(pipeline.id);
    expect(refetched?.stageId).toBe(stage.id);
  });

  it("an unrelated edit succeeds after the pipeline is soft-deleted (stage untouched, deal keeps pointing at it)", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const secondPipeline = await createPipeline(ctx, { name: "Second", isDefault: false });
    void secondPipeline;
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });

    // pipeline is the org's active default, so it cannot itself be
    // soft-deleted without switching the default first — use a
    // non-default pipeline for this specific scenario instead.
    const nonDefaultPipeline = await createPipeline(ctx, { name: "Non Default For Deletion" });
    const nonDefaultStage = await createPipelineStage(ctx, {
      pipelineId: nonDefaultPipeline.id,
      name: "Stage",
      sortOrder: 10,
    });
    const dealOnNonDefault = await createDeal(ctx, { pipelineId: nonDefaultPipeline.id, stageId: nonDefaultStage.id });
    await softDeletePipeline(ctx, nonDefaultPipeline.id);

    const updated = await updateDeal(ctx, dealOnNonDefault.id, { amount: 77 });
    expect(updated?.pipelineId).toBe(nonDefaultPipeline.id);
    expect(updated?.amount).toBe("77");
    expect(deal).toBeTruthy();
  });

  it("an unrelated edit succeeds after the stage is soft-deleted (frozen Milestone 2.2 decision — deal keeps pointing at it)", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const secondStage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Second Stage", sortOrder: 20 });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: secondStage.id });
    await softDeletePipelineStage(ctx, pipeline.id, secondStage.id);

    const updated = await updateDeal(ctx, deal.id, { amount: 88 });
    expect(updated?.stageId).toBe(secondStage.id);
    expect(updated?.amount).toBe("88");
    expect(stage).toBeTruthy();
  });
});

describe("softDeleteDeal", () => {
  it("soft-deletes and preserves relationship fields unchanged", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const company = await createCompany(ctx, { name: "Preserved Co" });
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id, companyId: company.id });
    const deleted = await softDeleteDeal(ctx, deal.id);
    expect(deleted?.deletedAt).not.toBeNull();
    expect(deleted?.companyId).toBe(company.id);
    expect(deleted?.pipelineId).toBe(pipeline.id);
    expect(deleted?.stageId).toBe(stage.id);
  });

  it("returns null for nonexistent/cross-org/already-deleted", async () => {
    const { ctx, pipeline, stage } = await makeCtxWithStage();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
    await softDeleteDeal(ctx, deal.id);
    expect(await softDeleteDeal(ctx, deal.id)).toBeNull();
  });
});
