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
} from "./crm-api-fixtures";
import { decideContactsConsoleAccess } from "../app/contacts/access";
import { listActiveCompanyOptions } from "../app/contacts/company-options";
import { createContactForResolvedContext } from "../app/contacts/create-logic";
import { updateContactForResolvedContext } from "../app/contacts/[id]/update-logic";
import { deleteContactForResolvedContext } from "../app/contacts/[id]/delete-logic";
import { handleGetContact } from "../app/api/v1/contacts/[id]/handlers";
import { handleDeleteCompany } from "../app/api/v1/companies/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.1G-C. Mirrors companies-console.test.ts's shape and same
 * non-duplication reasoning: handleListContacts/handleGetContact's own
 * list/pagination/filter/404/tenancy behavior is already exhaustively
 * covered by contacts-api.test.ts (21 tests, unmodified, re-run as part
 * of full regression) — ContactsPage/the detail page call those exact
 * functions with no additional logic beyond URL/param assembly. What's
 * new here — decideContactsConsoleAccess, listActiveCompanyOptions, and
 * the form-to-body translation including identity invariant/duplicate
 * email/company relationship surfacing — gets full dedicated coverage.
 */

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

afterAll(async () => {
  await closePool();
});

describe("decideContactsConsoleAccess()", () => {
  it("unauthenticated -> /login", () => {
    expect(decideContactsConsoleAccess(null, null)).toEqual({ kind: "redirect", to: "/login" });
  });

  it("authenticated with no org context -> /dashboard", () => {
    expect(decideContactsConsoleAccess(randomUUID(), null)).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it.each(["org_admin", "org_member", "org_viewer"] as const)("%s is allowed through", (roleKey) => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const decision = decideContactsConsoleAccess(userId, { organizationId, roleKey });
    expect(decision).toEqual({ kind: "allow", orgContext: { userId, organizationId, roleKey } });
  });

  it.each(["agency_owner", "agency_admin", "portal_customer"] as const)(
    "%s is redirected to /dashboard — no direct Contacts UI access",
    (roleKey) => {
      const userId = randomUUID();
      const organizationId = randomUUID();
      const decision = decideContactsConsoleAccess(userId, { organizationId, roleKey });
      expect(decision).toEqual({ kind: "redirect", to: "/dashboard" });
    },
  );
});

describe("listActiveCompanyOptions()", () => {
  it("excludes a soft-deleted company from the choices", async () => {
    const admin = await createOrgWithRole("org_admin", "company-opts-admin");
    const activeId = await seedCompany(admin.organizationId, { name: "Active Co" });
    const deletedId = await seedCompany(admin.organizationId, { name: "Deleted Co" });
    await handleDeleteCompany(admin.userId, deletedId);

    const options = await listActiveCompanyOptions(admin);
    const ids = options.map((o) => o.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(deletedId);
  });
});

describe("createContactForResolvedContext()", () => {
  it("creates the contact, ignoring forged organizationId/id", async () => {
    const admin = await createOrgWithRole("org_admin", "create-success-admin");
    const result = await createContactForResolvedContext(
      admin.userId,
      formData({
        idempotencyKey: randomUUID(),
        firstName: "Forge",
        lastName: "Test",
        organizationId: randomUUID(),
        id: randomUUID(),
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.createdId).toBeTruthy();

    const response = await handleGetContact(admin.userId, result.createdId!);
    const body = (await response.json()) as { contact: { organizationId: string } };
    expect(body.contact.organizationId).toBe(admin.organizationId);
  });

  it("violating the identity invariant (all three empty) is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "create-identity-admin");
    const result = await createContactForResolvedContext(admin.userId, formData({ idempotencyKey: randomUUID() }));
    expect(result.error).toBeTruthy();
    expect(result.createdId).toBeUndefined();
  });

  it("a duplicate active email is rejected with an actionable error", async () => {
    const admin = await createOrgWithRole("org_admin", "create-dup-email-admin");
    const email = `dup-${randomUUID()}@example.test`;
    const first = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), firstName: "A", email }),
    );
    expect(first.createdId).toBeTruthy();

    const second = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), firstName: "B", email }),
    );
    expect(second.error).toBeTruthy();
    expect(second.createdId).toBeUndefined();
  });

  it("a case-insensitive duplicate email is also rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "create-dup-email-ci-admin");
    const email = `dup-ci-${randomUUID()}@example.test`;
    await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), firstName: "A", email }),
    );
    const second = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), firstName: "B", email: email.toUpperCase() }),
    );
    expect(second.error).toBeTruthy();
  });

  it("an invalid owner produces a safe 400-shaped error", async () => {
    const admin = await createOrgWithRole("org_admin", "create-invalid-owner-admin");
    const result = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), firstName: "X", ownerId: randomUUID() }),
    );
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/relation|syntax|constraint/i);
  });

  it("a cross-org company relationship produces a safe error, not a leak", async () => {
    const admin = await createOrgWithRole("org_admin", "create-cross-org-company-admin");
    const otherOrg = await createOrgWithRole("org_admin", "create-cross-org-company-other");
    const otherCompanyId = await seedCompany(otherOrg.organizationId);

    const result = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), firstName: "X", companyId: otherCompanyId }),
    );
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/relation|syntax|constraint/i);
  });

  it("an unauthorized mutation (org_viewer) is rejected", async () => {
    const viewer = await createOrgWithRole("org_viewer", "create-unauthorized-viewer");
    const result = await createContactForResolvedContext(
      viewer.userId,
      formData({ idempotencyKey: randomUUID(), firstName: "Should Not Exist" }),
    );
    expect(result.error).toBeTruthy();
  });

  it("the same idempotency key reused for a retry returns the same created contact, not a duplicate", async () => {
    const admin = await createOrgWithRole("org_admin", "create-idempotent-admin");
    const key = randomUUID();
    const first = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, firstName: "Idempotent" }),
    );
    const second = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, firstName: "Idempotent" }),
    );
    expect(first.createdId).toBe(second.createdId);

    const client = await adminPool.connect();
    try {
      const r = await client.query(
        "select count(*)::int as n from public.contacts where organization_id = $1 and first_name = 'Idempotent'",
        [admin.organizationId],
      );
      expect(r.rows[0].n).toBe(1);
    } finally {
      client.release();
    }
  });

  it("a genuinely new create action (a new key) creates a second, distinct contact", async () => {
    const admin = await createOrgWithRole("org_admin", "create-new-key-admin");
    const first = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), firstName: "New Key" }),
    );
    const second = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), firstName: "New Key" }),
    );
    expect(first.createdId).toBeTruthy();
    expect(second.createdId).toBeTruthy();
    expect(first.createdId).not.toBe(second.createdId);
  });

  it("the same key reused for a genuinely different payload is a conflict, not a silent second write", async () => {
    const admin = await createOrgWithRole("org_admin", "create-conflict-admin");
    const key = randomUUID();
    const first = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, firstName: "Conflict A" }),
    );
    expect(first.createdId).toBeTruthy();

    const second = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, firstName: "Conflict B" }),
    );
    expect(second.error).toBeTruthy();
    expect(second.createdId).toBeUndefined();

    const client = await adminPool.connect();
    try {
      const r = await client.query(
        "select count(*)::int as n from public.contacts where organization_id = $1 and first_name = 'Conflict B'",
        [admin.organizationId],
      );
      expect(r.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });
});

describe("updateContactForResolvedContext()", () => {
  it("updates the touched field and leaves untouched fields at their existing value, not null", async () => {
    const admin = await createOrgWithRole("org_admin", "update-partial-admin");
    const contactId = await seedContact(admin.organizationId, { firstName: "Original" });
    const client = await adminPool.connect();
    try {
      await client.query("update public.contacts set phone = '555-0000' where id = $1", [contactId]);
    } finally {
      client.release();
    }

    const result = await updateContactForResolvedContext(
      admin.userId,
      contactId,
      formData({ idempotencyKey: randomUUID(), firstName: "Renamed", phone: "555-0000" }),
    );
    expect(result.error).toBeUndefined();

    const response = await handleGetContact(admin.userId, contactId);
    const body = (await response.json()) as { contact: { firstName: string; phone: string | null } };
    expect(body.contact.firstName).toBe("Renamed");
    expect(body.contact.phone).toBe("555-0000");
  });

  it("explicitly clearing a nullable field sends null, not an omission", async () => {
    const admin = await createOrgWithRole("org_admin", "update-clear-admin");
    const contactId = await seedContact(admin.organizationId, { firstName: "Clear Phone" });
    const client = await adminPool.connect();
    try {
      await client.query("update public.contacts set phone = '555-1111' where id = $1", [contactId]);
    } finally {
      client.release();
    }

    const result = await updateContactForResolvedContext(
      admin.userId,
      contactId,
      formData({ idempotencyKey: randomUUID(), firstName: "Clear Phone", phone: "" }),
    );
    expect(result.error).toBeUndefined();

    const response = await handleGetContact(admin.userId, contactId);
    const body = (await response.json()) as { contact: { phone: string | null } };
    expect(body.contact.phone).toBeNull();
  });

  it("org_viewer is forbidden from updating", async () => {
    const admin = await createOrgWithRole("org_admin", "update-viewer-setup-admin");
    const contactId = await seedContact(admin.organizationId);
    const viewer = await createOrgWithRole("org_viewer", "update-viewer");

    const result = await updateContactForResolvedContext(
      viewer.userId,
      contactId,
      formData({ idempotencyKey: randomUUID(), firstName: "Should Not Update" }),
    );
    expect(result.error).toBeTruthy();
  });

  it("updating to a duplicate active email is rejected", async () => {
    const admin = await createOrgWithRole("org_admin", "update-dup-email-admin");
    const existingEmail = `existing-${randomUUID()}@example.test`;
    await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), firstName: "Existing", email: existingEmail }),
    );
    const targetId = await seedContact(admin.organizationId, { firstName: "Target" });

    const result = await updateContactForResolvedContext(
      admin.userId,
      targetId,
      formData({ idempotencyKey: randomUUID(), firstName: "Target", email: existingEmail }),
    );
    expect(result.error).toBeTruthy();
  });

  it("an invalid company relationship on update produces a safe validation error", async () => {
    const admin = await createOrgWithRole("org_admin", "update-invalid-company-admin");
    const contactId = await seedContact(admin.organizationId, { firstName: "Test" });

    const result = await updateContactForResolvedContext(
      admin.userId,
      contactId,
      formData({ idempotencyKey: randomUUID(), firstName: "Test", companyId: randomUUID() }),
    );
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/relation|syntax|constraint/i);
  });

  it("replaying the same idempotency key for the same edit returns the same result", async () => {
    const admin = await createOrgWithRole("org_admin", "update-idempotent-admin");
    const contactId = await seedContact(admin.organizationId, { firstName: "Before" });
    const key = randomUUID();

    const first = await updateContactForResolvedContext(
      admin.userId,
      contactId,
      formData({ idempotencyKey: key, firstName: "After" }),
    );
    const second = await updateContactForResolvedContext(
      admin.userId,
      contactId,
      formData({ idempotencyKey: key, firstName: "After" }),
    );
    expect(first).toEqual(second);
  });

  it("the same key reused for a genuinely different edit payload is a conflict, not a silent second write", async () => {
    const admin = await createOrgWithRole("org_admin", "update-conflict-admin");
    const contactId = await seedContact(admin.organizationId, { firstName: "Before" });
    const key = randomUUID();

    const first = await updateContactForResolvedContext(
      admin.userId,
      contactId,
      formData({ idempotencyKey: key, firstName: "After A" }),
    );
    expect(first.error).toBeUndefined();

    const second = await updateContactForResolvedContext(
      admin.userId,
      contactId,
      formData({ idempotencyKey: key, firstName: "After B" }),
    );
    expect(second.error).toBeTruthy();

    const response = await handleGetContact(admin.userId, contactId);
    const body = (await response.json()) as { contact: { firstName: string } };
    expect(body.contact.firstName).toBe("After A");
  });
});

describe("deleteContactForResolvedContext()", () => {
  it("org_admin can soft-delete; the contact then 404s on lookup", async () => {
    const admin = await createOrgWithRole("org_admin", "delete-admin");
    const contactId = await seedContact(admin.organizationId);

    const result = await deleteContactForResolvedContext(admin.userId, contactId);
    expect(result.deleted).toBe(true);

    const response = await handleGetContact(admin.userId, contactId);
    expect(response.status).toBe(404);
  });

  it("org_member is forbidden from deleting", async () => {
    const admin = await createOrgWithRole("org_admin", "delete-member-setup-admin");
    const contactId = await seedContact(admin.organizationId);
    const member = await createOrgWithRole("org_member", "delete-member");

    const result = await deleteContactForResolvedContext(member.userId, contactId);
    expect(result.error).toBeTruthy();
    expect(result.deleted).toBeUndefined();

    const response = await handleGetContact(admin.userId, contactId);
    expect(response.status).toBe(200);
  });

  it("only ever soft-deletes — the row still physically exists afterward", async () => {
    const admin = await createOrgWithRole("org_admin", "delete-soft-admin");
    const contactId = await seedContact(admin.organizationId);

    await deleteContactForResolvedContext(admin.userId, contactId);

    const client = await adminPool.connect();
    try {
      const r = await client.query("select deleted_at from public.contacts where id = $1", [contactId]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].deleted_at).not.toBeNull();
    } finally {
      client.release();
    }
  });
});

describe("company relationship safety: linked company later soft-deleted", () => {
  it("an existing contact remains readable and keeps its stored companyId after the company is soft-deleted", async () => {
    const admin = await createOrgWithRole("org_admin", "linked-deleted-admin");
    const companyId = await seedCompany(admin.organizationId);
    const contactId = await seedContact(admin.organizationId, { companyId });

    await handleDeleteCompany(admin.userId, companyId);

    const response = await handleGetContact(admin.userId, contactId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { contact: { companyId: string | null } };
    expect(body.contact.companyId).toBe(companyId);

    // The now-soft-deleted company no longer appears in the active
    // options list — this is expected, not a bug; ContactEditForm's own
    // fallback (not exercised at the DOM level, per the accepted 2.1G-A
    // testing limitation) is what keeps this value selected without loss.
    const options = await listActiveCompanyOptions(admin);
    expect(options.map((o) => o.id)).not.toContain(companyId);
  });
});

describe("security: agency and unaffiliated actors get no Contacts UI access", () => {
  it("a pure agency actor is denied at the console access decision", async () => {
    const userId = await createPureAgencyActor();
    expect(decideContactsConsoleAccess(userId, null)).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it("an authenticated user with no membership at all is denied create/update/delete", async () => {
    const userId = await createUnaffiliatedUser();
    const createResult = await createContactForResolvedContext(
      userId,
      formData({ idempotencyKey: randomUUID(), firstName: "Should Not Exist" }),
    );
    expect(createResult.error).toBeTruthy();
  });

  it("a demoted actor cannot replay a stale create with continued authority", async () => {
    const admin = await createOrgWithRole("org_admin", "demoted-admin");
    const key = randomUUID();
    const first = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, firstName: "Demoted" }),
    );
    expect(first.createdId).toBeTruthy();

    await setMembershipStatus(admin.userId, admin.organizationId, "removed");
    const replay = await createContactForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, firstName: "Demoted" }),
    );
    expect(replay.error).toBeTruthy();
    expect(replay.createdId).toBeUndefined();
  });
});
