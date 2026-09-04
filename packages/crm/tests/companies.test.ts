import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, createOrgWithActiveMember, setMembershipStatus } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import {
  createCompany,
  getCompanyById,
  getCompanyByIdIncludingDeleted,
  listCompanies,
  updateCompany,
  softDeleteCompany,
} from "../src/companies";
import { ValidationError, InvalidOwnerError } from "../src/errors";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("createCompany", () => {
  it("creates a company and persists organization_id from ctx, never from input", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const company = await createCompany({ userId, organizationId, roleKey }, { name: "Acme Corp" });

    expect(company.name).toBe("Acme Corp");
    expect(company.organizationId).toBe(organizationId);
    expect(company.id).toBeTruthy();
    expect(company.deletedAt).toBeNull();
  });

  it("ignores any organizationId a caller tries to smuggle into the input object", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const otherOrgId = randomUUID();
    // CreateCompanyInput has no organizationId field at all — this proves
    // it structurally, not just by convention: even a raw object literal
    // with an extra property has no effect on the persisted row.
    const input = { name: "Spoof Attempt", organizationId: otherOrgId } as unknown as { name: string };
    const company = await createCompany({ userId, organizationId, roleKey }, input);
    expect(company.organizationId).toBe(organizationId);
    expect(company.organizationId).not.toBe(otherOrgId);
  });

  it("rejects a whitespace-only name", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    await expect(createCompany({ userId, organizationId, roleKey }, { name: "   " })).rejects.toThrow(
      ValidationError,
    );
    await expect(createCompany({ userId, organizationId, roleKey }, { name: "\t\n" })).rejects.toThrow(
      ValidationError,
    );
    await expect(createCompany({ userId, organizationId, roleKey }, { name: "" })).rejects.toThrow(ValidationError);
  });

  it("trims the name before persistence", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const company = await createCompany({ userId, organizationId, roleKey }, { name: "  Acme Corp  " });
    expect(company.name).toBe("Acme Corp");
  });

  it("allows a null owner", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const company = await createCompany({ userId, organizationId, roleKey }, { name: "No Owner Co" });
    expect(company.ownerId).toBeNull();
  });

  it("accepts a valid, active-member owner", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const company = await createCompany(
      { userId, organizationId, roleKey },
      { name: "Owned Co", ownerId: userId },
    );
    expect(company.ownerId).toBe(userId);
  });

  it("rejects a nonexistent owner", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    await expect(
      createCompany({ userId, organizationId, roleKey }, { name: "Bad Owner Co", ownerId: randomUUID() }),
    ).rejects.toThrow(InvalidOwnerError);
  });

  it("rejects an owner who is a member of a DIFFERENT organization", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    await expect(
      createCompany(
        { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
        { name: "Cross Org Owner Co", ownerId: orgB.userId },
      ),
    ).rejects.toThrow(InvalidOwnerError);
  });

  it("rejects an owner whose membership is 'removed' (not active)", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    await setMembershipStatus(userId, organizationId, "removed");
    await expect(
      createCompany({ userId, organizationId, roleKey }, { name: "Removed Owner Co", ownerId: userId }),
    ).rejects.toThrow(InvalidOwnerError);
  });
});

describe("getCompanyById", () => {
  it("returns the company for its own organization", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const created = await createCompany({ userId, organizationId, roleKey }, { name: "Findable Co" });
    const found = await getCompanyById({ userId, organizationId, roleKey }, created.id);
    expect(found?.id).toBe(created.id);
  });

  it("returns null for a nonexistent id", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const found = await getCompanyById({ userId, organizationId, roleKey }, randomUUID());
    expect(found).toBeNull();
  });

  it("returns null identically for a cross-org company (indistinguishable from nonexistent)", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const companyInB = await createCompany(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Co" },
    );

    const foundByA = await getCompanyById(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      companyInB.id,
    );
    const foundNonexistent = await getCompanyById(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      randomUUID(),
    );
    expect(foundByA).toBeNull();
    expect(foundNonexistent).toBeNull();
    expect(foundByA).toEqual(foundNonexistent);
  });

  it("excludes a soft-deleted company", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const created = await createCompany({ userId, organizationId, roleKey }, { name: "Soon Deleted Co" });
    await softDeleteCompany({ userId, organizationId, roleKey }, created.id);
    const found = await getCompanyById({ userId, organizationId, roleKey }, created.id);
    expect(found).toBeNull();
  });
});

describe("getCompanyByIdIncludingDeleted", () => {
  it("returns a soft-deleted company, unlike getCompanyById", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const created = await createCompany({ userId, organizationId, roleKey }, { name: "Deleted But Findable Co" });
    await softDeleteCompany({ userId, organizationId, roleKey }, created.id);

    const viaOrdinary = await getCompanyById({ userId, organizationId, roleKey }, created.id);
    const viaIncludingDeleted = await getCompanyByIdIncludingDeleted({ userId, organizationId, roleKey }, created.id);
    expect(viaOrdinary).toBeNull();
    expect(viaIncludingDeleted?.id).toBe(created.id);
    expect(viaIncludingDeleted?.name).toBe("Deleted But Findable Co");
    expect(viaIncludingDeleted?.deletedAt).not.toBeNull();
  });

  it("still returns an active company normally", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const created = await createCompany({ userId, organizationId, roleKey }, { name: "Active Co" });
    const found = await getCompanyByIdIncludingDeleted({ userId, organizationId, roleKey }, created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.deletedAt).toBeNull();
  });

  it("remains tenant-scoped — a cross-org id (even soft-deleted) is indistinguishable from nonexistent", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const companyInB = await createCompany(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Secret Co" },
    );
    await softDeleteCompany(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      companyInB.id,
    );

    const foundByA = await getCompanyByIdIncludingDeleted(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      companyInB.id,
    );
    const foundNonexistent = await getCompanyByIdIncludingDeleted(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      randomUUID(),
    );
    expect(foundByA).toBeNull();
    expect(foundByA).toEqual(foundNonexistent);
  });
});

describe("listCompanies", () => {
  it("paginates deterministically with no duplicates or gaps across pages", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    for (let i = 0; i < 5; i++) {
      await createCompany(ctx, { name: `List Co ${i}` });
      // ensure distinct created_at ordering deterministically
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const page1 = await listCompanies(ctx, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listCompanies(ctx, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);

    const page3 = await listCompanies(ctx, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items, ...page3.items].map((c) => c.id);
    expect(new Set(allIds).size).toBe(5);
  });

  /**
   * M4.1 Phase 2 pagination-precision correction (Final Re-Acceptance
   * Audit BLOCKER) — see the identical, more fully-commented test in
   * contacts.test.ts for the full rationale. RowC (newest, page 1's sole
   * item at limit=1, and therefore the cursor row) collides at
   * millisecond precision with RowB, which page 2 must still correctly
   * recover.
   */
  it("a microsecond-only collision between the page-1 cursor row and page 2's own first row does not skip a row", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };

    const ids = await seedAsAdmin(async (client) => {
      const rowA = await client.query<{ id: string }>(
        `insert into public.companies (organization_id, name, created_at)
         values ($1, 'RowA', '2026-01-01 12:00:00.100000+00') returning id`,
        [organizationId],
      );
      const rowB = await client.query<{ id: string }>(
        `insert into public.companies (organization_id, name, created_at)
         values ($1, 'RowB', '2026-01-01 12:00:00.200111+00') returning id`,
        [organizationId],
      );
      const rowC = await client.query<{ id: string }>(
        `insert into public.companies (organization_id, name, created_at)
         values ($1, 'RowC', '2026-01-01 12:00:00.200999+00') returning id`,
        [organizationId],
      );
      return { a: rowA.rows[0]!.id, b: rowB.rows[0]!.id, c: rowC.rows[0]!.id };
    });

    const page1 = await listCompanies(ctx, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.id).toBe(ids.c);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listCompanies(ctx, { limit: 2, cursor: page1.nextCursor! });
    const page2Ids = page2.items.map((c) => c.id);
    expect(page2Ids).toEqual([ids.b, ids.a]);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items].map((c) => c.id);
    expect(new Set(allIds)).toEqual(new Set([ids.a, ids.b, ids.c]));
    expect(allIds).toHaveLength(3);
  });

  it("filters by ownerId", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const owned = await createCompany(ctx, { name: "Owned", ownerId: userId });
    await createCompany(ctx, { name: "Unowned" });

    const result = await listCompanies(ctx, { ownerId: userId });
    expect(result.items.map((c) => c.id)).toEqual([owned.id]);
  });

  it("excludes soft-deleted companies from the default list", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const kept = await createCompany(ctx, { name: "Kept" });
    const deleted = await createCompany(ctx, { name: "Deleted" });
    await softDeleteCompany(ctx, deleted.id);

    const result = await listCompanies(ctx);
    const ids = result.items.map((c) => c.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(deleted.id);
  });

  it("never returns another organization's companies", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    await createCompany({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, {
      name: "Org B Only",
    });

    const result = await listCompanies({ userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey });
    expect(result.items).toEqual([]);
  });
});

describe("updateCompany", () => {
  it("updates provided fields only", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createCompany(ctx, { name: "Original", industry: "Tech" });

    const updated = await updateCompany(ctx, created.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.industry).toBe("Tech");
  });

  it("trims and rejects a whitespace-only name on update, exactly as on create", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createCompany(ctx, { name: "Original" });

    await expect(updateCompany(ctx, created.id, { name: "   " })).rejects.toThrow(ValidationError);
    const trimmed = await updateCompany(ctx, created.id, { name: "  Trimmed  " });
    expect(trimmed?.name).toBe("Trimmed");
  });

  it("validates a newly-assigned owner", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createCompany(ctx, { name: "Reassign Owner Co" });

    await expect(updateCompany(ctx, created.id, { ownerId: randomUUID() })).rejects.toThrow(InvalidOwnerError);
    const updated = await updateCompany(ctx, created.id, { ownerId: userId });
    expect(updated?.ownerId).toBe(userId);
  });

  it("allows an existing owner_id to remain when that membership later becomes inactive, as long as ownerId is not being reassigned", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createCompany(ctx, { name: "Stale Owner Co", ownerId: userId });

    await setMembershipStatus(userId, organizationId, "removed");

    // Updating an unrelated field must not be blocked by the now-inactive
    // owner — owner is not being reassigned, so no re-validation occurs.
    const updated = await updateCompany(ctx, created.id, { industry: "Finance" });
    expect(updated?.ownerId).toBe(userId);
    expect(updated?.industry).toBe("Finance");
  });

  it("rejects reassigning to a now-inactive member", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createCompany(ctx, { name: "Co" });
    await setMembershipStatus(userId, organizationId, "removed");

    await expect(updateCompany(ctx, created.id, { ownerId: userId })).rejects.toThrow(InvalidOwnerError);
  });

  it("returns null for a cross-org update attempt", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const companyInB = await createCompany(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Co" },
    );
    const result = await updateCompany(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      companyInB.id,
      { name: "Hacked" },
    );
    expect(result).toBeNull();

    const stillOriginal = await getCompanyById(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      companyInB.id,
    );
    expect(stillOriginal?.name).toBe("Org B Co");
  });

  it("returns null for an already soft-deleted company", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createCompany(ctx, { name: "Co" });
    await softDeleteCompany(ctx, created.id);
    const result = await updateCompany(ctx, created.id, { name: "Should Not Apply" });
    expect(result).toBeNull();
  });
});

describe("softDeleteCompany", () => {
  it("sets deleted_at and excludes it from subsequent get/list", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createCompany(ctx, { name: "To Delete" });

    const deleted = await softDeleteCompany(ctx, created.id);
    expect(deleted?.deletedAt).not.toBeNull();

    expect(await getCompanyById(ctx, created.id)).toBeNull();
  });

  it("cannot double soft-delete (returns null the second time)", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const created = await createCompany(ctx, { name: "To Delete Twice" });

    await softDeleteCompany(ctx, created.id);
    const second = await softDeleteCompany(ctx, created.id);
    expect(second).toBeNull();
  });

  it("cannot soft-delete another organization's company", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const companyInB = await createCompany(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Co" },
    );

    const result = await softDeleteCompany(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      companyInB.id,
    );
    expect(result).toBeNull();

    const stillThere = await seedAsAdmin(async (client) => {
      const r = await client.query("select deleted_at from public.companies where id = $1", [companyInB.id]);
      return r.rows[0];
    });
    expect(stillThere.deleted_at).toBeNull();
  });
});

describe("Milestone 4.1 Phase 2: domain-event emission", () => {
  async function eventCount(organizationId: string, eventType: string, companyId: string): Promise<number> {
    return seedAsAdmin(async (client) => {
      const r = await client.query<{ count: string }>(
        "select count(*)::text as count from public.events where organization_id = $1 and event_type = $2 and payload->>'company_id' = $3",
        [organizationId, eventType, companyId],
      );
      return Number(r.rows[0]!.count);
    });
  }

  it("createCompany emits exactly one company.created event", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const company = await createCompany({ userId, organizationId, roleKey }, { name: "Acme Inc" });
    expect(await eventCount(organizationId, "company.created", company.id)).toBe(1);
  });

  it("updateCompany emits exactly one company.updated event on a genuine field change", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const company = await createCompany(ctx, { name: "Acme Inc" });
    await updateCompany(ctx, company.id, { name: "Acme Corp" });
    expect(await eventCount(organizationId, "company.updated", company.id)).toBe(1);
  });

  it("updateCompany with no field changes does not emit a second event", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const company = await createCompany(ctx, { name: "Acme Inc" });
    await updateCompany(ctx, company.id, {});
    expect(await eventCount(organizationId, "company.updated", company.id)).toBe(0);
  });

  it("softDeleteCompany emits exactly one company.deleted event, never company.updated", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const company = await createCompany(ctx, { name: "Acme Inc" });
    await softDeleteCompany(ctx, company.id);
    expect(await eventCount(organizationId, "company.deleted", company.id)).toBe(1);
    expect(await eventCount(organizationId, "company.updated", company.id)).toBe(0);
  });
});
