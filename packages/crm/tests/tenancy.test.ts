import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, createOrgWithActiveMember } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import { createCompany, getCompanyById, listCompanies, updateCompany, softDeleteCompany } from "../src/companies";
import { createContact, getContactById, updateContact, softDeleteContact } from "../src/contacts";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("cross-tenant isolation — companies", () => {
  it("Org A cannot read Org B's company", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const companyB = await createCompany(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Co" },
    );
    const result = await getCompanyById(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      companyB.id,
    );
    expect(result).toBeNull();
  });

  it("Org A cannot update Org B's company", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const companyB = await createCompany(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Co" },
    );
    const result = await updateCompany(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      companyB.id,
      { name: "Pwned" },
    );
    expect(result).toBeNull();

    const row = await seedAsAdmin(async (client) => {
      const r = await client.query("select name from public.companies where id = $1", [companyB.id]);
      return r.rows[0];
    });
    expect(row.name).toBe("Org B Co");
  });

  it("Org A cannot soft-delete Org B's company", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const companyB = await createCompany(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Co" },
    );
    await softDeleteCompany(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      companyB.id,
    );
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query("select deleted_at from public.companies where id = $1", [companyB.id]);
      return r.rows[0];
    });
    expect(row.deleted_at).toBeNull();
  });
});

describe("cross-tenant isolation — contacts", () => {
  it("Org A cannot read Org B's contact", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const contactB = await createContact(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { firstName: "Org B Contact" },
    );
    const result = await getContactById(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      contactB.id,
    );
    expect(result).toBeNull();
  });

  it("Org A cannot update Org B's contact", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const contactB = await createContact(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { firstName: "Org B Contact" },
    );
    const result = await updateContact(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      contactB.id,
      { firstName: "Pwned" },
    );
    expect(result).toBeNull();

    const row = await seedAsAdmin(async (client) => {
      const r = await client.query("select first_name from public.contacts where id = $1", [contactB.id]);
      return r.rows[0];
    });
    expect(row.first_name).toBe("Org B Contact");
  });

  it("Org A cannot soft-delete Org B's contact", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const contactB = await createContact(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { firstName: "Org B Contact" },
    );
    await softDeleteContact(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      contactB.id,
    );
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query("select deleted_at from public.contacts where id = $1", [contactB.id]);
      return r.rows[0];
    });
    expect(row.deleted_at).toBeNull();
  });
});

describe("forged/spoofed tenant context cannot override ctx.organizationId", () => {
  it("a raw object carrying an extra organizationId-shaped input field has no effect on a company create", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const forged = { name: "Forged Co", organization_id: randomUUID(), organizationId: randomUUID() };
    const created = await createCompany(
      { userId, organizationId, roleKey },
      forged as unknown as { name: string },
    );
    expect(created.organizationId).toBe(organizationId);
  });

  it("a raw object carrying an extra organizationId-shaped input field has no effect on a contact create", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const forged = { firstName: "Ada", organization_id: randomUUID(), organizationId: randomUUID() };
    const created = await createContact(
      { userId, organizationId, roleKey },
      forged as unknown as { firstName: string },
    );
    expect(created.organizationId).toBe(organizationId);
  });

  it("relationship IDs cannot be used to bypass tenant isolation: a company id from another org is rejected, not silently linked", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const companyB = await createCompany(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Co" },
    );

    await expect(
      createContact(
        { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
        { firstName: "Ada", companyId: companyB.id },
      ),
    ).rejects.toThrow();

    // Confirm no contact was created linking across orgs.
    const leaked = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select id from public.contacts where company_id = $1 and organization_id = $2",
        [companyB.id, orgA.organizationId],
      );
      return r.rows;
    });
    expect(leaked).toHaveLength(0);
  });
});

describe("listCompanies tenant isolation", () => {
  it("never leaks another organization's rows regardless of filters used", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    await createCompany({ userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey }, {
      name: "Org B Co",
      ownerId: orgB.userId,
    });

    const result = await listCompanies(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey },
      { ownerId: orgB.userId },
    );
    expect(result.items).toEqual([]);
  });
});
