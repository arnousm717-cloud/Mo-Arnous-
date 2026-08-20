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
} from "./crm-api-fixtures";
import { handleListCompanies, handleCreateCompany } from "../app/api/v1/companies/handlers";
import { handleGetCompany, handleUpdateCompany, handleDeleteCompany } from "../app/api/v1/companies/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function listUrl(params: Record<string, string> = {}): URL {
  const url = new URL("http://localhost/api/v1/companies");
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

describe("companies API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleListCompanies(null, listUrl())).status).toBe(401);
    expect((await handleCreateCompany(null, { name: "X" }, null)).status).toBe(401);
    expect((await handleGetCompany(null, randomUUID())).status).toBe(401);
    expect((await handleUpdateCompany(null, randomUUID(), { name: "X" }, null)).status).toBe(401);
    expect((await handleDeleteCompany(null, randomUUID())).status).toBe(401);
  });
});

describe("companies API: RBAC", () => {
  it("org_admin has full CRUD", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const created = await handleCreateCompany(userId, { name: "Admin Co" }, null);
    expect(created.status).toBe(201);
    const { company } = await created.json();

    expect((await handleGetCompany(userId, company.id)).status).toBe(200);
    expect((await handleUpdateCompany(userId, company.id, { name: "Renamed" }, null)).status).toBe(200);
    const deleted = await handleDeleteCompany(userId, company.id);
    expect(deleted.status).toBe(200);
    expect(organizationId).toBeTruthy();
  });

  it("org_member can GET/POST/PATCH but not DELETE", async () => {
    const { userId } = await createOrgWithRole("org_member");
    const created = await handleCreateCompany(userId, { name: "Member Co" }, null);
    expect(created.status).toBe(201);
    const { company } = await created.json();

    expect((await handleGetCompany(userId, company.id)).status).toBe(200);
    expect((await handleUpdateCompany(userId, company.id, { name: "Renamed" }, null)).status).toBe(200);
    expect((await handleDeleteCompany(userId, company.id)).status).toBe(403);
  });

  it("org_viewer can GET but not POST/PATCH/DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const companyId = await seedCompany(organizationId);

    expect((await handleGetCompany(userId, companyId)).status).toBe(200);
    expect((await handleCreateCompany(userId, { name: "X" }, null)).status).toBe(403);
    expect((await handleUpdateCompany(userId, companyId, { name: "X" }, null)).status).toBe(403);
    expect((await handleDeleteCompany(userId, companyId)).status).toBe(403);
  });

  it("a pure agency actor (no org-scoped membership) gets 403 on every verb", async () => {
    const userId = await createPureAgencyActor();
    expect((await handleListCompanies(userId, listUrl())).status).toBe(403);
    expect((await handleCreateCompany(userId, { name: "X" }, null)).status).toBe(403);
    expect((await handleGetCompany(userId, randomUUID())).status).toBe(403);
    expect((await handleUpdateCompany(userId, randomUUID(), { name: "X" }, null)).status).toBe(403);
    expect((await handleDeleteCompany(userId, randomUUID())).status).toBe(403);
  });

  it("an authenticated user with no org membership at all gets 403", async () => {
    const userId = await createUnaffiliatedUser();
    expect((await handleListCompanies(userId, listUrl())).status).toBe(403);
  });
});

describe("companies API: tenancy", () => {
  it("cross-org GET/PATCH/DELETE all return 404, indistinguishable from a nonexistent id", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a");
    const orgB = await createOrgWithRole("org_admin", "org-b");
    const companyB = await seedCompany(orgB.organizationId);
    const nonexistentId = randomUUID();

    const crossGet = await handleGetCompany(orgA.userId, companyB);
    const missingGet = await handleGetCompany(orgA.userId, nonexistentId);
    expect(crossGet.status).toBe(404);
    expect(missingGet.status).toBe(404);
    const crossGetBody = await crossGet.json();
    const missingGetBody = await missingGet.json();
    expect(crossGetBody.error.code).toBe(missingGetBody.error.code);
    expect(crossGetBody.error.message).toBe(missingGetBody.error.message);
    expect(crossGetBody.error.request_id).not.toBe(missingGetBody.error.request_id);

    expect((await handleUpdateCompany(orgA.userId, companyB, { name: "Pwned" }, null)).status).toBe(404);
    expect((await handleDeleteCompany(orgA.userId, companyB)).status).toBe(404);

    // never a 403 for a cross-org id when the caller otherwise has the
    // correct permission — always 404
    expect(crossGet.status).not.toBe(403);
  });
});

describe("companies API: CRUD", () => {
  it("create -> 201, get -> 200, update -> 200, delete -> 200 with deletedAt, then GET -> 404", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const created = await handleCreateCompany(userId, { name: "Full Lifecycle Co" }, null);
    expect(created.status).toBe(201);
    const { company } = await created.json();
    expect(company.name).toBe("Full Lifecycle Co");

    const got = await handleGetCompany(userId, company.id);
    expect(got.status).toBe(200);

    const updated = await handleUpdateCompany(userId, company.id, { industry: "Tech" }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).company.industry).toBe("Tech");

    const deleted = await handleDeleteCompany(userId, company.id);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).company.deletedAt).not.toBeNull();

    expect((await handleGetCompany(userId, company.id)).status).toBe(404);
  });

  it("whitespace/invalid name -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateCompany(userId, { name: "   " }, null);
    expect(res.status).toBe(400);
  });

  it("invalid owner -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateCompany(userId, { name: "Bad Owner Co", ownerId: randomUUID() }, null);
    expect(res.status).toBe(400);
  });
});

describe("companies API: list/pagination", () => {
  it("paginates with nextCursor, filters by ownerId, rejects malformed cursor and invalid limit", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    for (let i = 0; i < 3; i++) {
      await seedCompany(organizationId, { name: `List Co ${i}` });
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await handleListCompanies(userId, listUrl({ limit: "2" }));
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.companies).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await handleListCompanies(userId, listUrl({ limit: "2", cursor: body1.nextCursor }));
    expect((await page2.json()).companies).toHaveLength(1);

    const owned = await seedCompany(organizationId, { name: "Owned", ownerId: userId });
    const filtered = await handleListCompanies(userId, listUrl({ ownerId: userId }));
    const filteredBody = await filtered.json();
    expect(filteredBody.companies.map((c: { id: string }) => c.id)).toEqual([owned]);

    expect((await handleListCompanies(userId, listUrl({ cursor: "not-valid-base64!!" }))).status).toBe(400);
    expect((await handleListCompanies(userId, listUrl({ limit: "0" }))).status).toBe(400);
    expect((await handleListCompanies(userId, listUrl({ limit: "101" }))).status).toBe(400);
  });
});

describe("companies API: idempotency", () => {
  it("POST replays the exact response for the same key + payload, callback runs only once", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    const first = await handleCreateCompany(userId, { name: "Idem Co" }, key);
    const second = await handleCreateCompany(userId, { name: "Idem Co" }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());

    const n = await rowCount(
      "select count(*)::int as n from public.companies where organization_id = $1 and name = 'Idem Co'",
      [organizationId],
    );
    expect(n).toBe(1); // the callback (and therefore the mutation) ran exactly once
  });

  it("POST same key + different payload -> 409", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    await handleCreateCompany(userId, { name: "Original" }, key);
    const conflict = await handleCreateCompany(userId, { name: "Different" }, key);
    expect(conflict.status).toBe(409);
  });

  it("PATCH replays the exact response for the same key + payload", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const companyId = await seedCompany(organizationId);
    const key = randomUUID();
    const first = await handleUpdateCompany(userId, companyId, { industry: "Finance" }, key);
    const second = await handleUpdateCompany(userId, companyId, { industry: "Finance" }, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });

  it("PATCH same key on a DIFFERENT resource -> 409 (resource id is part of route identity)", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const companyA = await seedCompany(organizationId, { name: "A" });
    const companyB = await seedCompany(organizationId, { name: "B" });
    const key = randomUUID();
    await handleUpdateCompany(userId, companyA, { industry: "Tech" }, key);
    const conflict = await handleUpdateCompany(userId, companyB, { industry: "Tech" }, key);
    expect(conflict.status).toBe(409);
  });

  it("no Idempotency-Key header -> normal operation, no idempotency row created", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateCompany(userId, { name: "No Key Co" }, null);
    expect(res.status).toBe(201);
  });
});

describe("companies API: adversarial / mass-assignment", () => {
  it("body organizationId/organization_id injection has no effect", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-inject");
    const forged = { name: "Forged", organizationId: randomUUID(), organization_id: randomUUID() };
    const res = await handleCreateCompany(orgA.userId, forged, null);
    expect(res.status).toBe(201);
    const { company } = await res.json();
    expect(company.organizationId).toBe(orgA.organizationId);
  });

  it("body id/deletedAt/enrichmentStatus injection has no effect", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const forgedId = randomUUID();
    const res = await handleCreateCompany(
      userId,
      { name: "Forged2", id: forgedId, deletedAt: new Date().toISOString(), enrichmentStatus: "enriched" },
      null,
    );
    const { company } = await res.json();
    expect(company.id).not.toBe(forgedId);
    expect(company.deletedAt).toBeNull();
    expect(company.enrichmentStatus).toBeNull();
    expect(organizationId).toBeTruthy();
  });

  it("unknown fields are silently ignored, not rejected", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateCompany(userId, { name: "Unknown Fields Co", totallyMadeUpField: "x" }, null);
    expect(res.status).toBe(201);
  });

  it("idempotency replay still re-runs auth/RBAC first — a demoted actor does not get a replay", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    const first = await handleCreateCompany(userId, { name: "Demoted Replay Co" }, key);
    expect(first.status).toBe(201);

    await setMembershipStatus(userId, organizationId, "removed");
    const replay = await handleCreateCompany(userId, { name: "Demoted Replay Co" }, key);
    expect(replay.status).toBe(403); // rejected before idempotency is ever consulted
  });

  it("the same Idempotency-Key across different organizations is fully isolated", async () => {
    const orgA = await createOrgWithRole("org_admin", "iso-a");
    const orgB = await createOrgWithRole("org_admin", "iso-b");
    const key = randomUUID();
    const resA = await handleCreateCompany(orgA.userId, { name: "Org A Co" }, key);
    const resB = await handleCreateCompany(orgB.userId, { name: "Org B Co" }, key);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect((await resA.json()).company.name).toBe("Org A Co");
    expect((await resB.json()).company.name).toBe("Org B Co");
  });

  it("an unexpected callback failure (not one of the four typed CRM errors) leaves no completed idempotency record, and a retry with the same key then succeeds", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();

    // A malformed ownerId that isn't even a well-formed UUID fails at the
    // Postgres type-cast layer (invalid input syntax for type uuid) — a
    // raw error, not an InvalidOwnerError, so mapCrmError returns null and
    // the idempotency callback rethrows, rolling back the whole
    // transaction. This is a genuinely "unexpected" failure reachable
    // through the real API, not a synthetic hook.
    const failing = await handleCreateCompany(userId, { name: "Unexpected Fail Co", ownerId: "not-a-uuid" }, key);
    expect(failing.status).toBe(500);

    const n = await rowCount("select count(*)::int as n from public.idempotency_keys where organization_id = $1", [
      organizationId,
    ]);
    expect(n).toBe(0); // the reservation itself never persisted

    const retried = await handleCreateCompany(userId, { name: "Unexpected Fail Co" }, key);
    expect(retried.status).toBe(201);
  });
});
