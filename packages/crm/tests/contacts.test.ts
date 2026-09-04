import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, createOrgWithActiveMember, setMembershipStatus } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import { createCompany, softDeleteCompany } from "../src/companies";
import {
  createContact,
  getContactById,
  getContactByIdIncludingDeleted,
  getContactByEmail,
  listContacts,
  updateContact,
  softDeleteContact,
} from "../src/contacts";
import { ValidationError, InvalidOwnerError, InvalidCompanyRelationshipError, DuplicateContactEmailError } from "../src/errors";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("createContact", () => {
  it("creates a contact and persists organization_id from ctx", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const contact = await createContact({ userId, organizationId, roleKey }, { firstName: "Ada" });
    expect(contact.organizationId).toBe(organizationId);
    expect(contact.firstName).toBe("Ada");
  });

  it("rejects when firstName/lastName/email are all missing (identity invariant)", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    await expect(createContact({ userId, organizationId, roleKey }, { phone: "555-1234" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects when firstName/lastName/email are all whitespace-only", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    await expect(
      createContact({ userId, organizationId, roleKey }, { firstName: "  ", lastName: "\t", email: "\n" }),
    ).rejects.toThrow(ValidationError);
  });

  it("accepts email alone as sufficient identity", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const contact = await createContact(
      { userId, organizationId, roleKey },
      { email: `ada-${randomUUID()}@example.test` },
    );
    expect(contact.email).toBeTruthy();
  });

  it("validates lifecycle_stage against the fixed enum", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    await expect(
      createContact({ userId, organizationId, roleKey }, { firstName: "Ada", lifecycleStage: "champion" }),
    ).rejects.toThrow(ValidationError);

    const contact = await createContact(
      { userId, organizationId, roleKey },
      { firstName: "Ada", lifecycleStage: "prospect" },
    );
    expect(contact.lifecycleStage).toBe("prospect");
  });

  it("allows a null company", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const contact = await createContact({ userId, organizationId, roleKey }, { firstName: "Ada" });
    expect(contact.companyId).toBeNull();
  });

  it("accepts a valid company in the same organization", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const company = await createCompany(ctx, { name: "Acme" });
    const contact = await createContact(ctx, { firstName: "Ada", companyId: company.id });
    expect(contact.companyId).toBe(company.id);
  });

  it("rejects a nonexistent company", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    await expect(
      createContact({ userId, organizationId, roleKey }, { firstName: "Ada", companyId: randomUUID() }),
    ).rejects.toThrow(InvalidCompanyRelationshipError);
  });

  it("rejects a company belonging to a different organization, indistinguishably from nonexistent", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const companyInB = await createCompany(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Co" },
    );

    let crossOrgError: unknown;
    try {
      await createContact(
        { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
        { firstName: "Ada", companyId: companyInB.id },
      );
    } catch (err) {
      crossOrgError = err;
    }
    let nonexistentError: unknown;
    try {
      await createContact(
        { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
        { firstName: "Ada", companyId: randomUUID() },
      );
    } catch (err) {
      nonexistentError = err;
    }

    expect(crossOrgError).toBeInstanceOf(InvalidCompanyRelationshipError);
    expect(nonexistentError).toBeInstanceOf(InvalidCompanyRelationshipError);
    expect((crossOrgError as Error).message).toBe((nonexistentError as Error).message);
  });

  it("rejects a soft-deleted company, indistinguishably from the other invalid cases", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const company = await createCompany(ctx, { name: "Doomed Co" });
    await softDeleteCompany(ctx, company.id);

    await expect(createContact(ctx, { firstName: "Ada", companyId: company.id })).rejects.toThrow(
      InvalidCompanyRelationshipError,
    );
  });

  it("preserves an existing contact's company_id when that company is later soft-deleted", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const company = await createCompany(ctx, { name: "Later Deleted Co" });
    const contact = await createContact(ctx, { firstName: "Ada", companyId: company.id });

    await softDeleteCompany(ctx, company.id);

    const stillLinked = await seedAsAdmin(async (client) => {
      const r = await client.query("select company_id from public.contacts where id = $1", [contact.id]);
      return r.rows[0];
    });
    expect(stillLinked.company_id).toBe(company.id);
  });

  it("accepts a valid, active-member owner and rejects an invalid one", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const contact = await createContact(ctx, { firstName: "Ada", ownerId: userId });
    expect(contact.ownerId).toBe(userId);

    await expect(createContact(ctx, { firstName: "Bob", ownerId: randomUUID() })).rejects.toThrow(
      InvalidOwnerError,
    );
  });

  it("rejects a duplicate active email within the same organization", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const email = `dup-${randomUUID()}@example.test`;
    await createContact(ctx, { firstName: "Ada", email });

    await expect(createContact(ctx, { firstName: "Ada Two", email })).rejects.toThrow(DuplicateContactEmailError);
  });

  it("rejects a duplicate email case-insensitively", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const localPart = randomUUID();
    await createContact(ctx, { firstName: "Ada", email: `Dup-${localPart}@Example.Test` });

    await expect(
      createContact(ctx, { firstName: "Ada Two", email: `dup-${localPart}@example.test` }),
    ).rejects.toThrow(DuplicateContactEmailError);
  });

  it("allows the same email again after the original contact is soft-deleted", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const email = `reuse-${randomUUID()}@example.test`;
    const original = await createContact(ctx, { firstName: "Ada", email });
    await softDeleteContact(ctx, original.id);

    const reused = await createContact(ctx, { firstName: "Ada New", email });
    expect(reused.email).toBe(email);
  });

  it("allows the same email in a DIFFERENT organization", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const email = `shared-${randomUUID()}@example.test`;
    await createContact({ userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey }, {
      firstName: "Ada",
      email,
    });
    const inB = await createContact(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { firstName: "Ada", email },
    );
    expect(inB.email).toBe(email);
  });
});

describe("getContactById", () => {
  it("returns the contact for its own organization", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const created = await createContact({ userId, organizationId, roleKey }, { firstName: "Ada" });
    const found = await getContactById({ userId, organizationId, roleKey }, created.id);
    expect(found?.id).toBe(created.id);
  });

  it("returns null identically for nonexistent and cross-org", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const contactInB = await createContact(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { firstName: "Ada" },
    );

    const crossOrg = await getContactById(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      contactInB.id,
    );
    const nonexistent = await getContactById(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      randomUUID(),
    );
    expect(crossOrg).toBeNull();
    expect(nonexistent).toBeNull();
  });

  it("excludes a soft-deleted contact", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createContact(ctx, { firstName: "Ada" });
    await softDeleteContact(ctx, created.id);
    expect(await getContactById(ctx, created.id)).toBeNull();
  });
});

describe("getContactByEmail (Milestone 3.2C -- Visitor Identification's canonical lookup)", () => {
  it("finds a contact by exact email", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const email = `ada-${randomUUID()}@example.test`;
    const created = await createContact(ctx, { email });
    const found = await getContactByEmail(ctx, email);
    expect(found?.id).toBe(created.id);
  });

  it("matches case-insensitively, mirroring contacts_org_active_email_idx's own lower(email) semantics", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const email = `Ada-${randomUUID()}@Example.Test`;
    const created = await createContact(ctx, { email });
    const found = await getContactByEmail(ctx, email.toUpperCase());
    expect(found?.id).toBe(created.id);
  });

  it("returns null for no matching email", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const found = await getContactByEmail({ userId, organizationId, roleKey }, `nobody-${randomUUID()}@example.test`);
    expect(found).toBeNull();
  });

  it("does not match a contact belonging to a different organization, even with the identical email", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const email = `shared-${randomUUID()}@example.test`;
    await createContact({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, { email });

    const found = await getContactByEmail(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      email,
    );
    expect(found).toBeNull();
  });

  it("excludes a soft-deleted contact -- matches getContactById's own exclusion exactly", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const email = `ada-${randomUUID()}@example.test`;
    const created = await createContact(ctx, { email });
    await softDeleteContact(ctx, created.id);
    expect(await getContactByEmail(ctx, email)).toBeNull();
  });
});

describe("getContactByIdIncludingDeleted", () => {
  it("returns a soft-deleted contact, unlike getContactById", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createContact(ctx, { firstName: "Deleted But Findable" });
    await softDeleteContact(ctx, created.id);

    const viaOrdinary = await getContactById(ctx, created.id);
    const viaIncludingDeleted = await getContactByIdIncludingDeleted(ctx, created.id);
    expect(viaOrdinary).toBeNull();
    expect(viaIncludingDeleted?.id).toBe(created.id);
    expect(viaIncludingDeleted?.firstName).toBe("Deleted But Findable");
    expect(viaIncludingDeleted?.deletedAt).not.toBeNull();
  });

  it("still returns an active contact normally", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createContact(ctx, { firstName: "Active" });
    const found = await getContactByIdIncludingDeleted(ctx, created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.deletedAt).toBeNull();
  });

  it("remains tenant-scoped — a cross-org id (even soft-deleted) is indistinguishable from nonexistent", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const ctxB = { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey };
    const contactInB = await createContact(ctxB, { firstName: "Org B Contact" });
    await softDeleteContact(ctxB, contactInB.id);

    const ctxA = { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey };
    const foundByA = await getContactByIdIncludingDeleted(ctxA, contactInB.id);
    const nonexistentByA = await getContactByIdIncludingDeleted(ctxA, randomUUID());
    expect(foundByA).toBeNull();
    expect(nonexistentByA).toBeNull();
  });
});

describe("listContacts", () => {
  it("paginates deterministically with no duplicates across pages", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    for (let i = 0; i < 5; i++) {
      await createContact(ctx, { firstName: `Contact ${i}` });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const page1 = await listContacts(ctx, { limit: 2 });
    const page2 = await listContacts(ctx, { limit: 2, cursor: page1.nextCursor! });
    const page3 = await listContacts(ctx, { limit: 2, cursor: page2.nextCursor! });

    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items, ...page3.items].map((c) => c.id);
    expect(new Set(allIds).size).toBe(5);
  });

  /**
   * M4.1 Phase 2 pagination-precision correction (Final Re-Acceptance
   * Audit BLOCKER). The cursor row itself (RowC, the sole item on page 1
   * at limit=1) collides at millisecond precision with RowB (the row
   * page 2 must correctly recover) — real Postgres `created_at` values
   * differ only in the microsecond digits node-postgres's default
   * `timestamptz` parser discards (`.200999` vs `.200111`, both `.200Z`
   * as a JS Date). This is the exact shape independently reproduced
   * against real Postgres before this fix (a 3-row case where the middle
   * row was silently dropped from page 2). Goes through the REAL
   * `listContacts` function end-to-end, not a raw-SQL replica.
   */
  it("a microsecond-only collision between the page-1 cursor row and page 2's own first row does not skip a row", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };

    const ids = await seedAsAdmin(async (client) => {
      // RowA: clearly the oldest, no collision.
      const rowA = await client.query<{ id: string }>(
        `insert into public.contacts (organization_id, first_name, email, created_at)
         values ($1, 'RowA', $2, '2026-01-01 12:00:00.100000+00') returning id`,
        [organizationId, `rowa-${randomUUID()}@example.test`],
      );
      // RowB and RowC collide at millisecond precision. RowC (newer) will
      // be page 1's sole item (limit=1) and therefore the cursor row;
      // RowB (older, but only by microseconds) must still be correctly
      // recovered on page 2 — the exact pairing that silently dropped a
      // row before this fix.
      const rowB = await client.query<{ id: string }>(
        `insert into public.contacts (organization_id, first_name, email, created_at)
         values ($1, 'RowB', $2, '2026-01-01 12:00:00.200111+00') returning id`,
        [organizationId, `rowb-${randomUUID()}@example.test`],
      );
      const rowC = await client.query<{ id: string }>(
        `insert into public.contacts (organization_id, first_name, email, created_at)
         values ($1, 'RowC', $2, '2026-01-01 12:00:00.200999+00') returning id`,
        [organizationId, `rowc-${randomUUID()}@example.test`],
      );
      return { a: rowA.rows[0]!.id, b: rowB.rows[0]!.id, c: rowC.rows[0]!.id };
    });

    const page1 = await listContacts(ctx, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.id).toBe(ids.c);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listContacts(ctx, { limit: 2, cursor: page1.nextCursor! });
    const page2Ids = page2.items.map((c) => c.id);
    // Before this fix: page2Ids was ['RowA'] only — RowB silently skipped.
    expect(page2Ids).toEqual([ids.b, ids.a]);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items].map((c) => c.id);
    expect(new Set(allIds)).toEqual(new Set([ids.a, ids.b, ids.c]));
    expect(allIds).toHaveLength(3);
  });

  it("filters by companyId", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const company = await createCompany(ctx, { name: "Filter Co" });
    const linked = await createContact(ctx, { firstName: "Linked", companyId: company.id });
    await createContact(ctx, { firstName: "Unlinked" });

    const result = await listContacts(ctx, { companyId: company.id });
    expect(result.items.map((c) => c.id)).toEqual([linked.id]);
  });

  it("filters by ownerId", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const owned = await createContact(ctx, { firstName: "Owned", ownerId: userId });
    await createContact(ctx, { firstName: "Unowned" });

    const result = await listContacts(ctx, { ownerId: userId });
    expect(result.items.map((c) => c.id)).toEqual([owned.id]);
  });

  it("filters by lifecycleStage", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const prospect = await createContact(ctx, { firstName: "P", lifecycleStage: "prospect" });
    await createContact(ctx, { firstName: "L", lifecycleStage: "lead" });

    const result = await listContacts(ctx, { lifecycleStage: "prospect" });
    expect(result.items.map((c) => c.id)).toEqual([prospect.id]);
  });

  it("excludes soft-deleted contacts", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const kept = await createContact(ctx, { firstName: "Kept" });
    const deleted = await createContact(ctx, { firstName: "Deleted" });
    await softDeleteContact(ctx, deleted.id);

    const result = await listContacts(ctx);
    const ids = result.items.map((c) => c.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(deleted.id);
  });
});

describe("updateContact", () => {
  it("updates provided fields only", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createContact(ctx, { firstName: "Ada", jobTitle: "Engineer" });

    const updated = await updateContact(ctx, created.id, { jobTitle: "Senior Engineer" });
    expect(updated?.jobTitle).toBe("Senior Engineer");
    expect(updated?.firstName).toBe("Ada");
  });

  it("validates the FINAL merged identity state, not just the patch", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    // Contact with ONLY email populated.
    const created = await createContact(ctx, { email: `only-email-${randomUUID()}@example.test` });

    // Attempting to null email (the only identity field) must be rejected,
    // since firstName/lastName are still empty — the FINAL state would
    // have none of the three populated.
    await expect(updateContact(ctx, created.id, { email: null })).rejects.toThrow(ValidationError);

    // Providing a firstName in the SAME update makes the final state valid.
    const updated = await updateContact(ctx, created.id, { email: null, firstName: "Ada" });
    expect(updated?.email).toBeNull();
    expect(updated?.firstName).toBe("Ada");
  });

  it("allows an update that doesn't touch identity fields at all", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createContact(ctx, { firstName: "Ada" });
    const updated = await updateContact(ctx, created.id, { phone: "555-0000" });
    expect(updated?.phone).toBe("555-0000");
    expect(updated?.firstName).toBe("Ada");
  });

  it("validates a newly-assigned company relationship", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createContact(ctx, { firstName: "Ada" });

    await expect(updateContact(ctx, created.id, { companyId: randomUUID() })).rejects.toThrow(
      InvalidCompanyRelationshipError,
    );

    const company = await createCompany(ctx, { name: "New Co" });
    const updated = await updateContact(ctx, created.id, { companyId: company.id });
    expect(updated?.companyId).toBe(company.id);
  });

  it("validates a newly-assigned owner", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createContact(ctx, { firstName: "Ada" });

    await expect(updateContact(ctx, created.id, { ownerId: randomUUID() })).rejects.toThrow(InvalidOwnerError);
    const updated = await updateContact(ctx, created.id, { ownerId: userId });
    expect(updated?.ownerId).toBe(userId);
  });

  it("rejects updating to a duplicate active email", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const email = `taken-${randomUUID()}@example.test`;
    await createContact(ctx, { firstName: "Ada", email });
    const other = await createContact(ctx, { firstName: "Bob" });

    await expect(updateContact(ctx, other.id, { email })).rejects.toThrow(DuplicateContactEmailError);
  });

  it("returns null for a cross-org update attempt", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const contactInB = await createContact(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { firstName: "Ada" },
    );

    const result = await updateContact(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      contactInB.id,
      { firstName: "Hacked" },
    );
    expect(result).toBeNull();
  });

  it("returns null for an already soft-deleted contact", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createContact(ctx, { firstName: "Ada" });
    await softDeleteContact(ctx, created.id);
    expect(await updateContact(ctx, created.id, { firstName: "Should Not Apply" })).toBeNull();
  });
});

describe("softDeleteContact", () => {
  it("sets deleted_at and excludes it from subsequent get/list", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createContact(ctx, { firstName: "Ada" });

    const deleted = await softDeleteContact(ctx, created.id);
    expect(deleted?.deletedAt).not.toBeNull();
    expect(await getContactById(ctx, created.id)).toBeNull();
  });

  it("cannot soft-delete another organization's contact", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const contactInB = await createContact(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { firstName: "Ada" },
    );

    const result = await softDeleteContact(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      contactInB.id,
    );
    expect(result).toBeNull();

    const stillThere = await seedAsAdmin(async (client) => {
      const r = await client.query("select deleted_at from public.contacts where id = $1", [contactInB.id]);
      return r.rows[0];
    });
    expect(stillThere.deleted_at).toBeNull();
  });
});

describe("owner validation shared with companies (cross-org, inactive, agency-only)", () => {
  it("rejects an owner belonging to a different organization", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    await expect(
      createContact(
        { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
        { firstName: "Ada", ownerId: orgB.userId },
      ),
    ).rejects.toThrow(InvalidOwnerError);
  });

  it("rejects an owner whose membership is removed", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    await setMembershipStatus(userId, organizationId, "removed");
    await expect(
      createContact({ userId, organizationId, roleKey }, { firstName: "Ada", ownerId: userId }),
    ).rejects.toThrow(InvalidOwnerError);
  });
});

/**
 * Milestone 4.1 Phase 2 — event emission (Detailed Design §E, Final Design
 * Challenge §C). Each of the three authoritative mutation paths emits
 * exactly the matching event, atomically with its own write.
 */
describe("Milestone 4.1 Phase 2: domain-event emission", () => {
  async function eventCount(organizationId: string, eventType: string, contactId: string): Promise<number> {
    return seedAsAdmin(async (client) => {
      const r = await client.query<{ count: string }>(
        "select count(*)::text as count from public.events where organization_id = $1 and event_type = $2 and payload->>'contact_id' = $3",
        [organizationId, eventType, contactId],
      );
      return Number(r.rows[0]!.count);
    });
  }

  it("createContact emits exactly one contact.created event", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const contact = await createContact({ userId, organizationId, roleKey }, { firstName: "Ada" });
    expect(await eventCount(organizationId, "contact.created", contact.id)).toBe(1);
  });

  it("updateContact emits exactly one contact.updated event on a genuine field change", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const contact = await createContact(ctx, { firstName: "Ada" });
    await updateContact(ctx, contact.id, { firstName: "Grace" });
    expect(await eventCount(organizationId, "contact.updated", contact.id)).toBe(1);
  });

  it("updateContact with no actual field changes (empty patch) does not emit a second event", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const contact = await createContact(ctx, { firstName: "Ada" });
    await updateContact(ctx, contact.id, {});
    expect(await eventCount(organizationId, "contact.updated", contact.id)).toBe(0);
  });

  it("softDeleteContact emits exactly one contact.deleted event, never contact.updated", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const contact = await createContact(ctx, { firstName: "Ada" });
    await softDeleteContact(ctx, contact.id);
    expect(await eventCount(organizationId, "contact.deleted", contact.id)).toBe(1);
    expect(await eventCount(organizationId, "contact.updated", contact.id)).toBe(0);
  });

  it("a failed softDeleteContact (nonexistent id) emits no event", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const fakeId = "00000000-0000-0000-0000-000000000000";
    await softDeleteContact({ userId, organizationId, roleKey }, fakeId);
    expect(await eventCount(organizationId, "contact.deleted", fakeId)).toBe(0);
  });
});
