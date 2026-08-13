import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, createOrgWithActiveMember, setMembershipStatus } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import { createCompany, getCompanyById, listCompanies, updateCompany, softDeleteCompany } from "../src/companies";
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
