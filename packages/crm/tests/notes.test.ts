import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, createOrgWithActiveMember } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import { createCompany, softDeleteCompany } from "../src/companies";
import { createContact, softDeleteContact } from "../src/contacts";
import { createPipeline } from "../src/pipelines";
import { createPipelineStage } from "../src/pipeline-stages";
import { createDeal, softDeleteDeal } from "../src/deals";
import { createNote, getNoteById, listNotes, updateNote, softDeleteNote } from "../src/notes";
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
 * for a directly-related Note — never via the domain layer. */
async function simulateGdprErasure(noteId: string): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query("update public.notes set related_to_id = null, body = null where id = $1", [noteId]);
  });
}

describe("createNote", () => {
  it("creates a note and persists organization_id from ctx", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const note = await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "First contact went well" });
    expect(note.organizationId).toBe(ctx.organizationId);
    expect(note.relatedToType).toBe("deal");
    expect(note.relatedToId).toBe(deal.id);
    expect(note.body).toBe("First contact went well");
    expect(note.deletedAt).toBeNull();
  });

  it("sets createdBy from ctx.userId, never from input (mass-assignment guard)", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const attacker = randomUUID();
    const note = await createNote(
      ctx,
      { relatedToType: "deal", relatedToId: deal.id, body: "x", createdBy: attacker } as never,
    );
    expect(note.createdBy).toBe(ctx.userId);
    expect(note.createdBy).not.toBe(attacker);
  });

  it("sets organizationId from ctx, never from input (mass-assignment guard)", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const otherOrg = randomUUID();
    const note = await createNote(
      ctx,
      { relatedToType: "deal", relatedToId: deal.id, body: "x", organizationId: otherOrg } as never,
    );
    expect(note.organizationId).toBe(ctx.organizationId);
    expect(note.organizationId).not.toBe(otherOrg);
  });

  describe("relatedToType allowlist", () => {
    it("rejects an unrecognized relatedToType", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      await expect(
        createNote(ctx, { relatedToType: "campaign" as never, relatedToId: deal.id, body: "x" }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("relatedToId is required despite DB nullability", () => {
    it("rejects a missing relatedToId", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(createNote(ctx, { relatedToType: "deal", body: "x" } as never)).rejects.toThrow(ValidationError);
    });

    it("rejects a null relatedToId", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(
        createNote(ctx, { relatedToType: "deal", relatedToId: null as never, body: "x" }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects an empty-string relatedToId", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(createNote(ctx, { relatedToType: "deal", relatedToId: "", body: "x" })).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe("body is required despite DB nullability", () => {
    it("rejects a missing body", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      await expect(createNote(ctx, { relatedToType: "deal", relatedToId: deal.id } as never)).rejects.toThrow(
        ValidationError,
      );
    });

    it("rejects a null body", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      await expect(
        createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: null as never }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a whitespace-only body", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      await expect(
        createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "   \n\t  " }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("company relationship validation", () => {
    it("accepts a valid active company in the same organization", async () => {
      const { ctx } = await makeCtxWithDeal();
      const company = await createCompany(ctx, { name: "Acme" });
      const note = await createNote(ctx, { relatedToType: "company", relatedToId: company.id, body: "x" });
      expect(note.relatedToId).toBe(company.id);
    });

    it("rejects a nonexistent company", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(
        createNote(ctx, { relatedToType: "company", relatedToId: randomUUID(), body: "x" }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });

    it("rejects a company belonging to a different organization (adversarial: Note Org A -> Company Org B)", async () => {
      const { ctx } = await makeCtxWithDeal();
      const orgB = await createOrgWithActiveMember();
      const companyInB = await createCompany(
        { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
        { name: "Org B Co" },
      );
      await expect(
        createNote(ctx, { relatedToType: "company", relatedToId: companyInB.id, body: "x" }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });

    it("rejects a soft-deleted company as a new target", async () => {
      const { ctx } = await makeCtxWithDeal();
      const company = await createCompany(ctx, { name: "Soon Deleted" });
      await softDeleteCompany(ctx, company.id);
      await expect(
        createNote(ctx, { relatedToType: "company", relatedToId: company.id, body: "x" }),
      ).rejects.toThrow(InvalidCompanyRelationshipError);
    });
  });

  describe("contact relationship validation", () => {
    it("accepts a valid active contact in the same organization", async () => {
      const { ctx } = await makeCtxWithDeal();
      const contact = await createContact(ctx, { firstName: "Ada" });
      const note = await createNote(ctx, { relatedToType: "contact", relatedToId: contact.id, body: "x" });
      expect(note.relatedToId).toBe(contact.id);
    });

    it("rejects a nonexistent contact", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(
        createNote(ctx, { relatedToType: "contact", relatedToId: randomUUID(), body: "x" }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });

    it("rejects a contact belonging to a different organization (adversarial: Note Org A -> Contact Org B)", async () => {
      const { ctx } = await makeCtxWithDeal();
      const orgB = await createOrgWithActiveMember();
      const contactInB = await createContact(
        { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
        { firstName: "Org B Contact" },
      );
      await expect(
        createNote(ctx, { relatedToType: "contact", relatedToId: contactInB.id, body: "x" }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });

    it("rejects a soft-deleted contact as a new target", async () => {
      const { ctx } = await makeCtxWithDeal();
      const contact = await createContact(ctx, { firstName: "Soon Deleted" });
      await softDeleteContact(ctx, contact.id);
      await expect(
        createNote(ctx, { relatedToType: "contact", relatedToId: contact.id, body: "x" }),
      ).rejects.toThrow(InvalidContactRelationshipError);
    });
  });

  describe("deal relationship validation", () => {
    it("accepts a valid active deal in the same organization", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      const note = await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "x" });
      expect(note.relatedToId).toBe(deal.id);
    });

    it("rejects a nonexistent deal", async () => {
      const { ctx } = await makeCtxWithDeal();
      await expect(
        createNote(ctx, { relatedToType: "deal", relatedToId: randomUUID(), body: "x" }),
      ).rejects.toThrow(InvalidDealRelationshipError);
    });

    it("rejects a deal belonging to a different organization (adversarial: Note Org A -> Deal Org B)", async () => {
      const { ctx } = await makeCtxWithDeal();
      const orgB = await makeCtxWithDeal();
      await expect(
        createNote(ctx, { relatedToType: "deal", relatedToId: orgB.deal.id, body: "x" }),
      ).rejects.toThrow(InvalidDealRelationshipError);
    });

    it("rejects a soft-deleted deal as a new target", async () => {
      const { ctx, deal } = await makeCtxWithDeal();
      await softDeleteDeal(ctx, deal.id);
      await expect(
        createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "x" }),
      ).rejects.toThrow(InvalidDealRelationshipError);
    });
  });
});

describe("getNoteById", () => {
  it("excludes soft-deleted notes", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const note = await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "x" });
    await softDeleteNote(ctx, note.id);
    expect(await getNoteById(ctx, note.id)).toBeNull();
  });

  it("returns null for nonexistent and cross-org", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const note = await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "x" });
    expect(await getNoteById(ctx, randomUUID())).toBeNull();
    const orgB = await createOrgWithActiveMember();
    expect(
      await getNoteById({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, note.id),
    ).toBeNull();
  });

  it("survives its related target being soft-deleted after creation", async () => {
    const { ctx } = await makeCtxWithDeal();
    const company = await createCompany(ctx, { name: "Target Then Deleted" });
    const note = await createNote(ctx, { relatedToType: "company", relatedToId: company.id, body: "x" });
    await softDeleteCompany(ctx, company.id);
    const fetched = await getNoteById(ctx, note.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.relatedToId).toBe(company.id);
  });

  describe("GDPR-erased historical state (Milestone 2.3A execute_contact_erasure)", () => {
    it("remains readable with relatedToId/body null and relatedToType still 'contact' — never rejected or repaired", async () => {
      const { ctx } = await makeCtxWithDeal();
      const contact = await createContact(ctx, { firstName: "Erasure Target" });
      const note = await createNote(ctx, {
        relatedToType: "contact",
        relatedToId: contact.id,
        body: "Prefers email over phone",
      });
      await simulateGdprErasure(note.id);

      const fetched = await getNoteById(ctx, note.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.relatedToType).toBe("contact");
      expect(fetched?.relatedToId).toBeNull();
      expect(fetched?.body).toBeNull();
      expect(fetched?.deletedAt).toBeNull();
    });

    it("is included in listNotes results, not silently filtered out", async () => {
      const { ctx } = await makeCtxWithDeal();
      const contact = await createContact(ctx, { firstName: "Erasure Target List" });
      const note = await createNote(ctx, { relatedToType: "contact", relatedToId: contact.id, body: "x" });
      await simulateGdprErasure(note.id);

      const page = await listNotes(ctx);
      expect(page.items.some((n) => n.id === note.id)).toBe(true);
    });
  });
});

describe("listNotes", () => {
  it("filters by relatedToType and relatedToId", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const company = await createCompany(ctx, { name: "Filter Co" });
    await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "x" });
    const companyNote = await createNote(ctx, { relatedToType: "company", relatedToId: company.id, body: "x" });

    const page = await listNotes(ctx, { relatedToType: "company", relatedToId: company.id });
    expect(page.items.map((n) => n.id)).toEqual([companyNote.id]);
  });

  it("excludes notes from other organizations", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "x" });
    const orgB = await createOrgWithActiveMember();
    const page = await listNotes({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey });
    expect(page.items).toEqual([]);
  });
});

describe("updateNote", () => {
  it("updates body", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const note = await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "original" });
    const updated = await updateNote(ctx, note.id, { body: "revised" });
    expect(updated?.body).toBe("revised");
  });

  it("cannot reassign relatedToType or relatedToId — UpdateNoteInput has no such fields, and a smuggled value is ignored", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const company = await createCompany(ctx, { name: "Attempted Reassign Target" });
    const note = await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "original" });

    const updated = await updateNote(
      ctx,
      note.id,
      { body: "touched", relatedToType: "company", relatedToId: company.id } as never,
    );
    expect(updated?.body).toBe("touched");
    expect(updated?.relatedToType).toBe("deal");
    expect(updated?.relatedToId).toBe(deal.id);
  });

  it("does not revalidate/reject an unrelated update when the target has since been soft-deleted", async () => {
    const { ctx } = await makeCtxWithDeal();
    const company = await createCompany(ctx, { name: "Soft-Deleted After Creation" });
    const note = await createNote(ctx, { relatedToType: "company", relatedToId: company.id, body: "original" });
    await softDeleteCompany(ctx, company.id);

    const updated = await updateNote(ctx, note.id, { body: "still editable" });
    expect(updated?.body).toBe("still editable");
    expect(updated?.relatedToId).toBe(company.id);
  });

  it("rejects a whitespace-only body update", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const note = await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "original" });
    await expect(updateNote(ctx, note.id, { body: "   " })).rejects.toThrow(ValidationError);
  });

  it("returns null for nonexistent/cross-org/already-deleted", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const note = await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "x" });
    expect(await updateNote(ctx, randomUUID(), { body: "y" })).toBeNull();

    const orgB = await createOrgWithActiveMember();
    expect(
      await updateNote({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, note.id, {
        body: "y",
      }),
    ).toBeNull();

    await softDeleteNote(ctx, note.id);
    expect(await updateNote(ctx, note.id, { body: "y" })).toBeNull();
  });
});

describe("softDeleteNote", () => {
  it("sets deleted_at and never physically deletes the row", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const note = await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "x" });
    const deleted = await softDeleteNote(ctx, note.id);
    expect(deleted?.deletedAt).not.toBeNull();

    const stillInDb = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.notes where id = $1", [note.id]);
      return r.rows;
    });
    expect(stillInDb).toHaveLength(1);
  });

  it("returns null for nonexistent/cross-org/already-deleted", async () => {
    const { ctx, deal } = await makeCtxWithDeal();
    const note = await createNote(ctx, { relatedToType: "deal", relatedToId: deal.id, body: "x" });
    expect(await softDeleteNote(ctx, randomUUID())).toBeNull();

    const orgB = await createOrgWithActiveMember();
    expect(
      await softDeleteNote({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, note.id),
    ).toBeNull();

    await softDeleteNote(ctx, note.id);
    expect(await softDeleteNote(ctx, note.id)).toBeNull();
  });
});
