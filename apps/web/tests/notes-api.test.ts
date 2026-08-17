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
  seedNote,
} from "./crm-api-fixtures";
import { handleListNotes, handleCreateNote } from "../app/api/v1/notes/handlers";
import { handleGetNote, handleUpdateNote, handleDeleteNote } from "../app/api/v1/notes/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function listUrl(params: Record<string, string> = {}): URL {
  const url = new URL("http://localhost/api/v1/notes");
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

describe("notes API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleListNotes(null, listUrl())).status).toBe(401);
    expect((await handleCreateNote(null, {}, null)).status).toBe(401);
    expect((await handleGetNote(null, randomUUID())).status).toBe(401);
    expect((await handleUpdateNote(null, randomUUID(), {}, null)).status).toBe(401);
    expect((await handleDeleteNote(null, randomUUID())).status).toBe(401);
  });
});

describe("notes API: RBAC", () => {
  it("org_admin has full CRUD", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const created = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "x" }, null);
    expect(created.status).toBe(201);
    const { note } = await created.json();

    expect((await handleGetNote(userId, note.id)).status).toBe(200);
    expect((await handleUpdateNote(userId, note.id, { body: "y" }, null)).status).toBe(200);
    expect((await handleDeleteNote(userId, note.id)).status).toBe(200);
  });

  it("org_member can GET/POST/PATCH but not DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const dealId = await makeDeal(organizationId);
    const created = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "x" }, null);
    expect(created.status).toBe(201);
    const { note } = await created.json();

    expect((await handleGetNote(userId, note.id)).status).toBe(200);
    expect((await handleUpdateNote(userId, note.id, { body: "y" }, null)).status).toBe(200);
    expect((await handleDeleteNote(userId, note.id)).status).toBe(403);
  });

  it("org_viewer can GET but not POST/PATCH/DELETE", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const dealId = await makeDeal(organizationId);
    const noteId = await seedNote(organizationId, "deal", dealId);

    expect((await handleGetNote(userId, noteId)).status).toBe(200);
    expect((await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "x" }, null)).status).toBe(403);
    expect((await handleUpdateNote(userId, noteId, { body: "y" }, null)).status).toBe(403);
    expect((await handleDeleteNote(userId, noteId)).status).toBe(403);
  });

  it("a pure agency actor (no org-scoped membership) gets 403 on every verb", async () => {
    const userId = await createPureAgencyActor();
    expect((await handleListNotes(userId, listUrl())).status).toBe(403);
    expect((await handleCreateNote(userId, {}, null)).status).toBe(403);
    expect((await handleGetNote(userId, randomUUID())).status).toBe(403);
    expect((await handleUpdateNote(userId, randomUUID(), {}, null)).status).toBe(403);
    expect((await handleDeleteNote(userId, randomUUID())).status).toBe(403);
  });

  it("an authenticated user with no org membership at all gets 403", async () => {
    const userId = await createUnaffiliatedUser();
    expect((await handleListNotes(userId, listUrl())).status).toBe(403);
  });
});

describe("notes API: tenancy / IDOR", () => {
  it("cross-org GET/PATCH/DELETE all return 404, indistinguishable from a nonexistent id", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-notes");
    const orgB = await createOrgWithRole("org_admin", "org-b-notes");
    const dealB = await makeDeal(orgB.organizationId);
    const noteB = await seedNote(orgB.organizationId, "deal", dealB);
    const nonexistentId = randomUUID();

    const crossGet = await handleGetNote(orgA.userId, noteB);
    const missingGet = await handleGetNote(orgA.userId, nonexistentId);
    expect(crossGet.status).toBe(404);
    expect(missingGet.status).toBe(404);
    expect(await crossGet.json()).toEqual(await missingGet.json());

    expect((await handleUpdateNote(orgA.userId, noteB, { body: "x" }, null)).status).toBe(404);
    expect((await handleDeleteNote(orgA.userId, noteB)).status).toBe(404);
  });

  it("collection list never leaks another organization's notes", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-notes-list");
    const orgB = await createOrgWithRole("org_admin", "org-b-notes-list");
    const dealA = await makeDeal(orgA.organizationId);
    const dealB = await makeDeal(orgB.organizationId);
    await seedNote(orgA.organizationId, "deal", dealA);
    await seedNote(orgB.organizationId, "deal", dealB);

    const page = await handleListNotes(orgA.userId, listUrl());
    const body = await page.json();
    expect(body.notes.every((n: { organizationId: string }) => n.organizationId === orgA.organizationId)).toBe(true);
  });
});

describe("notes API: relationship create attacks (cross-org target)", () => {
  it("Note Org A -> Company Org B -> 400, and never reveals whether the target exists", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-note-company");
    const orgB = await createOrgWithRole("org_admin", "org-b-note-company");
    const companyB = await seedCompany(orgB.organizationId);

    const res = await handleCreateNote(orgA.userId, { relatedToType: "company", relatedToId: companyB, body: "x" }, null);
    expect(res.status).toBe(400);
    const nonexistentRes = await handleCreateNote(
      orgA.userId,
      { relatedToType: "company", relatedToId: randomUUID(), body: "x" },
      null,
    );
    expect(nonexistentRes.status).toBe(400);
    expect(await res.json()).toEqual(await nonexistentRes.json());
  });

  it("Note Org A -> Contact Org B -> 400", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-note-contact");
    const orgB = await createOrgWithRole("org_admin", "org-b-note-contact");
    const contactB = await seedContact(orgB.organizationId);

    const res = await handleCreateNote(orgA.userId, { relatedToType: "contact", relatedToId: contactB, body: "x" }, null);
    expect(res.status).toBe(400);
  });

  it("Note Org A -> Deal Org B -> 400", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-note-deal");
    const orgB = await createOrgWithRole("org_admin", "org-b-note-deal");
    const dealB = await makeDeal(orgB.organizationId);

    const res = await handleCreateNote(orgA.userId, { relatedToType: "deal", relatedToId: dealB, body: "x" }, null);
    expect(res.status).toBe(400);
  });
});

describe("notes API: create/list/single/update/soft-delete", () => {
  it("create -> 201, get -> 200, update -> 200, delete -> 200 with deletedAt, then GET -> 404", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const created = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "original" }, null);
    expect(created.status).toBe(201);
    const { note } = await created.json();
    expect(note.relatedToId).toBe(dealId);
    expect(note.body).toBe("original");

    expect((await handleGetNote(userId, note.id)).status).toBe(200);

    const updated = await handleUpdateNote(userId, note.id, { body: "revised" }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).note.body).toBe("revised");

    const deleted = await handleDeleteNote(userId, note.id);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).note.deletedAt).not.toBeNull();

    expect((await handleGetNote(userId, note.id)).status).toBe(404);
  });

  it("missing relatedToType/relatedToId/body -> 400", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleCreateNote(userId, {}, null)).status).toBe(400);
  });

  it("whitespace-only body -> 400", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const res = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "   " }, null);
    expect(res.status).toBe(400);
  });

  it("PATCH with a whitespace-only body -> 400", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const noteId = await seedNote(organizationId, "deal", dealId);
    const res = await handleUpdateNote(userId, noteId, { body: "   " }, null);
    expect(res.status).toBe(400);
  });
});

describe("notes API: filters and pagination", () => {
  it("paginates with nextCursor and filters by relatedToType/relatedToId", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const company = await seedCompany(organizationId);

    for (let i = 0; i < 3; i++) {
      await seedNote(organizationId, "deal", dealId);
      await new Promise((r) => setTimeout(r, 5));
    }
    const companyNote = await seedNote(organizationId, "company", company);

    const page1 = await handleListNotes(userId, listUrl({ limit: "2" }));
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.notes).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const byRelated = await handleListNotes(userId, listUrl({ relatedToType: "company", relatedToId: company }));
    expect((await byRelated.json()).notes.map((n: { id: string }) => n.id)).toEqual([companyNote]);
  });

  it("rejects malformed cursor, invalid limit, invalid relatedToType, malformed relatedToId UUID", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleListNotes(userId, listUrl({ cursor: "not-valid-base64!!" }))).status).toBe(400);
    expect((await handleListNotes(userId, listUrl({ limit: "0" }))).status).toBe(400);
    expect((await handleListNotes(userId, listUrl({ relatedToType: "bogus" }))).status).toBe(400);
    expect((await handleListNotes(userId, listUrl({ relatedToId: "not-a-uuid" }))).status).toBe(400);
  });
});

describe("notes API: malformed UUID hardening", () => {
  it("a malformed :id on GET/PATCH/DELETE returns 404, never a raw database error / 500", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    expect((await handleGetNote(userId, "not-a-uuid")).status).toBe(404);
    expect((await handleUpdateNote(userId, "not-a-uuid", { body: "x" }, null)).status).toBe(404);
    expect((await handleDeleteNote(userId, "not-a-uuid")).status).toBe(404);
  });

  it("a malformed relatedToId in the POST body returns 400, never a raw database error / 500", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: "not-a-uuid", body: "x" }, null);
    expect(res.status).toBe(400);
  });
});

describe("notes API: historical soft-delete relationship preservation", () => {
  it("an unrelated edit succeeds after the linked company is soft-deleted", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const company = await seedCompany(organizationId);
    const noteId = await seedNote(organizationId, "company", company);

    await adminPool.query("update public.companies set deleted_at = now() where id = $1", [company]);

    const updated = await handleUpdateNote(userId, noteId, { body: "still editable" }, null);
    expect(updated.status).toBe(200);
    expect((await updated.json()).note.relatedToId).toBe(company);
  });
});

describe("notes API: GDPR historical read", () => {
  it("GET correctly serializes a row produced by contact erasure (relatedToId/body null, relatedToType still 'contact')", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);
    const noteId = await seedNote(organizationId, "contact", contact, { body: "Will be erased" });

    await adminPool.query("update public.notes set related_to_id = null, body = null where id = $1", [noteId]);

    const res = await handleGetNote(userId, noteId);
    expect(res.status).toBe(200);
    const { note } = await res.json();
    expect(note.relatedToType).toBe("contact");
    expect(note.relatedToId).toBeNull();
    expect(note.body).toBeNull();
  });

  it("list correctly serializes the same GDPR-erased historical row without 500ing", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);
    const noteId = await seedNote(organizationId, "contact", contact);
    await adminPool.query("update public.notes set related_to_id = null, body = null where id = $1", [noteId]);

    const res = await handleListNotes(userId, listUrl());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes.some((n: { id: string }) => n.id === noteId)).toBe(true);
  });
});

describe("notes API: mass assignment", () => {
  it("body organizationId/organization_id/id/createdBy/created_by/deletedAt/createdAt/updatedAt injection has no effect", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const forgedId = randomUUID();
    const forgedCreatedBy = randomUUID();
    const res = await handleCreateNote(
      userId,
      {
        relatedToType: "deal",
        relatedToId: dealId,
        body: "x",
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
    const { note } = await res.json();
    expect(note.organizationId).toBe(organizationId);
    expect(note.id).not.toBe(forgedId);
    expect(note.createdBy).toBe(userId);
    expect(note.createdBy).not.toBe(forgedCreatedBy);
    expect(note.deletedAt).toBeNull();
  });

  it("PATCH cannot reassign relatedToType or relatedToId", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const company = await seedCompany(organizationId);
    const created = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "x" }, null);
    const noteId = (await created.json()).note.id;

    const updated = await handleUpdateNote(
      userId,
      noteId,
      { body: "touched", relatedToType: "company", relatedToId: company },
      null,
    );
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.note.body).toBe("touched");
    expect(body.note.relatedToType).toBe("deal");
    expect(body.note.relatedToId).toBe(dealId);
  });

  it("unknown fields are silently ignored, not rejected", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const res = await handleCreateNote(
      userId,
      { relatedToType: "deal", relatedToId: dealId, body: "x", totallyMadeUpField: "x" },
      null,
    );
    expect(res.status).toBe(201);
  });
});

describe("notes API: idempotency", () => {
  it("POST replays the exact response for the same key + payload, callback runs only once", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const key = randomUUID();
    const first = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "x" }, key);
    const second = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "x" }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());

    const n = await adminPool
      .query("select count(*)::int as n from public.notes where organization_id = $1", [organizationId])
      .then((r) => r.rows[0].n);
    expect(n).toBe(1);
  });

  it("POST same key + different payload -> 409", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const key = randomUUID();
    await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "x" }, key);
    const conflict = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "y" }, key);
    expect(conflict.status).toBe(409);
  });

  it("PATCH replays the exact response for the same key + payload", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const noteId = await seedNote(organizationId, "deal", dealId);
    const key = randomUUID();
    const first = await handleUpdateNote(userId, noteId, { body: "x" }, key);
    const second = await handleUpdateNote(userId, noteId, { body: "x" }, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });

  it("no Idempotency-Key header -> normal operation", async () => {
    const { userId, organizationId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const res = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "x" }, null);
    expect(res.status).toBe(201);
  });

  it("idempotency replay still re-runs auth/RBAC first — a demoted actor does not get a replay", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const key = randomUUID();
    const first = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "x" }, key);
    expect(first.status).toBe(201);

    await setMembershipStatus(userId, organizationId, "removed");
    const replay = await handleCreateNote(userId, { relatedToType: "deal", relatedToId: dealId, body: "x" }, key);
    expect(replay.status).toBe(403);
  });
});
