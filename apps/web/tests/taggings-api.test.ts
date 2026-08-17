import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  adminPool,
  createOrgWithRole,
  createPureAgencyActor,
  createUnaffiliatedUser,
  seedCompany,
  seedContact,
  seedPipelineWithStage,
  seedDeal,
  seedTag,
  seedTagging,
} from "./crm-api-fixtures";
import { handleListTaggings, handleCreateTagging } from "../app/api/v1/taggings/handlers";
import { handleDeleteTagging } from "../app/api/v1/taggings/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function listUrl(params: Record<string, string> = {}): URL {
  const url = new URL("http://localhost/api/v1/taggings");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

async function makeDeal(organizationId: string): Promise<string> {
  const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
  return seedDeal(organizationId, pipelineId, stageId);
}

afterAll(async () => {
  await closePool();
});

describe("taggings API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleListTaggings(null, listUrl())).status).toBe(401);
    expect((await handleCreateTagging(null, {})).status).toBe(401);
    expect((await handleDeleteTagging(null, randomUUID())).status).toBe(401);
  });
});

describe("taggings API: authorization maps to tags:* (no taggings:* permission family)", () => {
  it("GET uses tags:read — org_viewer (read-only) can list", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    await seedTagging(organizationId, tagId, "deal", dealId);

    expect((await handleListTaggings(userId, listUrl())).status).toBe(200);
  });

  it("POST uses tags:create — org_member (has tags:create) can create", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);

    const res = await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId });
    expect(res.status).toBe(201);
  });

  it("DELETE uses tags:delete — org_member (lacks tags:delete) is denied", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    const taggingId = await seedTagging(organizationId, tagId, "deal", dealId);

    const res = await handleDeleteTagging(userId, taggingId);
    expect(res.status).toBe(403);

    const stillExists = await adminPool.query("select id from public.taggings where id = $1", [taggingId]);
    expect(stillExists.rows).toHaveLength(1);
  });

  it("org_viewer cannot POST or DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    const taggingId = await seedTagging(organizationId, tagId, "deal", dealId);

    expect((await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId })).status).toBe(403);
    expect((await handleDeleteTagging(userId, taggingId)).status).toBe(403);
  });

  it("org_admin has full GET/POST/DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);

    const created = await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId });
    expect(created.status).toBe(201);
    const { tagging } = await created.json();

    expect((await handleListTaggings(userId, listUrl())).status).toBe(200);
    expect((await handleDeleteTagging(userId, tagging.id)).status).toBe(200);
  });

  it("agency_owner, agency_admin, and portal_customer do not gain access via any verb", async () => {
    const agencyOwnerUserId = await createPureAgencyActor();
    expect((await handleListTaggings(agencyOwnerUserId, listUrl())).status).toBe(403);
    expect((await handleCreateTagging(agencyOwnerUserId, {})).status).toBe(403);
    expect((await handleDeleteTagging(agencyOwnerUserId, randomUUID())).status).toBe(403);

    const unaffiliatedUserId = await createUnaffiliatedUser();
    expect((await handleListTaggings(unaffiliatedUserId, listUrl())).status).toBe(403);
  });
});

describe("taggings API: tenancy / IDOR", () => {
  it("cross-org DELETE returns 404, indistinguishable from a nonexistent id", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-taggings");
    const orgB = await createOrgWithRole("org_admin", "org-b-taggings");
    const dealB = await makeDeal(orgB.organizationId);
    const tagB = await seedTag(orgB.organizationId);
    const taggingB = await seedTagging(orgB.organizationId, tagB, "deal", dealB);
    const nonexistentId = randomUUID();

    const crossDelete = await handleDeleteTagging(orgA.userId, taggingB);
    const missingDelete = await handleDeleteTagging(orgA.userId, nonexistentId);
    expect(crossDelete.status).toBe(404);
    expect(missingDelete.status).toBe(404);
    expect(await crossDelete.json()).toEqual(await missingDelete.json());

    const stillExists = await adminPool.query("select id from public.taggings where id = $1", [taggingB]);
    expect(stillExists.rows).toHaveLength(1);
  });

  it("collection list never leaks another organization's taggings", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-taggings-list");
    const orgB = await createOrgWithRole("org_admin", "org-b-taggings-list");
    const dealA = await makeDeal(orgA.organizationId);
    const dealB = await makeDeal(orgB.organizationId);
    const tagA = await seedTag(orgA.organizationId);
    const tagB = await seedTag(orgB.organizationId);
    await seedTagging(orgA.organizationId, tagA, "deal", dealA);
    await seedTagging(orgB.organizationId, tagB, "deal", dealB);

    const page = await handleListTaggings(orgA.userId, listUrl());
    const body = await page.json();
    expect(body.taggings.every((t: { organizationId: string }) => t.organizationId === orgA.organizationId)).toBe(true);
  });
});

describe("taggings API: relationship create attacks (cross-org)", () => {
  it("Tagging Org A -> Tag Org B -> 400, and never reveals whether the tag exists", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-tagging-tag");
    const orgB = await createOrgWithRole("org_admin", "org-b-tagging-tag");
    const dealA = await makeDeal(orgA.organizationId);
    const tagB = await seedTag(orgB.organizationId);

    const res = await handleCreateTagging(orgA.userId, { tagId: tagB, taggableType: "deal", taggableId: dealA });
    expect(res.status).toBe(400);
    const nonexistentRes = await handleCreateTagging(orgA.userId, {
      tagId: randomUUID(),
      taggableType: "deal",
      taggableId: dealA,
    });
    expect(nonexistentRes.status).toBe(400);
    expect(await res.json()).toEqual(await nonexistentRes.json());
  });

  it("Tagging Org A -> Company Org B -> 400", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-tagging-company");
    const orgB = await createOrgWithRole("org_admin", "org-b-tagging-company");
    const tagA = await seedTag(orgA.organizationId);
    const companyB = await seedCompany(orgB.organizationId);

    const res = await handleCreateTagging(orgA.userId, { tagId: tagA, taggableType: "company", taggableId: companyB });
    expect(res.status).toBe(400);
  });

  it("Tagging Org A -> Contact Org B -> 400", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-tagging-contact");
    const orgB = await createOrgWithRole("org_admin", "org-b-tagging-contact");
    const tagA = await seedTag(orgA.organizationId);
    const contactB = await seedContact(orgB.organizationId);

    const res = await handleCreateTagging(orgA.userId, { tagId: tagA, taggableType: "contact", taggableId: contactB });
    expect(res.status).toBe(400);
  });

  it("Tagging Org A -> Deal Org B -> 400", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-tagging-deal");
    const orgB = await createOrgWithRole("org_admin", "org-b-tagging-deal");
    const tagA = await seedTag(orgA.organizationId);
    const dealB = await makeDeal(orgB.organizationId);

    const res = await handleCreateTagging(orgA.userId, { tagId: tagA, taggableType: "deal", taggableId: dealB });
    expect(res.status).toBe(400);
  });
});

describe("taggings API: create/list/physical delete", () => {
  it("create -> 201, list includes it, delete -> 200, then physically gone from the database", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);

    const created = await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId });
    expect(created.status).toBe(201);
    const { tagging } = await created.json();
    expect(tagging.tagId).toBe(tagId);
    expect(tagging.taggableId).toBe(dealId);

    const listed = await handleListTaggings(userId, listUrl());
    expect((await listed.json()).taggings.map((t: { id: string }) => t.id)).toContain(tagging.id);

    const deleted = await handleDeleteTagging(userId, tagging.id);
    expect(deleted.status).toBe(200);

    const stillInDb = await adminPool.query("select id from public.taggings where id = $1", [tagging.id]);
    expect(stillInDb.rows).toEqual([]);
  });

  it("missing tagId/taggableType/taggableId -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleCreateTagging(userId, {})).status).toBe(400);
  });

  it("invalid taggableType -> 400", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    const res = await handleCreateTagging(userId, { tagId, taggableType: "campaign", taggableId: dealId });
    expect(res.status).toBe(400);
  });

  it("duplicate Tagging (same tag + same target) -> 409", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId });
    const conflict = await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId });
    expect(conflict.status).toBe(409);
  });

  it("soft-deleted tag cannot be used for a new Tagging -> 400", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    await adminPool.query("update public.tags set deleted_at = now() where id = $1", [tagId]);

    const res = await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId });
    expect(res.status).toBe(400);
  });

  it("soft-deleted target cannot receive a new Tagging -> 400", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    await adminPool.query("update public.deals set deleted_at = now() where id = $1", [dealId]);
    const tagId = await seedTag(organizationId);

    const res = await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId });
    expect(res.status).toBe(400);
  });
});

describe("taggings API: filters and pagination", () => {
  it("filters by tagId, taggableType, and taggableId", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const company = await seedCompany(organizationId);
    const tagId = await seedTag(organizationId);

    const dealTagging = await seedTagging(organizationId, tagId, "deal", dealId);
    await seedTagging(organizationId, tagId, "company", company);

    const byTag = await handleListTaggings(userId, listUrl({ tagId }));
    expect((await byTag.json()).taggings).toHaveLength(2);

    const byTarget = await handleListTaggings(userId, listUrl({ taggableType: "deal", taggableId: dealId }));
    expect((await byTarget.json()).taggings.map((t: { id: string }) => t.id)).toEqual([dealTagging]);
  });

  it("rejects malformed cursor, invalid limit, invalid taggableType, malformed tagId/taggableId UUID", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleListTaggings(userId, listUrl({ cursor: "not-valid-base64!!" }))).status).toBe(400);
    expect((await handleListTaggings(userId, listUrl({ limit: "0" }))).status).toBe(400);
    expect((await handleListTaggings(userId, listUrl({ taggableType: "bogus" }))).status).toBe(400);
    expect((await handleListTaggings(userId, listUrl({ tagId: "not-a-uuid" }))).status).toBe(400);
    expect((await handleListTaggings(userId, listUrl({ taggableId: "not-a-uuid" }))).status).toBe(400);
  });
});

describe("taggings API: malformed UUID hardening", () => {
  it("a malformed :id on DELETE returns 404, never a raw database error / 500", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleDeleteTagging(userId, "not-a-uuid")).status).toBe(404);
  });

  it("a malformed tagId/taggableId in the POST body returns 400, never a raw database error / 500", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);

    expect((await handleCreateTagging(userId, { tagId: "not-a-uuid", taggableType: "deal", taggableId: dealId })).status).toBe(400);
    expect((await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: "not-a-uuid" })).status).toBe(400);
  });
});

describe("taggings API: mass assignment", () => {
  it("body organizationId/organization_id/id injection has no effect", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    const forgedId = randomUUID();

    const res = await handleCreateTagging(userId, {
      tagId,
      taggableType: "deal",
      taggableId: dealId,
      organizationId: randomUUID(),
      organization_id: randomUUID(),
      id: forgedId,
    });
    expect(res.status).toBe(201);
    const { tagging } = await res.json();
    expect(tagging.organizationId).toBe(organizationId);
    expect(tagging.id).not.toBe(forgedId);
  });

  it("unknown fields are silently ignored, not rejected", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    const res = await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId, totallyMadeUpField: "x" });
    expect(res.status).toBe(201);
  });
});

describe("taggings API: no idempotency machinery — duplicate creation maps to 409 through the unique constraint instead", () => {
  it("two identical POSTs with no Idempotency-Key both attempt real inserts; the second collides with the unique constraint -> 409", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);

    const first = await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId });
    expect(first.status).toBe(201);
    const second = await handleCreateTagging(userId, { tagId, taggableType: "deal", taggableId: dealId });
    expect(second.status).toBe(409);

    const n = await adminPool
      .query("select count(*)::int as n from public.taggings where organization_id = $1", [organizationId])
      .then((r) => r.rows[0].n);
    expect(n).toBe(1);
  });
});
