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
import { handleListDeals, handleCreateDeal } from "../app/api/v1/deals/handlers";
import { handleGetDeal, handleUpdateDeal, handleDeleteDeal } from "../app/api/v1/deals/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function listUrl(params: Record<string, string> = {}): URL {
  const url = new URL("http://localhost/api/v1/deals");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

async function rowCount(sql: string, params: unknown[]): Promise<number> {
  const client = await adminPool.connect();
  try {
    const r = await client.query(sql, params);
    return r.rows[0].n;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await closePool();
});

describe("deals API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleListDeals(null, listUrl())).status).toBe(401);
    expect((await handleCreateDeal(null, {}, null)).status).toBe(401);
    expect((await handleGetDeal(null, randomUUID())).status).toBe(401);
    expect((await handleUpdateDeal(null, randomUUID(), {}, null)).status).toBe(401);
    expect((await handleDeleteDeal(null, randomUUID())).status).toBe(401);
  });
});

describe("deals API: RBAC", () => {
  it("org_admin has full CRUD", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const created = await handleCreateDeal(userId, { pipelineId, stageId }, null);
    expect(created.status).toBe(201);
    const { deal } = await created.json();

    expect((await handleGetDeal(userId, deal.id)).status).toBe(200);
    expect((await handleUpdateDeal(userId, deal.id, { amount: 500 }, null)).status).toBe(200);
    expect((await handleDeleteDeal(userId, deal.id)).status).toBe(200);
  });

  it("org_member can GET/POST/PATCH but not DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const created = await handleCreateDeal(userId, { pipelineId, stageId }, null);
    expect(created.status).toBe(201);
    const { deal } = await created.json();

    expect((await handleGetDeal(userId, deal.id)).status).toBe(200);
    expect((await handleUpdateDeal(userId, deal.id, { amount: 100 }, null)).status).toBe(200);
    expect((await handleDeleteDeal(userId, deal.id)).status).toBe(403);
  });

  it("org_viewer can GET but not POST/PATCH/DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const dealId = await seedDeal(organizationId, pipelineId, stageId);

    expect((await handleGetDeal(userId, dealId)).status).toBe(200);
    expect((await handleCreateDeal(userId, { pipelineId, stageId }, null)).status).toBe(403);
    expect((await handleUpdateDeal(userId, dealId, { amount: 1 }, null)).status).toBe(403);
    expect((await handleDeleteDeal(userId, dealId)).status).toBe(403);
  });

  it("a pure agency actor (no org-scoped membership) gets 403 on every verb", async () => {
    const userId = await createPureAgencyActor();
    expect((await handleListDeals(userId, listUrl())).status).toBe(403);
    expect((await handleCreateDeal(userId, {}, null)).status).toBe(403);
    expect((await handleGetDeal(userId, randomUUID())).status).toBe(403);
    expect((await handleUpdateDeal(userId, randomUUID(), {}, null)).status).toBe(403);
    expect((await handleDeleteDeal(userId, randomUUID())).status).toBe(403);
  });

  it("an authenticated user with no org membership at all gets 403", async () => {
    const userId = await createUnaffiliatedUser();
    expect((await handleListDeals(userId, listUrl())).status).toBe(403);
  });
});

describe("deals API: tenancy", () => {
  it("cross-org GET/PATCH/DELETE all return 404, indistinguishable from a nonexistent id", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-deals");
    const orgB = await createOrgWithRole("org_admin", "org-b-deals");
    const { pipelineId, stageId } = await seedPipelineWithStage(orgB.organizationId);
    const dealB = await seedDeal(orgB.organizationId, pipelineId, stageId);
    const nonexistentId = randomUUID();

    const crossGet = await handleGetDeal(orgA.userId, dealB);
    const missingGet = await handleGetDeal(orgA.userId, nonexistentId);
    expect(crossGet.status).toBe(404);
    expect(missingGet.status).toBe(404);
    expect(await crossGet.json()).toEqual(await missingGet.json());

    expect((await handleUpdateDeal(orgA.userId, dealB, { amount: 1 }, null)).status).toBe(404);
    expect((await handleDeleteDeal(orgA.userId, dealB)).status).toBe(404);
  });
});

describe("deals API: create/list/single/update/soft-delete", () => {
  it("create -> 201, get -> 200, update -> 200, delete -> 200 with deletedAt, then GET -> 404", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const created = await handleCreateDeal(userId, { pipelineId, stageId, amount: 250 }, null);
    expect(created.status).toBe(201);
    const { deal } = await created.json();
    expect(deal.pipelineId).toBe(pipelineId);
    expect(deal.stageId).toBe(stageId);
    expect(deal.status).toBe("open");
    expect(deal.currency).toBe("EUR");

    const got = await handleGetDeal(userId, deal.id);
    expect(got.status).toBe(200);

    const updated = await handleUpdateDeal(userId, deal.id, { amount: 999 }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).deal.amount).toBe("999");

    const deleted = await handleDeleteDeal(userId, deal.id);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).deal.deletedAt).not.toBeNull();

    expect((await handleGetDeal(userId, deal.id)).status).toBe(404);
  });

  it("missing pipelineId/stageId -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleCreateDeal(userId, {}, null)).status).toBe(400);
  });

  it("invalid currency -> 400", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const res = await handleCreateDeal(userId, { pipelineId, stageId, currency: "eur" }, null);
    expect(res.status).toBe(400);
  });
});

describe("deals API: filters and pagination", () => {
  it("paginates with nextCursor and filters by pipelineId/stageId/ownerId/companyId/status", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const otherPipelineId = await seedPipeline(organizationId, { name: "Other" });
    const otherStageId = await seedPipelineStage(organizationId, otherPipelineId, { name: "Other Stage" });
    const company = await seedCompany(organizationId);

    for (let i = 0; i < 3; i++) {
      await seedDeal(organizationId, pipelineId, stageId);
      await new Promise((r) => setTimeout(r, 5));
    }
    await seedDeal(organizationId, otherPipelineId, otherStageId);

    const page1 = await handleListDeals(userId, listUrl({ limit: "2" }));
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.deals).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const byPipeline = await handleListDeals(userId, listUrl({ pipelineId }));
    expect((await byPipeline.json()).deals).toHaveLength(3);

    const byStage = await handleListDeals(userId, listUrl({ stageId: otherStageId }));
    expect((await byStage.json()).deals).toHaveLength(1);

    const owned = await handleCreateDeal(userId, { pipelineId, stageId, ownerId: userId, companyId: company }, null);
    expect(owned.status).toBe(201);
    const ownedId = (await owned.json()).deal.id;

    const byOwner = await handleListDeals(userId, listUrl({ ownerId: userId }));
    expect((await byOwner.json()).deals.map((d: { id: string }) => d.id)).toEqual([ownedId]);

    const byCompany = await handleListDeals(userId, listUrl({ companyId: company }));
    expect((await byCompany.json()).deals.map((d: { id: string }) => d.id)).toEqual([ownedId]);

    const byStatus = await handleListDeals(userId, listUrl({ status: "open" }));
    expect((await byStatus.json()).deals.length).toBeGreaterThan(0);
  });

  it("rejects malformed cursor, invalid limit, and invalid status filter", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleListDeals(userId, listUrl({ cursor: "not-valid-base64!!" }))).status).toBe(400);
    expect((await handleListDeals(userId, listUrl({ limit: "0" }))).status).toBe(400);
    expect((await handleListDeals(userId, listUrl({ limit: "101" }))).status).toBe(400);
    expect((await handleListDeals(userId, listUrl({ status: "bogus" }))).status).toBe(400);
  });
});

describe("deals API: relationship validation (owner/company/contact/pipeline/stage)", () => {
  it("invalid owner -> 400", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const res = await handleCreateDeal(userId, { pipelineId, stageId, ownerId: randomUUID() }, null);
    expect(res.status).toBe(400);
  });

  it("invalid company -> 400", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const res = await handleCreateDeal(userId, { pipelineId, stageId, companyId: randomUUID() }, null);
    expect(res.status).toBe(400);
  });

  it("invalid/cross-org contact -> 400", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const res = await handleCreateDeal(userId, { pipelineId, stageId, primaryContactId: randomUUID() }, null);
    expect(res.status).toBe(400);
  });

  it("invalid/cross-org pipeline -> 400", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { stageId } = await seedPipelineWithStage(organizationId);
    const res = await handleCreateDeal(userId, { pipelineId: randomUUID(), stageId }, null);
    expect(res.status).toBe(400);
  });

  it("wrong-pipeline stage -> 400", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId } = await seedPipelineWithStage(organizationId);
    const otherPipelineId = await seedPipeline(organizationId, { name: "Other" });
    const otherStageId = await seedPipelineStage(organizationId, otherPipelineId, { name: "Wrong Pipeline Stage" });
    const res = await handleCreateDeal(userId, { pipelineId, stageId: otherStageId }, null);
    expect(res.status).toBe(400);
  });
});

describe("deals API: status derivation and stage move", () => {
  it("status is derived from the target stage on create, never client-settable", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId, { isDefault: true });
    const wonStageId = await seedPipelineStage(organizationId, pipelineId, { name: "Won", isWonStage: true });
    const res = await handleCreateDeal(
      userId,
      { pipelineId, stageId: wonStageId, status: "open" }, // status injection attempt
      null,
    );
    expect(res.status).toBe(201);
    expect((await res.json()).deal.status).toBe("won");
  });

  it("moving to a different stage re-derives status", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const pipelineId = await seedPipeline(organizationId, { isDefault: true });
    const openStageId = await seedPipelineStage(organizationId, pipelineId, { name: "Open", sortOrder: 10 });
    const lostStageId = await seedPipelineStage(organizationId, pipelineId, {
      name: "Lost",
      sortOrder: 20,
      isLostStage: true,
    });
    const created = await handleCreateDeal(userId, { pipelineId, stageId: openStageId }, null);
    const dealId = (await created.json()).deal.id;

    const moved = await handleUpdateDeal(userId, dealId, { stageId: lostStageId }, null);
    expect(moved.status).toBe(200);
    expect((await moved.json()).deal.status).toBe("lost");
  });

  it("a client attempting to set status via PATCH has it silently ignored (status remains stage-derived)", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const created = await handleCreateDeal(userId, { pipelineId, stageId }, null);
    const dealId = (await created.json()).deal.id;

    const updated = await handleUpdateDeal(userId, dealId, { status: "won", amount: 10 }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).deal.status).toBe("open"); // unchanged — stageId wasn't touched
  });
});

describe("deals API: historical soft-delete relationship preservation", () => {
  it("an unrelated edit succeeds after the linked company is soft-deleted", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const company = await seedCompany(organizationId);
    const created = await handleCreateDeal(userId, { pipelineId, stageId, companyId: company }, null);
    const dealId = (await created.json()).deal.id;

    await adminPool.query("update public.companies set deleted_at = now() where id = $1", [company]);

    const updated = await handleUpdateDeal(userId, dealId, { amount: 42 }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).deal.companyId).toBe(company);
  });

  it("a NEW reassignment to a soft-deleted company FAILS", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const created = await handleCreateDeal(userId, { pipelineId, stageId }, null);
    const dealId = (await created.json()).deal.id;
    const company = await seedCompany(organizationId);
    await adminPool.query("update public.companies set deleted_at = now() where id = $1", [company]);

    const res = await handleUpdateDeal(userId, dealId, { companyId: company }, null);
    expect(res.status).toBe(400);
  });

  it("an unrelated edit succeeds after the linked contact is soft-deleted", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const contact = await seedContact(organizationId);
    const created = await handleCreateDeal(userId, { pipelineId, stageId, primaryContactId: contact }, null);
    const dealId = (await created.json()).deal.id;

    await adminPool.query("update public.contacts set deleted_at = now() where id = $1", [contact]);

    const updated = await handleUpdateDeal(userId, dealId, { amount: 17 }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).deal.primaryContactId).toBe(contact);
  });
});

describe("deals API: mass assignment", () => {
  it("body organizationId/organization_id/id/status/deletedAt/createdAt/updatedAt injection has no effect", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const forgedId = randomUUID();
    const res = await handleCreateDeal(
      userId,
      {
        pipelineId,
        stageId,
        organizationId: randomUUID(),
        organization_id: randomUUID(),
        id: forgedId,
        status: "won",
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
    const { deal } = await res.json();
    expect(deal.organizationId).toBe(organizationId);
    expect(deal.id).not.toBe(forgedId);
    expect(deal.status).toBe("open");
    expect(deal.deletedAt).toBeNull();
  });

  it("unknown fields are silently ignored, not rejected", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const res = await handleCreateDeal(userId, { pipelineId, stageId, totallyMadeUpField: "x" }, null);
    expect(res.status).toBe(201);
  });
});

describe("deals API: idempotency", () => {
  it("POST replays the exact response for the same key + payload, callback runs only once", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const key = randomUUID();
    const first = await handleCreateDeal(userId, { pipelineId, stageId, amount: 1 }, key);
    const second = await handleCreateDeal(userId, { pipelineId, stageId, amount: 1 }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());

    const n = await rowCount(
      "select count(*)::int as n from public.deals where organization_id = $1 and pipeline_id = $2",
      [organizationId, pipelineId],
    );
    expect(n).toBe(1);
  });

  it("POST same key + different payload -> 409", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const key = randomUUID();
    await handleCreateDeal(userId, { pipelineId, stageId, amount: 1 }, key);
    const conflict = await handleCreateDeal(userId, { pipelineId, stageId, amount: 2 }, key);
    expect(conflict.status).toBe(409);
  });

  it("PATCH replays the exact response for the same key + payload", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const dealId = await seedDeal(organizationId, pipelineId, stageId);
    const key = randomUUID();
    const first = await handleUpdateDeal(userId, dealId, { amount: 55 }, key);
    const second = await handleUpdateDeal(userId, dealId, { amount: 55 }, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });

  it("no Idempotency-Key header -> normal operation", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const res = await handleCreateDeal(userId, { pipelineId, stageId }, null);
    expect(res.status).toBe(201);
  });

  it("idempotency replay still re-runs auth/RBAC first — a demoted actor does not get a replay", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
    const key = randomUUID();
    const first = await handleCreateDeal(userId, { pipelineId, stageId }, key);
    expect(first.status).toBe(201);

    await setMembershipStatus(userId, organizationId, "removed");
    const replay = await handleCreateDeal(userId, { pipelineId, stageId }, key);
    expect(replay.status).toBe(403); // rejected before idempotency is ever consulted
  });
});
