import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  adminPool,
  createOrgWithRole,
  createPureAgencyActor,
  createUnaffiliatedUser,
  setMembershipStatus,
  seedTag,
} from "./crm-api-fixtures";
import { handleListTags, handleCreateTag } from "../app/api/v1/tags/handlers";
import { handleGetTag, handleUpdateTag, handleDeleteTag } from "../app/api/v1/tags/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function listUrl(params: Record<string, string> = {}): URL {
  const url = new URL("http://localhost/api/v1/tags");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

afterAll(async () => {
  await closePool();
});

describe("tags API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleListTags(null, listUrl())).status).toBe(401);
    expect((await handleCreateTag(null, {}, null)).status).toBe(401);
    expect((await handleGetTag(null, randomUUID())).status).toBe(401);
    expect((await handleUpdateTag(null, randomUUID(), {}, null)).status).toBe(401);
    expect((await handleDeleteTag(null, randomUUID())).status).toBe(401);
  });
});

describe("tags API: RBAC", () => {
  it("org_admin has full CRUD", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const created = await handleCreateTag(userId, { name: "Hot Lead" }, null);
    expect(created.status).toBe(201);
    const { tag } = await created.json();

    expect((await handleGetTag(userId, tag.id)).status).toBe(200);
    expect((await handleUpdateTag(userId, tag.id, { name: "Renamed" }, null)).status).toBe(200);
    expect((await handleDeleteTag(userId, tag.id)).status).toBe(200);
  });

  it("org_member can GET/POST/PATCH but not DELETE", async () => {
    const { userId } = await createOrgWithRole("org_member");
    const created = await handleCreateTag(userId, { name: "Hot Lead" }, null);
    expect(created.status).toBe(201);
    const { tag } = await created.json();

    expect((await handleGetTag(userId, tag.id)).status).toBe(200);
    expect((await handleUpdateTag(userId, tag.id, { name: "Renamed" }, null)).status).toBe(200);
    expect((await handleDeleteTag(userId, tag.id)).status).toBe(403);
  });

  it("org_viewer can GET but not POST/PATCH/DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const tagId = await seedTag(organizationId);

    expect((await handleGetTag(userId, tagId)).status).toBe(200);
    expect((await handleCreateTag(userId, { name: "x" }, null)).status).toBe(403);
    expect((await handleUpdateTag(userId, tagId, { name: "y" }, null)).status).toBe(403);
    expect((await handleDeleteTag(userId, tagId)).status).toBe(403);
  });

  it("a pure agency actor (no org-scoped membership) gets 403 on every verb", async () => {
    const userId = await createPureAgencyActor();
    expect((await handleListTags(userId, listUrl())).status).toBe(403);
    expect((await handleCreateTag(userId, {}, null)).status).toBe(403);
    expect((await handleGetTag(userId, randomUUID())).status).toBe(403);
    expect((await handleUpdateTag(userId, randomUUID(), {}, null)).status).toBe(403);
    expect((await handleDeleteTag(userId, randomUUID())).status).toBe(403);
  });

  it("an authenticated user with no org membership at all gets 403", async () => {
    const userId = await createUnaffiliatedUser();
    expect((await handleListTags(userId, listUrl())).status).toBe(403);
  });
});

describe("tags API: tenancy / IDOR", () => {
  it("cross-org GET/PATCH/DELETE all return 404, indistinguishable from a nonexistent id", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-tags");
    const orgB = await createOrgWithRole("org_admin", "org-b-tags");
    const tagB = await seedTag(orgB.organizationId);
    const nonexistentId = randomUUID();

    const crossGet = await handleGetTag(orgA.userId, tagB);
    const missingGet = await handleGetTag(orgA.userId, nonexistentId);
    expect(crossGet.status).toBe(404);
    expect(missingGet.status).toBe(404);
    expect(await crossGet.json()).toEqual(await missingGet.json());

    expect((await handleUpdateTag(orgA.userId, tagB, { name: "x" }, null)).status).toBe(404);
    expect((await handleDeleteTag(orgA.userId, tagB)).status).toBe(404);
  });

  it("collection list never leaks another organization's tags", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-tags-list");
    const orgB = await createOrgWithRole("org_admin", "org-b-tags-list");
    await seedTag(orgA.organizationId);
    await seedTag(orgB.organizationId);

    const page = await handleListTags(orgA.userId, listUrl());
    const body = await page.json();
    expect(body.tags.every((t: { organizationId: string }) => t.organizationId === orgA.organizationId)).toBe(true);
  });
});

describe("tags API: create/list/single/update/soft-delete", () => {
  it("create -> 201, get -> 200, update -> 200, delete -> 200 with deletedAt, then GET -> 404", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const created = await handleCreateTag(userId, { name: "Hot Lead", color: "#ff0000" }, null);
    expect(created.status).toBe(201);
    const { tag } = await created.json();
    expect(tag.name).toBe("Hot Lead");
    expect(tag.color).toBe("#ff0000");

    expect((await handleGetTag(userId, tag.id)).status).toBe(200);

    const updated = await handleUpdateTag(userId, tag.id, { name: "Renamed" }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).tag.name).toBe("Renamed");

    const deleted = await handleDeleteTag(userId, tag.id);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).tag.deletedAt).not.toBeNull();

    expect((await handleGetTag(userId, tag.id)).status).toBe(404);
  });

  it("missing name -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleCreateTag(userId, {}, null)).status).toBe(400);
  });

  it("whitespace-only name -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleCreateTag(userId, { name: "   " }, null)).status).toBe(400);
  });

  it("duplicate active tag name (case-insensitive) -> 409", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    await handleCreateTag(userId, { name: "Priority" }, null);
    const res = await handleCreateTag(userId, { name: "PRIORITY" }, null);
    expect(res.status).toBe(409);
  });

  it("PATCH rename colliding with another active tag -> 409", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    await handleCreateTag(userId, { name: "Taken" }, null);
    const created = await handleCreateTag(userId, { name: "Free" }, null);
    const tagId = (await created.json()).tag.id;
    const res = await handleUpdateTag(userId, tagId, { name: "TAKEN" }, null);
    expect(res.status).toBe(409);
  });
});

describe("tags API: pagination", () => {
  it("paginates with nextCursor", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    for (let i = 0; i < 3; i++) {
      await seedTag(organizationId, { name: `Tag ${i}` });
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await handleListTags(userId, listUrl({ limit: "2" }));
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.tags).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();
  });

  it("rejects malformed cursor and invalid limit", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleListTags(userId, listUrl({ cursor: "not-valid-base64!!" }))).status).toBe(400);
    expect((await handleListTags(userId, listUrl({ limit: "0" }))).status).toBe(400);
    expect((await handleListTags(userId, listUrl({ limit: "101" }))).status).toBe(400);
  });
});

describe("tags API: malformed UUID hardening", () => {
  it("a malformed :id on GET/PATCH/DELETE returns 404, never a raw database error / 500", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleGetTag(userId, "not-a-uuid")).status).toBe(404);
    expect((await handleUpdateTag(userId, "not-a-uuid", { name: "x" }, null)).status).toBe(404);
    expect((await handleDeleteTag(userId, "not-a-uuid")).status).toBe(404);
  });
});

describe("tags API: mass assignment", () => {
  it("body organizationId/organization_id/id/deletedAt/createdAt/updatedAt injection has no effect", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const forgedId = randomUUID();
    const res = await handleCreateTag(
      userId,
      {
        name: "Guarded",
        organizationId: randomUUID(),
        organization_id: randomUUID(),
        id: forgedId,
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
    const { tag } = await res.json();
    expect(tag.organizationId).toBe(organizationId);
    expect(tag.id).not.toBe(forgedId);
    expect(tag.deletedAt).toBeNull();
  });

  it("unknown fields are silently ignored, not rejected", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateTag(userId, { name: "x", totallyMadeUpField: "x" }, null);
    expect(res.status).toBe(201);
  });
});

describe("tags API: idempotency", () => {
  it("POST replays the exact response for the same key + payload, callback runs only once", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    const first = await handleCreateTag(userId, { name: "Idempotent Tag" }, key);
    const second = await handleCreateTag(userId, { name: "Idempotent Tag" }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());

    const n = await adminPool
      .query("select count(*)::int as n from public.tags where organization_id = $1", [organizationId])
      .then((r) => r.rows[0].n);
    expect(n).toBe(1);
  });

  it("POST same key + different payload -> 409", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    await handleCreateTag(userId, { name: "First Name" }, key);
    const conflict = await handleCreateTag(userId, { name: "Different Name" }, key);
    expect(conflict.status).toBe(409);
  });

  it("PATCH replays the exact response for the same key + payload", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const tagId = await seedTag(organizationId);
    const key = randomUUID();
    const first = await handleUpdateTag(userId, tagId, { name: "Patched" }, key);
    const second = await handleUpdateTag(userId, tagId, { name: "Patched" }, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });

  it("no Idempotency-Key header -> normal operation", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateTag(userId, { name: "x" }, null);
    expect(res.status).toBe(201);
  });

  it("idempotency replay still re-runs auth/RBAC first — a demoted actor does not get a replay", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    const first = await handleCreateTag(userId, { name: "x" }, key);
    expect(first.status).toBe(201);

    await setMembershipStatus(userId, organizationId, "removed");
    const replay = await handleCreateTag(userId, { name: "x" }, key);
    expect(replay.status).toBe(403);
  });
});
