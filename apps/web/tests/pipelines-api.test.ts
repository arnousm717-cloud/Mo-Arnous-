import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  adminPool,
  createOrgWithRole,
  createPureAgencyActor,
  createUnaffiliatedUser,
  seedPipeline,
} from "./crm-api-fixtures";
import { handleListPipelines, handleCreatePipeline } from "../app/api/v1/pipelines/handlers";
import { handleGetPipeline, handleUpdatePipeline, handleDeletePipeline } from "../app/api/v1/pipelines/[id]/handlers";
import { handleSetDefaultPipeline } from "../app/api/v1/pipelines/[id]/set-default/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function listUrl(params: Record<string, string> = {}): URL {
  const url = new URL("http://localhost/api/v1/pipelines");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

async function rowCount(sql: string, params: unknown[]): Promise<number> {
  const r = await adminPool.query(sql, params);
  return r.rows[0].n;
}

afterAll(async () => {
  await closePool();
});

describe("pipelines API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleListPipelines(null, listUrl())).status).toBe(401);
    expect((await handleCreatePipeline(null, { name: "X" }, null)).status).toBe(401);
    expect((await handleGetPipeline(null, randomUUID())).status).toBe(401);
    expect((await handleUpdatePipeline(null, randomUUID(), { name: "X" }, null)).status).toBe(401);
    expect((await handleDeletePipeline(null, randomUUID())).status).toBe(401);
    expect((await handleSetDefaultPipeline(null, randomUUID())).status).toBe(401);
  });
});

describe("pipelines API: RBAC", () => {
  it("org_admin has full CRUD plus set-default", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const created = await handleCreatePipeline(userId, { name: "Admin Pipeline" }, null);
    expect(created.status).toBe(201);
    const { pipeline } = await created.json();

    expect((await handleGetPipeline(userId, pipeline.id)).status).toBe(200);
    expect((await handleUpdatePipeline(userId, pipeline.id, { name: "Renamed" }, null)).status).toBe(200);
    expect((await handleSetDefaultPipeline(userId, pipeline.id)).status).toBe(200);
    expect((await handleDeletePipeline(userId, pipeline.id)).status).toBe(409); // now the active default
  });

  it("org_member can GET only — POST/PATCH/DELETE all denied", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const pipelineId = await seedPipeline(organizationId);

    expect((await handleGetPipeline(userId, pipelineId)).status).toBe(200);
    expect((await handleCreatePipeline(userId, { name: "X" }, null)).status).toBe(403);
    expect((await handleUpdatePipeline(userId, pipelineId, { name: "X" }, null)).status).toBe(403);
    expect((await handleDeletePipeline(userId, pipelineId)).status).toBe(403);
    expect((await handleSetDefaultPipeline(userId, pipelineId)).status).toBe(403);
  });

  it("org_viewer can GET only — all mutations denied", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const pipelineId = await seedPipeline(organizationId);

    expect((await handleGetPipeline(userId, pipelineId)).status).toBe(200);
    expect((await handleCreatePipeline(userId, { name: "X" }, null)).status).toBe(403);
    expect((await handleUpdatePipeline(userId, pipelineId, { name: "X" }, null)).status).toBe(403);
    expect((await handleDeletePipeline(userId, pipelineId)).status).toBe(403);
    expect((await handleSetDefaultPipeline(userId, pipelineId)).status).toBe(403);
  });

  it("a pure agency actor (no org-scoped membership) gets 403 on every verb", async () => {
    const userId = await createPureAgencyActor();
    expect((await handleListPipelines(userId, listUrl())).status).toBe(403);
    expect((await handleCreatePipeline(userId, { name: "X" }, null)).status).toBe(403);
    expect((await handleGetPipeline(userId, randomUUID())).status).toBe(403);
    expect((await handleUpdatePipeline(userId, randomUUID(), { name: "X" }, null)).status).toBe(403);
    expect((await handleDeletePipeline(userId, randomUUID())).status).toBe(403);
    expect((await handleSetDefaultPipeline(userId, randomUUID())).status).toBe(403);
  });

  it("an authenticated user with no org membership at all gets 403", async () => {
    const userId = await createUnaffiliatedUser();
    expect((await handleListPipelines(userId, listUrl())).status).toBe(403);
  });
});

describe("pipelines API: tenancy", () => {
  it("cross-org GET/PATCH/DELETE/set-default all return 404, indistinguishable from a nonexistent id", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-pipelines");
    const orgB = await createOrgWithRole("org_admin", "org-b-pipelines");
    const pipelineB = await seedPipeline(orgB.organizationId);
    const nonexistentId = randomUUID();

    const crossGet = await handleGetPipeline(orgA.userId, pipelineB);
    const missingGet = await handleGetPipeline(orgA.userId, nonexistentId);
    expect(crossGet.status).toBe(404);
    expect(missingGet.status).toBe(404);
    const crossGetBody = await crossGet.json();
    const missingGetBody = await missingGet.json();
    expect(crossGetBody.error.code).toBe(missingGetBody.error.code);
    expect(crossGetBody.error.message).toBe(missingGetBody.error.message);
    expect(crossGetBody.error.request_id).not.toBe(missingGetBody.error.request_id);

    expect((await handleUpdatePipeline(orgA.userId, pipelineB, { name: "Pwned" }, null)).status).toBe(404);
    expect((await handleDeletePipeline(orgA.userId, pipelineB)).status).toBe(404);
    expect((await handleSetDefaultPipeline(orgA.userId, pipelineB)).status).toBe(404);
  });

  it("Milestone 2.5C: a malformed (non-UUID-shaped) :id returns the same structured 404 as cross-org/nonexistent, for GET/PATCH/DELETE/set-default", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-pipelines-malformed");
    const orgB = await createOrgWithRole("org_admin", "org-b-pipelines-malformed");
    const pipelineB = await seedPipeline(orgB.organizationId);
    const nonexistentId = randomUUID();
    const malformedId = "not-a-uuid";

    const malformedGet = await handleGetPipeline(orgA.userId, malformedId);
    const crossGet = await handleGetPipeline(orgA.userId, pipelineB);
    const missingGet = await handleGetPipeline(orgA.userId, nonexistentId);
    expect(malformedGet.status).toBe(404);
    const malformedBody = await malformedGet.json();
    const crossBody = await crossGet.json();
    const missingBody = await missingGet.json();
    expect(malformedBody.error.code).toBe(crossBody.error.code);
    expect(malformedBody.error.code).toBe(missingBody.error.code);
    expect(malformedBody.error.message).toBe(crossBody.error.message);
    expect(malformedBody.error.message).toBe(missingBody.error.message);
    expect(malformedBody.error.request_id.length).toBeGreaterThan(0);

    expect((await handleUpdatePipeline(orgA.userId, malformedId, { name: "Pwned" }, null)).status).toBe(404);
    expect((await handleDeletePipeline(orgA.userId, malformedId)).status).toBe(404);
    expect((await handleSetDefaultPipeline(orgA.userId, malformedId)).status).toBe(404);
  });

  it("Milestone 2.5C: a malformed :id still requires auth/RBAC first — unauthenticated -> 401, wrong permission -> 403", async () => {
    const malformedId = "not-a-uuid";
    expect((await handleGetPipeline(null, malformedId)).status).toBe(401);

    const { userId } = await createOrgWithRole("org_viewer", "malformed-perm-viewer-pipelines");
    expect((await handleUpdatePipeline(userId, malformedId, { name: "X" }, null)).status).toBe(403);
  });
});

describe("pipelines API: create/list/single/update/soft-delete", () => {
  it("create -> 201, get -> 200, update -> 200, delete -> 200 with deletedAt, then GET -> 404", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const created = await handleCreatePipeline(userId, { name: "Full Lifecycle Pipeline" }, null);
    expect(created.status).toBe(201);
    const { pipeline } = await created.json();
    expect(pipeline.name).toBe("Full Lifecycle Pipeline");
    expect(pipeline.isDefault).toBe(false);

    const got = await handleGetPipeline(userId, pipeline.id);
    expect(got.status).toBe(200);

    const updated = await handleUpdatePipeline(userId, pipeline.id, { name: "Renamed" }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).pipeline.name).toBe("Renamed");

    const deleted = await handleDeletePipeline(userId, pipeline.id);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).pipeline.deletedAt).not.toBeNull();

    expect((await handleGetPipeline(userId, pipeline.id)).status).toBe(404);
  });

  it("whitespace name -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreatePipeline(userId, { name: "   " }, null);
    expect(res.status).toBe(400);
  });

  it("creating as isDefault:true is accepted on POST", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreatePipeline(userId, { name: "Default From Create", isDefault: true }, null);
    expect(res.status).toBe(201);
    expect((await res.json()).pipeline.isDefault).toBe(true);
  });
});

describe("pipelines API: default-pipeline protection", () => {
  it("DELETE on the organization's active default pipeline is rejected with 409", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const created = await handleCreatePipeline(userId, { name: "The Default", isDefault: true }, null);
    const pipelineId = (await created.json()).pipeline.id;

    const deleted = await handleDeletePipeline(userId, pipelineId);
    expect(deleted.status).toBe(409);

    const stillThere = await handleGetPipeline(userId, pipelineId);
    expect(stillThere.status).toBe(200);
    expect((await stillThere.json()).pipeline.deletedAt).toBeNull();
  });

  it("DELETE succeeds once the default has been switched away via set-default", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const original = await handleCreatePipeline(userId, { name: "Original Default", isDefault: true }, null);
    const originalId = (await original.json()).pipeline.id;
    const replacement = await handleCreatePipeline(userId, { name: "Replacement" }, null);
    const replacementId = (await replacement.json()).pipeline.id;

    const switched = await handleSetDefaultPipeline(userId, replacementId);
    expect(switched.status).toBe(200);
    expect((await switched.json()).pipeline.isDefault).toBe(true);

    const deleted = await handleDeletePipeline(userId, originalId);
    expect(deleted.status).toBe(200);
  });

  it("PATCH cannot mutate isDefault — a body isDefault field is silently ignored, never reaching packages/crm", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const created = await handleCreatePipeline(userId, { name: "Default Pipeline", isDefault: true }, null);
    const pipelineId = (await created.json()).pipeline.id;

    const patched = await handleUpdatePipeline(userId, pipelineId, { name: "Still Default", isDefault: false }, null);
    expect(patched.status).toBe(200);
    expect((await patched.json()).pipeline.isDefault).toBe(true); // unchanged
  });

  it("set-default is a no-op (200, unchanged) when the target is already the default", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const created = await handleCreatePipeline(userId, { name: "Already Default", isDefault: true }, null);
    const pipelineId = (await created.json()).pipeline.id;

    const res = await handleSetDefaultPipeline(userId, pipelineId);
    expect(res.status).toBe(200);
    expect((await res.json()).pipeline.isDefault).toBe(true);
  });
});

describe("pipelines API: mass assignment", () => {
  it("body organizationId/organization_id/id/deletedAt/createdAt/updatedAt injection has no effect", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const forgedId = randomUUID();
    const res = await handleCreatePipeline(
      userId,
      {
        name: "Forged",
        organizationId: randomUUID(),
        organization_id: randomUUID(),
        id: forgedId,
        deletedAt: new Date().toISOString(),
        deleted_at: new Date().toISOString(),
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-01-01T00:00:00Z",
      },
      null,
    );
    expect(res.status).toBe(201);
    const { pipeline } = await res.json();
    expect(pipeline.organizationId).toBe(organizationId);
    expect(pipeline.id).not.toBe(forgedId);
    expect(pipeline.deletedAt).toBeNull();
  });

  it("unknown fields are silently ignored, not rejected", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreatePipeline(userId, { name: "Unknown Fields Pipeline", totallyMadeUpField: "x" }, null);
    expect(res.status).toBe(201);
  });
});

describe("pipelines API: idempotency", () => {
  it("POST replays the exact response for the same key + payload, callback runs only once", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    const first = await handleCreatePipeline(userId, { name: "Idem Pipeline" }, key);
    const second = await handleCreatePipeline(userId, { name: "Idem Pipeline" }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());

    const n = await rowCount(
      "select count(*)::int as n from public.pipelines where organization_id = $1 and name = 'Idem Pipeline'",
      [organizationId],
    );
    expect(n).toBe(1);
  });

  it("POST same key + different payload -> 409", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    await handleCreatePipeline(userId, { name: "Original" }, key);
    const conflict = await handleCreatePipeline(userId, { name: "Different" }, key);
    expect(conflict.status).toBe(409);
  });

  it("PATCH replays the exact response for the same key + payload", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId);
    const key = randomUUID();
    const first = await handleUpdatePipeline(userId, pipelineId, { name: "Renamed" }, key);
    const second = await handleUpdatePipeline(userId, pipelineId, { name: "Renamed" }, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });
});

