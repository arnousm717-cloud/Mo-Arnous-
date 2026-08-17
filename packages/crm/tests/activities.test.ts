import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, createOrgWithActiveMember } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import { createCompany, softDeleteCompany } from "../src/companies";
import { createContact, softDeleteContact } from "../src/contacts";
import { createPipeline } from "../src/pipelines";
import { createPipelineStage } from "../src/pipeline-stages";
import { createDeal, softDeleteDeal } from "../src/deals";
import {
  createActivity,
  getActivityById,
  listActivities,
  updateActivity,
  softDeleteActivity,
} from "../src/activities";
import {
  ValidationError,
  InvalidCompanyRelationshipError,
  InvalidContactRelationshipError,
  InvalidDealRelationshipError,
} from "../src/errors";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function makeCtxWithDeal() {
  const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
  const ctx = { userId, organizationId, roleKey };
  const pipeline = await createPipeline(ctx, { name: "Test Pipeline", isDefault: true });
  const stage = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Lead", sortOrder: 10 });
  const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: stage.id });
  return { ctx, deal };
}

/** Directly reproduces the exact post-GDPR-erasure shape
 * execute_contact_erasure() (packages/database, Milestone 2.3A) produces
 * for a directly-related Activity — never via the domain layer, which can
 * never produce this state itself. */
async function simulateGdprErasure(activityId: string): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query(
      "update public.activities set related_to_id = null, subject = null, body = null where id = $1",
      [activityId],
    );
  });
}

describe("createActivity", () => {
  it("creates an activity and persists organization_id from ctx", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    expect(activity.organizationId).toBe(ctx.organizationId);
    expect(activity.relatedToType).toBe("deal");
    expect(activity.relatedToId).toBe(deal.id);
  });

  it("defaults subject/body/dueAt/completedAt to null", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const activity = await createActivity(ctx, { type: "task", relatedToType: "deal", relatedToId: deal.id });
    expect(activity.subject).toBeNull();
    expect(activity.body).toBeNull();
    expect(activity.dueAt).toBeNull();
    expect(activity.completedAt).toBeNull();
    expect(activity.deletedAt).toBeNull();
  });

  it("sets createdBy from ctx.userId, never from input (mass-assignment guard)", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const attacker = randomUUID();
    const activity = await createActivity(
      ctx,
      { type: "call", relatedToType: "deal", relatedToId: deal.id, createdBy: attacker } as never,
    );
    expect(activity.createdBy).toBe(ctx.userId);
    expect(activity.createdBy).not.toBe(attacker);
  });

  it("sets organizationId from ctx, never from input (mass-assignment guard)", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const otherOrg = randomUUID();
    const activity = await createActivity(
      ctx,
      { type: "call", relatedToType: "deal", relatedToId: deal.id, organizationId: otherOrg } as never,
    );
    expect(activity.organizationId).toBe(ctx.organizationId);
    expect(activity.organizationId).not.toBe(otherOrg);
  });

  describe("type allowlist", () => {
    it.each(["call", "email", "meeting", "note", "task"])("accepts type=%s", async (type) => {
      const { ctx, deal } = await makeCtxWithDeal();
      const activity = await createActivity(ctx, { type: type as never, relatedToType: "deal", relatedToId: deal.id });
      expect(activity.type).toBe(type);
    });

    it("rejects an unrecognized type", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      await expect(
        createActivity(ctx, { type: "sms" as never, relatedToType: "deal", relatedToId: deal.id }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("relatedToType allowlist", () => {
    it("rejects an unrecognized relatedToType", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "campaign" as never, relatedToId: deal.id }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("relatedToId is required despite DB nullability", () => {
    it("rejects a missing relatedToId", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "deal" } as never),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a null relatedToId", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: null as never }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects an empty-string relatedToId", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: "" }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("company relationship validation", () => {
    it("accepts a valid active company in the same organization", async () => {
      const { ctx } = await makeCtxWithDeal();
      const company = await createCompany(ctx, { name: "Acme" });
      const activity = await createActivity(ctx, { type: "call", relatedToType: "company", relatedToId: company.id });
      expect(activity.relatedToId).toBe(company.id);
    });

    it("rejects a nonexistent company", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "company", relatedToId: randomUUID() }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });

    it("rejects a company belonging to a different organization (adversarial: Activity Org A -> Company Org B)", async () => {
      const { ctx } = await makeCtxWithDeal();
      const orgB = await createOrgWithActiveMember();
      const companyInB = await createCompany(
        { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
        { name: "Org B Co" },
      );
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "company", relatedToId: companyInB.id }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });

    it("rejects a soft-deleted company as a new target", async () => {
      const { ctx } = await makeCtxWithDeal();
      const company = await createCompany(ctx, { name: "Soon Deleted" });
      await softDeleteCompany(ctx, company.id);
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "company", relatedToId: company.id }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });
  });

  describe("contact relationship validation", () => {
    it("accepts a valid active contact in the same organization", async () => {
      const { ctx } = await makeCtxWithDeal();
      const contact = await createContact(ctx, { firstName: "Ada" });
      const activity = await createActivity(ctx, { type: "call", relatedToType: "contact", relatedToId: contact.id });
      expect(activity.relatedToId).toBe(contact.id);
    });

    it("rejects a nonexistent contact", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "contact", relatedToId: randomUUID() }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });

    it("rejects a contact belonging to a different organization (adversarial: Activity Org A -> Contact Org B)", async () => {
      const { ctx } = await makeCtxWithDeal();
      const orgB = await createOrgWithActiveMember();
      const contactInB = await createContact(
        { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
        { firstName: "Org B Contact" },
      );
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "contact", relatedToId: contactInB.id }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });

    it("rejects a soft-deleted contact as a new target", async () => {
      const { ctx } = await makeCtxWithDeal();
      const contact = await createContact(ctx, { firstName: "Soon Deleted" });
      await softDeleteContact(ctx, contact.id);
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "contact", relatedToId: contact.id }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });
  });

  describe("deal relationship validation", () => {
    it("accepts a valid active deal in the same organization", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
      expect(activity.relatedToId).toBe(deal.id);
    });

    it("rejects a nonexistent deal", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: randomUUID() }),
      ).rejects.toThrow(InvalidDealRelationshipError);
    });

    it("rejects a deal belonging to a different organization (adversarial: Activity Org A -> Deal Org B)", async () => {
      const { ctx } = await makeCtxWithDeal();
      const orgB = await makeCtxWithDeal();
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: orgB.deal.id }),
      ).rejects.toThrow(InvalidDealRelationshipError);
    });

    it("rejects a soft-deleted deal as a new target", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      await softDeleteDeal(ctx, deal.id);
      await expect(
        createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id }),
      ).rejects.toThrow(InvalidDealRelationshipError);
    });
  });
});

describe("getActivityById", () => {
  it("excludes soft-deleted activities", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    await softDeleteActivity(ctx, activity.id);
    expect(await getActivityById(ctx, activity.id)).toBeNull();
  });

  it("returns null for nonexistent and cross-org", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    expect(await getActivityById(ctx, randomUUID())).toBeNull();
    const orgB = await createOrgWithActiveMember();
    expect(
      await getActivityById({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, activity.id),
    ).toBeNull();
  });

  it("survives its related target being soft-deleted after creation", async () => {
    const { ctx } = await makeCtxWithDeal();
    const company = await createCompany(ctx, { name: "Target Then Deleted" });
    const activity = await createActivity(ctx, { type: "call", relatedToType: "company", relatedToId: company.id });
    await softDeleteCompany(ctx, company.id);
    const fetched = await getActivityById(ctx, activity.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.relatedToId).toBe(company.id);
    expect(fetched?.deletedAt).toBeNull();
  });

  describe("GDPR-erased historical state (Milestone 2.3A execute_contact_erasure)", () => {
    it("remains readable with relatedToId/subject/body null and relatedToType still 'contact' — never rejected or repaired", async () => {
      const { ctx } = await makeCtxWithDeal();
      const contact = await createContact(ctx, { firstName: "Erasure Target" });
      const activity = await createActivity(ctx, {
        type: "call",
        relatedToType: "contact",
        relatedToId: contact.id,
        subject: "Discovery call",
        body: "Discussed pricing",
      });
      await simulateGdprErasure(activity.id);

      const fetched = await getActivityById(ctx, activity.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.relatedToType).toBe("contact");
      expect(fetched?.relatedToId).toBeNull();
      expect(fetched?.subject).toBeNull();
      expect(fetched?.body).toBeNull();
      expect(fetched?.deletedAt).toBeNull();
      expect(fetched?.type).toBe("call");
    });

    it("is included in listActivities results, not silently filtered out", async () => {
      const { ctx } = await makeCtxWithDeal();
      const contact = await createContact(ctx, { firstName: "Erasure Target List" });
      const activity = await createActivity(ctx, { type: "meeting", relatedToType: "contact", relatedToId: contact.id });
      await simulateGdprErasure(activity.id);

      const page = await listActivities(ctx);
      expect(page.items.some((a) => a.id === activity.id)).toBe(true);
    });
  });
});

describe("listActivities", () => {
  it("filters by relatedToType and relatedToId", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const company = await createCompany(ctx, { name: "Filter Co" });
    await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    const companyActivity = await createActivity(ctx, { type: "call", relatedToType: "company", relatedToId: company.id });

    const page = await listActivities(ctx, { relatedToType: "company", relatedToId: company.id });
    expect(page.items.map((a) => a.id)).toEqual([companyActivity.id]);
  });

  it("filters by type", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    const task = await createActivity(ctx, { type: "task", relatedToType: "deal", relatedToId: deal.id });

    const page = await listActivities(ctx, { type: "task" });
    expect(page.items.map((a) => a.id)).toEqual([task.id]);
  });

  it("filters by createdBy", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });

    const page = await listActivities(ctx, { createdBy: ctx.userId });
    expect(page.items.map((a) => a.id)).toContain(activity.id);

    const noneFromOther = await listActivities(ctx, { createdBy: randomUUID() });
    expect(noneFromOther.items).toEqual([]);
  });

  it("filters by completed", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const open = await createActivity(ctx, { type: "task", relatedToType: "deal", relatedToId: deal.id });
    const done = await createActivity(ctx, {
      type: "task",
      relatedToType: "deal",
      relatedToId: deal.id,
      completedAt: new Date().toISOString(),
    });

    const completedPage = await listActivities(ctx, { completed: true });
    expect(completedPage.items.map((a) => a.id)).toEqual([done.id]);

    const incompletePage = await listActivities(ctx, { completed: false });
    expect(incompletePage.items.map((a) => a.id)).toContain(open.id);
    expect(incompletePage.items.map((a) => a.id)).not.toContain(done.id);
  });

  it("excludes activities from other organizations", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    const orgB = await createOrgWithActiveMember();
    const page = await listActivities({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey });
    expect(page.items).toEqual([]);
  });
});

describe("updateActivity", () => {
  it("updates mutable fields (type/subject/body/dueAt/completedAt)", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    const updated = await updateActivity(ctx, activity.id, {
      type: "meeting",
      subject: "Renamed",
      body: "New body",
      dueAt: "2026-09-01T00:00:00.000Z",
      completedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(updated?.type).toBe("meeting");
    expect(updated?.subject).toBe("Renamed");
    expect(updated?.body).toBe("New body");
    expect(updated?.dueAt).not.toBeNull();
    expect(updated?.completedAt).not.toBeNull();
  });

  it("cannot reassign relatedToType or relatedToId — UpdateActivityInput has no such fields, and a smuggled value is ignored", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const company = await createCompany(ctx, { name: "Attempted Reassign Target" });
    const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });

    const updated = await updateActivity(
      ctx,
      activity.id,
      { subject: "Touched", relatedToType: "company", relatedToId: company.id } as never,
    );
    expect(updated?.subject).toBe("Touched");
    expect(updated?.relatedToType).toBe("deal");
    expect(updated?.relatedToId).toBe(deal.id);
  });

  it("does not revalidate/reject an unrelated update when the target has since been soft-deleted", async () => {
    const { ctx } = await makeCtxWithDeal();
    const company = await createCompany(ctx, { name: "Soft-Deleted After Creation" });
    const activity = await createActivity(ctx, { type: "call", relatedToType: "company", relatedToId: company.id });
    await softDeleteCompany(ctx, company.id);

    const updated = await updateActivity(ctx, activity.id, { subject: "Still editable" });
    expect(updated?.subject).toBe("Still editable");
    expect(updated?.relatedToId).toBe(company.id);
  });

  it("rejects an unrecognized type", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    await expect(updateActivity(ctx, activity.id, { type: "sms" as never })).rejects.toThrow(ValidationError);
  });

  it("returns null for nonexistent/cross-org/already-deleted", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    expect(await updateActivity(ctx, randomUUID(), { subject: "x" })).toBeNull();

    const orgB = await createOrgWithActiveMember();
    expect(
      await updateActivity({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, activity.id, {
        subject: "x",
      }),
    ).toBeNull();

    await softDeleteActivity(ctx, activity.id);
    expect(await updateActivity(ctx, activity.id, { subject: "x" })).toBeNull();
  });
});

describe("softDeleteActivity", () => {
  it("sets deleted_at and never physically deletes the row", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    const deleted = await softDeleteActivity(ctx, activity.id);
    expect(deleted?.deletedAt).not.toBeNull();

    const stillInDb = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.activities where id = $1", [activity.id]);
      return r.rows;
    });
    expect(stillInDb).toHaveLength(1);
  });

  it("returns null for nonexistent/cross-org/already-deleted", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const activity = await createActivity(ctx, { type: "call", relatedToType: "deal", relatedToId: deal.id });
    expect(await softDeleteActivity(ctx, randomUUID())).toBeNull();

    const orgB = await createOrgWithActiveMember();
    expect(
      await softDeleteActivity({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, activity.id),
    ).toBeNull();

    await softDeleteActivity(ctx, activity.id);
    expect(await softDeleteActivity(ctx, activity.id)).toBeNull();
  });
});
