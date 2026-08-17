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
  createTag,
  getTagById,
  listTags,
  updateTag,
  softDeleteTag,
  createTagging,
  listTaggings,
  deleteTagging,
} from "../src/tags";
import {
  ValidationError,
  DuplicateTagNameError,
  DuplicateTaggingError,
  InvalidCompanyRelationshipError,
  InvalidContactRelationshipError,
  InvalidDealRelationshipError,
  InvalidTagRelationshipError,
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

describe("createTag", () => {
  it("creates a tag and persists organization_id from ctx", async () => {
    const { ctx } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "Hot Lead" });
    expect(tag.organizationId).toBe(ctx.organizationId);
    expect(tag.name).toBe("Hot Lead");
    expect(tag.color).toBeNull();
    expect(tag.deletedAt).toBeNull();
  });

  it("accepts a free-form color with no format validation", async () => {
    const { ctx } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "Colored", color: "not-a-hex-value" });
    expect(tag.color).toBe("not-a-hex-value");
  });

  it("sets organizationId from ctx, never from input (mass-assignment guard)", async () => {
    const { ctx } = await makeCtxWithDeal();
    const otherOrg = randomUUID();
    const tag = await createTag(ctx, { name: "Guarded", organizationId: otherOrg } as never);
    expect(tag.organizationId).toBe(ctx.organizationId);
    expect(tag.organizationId).not.toBe(otherOrg);
  });

  describe("name validation", () => {
    it("rejects a missing name", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(createTag(ctx, {} as never)).rejects.toThrow(ValidationError);
    });

    it("rejects a whitespace-only name", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(createTag(ctx, { name: "   " })).rejects.toThrow(ValidationError);
    });
  });

  describe("case-insensitive active-name uniqueness", () => {
    it("rejects a duplicate active name differing only by case, in the same organization", async () => {
      const { ctx } = await makeCtxWithDeal();
      await createTag(ctx, { name: "Priority" });
      await expect(createTag(ctx, { name: "PRIORITY" })).rejects.toThrow(DuplicateTagNameError);
    });

    it("allows the name to be reused once the prior tag with that name is soft-deleted", async () => {
      const { ctx } = await makeCtxWithDeal();
      const first = await createTag(ctx, { name: "Reusable" });
      await softDeleteTag(ctx, first.id);
      const second = await createTag(ctx, { name: "Reusable" });
      expect(second.id).not.toBe(first.id);
    });

    it("allows two different organizations to each have a tag with the same name", async () => {
      const { ctx } = await makeCtxWithDeal();
      await createTag(ctx, { name: "Shared Name" });
      const orgB = await createOrgWithActiveMember();
      const tagB = await createTag(
        { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
        { name: "Shared Name" },
      );
      expect(tagB.name).toBe("Shared Name");
    });
  });
});

describe("getTagById", () => {
  it("excludes soft-deleted tags", async () => {
    const { ctx } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "Soon Gone" });
    await softDeleteTag(ctx, tag.id);
    expect(await getTagById(ctx, tag.id)).toBeNull();
  });

  it("returns null for nonexistent and cross-org", async () => {
    const { ctx } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "Org A Tag" });
    expect(await getTagById(ctx, randomUUID())).toBeNull();
    const orgB = await createOrgWithActiveMember();
    expect(
      await getTagById({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, tag.id),
    ).toBeNull();
  });
});

describe("listTags", () => {
  it("excludes soft-deleted and cross-org tags", async () => {
    const { ctx } = await makeCtxWithDeal();
    const active = await createTag(ctx, { name: "Active" });
    const deleted = await createTag(ctx, { name: "Deleted" });
    await softDeleteTag(ctx, deleted.id);

    const page = await listTags(ctx);
    const ids = page.items.map((t) => t.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(deleted.id);
  });
});

describe("updateTag", () => {
  it("updates name and color", async () => {
    const { ctx } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "Original" });
    const updated = await updateTag(ctx, tag.id, { name: "Renamed", color: "#ff0000" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.color).toBe("#ff0000");
  });

  it("rejects renaming to a name that collides case-insensitively with another active tag", async () => {
    const { ctx } = await makeCtxWithDeal();
    await createTag(ctx, { name: "Taken" });
    const tag = await createTag(ctx, { name: "Free" });
    await expect(updateTag(ctx, tag.id, { name: "TAKEN" })).rejects.toThrow(DuplicateTagNameError);
  });

  it("returns null for nonexistent/cross-org/already-deleted", async () => {
    const { ctx } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "x" });
    expect(await updateTag(ctx, randomUUID(), { name: "y" })).toBeNull();

    const orgB = await createOrgWithActiveMember();
    expect(
      await updateTag({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, tag.id, {
        name: "y",
      }),
    ).toBeNull();

    await softDeleteTag(ctx, tag.id);
    expect(await updateTag(ctx, tag.id, { name: "y" })).toBeNull();
  });
});

describe("softDeleteTag", () => {
  it("sets deleted_at and never physically deletes the row", async () => {
    const { ctx } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "x" });
    const deleted = await softDeleteTag(ctx, tag.id);
    expect(deleted?.deletedAt).not.toBeNull();

    const stillInDb = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.tags where id = $1", [tag.id]);
      return r.rows;
    });
    expect(stillInDb).toHaveLength(1);
  });
});

describe("createTagging", () => {
  it("creates a tagging and persists organization_id from ctx", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "Hot" });
    const tagging = await createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: deal.id });
    expect(tagging.organizationId).toBe(ctx.organizationId);
    expect(tagging.tagId).toBe(tag.id);
    expect(tagging.taggableType).toBe("deal");
    expect(tagging.taggableId).toBe(deal.id);
  });

  it("sets organizationId from ctx, never from input (mass-assignment guard)", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "Guarded" });
    const otherOrg = randomUUID();
    const tagging = await createTagging(
      ctx,
      { tagId: tag.id, taggableType: "deal", taggableId: deal.id, organizationId: otherOrg } as never,
    );
    expect(tagging.organizationId).toBe(ctx.organizationId);
    expect(tagging.organizationId).not.toBe(otherOrg);
  });

  describe("taggableType allowlist", () => {
    it("rejects an unrecognized taggableType", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Bad Type" });
      await expect(
        createTagging(ctx, { tagId: tag.id, taggableType: "campaign" as never, taggableId: deal.id }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("tag validation", () => {
    it("rejects a nonexistent tag", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      await expect(
        createTagging(ctx, { tagId: randomUUID(), taggableType: "deal", taggableId: deal.id }),
      ).rejects.toThrow(InvalidTagRelationshipError);
    });

    it("rejects a soft-deleted tag", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Soon Deleted Tag" });
      await softDeleteTag(ctx, tag.id);
      await expect(
        createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: deal.id }),
      ).rejects.toThrow(InvalidTagRelationshipError);
    });

    it("rejects a cross-org tag (adversarial: cross-org tag cannot be attached)", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      const orgB = await createOrgWithActiveMember();
      const tagInB = await createTag(
        { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
        { name: "Org B Tag" },
      );
      await expect(
        createTagging(ctx, { tagId: tagInB.id, taggableType: "deal", taggableId: deal.id }),
      ).rejects.toThrow(InvalidTagRelationshipError);
    });
  });

  describe("company target validation", () => {
    it("accepts a valid active company in the same organization", async () => {
      const { ctx } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Co Tag" });
      const company = await createCompany(ctx, { name: "Acme" });
      const tagging = await createTagging(ctx, { tagId: tag.id, taggableType: "company", taggableId: company.id });
      expect(tagging.taggableId).toBe(company.id);
    });

    it("rejects a company belonging to a different organization (adversarial: Tagging Org A -> Company Org B)", async () => {
      const { ctx } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Co Tag" });
      const orgB = await createOrgWithActiveMember();
      const companyInB = await createCompany(
        { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
        { name: "Org B Co" },
      );
      await expect(
        createTagging(ctx, { tagId: tag.id, taggableType: "company", taggableId: companyInB.id }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });

    it("rejects a soft-deleted company as a new target", async () => {
      const { ctx } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Co Tag" });
      const company = await createCompany(ctx, { name: "Soon Deleted" });
      await softDeleteCompany(ctx, company.id);
      await expect(
        createTagging(ctx, { tagId: tag.id, taggableType: "company", taggableId: company.id }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });
  });

  describe("contact target validation", () => {
    it("accepts a valid active contact in the same organization", async () => {
      const { ctx } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Contact Tag" });
      const contact = await createContact(ctx, { firstName: "Ada" });
      const tagging = await createTagging(ctx, { tagId: tag.id, taggableType: "contact", taggableId: contact.id });
      expect(tagging.taggableId).toBe(contact.id);
    });

    it("rejects a contact belonging to a different organization (adversarial: Tagging Org A -> Contact Org B)", async () => {
      const { ctx } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Contact Tag" });
      const orgB = await createOrgWithActiveMember();
      const contactInB = await createContact(
        { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
        { firstName: "Org B Contact" },
      );
      await expect(
        createTagging(ctx, { tagId: tag.id, taggableType: "contact", taggableId: contactInB.id }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });

    it("rejects a soft-deleted contact as a new target", async () => {
      const { ctx } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Contact Tag" });
      const contact = await createContact(ctx, { firstName: "Soon Deleted" });
      await softDeleteContact(ctx, contact.id);
      await expect(
        createTagging(ctx, { tagId: tag.id, taggableType: "contact", taggableId: contact.id }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });
  });

  describe("deal target validation", () => {
    it("accepts a valid active deal in the same organization", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Deal Tag" });
      const tagging = await createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: deal.id });
      expect(tagging.taggableId).toBe(deal.id);
    });

    it("rejects a deal belonging to a different organization (adversarial: Tagging Org A -> Deal Org B)", async () => {
      const { ctx } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Deal Tag" });
      const orgB = await makeCtxWithDeal();
      await expect(
        createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: orgB.deal.id }),
      ).rejects.toThrow(InvalidDealRelationshipError);
    });

    it("rejects a soft-deleted deal as a new target", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Deal Tag" });
      await softDeleteDeal(ctx, deal.id);
      await expect(
        createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: deal.id }),
      ).rejects.toThrow(InvalidDealRelationshipError);
    });
  });

  describe("duplicate tagging", () => {
    it("rejects attaching the same tag to the same target twice", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      const tag = await createTag(ctx, { name: "Dup Tag" });
      await createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: deal.id });
      await expect(
        createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: deal.id }),
      ).rejects.toThrow(DuplicateTaggingError);
    });

    it("allows the same target to be tagged with two different tags", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      const tagOne = await createTag(ctx, { name: "Tag One" });
      const tagTwo = await createTag(ctx, { name: "Tag Two" });
      await createTagging(ctx, { tagId: tagOne.id, taggableType: "deal", taggableId: deal.id });
      const second = await createTagging(ctx, { tagId: tagTwo.id, taggableType: "deal", taggableId: deal.id });
      expect(second.tagId).toBe(tagTwo.id);
    });
  });
});

describe("listTaggings", () => {
  it("filters by tagId, taggableType, and taggableId", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const company = await createCompany(ctx, { name: "Filter Co" });
    const tag = await createTag(ctx, { name: "Filter Tag" });
    const dealTagging = await createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: deal.id });
    await createTagging(ctx, { tagId: tag.id, taggableType: "company", taggableId: company.id });

    const byTag = await listTaggings(ctx, { tagId: tag.id });
    expect(byTag.items).toHaveLength(2);

    const byTarget = await listTaggings(ctx, { taggableType: "deal", taggableId: deal.id });
    expect(byTarget.items.map((t) => t.id)).toEqual([dealTagging.id]);
  });

  it("excludes taggings from other organizations", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "Org A Tag" });
    await createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: deal.id });
    const orgB = await createOrgWithActiveMember();
    const page = await listTaggings({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey });
    expect(page.items).toEqual([]);
  });
});

describe("deleteTagging", () => {
  it("physically deletes the row — no soft-delete, no deleted_at column at all", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "Delete Me Tag" });
    const tagging = await createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: deal.id });

    const deleted = await deleteTagging(ctx, tagging.id);
    expect(deleted?.id).toBe(tagging.id);

    const stillInDb = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.taggings where id = $1", [tagging.id]);
      return r.rows;
    });
    expect(stillInDb).toEqual([]);
  });

  it("returns null for nonexistent and cross-org (cannot delete another organization's tagging)", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const tag = await createTag(ctx, { name: "Cross Org Delete Tag" });
    const tagging = await createTagging(ctx, { tagId: tag.id, taggableType: "deal", taggableId: deal.id });

    expect(await deleteTagging(ctx, randomUUID())).toBeNull();

    const orgB = await createOrgWithActiveMember();
    const crossOrgResult = await deleteTagging(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      tagging.id,
    );
    expect(crossOrgResult).toBeNull();

    const stillInDb = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.taggings where id = $1", [tagging.id]);
      return r.rows;
    });
    expect(stillInDb).toHaveLength(1);
  });
});
