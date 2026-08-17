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
  seedPipelineWithStage,
  seedDeal,
  seedActivity,
} from "./crm-api-fixtures";
import { handleListActivities, handleCreateActivity } from "../app/api/v1/activities/handlers";
import { handleGetActivity, handleUpdateActivity, handleDeleteActivity } from "../app/api/v1/activities/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function listUrl(params: Record<string, string> = {}): URL {
  const url = new URL("http://localhost/api/v1/activities");
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

describe("activities API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleListActivities(null, listUrl())).status).toBe(401);
    expect((await handleCreateActivity(null, {}, null)).status).toBe(401);
    expect((await handleGetActivity(null, randomUUID())).status).toBe(401);
    expect((await handleUpdateActivity(null, randomUUID(), {}, null)).status).toBe(401);
    expect((await handleDeleteActivity(null, randomUUID())).status).toBe(401);
  });
});

describe("activities API: RBAC", () => {
  it("org_admin has full CRUD", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const created = await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: dealId }, null);
    expect(created.status).toBe(201);
    const { activity } = await created.json();

    expect((await handleGetActivity(userId, activity.id)).status).toBe(200);
    expect((await handleUpdateActivity(userId, activity.id, { subject: "x" }, null)).status).toBe(200);
    expect((await handleDeleteActivity(userId, activity.id)).status).toBe(200);
  });

  it("org_member can GET/POST/PATCH but not DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const dealId = await makeDeal(organizationId);
    const created = await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: dealId }, null);
    expect(created.status).toBe(201);
    const { activity } = await created.json();

    expect((await handleGetActivity(userId, activity.id)).status).toBe(200);
    expect((await handleUpdateActivity(userId, activity.id, { subject: "x" }, null)).status).toBe(200);
    expect((await handleDeleteActivity(userId, activity.id)).status).toBe(403);
  });

  it("org_viewer can GET but not POST/PATCH/DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const dealId = await makeDeal(organizationId);
    const activityId = await seedActivity(organizationId, "deal", dealId);

    expect((await handleGetActivity(userId, activityId)).status).toBe(200);
    expect((await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: dealId }, null)).status).toBe(403);
    expect((await handleUpdateActivity(userId, activityId, { subject: "x" }, null)).status).toBe(403);
    expect((await handleDeleteActivity(userId, activityId)).status).toBe(403);
  });

  it("a pure agency actor (no org-scoped membership) gets 403 on every verb", async () => {
    const userId = await createPureAgencyActor();
    expect((await handleListActivities(userId, listUrl())).status).toBe(403);
    expect((await handleCreateActivity(userId, {}, null)).status).toBe(403);
    expect((await handleGetActivity(userId, randomUUID())).status).toBe(403);
    expect((await handleUpdateActivity(userId, randomUUID(), {}, null)).status).toBe(403);
    expect((await handleDeleteActivity(userId, randomUUID())).status).toBe(403);
  });

  it("an authenticated user with no org membership at all gets 403", async () => {
    const userId = await createUnaffiliatedUser();
    expect((await handleListActivities(userId, listUrl())).status).toBe(403);
  });
});

describe("activities API: tenancy / IDOR", () => {
  it("cross-org GET/PATCH/DELETE all return 404, indistinguishable from a nonexistent id", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-activities");
    const orgB = await createOrgWithRole("org_admin", "org-b-activities");
    const dealB = await makeDeal(orgB.organizationId);
    const activityB = await seedActivity(orgB.organizationId, "deal", dealB);
    const nonexistentId = randomUUID();

    const crossGet = await handleGetActivity(orgA.userId, activityB);
    const missingGet = await handleGetActivity(orgA.userId, nonexistentId);
    expect(crossGet.status).toBe(404);
    expect(missingGet.status).toBe(404);
    expect(await crossGet.json()).toEqual(await missingGet.json());

    expect((await handleUpdateActivity(orgA.userId, activityB, { subject: "x" }, null)).status).toBe(404);
    expect((await handleDeleteActivity(orgA.userId, activityB)).status).toBe(404);
  });

  it("collection list never leaks another organization's activities", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-activities-list");
    const orgB = await createOrgWithRole("org_admin", "org-b-activities-list");
    const dealA = await makeDeal(orgA.organizationId);
    const dealB = await makeDeal(orgB.organizationId);
    await seedActivity(orgA.organizationId, "deal", dealA);
    await seedActivity(orgB.organizationId, "deal", dealB);

    const page = await handleListActivities(orgA.userId, listUrl());
    const body = await page.json();
    expect(body.activities.every((a: { organizationId: string }) => a.organizationId === orgA.organizationId)).toBe(true);
  });
});

describe("activities API: relationship create attacks (cross-org target)", () => {
  it("Activity Org A -> Company Org B -> 400, and never reveals whether the target exists", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-act-company");
    const orgB = await createOrgWithRole("org_admin", "org-b-act-company");
    const companyB = await seedCompany(orgB.organizationId);

    const res = await handleCreateActivity(orgA.userId, { type: "call", relatedToType: "company", relatedToId: companyB }, null);
    expect(res.status).toBe(400);
    const nonexistentRes = await handleCreateActivity(
      orgA.userId,
      { type: "call", relatedToType: "company", relatedToId: randomUUID() },
      null,
    );
    expect(nonexistentRes.status).toBe(400);
    expect(await res.json()).toEqual(await nonexistentRes.json());
  });

  it("Activity Org A -> Contact Org B -> 400", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-act-contact");
    const orgB = await createOrgWithRole("org_admin", "org-b-act-contact");
    const contactB = await seedContact(orgB.organizationId);

    const res = await handleCreateActivity(orgA.userId, { type: "call", relatedToType: "contact", relatedToId: contactB }, null);
    expect(res.status).toBe(400);
  });

  it("Activity Org A -> Deal Org B -> 400", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-act-deal");
    const orgB = await createOrgWithRole("org_admin", "org-b-act-deal");
    const dealB = await makeDeal(orgB.organizationId);

    const res = await handleCreateActivity(orgA.userId, { type: "call", relatedToType: "deal", relatedToId: dealB }, null);
    expect(res.status).toBe(400);
  });
});

describe("activities API: create/list/single/update/soft-delete", () => {
  it("create -> 201, get -> 200, update -> 200, delete -> 200 with deletedAt, then GET -> 404", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const created = await handleCreateActivity(
      userId,
      { type: "call", relatedToType: "deal", relatedToId: dealId, subject: "Discovery call" },
      null,
    );
    expect(created.status).toBe(201);
    const { activity } = await created.json();
    expect(activity.relatedToId).toBe(dealId);
    expect(activity.subject).toBe("Discovery call");

    expect((await handleGetActivity(userId, activity.id)).status).toBe(200);

    const updated = await handleUpdateActivity(userId, activity.id, { subject: "Renamed" }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).activity.subject).toBe("Renamed");

    const deleted = await handleDeleteActivity(userId, activity.id);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).activity.deletedAt).not.toBeNull();

    expect((await handleGetActivity(userId, activity.id)).status).toBe(404);
  });

  it("missing type/relatedToType/relatedToId -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleCreateActivity(userId, {}, null)).status).toBe(400);
  });

  it("invalid type -> 400", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const res = await handleCreateActivity(userId, { type: "sms", relatedToType: "deal", relatedToId: dealId }, null);
    expect(res.status).toBe(400);
  });
});

describe("activities API: filters and pagination", () => {
  it("paginates with nextCursor and filters by relatedToType/relatedToId/type/createdBy/completed", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const company = await seedCompany(organizationId);

    for (let i = 0; i < 3; i++) {
      await seedActivity(organizationId, "deal", dealId);
      await new Promise((r) => setTimeout(r, 5));
    }
    const companyActivity = await seedActivity(organizationId, "company", company, { type: "task" });

    const page1 = await handleListActivities(userId, listUrl({ limit: "2" }));
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.activities).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const byRelated = await handleListActivities(userId, listUrl({ relatedToType: "company", relatedToId: company }));
    expect((await byRelated.json()).activities.map((a: { id: string }) => a.id)).toEqual([companyActivity]);

    const byType = await handleListActivities(userId, listUrl({ type: "task" }));
    expect((await byType.json()).activities.map((a: { id: string }) => a.id)).toEqual([companyActivity]);

    const created = await handleCreateActivity(
      userId,
      { type: "call", relatedToType: "deal", relatedToId: dealId, completedAt: new Date().toISOString() },
      null,
    );
    const completedId = (await created.json()).activity.id;

    const byCreatedBy = await handleListActivities(userId, listUrl({ createdBy: userId }));
    expect((await byCreatedBy.json()).activities.map((a: { id: string }) => a.id)).toEqual([completedId]);

    const completedPage = await handleListActivities(userId, listUrl({ completed: "true" }));
    expect((await completedPage.json()).activities.map((a: { id: string }) => a.id)).toEqual([completedId]);
  });

  it("rejects malformed cursor, invalid limit, invalid relatedToType, invalid type, malformed relatedToId/createdBy UUID, invalid completed", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleListActivities(userId, listUrl({ cursor: "not-valid-base64!!" }))).status).toBe(400);
    expect((await handleListActivities(userId, listUrl({ limit: "0" }))).status).toBe(400);
    expect((await handleListActivities(userId, listUrl({ relatedToType: "bogus" }))).status).toBe(400);
    expect((await handleListActivities(userId, listUrl({ type: "bogus" }))).status).toBe(400);
    expect((await handleListActivities(userId, listUrl({ relatedToId: "not-a-uuid" }))).status).toBe(400);
    expect((await handleListActivities(userId, listUrl({ createdBy: "not-a-uuid" }))).status).toBe(400);
    expect((await handleListActivities(userId, listUrl({ completed: "maybe" }))).status).toBe(400);
  });
});

describe("activities API: malformed UUID hardening", () => {
  it("a malformed :id on GET/PATCH/DELETE returns 404, never a raw database error / 500", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleGetActivity(userId, "not-a-uuid")).status).toBe(404);
    expect((await handleUpdateActivity(userId, "not-a-uuid", { subject: "x" }, null)).status).toBe(404);
    expect((await handleDeleteActivity(userId, "not-a-uuid")).status).toBe(404);
  });

  it("a malformed relatedToId in the POST body returns 400, never a raw database error / 500", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: "not-a-uuid" }, null);
    expect(res.status).toBe(400);
  });
});

describe("activities API: historical soft-delete relationship preservation", () => {
  it("an unrelated edit succeeds after the linked company is soft-deleted", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const company = await seedCompany(organizationId);
    const activityId = await seedActivity(organizationId, "company", company);

    await adminPool.query("update public.companies set deleted_at = now() where id = $1", [company]);

    const updated = await handleUpdateActivity(userId, activityId, { subject: "Still editable" }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).activity.relatedToId).toBe(company);
  });
});

describe("activities API: GDPR historical read", () => {
  it("GET correctly serializes a row produced by contact erasure (relatedToId/subject/body null, relatedToType still 'contact')", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);
    const activityId = await seedActivity(organizationId, "contact", contact, { subject: "Will be erased" });

    await adminPool.query(
      "update public.activities set related_to_id = null, subject = null, body = null where id = $1",
      [activityId],
    );

    const res = await handleGetActivity(userId, activityId);
    expect(res.status).toBe(200);
    const { activity } = await res.json();
    expect(activity.relatedToType).toBe("contact");
    expect(activity.relatedToId).toBeNull();
    expect(activity.subject).toBeNull();
    expect(activity.body).toBeNull();
  });

  it("list correctly serializes the same GDPR-erased historical row without 500ing", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);
    const activityId = await seedActivity(organizationId, "contact", contact);
    await adminPool.query(
      "update public.activities set related_to_id = null, subject = null, body = null where id = $1",
      [activityId],
    );

    const res = await handleListActivities(userId, listUrl());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activities.some((a: { id: string }) => a.id === activityId)).toBe(true);
  });
});

describe("activities API: mass assignment", () => {
  it("body organizationId/organization_id/id/createdBy/created_by/deletedAt/createdAt/updatedAt injection has no effect", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const forgedId = randomUUID();
    const forgedCreatedBy = randomUUID();
    const res = await handleCreateActivity(
      userId,
      {
        type: "call",
        relatedToType: "deal",
        relatedToId: dealId,
        organizationId: randomUUID(),
        organization_id: randomUUID(),
        id: forgedId,
        createdBy: forgedCreatedBy,
        created_by: forgedCreatedBy,
        deletedAt: new Date().toISOString(),
        deleted_at: new Date().toISOString(),
        createdAt: "2020-01-01T00:00:00Z",
        created_at: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
        updated_at: "2020-01-01T00:00:00Z",
      },
      null,
    );
    expect(res.status).toBe(201);
    const { activity } = await res.json();
    expect(activity.organizationId).toBe(organizationId);
    expect(activity.id).not.toBe(forgedId);
    expect(activity.createdBy).toBe(userId);
    expect(activity.createdBy).not.toBe(forgedCreatedBy);
    expect(activity.deletedAt).toBeNull();
  });

  it("PATCH cannot reassign relatedToType or relatedToId", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const company = await seedCompany(organizationId);
    const created = await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: dealId }, null);
    const activityId = (await created.json()).activity.id;

    const updated = await handleUpdateActivity(
      userId,
      activityId,
      { subject: "Touched", relatedToType: "company", relatedToId: company },
      null,
    );
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.activity.subject).toBe("Touched");
    expect(body.activity.relatedToType).toBe("deal");
    expect(body.activity.relatedToId).toBe(dealId);
  });

  it("unknown fields are silently ignored, not rejected", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const res = await handleCreateActivity(
      userId,
      { type: "call", relatedToType: "deal", relatedToId: dealId, totallyMadeUpField: "x" },
      null,
    );
    expect(res.status).toBe(201);
  });
});

describe("activities API: idempotency", () => {
  it("POST replays the exact response for the same key + payload, callback runs only once", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const key = randomUUID();
    const first = await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: dealId }, key);
    const second = await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: dealId }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());

    const n = await adminPool
      .query("select count(*)::int as n from public.activities where organization_id = $1", [organizationId])
      .then((r) => r.rows[0].n);
    expect(n).toBe(1);
  });

  it("POST same key + different payload -> 409", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const key = randomUUID();
    await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: dealId }, key);
    const conflict = await handleCreateActivity(userId, { type: "task", relatedToType: "deal", relatedToId: dealId }, key);
    expect(conflict.status).toBe(409);
  });

  it("PATCH replays the exact response for the same key + payload", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const activityId = await seedActivity(organizationId, "deal", dealId);
    const key = randomUUID();
    const first = await handleUpdateActivity(userId, activityId, { subject: "x" }, key);
    const second = await handleUpdateActivity(userId, activityId, { subject: "x" }, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });

  it("no Idempotency-Key header -> normal operation", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const res = await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: dealId }, null);
    expect(res.status).toBe(201);
  });

  it("idempotency replay still re-runs auth/RBAC first — a demoted actor does not get a replay", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const key = randomUUID();
    const first = await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: dealId }, key);
    expect(first.status).toBe(201);

    await setMembershipStatus(userId, organizationId, "removed");
    const replay = await handleCreateActivity(userId, { type: "call", relatedToType: "deal", relatedToId: dealId }, key);
    expect(replay.status).toBe(403);
  });
});
