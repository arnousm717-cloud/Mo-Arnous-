import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  adminPool,
  createOrgWithRole,
  createPureAgencyActor,
  createUnaffiliatedUser,
  setMembershipStatus,
  seedContact,
  seedCompany,
} from "./crm-api-fixtures";
import { handleListContacts, handleCreateContact } from "../app/api/v1/contacts/handlers";
import { handleGetContact, handleUpdateContact, handleDeleteContact } from "../app/api/v1/contacts/[id]/handlers";
import { handleDeleteCompany } from "../app/api/v1/companies/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function listUrl(params: Record<string, string> = {}): URL {
  const url = new URL("http://localhost/api/v1/contacts");
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

describe("contacts API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleListContacts(null, listUrl())).status).toBe(401);
    expect((await handleCreateContact(null, { firstName: "X" }, null)).status).toBe(401);
    expect((await handleGetContact(null, randomUUID())).status).toBe(401);
    expect((await handleUpdateContact(null, randomUUID(), { firstName: "X" }, null)).status).toBe(401);
    expect((await handleDeleteContact(null, randomUUID())).status).toBe(401);
  });
});

describe("contacts API: RBAC", () => {
  it("org_admin has full CRUD", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const created = await handleCreateContact(userId, { firstName: "Admin Contact" }, null);
    expect(created.status).toBe(201);
    const { contact } = await created.json();

    expect((await handleGetContact(userId, contact.id)).status).toBe(200);
    expect((await handleUpdateContact(userId, contact.id, { firstName: "Renamed" }, null)).status).toBe(200);
    expect((await handleDeleteContact(userId, contact.id)).status).toBe(200);
  });

  it("org_member can GET/POST/PATCH but not DELETE", async () => {
    const { userId } = await createOrgWithRole("org_member");
    const created = await handleCreateContact(userId, { firstName: "Member Contact" }, null);
    expect(created.status).toBe(201);
    const { contact } = await created.json();

    expect((await handleGetContact(userId, contact.id)).status).toBe(200);
    expect((await handleUpdateContact(userId, contact.id, { firstName: "Renamed" }, null)).status).toBe(200);
    expect((await handleDeleteContact(userId, contact.id)).status).toBe(403);
  });

  it("org_viewer can GET but not POST/PATCH/DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const contactId = await seedContact(organizationId);

    expect((await handleGetContact(userId, contactId)).status).toBe(200);
    expect((await handleCreateContact(userId, { firstName: "X" }, null)).status).toBe(403);
    expect((await handleUpdateContact(userId, contactId, { firstName: "X" }, null)).status).toBe(403);
    expect((await handleDeleteContact(userId, contactId)).status).toBe(403);
  });

  it("a pure agency actor gets 403 on every verb", async () => {
    const userId = await createPureAgencyActor();
    expect((await handleListContacts(userId, listUrl())).status).toBe(403);
    expect((await handleCreateContact(userId, { firstName: "X" }, null)).status).toBe(403);
    expect((await handleGetContact(userId, randomUUID())).status).toBe(403);
    expect((await handleUpdateContact(userId, randomUUID(), { firstName: "X" }, null)).status).toBe(403);
    expect((await handleDeleteContact(userId, randomUUID())).status).toBe(403);
  });

  it("an authenticated user with no org membership at all gets 403", async () => {
    const userId = await createUnaffiliatedUser();
    expect((await handleListContacts(userId, listUrl())).status).toBe(403);
  });
});

describe("contacts API: tenancy", () => {
  it("cross-org GET/PATCH/DELETE all return 404, indistinguishable from a nonexistent id", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a");
    const orgB = await createOrgWithRole("org_admin", "org-b");
    const contactB = await seedContact(orgB.organizationId);
    const nonexistentId = randomUUID();

    const crossGet = await handleGetContact(orgA.userId, contactB);
    const missingGet = await handleGetContact(orgA.userId, nonexistentId);
    expect(crossGet.status).toBe(404);
    expect(missingGet.status).toBe(404);
    expect(await crossGet.json()).toEqual(await missingGet.json());
    expect(crossGet.status).not.toBe(403);

    expect((await handleUpdateContact(orgA.userId, contactB, { firstName: "Pwned" }, null)).status).toBe(404);
    expect((await handleDeleteContact(orgA.userId, contactB)).status).toBe(404);
  });
});

describe("contacts API: CRUD", () => {
  it("create -> 201, get -> 200, update -> 200, delete -> 200 with deletedAt, then GET -> 404", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const created = await handleCreateContact(userId, { firstName: "Full Lifecycle" }, null);
    expect(created.status).toBe(201);
    const { contact } = await created.json();

    expect((await handleGetContact(userId, contact.id)).status).toBe(200);

    const updated = await handleUpdateContact(userId, contact.id, { jobTitle: "Engineer" }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).contact.jobTitle).toBe("Engineer");

    const deleted = await handleDeleteContact(userId, contact.id);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).contact.deletedAt).not.toBeNull();

    expect((await handleGetContact(userId, contact.id)).status).toBe(404);
  });

  it("identity invariant violation -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateContact(userId, { phone: "555-1234" }, null);
    expect(res.status).toBe(400);
  });

  it("duplicate active email -> 409, case-insensitive duplicate -> 409, reusable after soft-delete", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const email = `dup-${randomUUID()}@example.test`;
    const first = await handleCreateContact(userId, { firstName: "A", email }, null);
    expect(first.status).toBe(201);

    const dup = await handleCreateContact(userId, { firstName: "B", email }, null);
    expect(dup.status).toBe(409);

    const caseDup = await handleCreateContact(userId, { firstName: "C", email: email.toUpperCase() }, null);
    expect(caseDup.status).toBe(409);

    const { contact } = await first.json();
    await handleDeleteContact(userId, contact.id);
    const reused = await handleCreateContact(userId, { firstName: "D", email }, null);
    expect(reused.status).toBe(201);
  });

  it("invalid companyId -> 400; cross-org companyId -> same 400; soft-deleted companyId -> same 400", async () => {
    const orgA = await createOrgWithRole("org_admin", "co-a");
    const orgB = await createOrgWithRole("org_admin", "co-b");
    const companyB = await seedCompany(orgB.organizationId);
    const deletedCompanyId = await seedCompany(orgA.organizationId);
    await handleDeleteCompany(orgA.userId, deletedCompanyId);

    const invalid = await handleCreateContact(orgA.userId, { firstName: "X", companyId: randomUUID() }, null);
    const crossOrg = await handleCreateContact(orgA.userId, { firstName: "X", companyId: companyB }, null);
    const softDeleted = await handleCreateContact(
      orgA.userId,
      { firstName: "X", companyId: deletedCompanyId },
      null,
    );
    expect(invalid.status).toBe(400);
    expect(crossOrg.status).toBe(400);
    expect(softDeleted.status).toBe(400);
  });

  it("invalid lifecycleStage -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateContact(userId, { firstName: "X", lifecycleStage: "champion" }, null);
    expect(res.status).toBe(400);
  });

  it("an existing contact remains readable when its linked company is later soft-deleted", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const companyId = await seedCompany(organizationId);
    const created = await handleCreateContact(userId, { firstName: "Linked", companyId }, null);
    const { contact } = await created.json();

    await handleDeleteCompany(userId, companyId);

    const stillReadable = await handleGetContact(userId, contact.id);
    expect(stillReadable.status).toBe(200);
    expect((await stillReadable.json()).contact.companyId).toBe(companyId);
  });
});

describe("contacts API: list/pagination/filters", () => {
  it("paginates, filters by companyId/ownerId/lifecycleStage, rejects malformed cursor/invalid limit", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    for (let i = 0; i < 3; i++) {
      await seedContact(organizationId, { firstName: `List ${i}` });
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await handleListContacts(userId, listUrl({ limit: "2" }));
    const body1 = await page1.json();
    expect(body1.contacts).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await handleListContacts(userId, listUrl({ limit: "2", cursor: body1.nextCursor }));
    expect((await page2.json()).contacts).toHaveLength(1);

    const companyId = await seedCompany(organizationId);
    const linked = await seedContact(organizationId, { companyId });
    const byCompany = await handleListContacts(userId, listUrl({ companyId }));
    expect((await byCompany.json()).contacts.map((c: { id: string }) => c.id)).toEqual([linked]);

    const ownedRes = await handleCreateContact(userId, { firstName: "Owned", ownerId: userId }, null);
    const owned = (await ownedRes.json()).contact.id;
    const byOwner = await handleListContacts(userId, listUrl({ ownerId: userId }));
    expect((await byOwner.json()).contacts.map((c: { id: string }) => c.id)).toEqual([owned]);

    const prospectRes = await handleCreateContact(
      userId,
      { firstName: "Prospect", lifecycleStage: "prospect" },
      null,
    );
    const prospect = (await prospectRes.json()).contact.id;
    const byStage = await handleListContacts(userId, listUrl({ lifecycleStage: "prospect" }));
    expect((await byStage.json()).contacts.map((c: { id: string }) => c.id)).toEqual([prospect]);

    expect((await handleListContacts(userId, listUrl({ cursor: "not-valid!!" }))).status).toBe(400);
    expect((await handleListContacts(userId, listUrl({ limit: "0" }))).status).toBe(400);
  });
});

describe("contacts API: idempotency", () => {
  it("POST replays the exact response for the same key + payload, callback runs only once", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    const first = await handleCreateContact(userId, { firstName: "Idem" }, key);
    const second = await handleCreateContact(userId, { firstName: "Idem" }, key);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());

    const n = await rowCount(
      "select count(*)::int as n from public.contacts where organization_id = $1 and first_name = 'Idem'",
      [organizationId],
    );
    expect(n).toBe(1);
  });

  it("PATCH replays the exact response for the same key + payload", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const contactId = await seedContact(organizationId);
    const key = randomUUID();
    const first = await handleUpdateContact(userId, contactId, { jobTitle: "CEO" }, key);
    const second = await handleUpdateContact(userId, contactId, { jobTitle: "CEO" }, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });
});

describe("contacts API: adversarial / mass-assignment", () => {
  it("body organizationId injection has no effect", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateContact(
      userId,
      { firstName: "Forged", organizationId: randomUUID(), organization_id: randomUUID() },
      null,
    );
    expect(res.status).toBe(201);
    const { contact } = await res.json();
    expect(contact.organizationId).toBe(organizationId);
  });

  it("unknown fields are silently ignored", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateContact(userId, { firstName: "Unknown", notARealField: true }, null);
    expect(res.status).toBe(201);
  });

  it("idempotency replay still re-runs auth/RBAC first — a demoted actor does not get a replay", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    const first = await handleCreateContact(userId, { firstName: "Demoted" }, key);
    expect(first.status).toBe(201);

    await setMembershipStatus(userId, organizationId, "removed");
    const replay = await handleCreateContact(userId, { firstName: "Demoted" }, key);
    expect(replay.status).toBe(403);
  });

  it("the same Idempotency-Key across different organizations is fully isolated", async () => {
    const orgA = await createOrgWithRole("org_admin", "iso-a");
    const orgB = await createOrgWithRole("org_admin", "iso-b");
    const key = randomUUID();
    const resA = await handleCreateContact(orgA.userId, { firstName: "Org A" }, key);
    const resB = await handleCreateContact(orgB.userId, { firstName: "Org B" }, key);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect((await resA.json()).contact.firstName).toBe("Org A");
    expect((await resB.json()).contact.firstName).toBe("Org B");
  });

  it("an unexpected callback failure leaves no completed idempotency record, and a retry with the same key then succeeds", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();

    const failing = await handleCreateContact(userId, { firstName: "X", ownerId: "not-a-uuid" }, key);
    expect(failing.status).toBe(500);

    const n = await rowCount("select count(*)::int as n from public.idempotency_keys where organization_id = $1", [
      organizationId,
    ]);
    expect(n).toBe(0);

    const retried = await handleCreateContact(userId, { firstName: "X" }, key);
    expect(retried.status).toBe(201);
  });
});
