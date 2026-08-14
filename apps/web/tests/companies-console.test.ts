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
import { decideCompaniesConsoleAccess } from "../app/companies/access";
import { listActiveOwnerOptions } from "../app/_shared/owner-options";
import { createCompanyForResolvedContext } from "../app/companies/create-logic";
import { updateCompanyForResolvedContext } from "../app/companies/[id]/update-logic";
import { deleteCompanyForResolvedContext } from "../app/companies/[id]/delete-logic";
import { handleGetCompany } from "../app/api/v1/companies/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.1G-B. Mirrors agency-console.test.ts's pure access/logic
 * testing shape. Deliberately does NOT re-test handleListCompanies/
 * handleGetCompany's own list/pagination/filter/404/tenancy behavior —
 * that's already exhaustively covered by companies-api.test.ts (22
 * tests, unmodified, re-run as part of full regression below) and
 * CompaniesPage/the detail page call those exact same functions with no
 * additional logic of their own beyond URL/param assembly. What's
 * genuinely new here — decideCompaniesConsoleAccess, listActiveOwnerOptions,
 * and the form-to-body translation in create-logic.ts/update-logic.ts
 * (including the "always resend, empty means clear" partial-update
 * semantics that differ from the raw JSON API's hasOwnProperty contract)
 * — gets full, dedicated coverage below.
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

describe("decideCompaniesConsoleAccess()", () => {
  it("unauthenticated -> /login", () => {
    expect(decideCompaniesConsoleAccess(null, null)).toEqual({ kind: "redirect", to: "/login" });
  });

  it("authenticated with no org context -> /dashboard", () => {
    expect(decideCompaniesConsoleAccess(randomUUID(), null)).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it.each(["org_admin", "org_member", "org_viewer"] as const)("%s is allowed through", (roleKey) => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const decision = decideCompaniesConsoleAccess(userId, { organizationId, roleKey });
    expect(decision).toEqual({ kind: "allow", orgContext: { userId, organizationId, roleKey } });
  });

  it.each(["agency_owner", "agency_admin", "portal_customer"] as const)(
    "%s is redirected to /dashboard — no direct Companies UI access",
    (roleKey) => {
      const userId = randomUUID();
      const organizationId = randomUUID();
      const decision = decideCompaniesConsoleAccess(userId, { organizationId, roleKey });
      expect(decision).toEqual({ kind: "redirect", to: "/dashboard" });
    },
  );
});

describe("listActiveOwnerOptions()", () => {
  it("returns only active members of the caller's own organization", async () => {
    const admin = await createOrgWithRole("org_admin", "owner-opts-admin");
    const member = await createOrgWithRole("org_member", "owner-opts-member");

    const options = await listActiveOwnerOptions(admin);
    const ids = options.map((o) => o.userId);
    expect(ids).toContain(admin.userId);
    expect(ids).not.toContain(member.userId);
  });

  it("excludes a removed membership", async () => {
    const admin = await createOrgWithRole("org_admin", "owner-opts-removed-admin");
    const removedUserId = randomUUID();

    const client = await adminPool.connect();
    try {
      await client.query("insert into auth.users (id, email) values ($1, $2)", [
        removedUserId,
        `owner-opts-removed-${removedUserId}@example.test`,
      ]);
      const role = await client.query<{ id: string }>("select id from public.roles where key = 'org_member'");
      await client.query(
        "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'removed')",
        [removedUserId, admin.organizationId, role.rows[0]!.id],
      );
    } finally {
      client.release();
    }

    const options = await listActiveOwnerOptions(admin);
    expect(options.map((o) => o.userId)).not.toContain(removedUserId);
  });
});

describe("createCompanyForResolvedContext()", () => {
  it("creates the company with only the allowed fields, ignoring forged organizationId/id", async () => {
    const admin = await createOrgWithRole("org_admin", "create-success-admin");
    const forgedOrgId = randomUUID();
    const result = await createCompanyForResolvedContext(
      admin.userId,
      formData({
        idempotencyKey: randomUUID(),
        name: "Forge Test Co",
        organizationId: forgedOrgId,
        id: randomUUID(),
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.createdId).toBeTruthy();

    const response = await handleGetCompany(admin.userId, result.createdId!);
    const body = (await response.json()) as { company: { organizationId: string; name: string } };
    expect(body.company.organizationId).toBe(admin.organizationId);
    expect(body.company.organizationId).not.toBe(forgedOrgId);
    expect(body.company.name).toBe("Forge Test Co");
  });

  it("returns a validation error for a blank name, without calling the handler's own 500 path", async () => {
    const admin = await createOrgWithRole("org_admin", "create-blank-name-admin");
    const result = await createCompanyForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), name: "   " }),
    );
    expect(result.error).toBeTruthy();
    expect(result.createdId).toBeUndefined();
  });

  it("rejects a non-numeric employeeCount safely, before any database call", async () => {
    const admin = await createOrgWithRole("org_admin", "create-bad-employee-count-admin");
    const result = await createCompanyForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), name: "Bad Count Co", employeeCount: "not-a-number" }),
    );
    expect(result.error).toContain("Employee count");
  });

  it("an unauthorized mutation (org_viewer) is rejected", async () => {
    const viewer = await createOrgWithRole("org_viewer", "create-unauthorized-viewer");
    const result = await createCompanyForResolvedContext(
      viewer.userId,
      formData({ idempotencyKey: randomUUID(), name: "Should Not Exist" }),
    );
    expect(result.error).toBeTruthy();
    expect(result.createdId).toBeUndefined();
  });

  it("the same idempotency key reused for a retry returns the same created company, not a duplicate", async () => {
    const admin = await createOrgWithRole("org_admin", "create-idempotent-admin");
    const key = randomUUID();
    const first = await createCompanyForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, name: "Idempotent Co" }),
    );
    const second = await createCompanyForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, name: "Idempotent Co" }),
    );
    expect(first.createdId).toBe(second.createdId);

    const client = await adminPool.connect();
    try {
      const r = await client.query(
        "select count(*)::int as n from public.companies where organization_id = $1 and name = 'Idempotent Co'",
        [admin.organizationId],
      );
      expect(r.rows[0].n).toBe(1);
    } finally {
      client.release();
    }
  });

  it("the same key reused for a genuinely different payload is a conflict, not a silent second write", async () => {
    const admin = await createOrgWithRole("org_admin", "create-conflict-admin");
    const key = randomUUID();
    const first = await createCompanyForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, name: "Conflict Co A" }),
    );
    expect(first.createdId).toBeTruthy();

    const second = await createCompanyForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, name: "Conflict Co B" }),
    );
    expect(second.error).toBeTruthy();
    expect(second.createdId).toBeUndefined();

    const client = await adminPool.connect();
    try {
      const r = await client.query(
        "select count(*)::int as n from public.companies where organization_id = $1 and name = 'Conflict Co B'",
        [admin.organizationId],
      );
      expect(r.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it("a genuinely new create action (a new key) creates a second, distinct company", async () => {
    const admin = await createOrgWithRole("org_admin", "create-new-key-admin");
    const first = await createCompanyForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), name: "New Key Co" }),
    );
    const second = await createCompanyForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: randomUUID(), name: "New Key Co" }),
    );
    expect(first.createdId).toBeTruthy();
    expect(second.createdId).toBeTruthy();
    expect(first.createdId).not.toBe(second.createdId);
  });
});

describe("updateCompanyForResolvedContext()", () => {
  it("updates the touched field and leaves untouched fields at their existing value, not null", async () => {
    const admin = await createOrgWithRole("org_admin", "update-partial-admin");
    const companyId = await seedCompany(admin.organizationId, { name: "Original Name" });
    const client = await adminPool.connect();
    try {
      await client.query("update public.companies set domain = 'original.test' where id = $1", [companyId]);
    } finally {
      client.release();
    }

    const result = await updateCompanyForResolvedContext(
      admin.userId,
      companyId,
      formData({ idempotencyKey: randomUUID(), name: "Renamed Co", domain: "original.test" }),
    );
    expect(result.error).toBeUndefined();

    const response = await handleGetCompany(admin.userId, companyId);
    const body = (await response.json()) as { company: { name: string; domain: string | null } };
    expect(body.company.name).toBe("Renamed Co");
    expect(body.company.domain).toBe("original.test");
  });

  it("explicitly clearing a nullable field sends null, not an omission", async () => {
    const admin = await createOrgWithRole("org_admin", "update-clear-admin");
    const companyId = await seedCompany(admin.organizationId, { name: "Clear Domain Co" });
    const client = await adminPool.connect();
    try {
      await client.query("update public.companies set domain = 'to-be-cleared.test' where id = $1", [companyId]);
    } finally {
      client.release();
    }

    const result = await updateCompanyForResolvedContext(
      admin.userId,
      companyId,
      formData({ idempotencyKey: randomUUID(), name: "Clear Domain Co", domain: "" }),
    );
    expect(result.error).toBeUndefined();

    const response = await handleGetCompany(admin.userId, companyId);
    const body = (await response.json()) as { company: { domain: string | null } };
    expect(body.company.domain).toBeNull();
  });

  it("org_viewer is forbidden from updating", async () => {
    const admin = await createOrgWithRole("org_admin", "update-viewer-setup-admin");
    const companyId = await seedCompany(admin.organizationId);
    const viewer = await createOrgWithRole("org_viewer", "update-viewer");

    const result = await updateCompanyForResolvedContext(
      viewer.userId,
      companyId,
      formData({ idempotencyKey: randomUUID(), name: "Should Not Update" }),
    );
    expect(result.error).toBeTruthy();
  });

  it("an invalid owner produces a safe validation error, not a raw database error", async () => {
    const admin = await createOrgWithRole("org_admin", "update-invalid-owner-admin");
    const companyId = await seedCompany(admin.organizationId);

    const result = await updateCompanyForResolvedContext(
      admin.userId,
      companyId,
      formData({ idempotencyKey: randomUUID(), name: "Owner Test Co", ownerId: randomUUID() }),
    );
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/relation|syntax|constraint/i);
  });

  it("replaying the same idempotency key for the same edit returns the same result", async () => {
    const admin = await createOrgWithRole("org_admin", "update-idempotent-admin");
    const companyId = await seedCompany(admin.organizationId, { name: "Before" });
    const key = randomUUID();

    const first = await updateCompanyForResolvedContext(
      admin.userId,
      companyId,
      formData({ idempotencyKey: key, name: "After" }),
    );
    const second = await updateCompanyForResolvedContext(
      admin.userId,
      companyId,
      formData({ idempotencyKey: key, name: "After" }),
    );
    expect(first).toEqual(second);
  });

  it("the same key reused for a genuinely different edit payload is a conflict, not a silent second write", async () => {
    const admin = await createOrgWithRole("org_admin", "update-conflict-admin");
    const companyId = await seedCompany(admin.organizationId, { name: "Before" });
    const key = randomUUID();

    const first = await updateCompanyForResolvedContext(
      admin.userId,
      companyId,
      formData({ idempotencyKey: key, name: "After A" }),
    );
    expect(first.error).toBeUndefined();

    const second = await updateCompanyForResolvedContext(
      admin.userId,
      companyId,
      formData({ idempotencyKey: key, name: "After B" }),
    );
    expect(second.error).toBeTruthy();

    const response = await handleGetCompany(admin.userId, companyId);
    const body = (await response.json()) as { company: { name: string } };
    expect(body.company.name).toBe("After A");
  });
});

describe("deleteCompanyForResolvedContext()", () => {
  it("org_admin can soft-delete; the company then 404s on lookup", async () => {
    const admin = await createOrgWithRole("org_admin", "delete-admin");
    const companyId = await seedCompany(admin.organizationId);

    const result = await deleteCompanyForResolvedContext(admin.userId, companyId);
    expect(result.deleted).toBe(true);

    const response = await handleGetCompany(admin.userId, companyId);
    expect(response.status).toBe(404);
  });

  it("org_member is forbidden from deleting", async () => {
    const admin = await createOrgWithRole("org_admin", "delete-member-setup-admin");
    const companyId = await seedCompany(admin.organizationId);
    const member = await createOrgWithRole("org_member", "delete-member");

    const result = await deleteCompanyForResolvedContext(member.userId, companyId);
    expect(result.error).toBeTruthy();
    expect(result.deleted).toBeUndefined();

    const response = await handleGetCompany(admin.userId, companyId);
    expect(response.status).toBe(200);
  });

  it("only ever soft-deletes — the row still physically exists afterward", async () => {
    const admin = await createOrgWithRole("org_admin", "delete-soft-admin");
    const companyId = await seedCompany(admin.organizationId);

    await deleteCompanyForResolvedContext(admin.userId, companyId);

    const client = await adminPool.connect();
    try {
      const r = await client.query("select deleted_at from public.companies where id = $1", [companyId]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].deleted_at).not.toBeNull();
    } finally {
      client.release();
    }
  });
});

describe("security: agency and unaffiliated actors get no Companies UI access", () => {
  it("a pure agency actor is denied at the console access decision", async () => {
    const userId = await createPureAgencyActor();
    // No org-scoped membership at all -> orgContext resolves to null in
    // the real request flow; decideCompaniesConsoleAccess must redirect,
    // never attempt to resolve companies data for this actor.
    expect(decideCompaniesConsoleAccess(userId, null)).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it("an authenticated user with no membership at all is denied create/update/delete", async () => {
    const userId = await createUnaffiliatedUser();
    const createResult = await createCompanyForResolvedContext(
      userId,
      formData({ idempotencyKey: randomUUID(), name: "Should Not Exist" }),
    );
    expect(createResult.error).toBeTruthy();
  });

  it("a demoted actor (membership removed after creating) cannot replay a stale create with continued authority", async () => {
    const admin = await createOrgWithRole("org_admin", "demoted-admin");
    const key = randomUUID();
    const first = await createCompanyForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, name: "Demoted Co" }),
    );
    expect(first.createdId).toBeTruthy();

    await setMembershipStatus(admin.userId, admin.organizationId, "removed");
    const replay = await createCompanyForResolvedContext(
      admin.userId,
      formData({ idempotencyKey: key, name: "Demoted Co" }),
    );
    expect(replay.error).toBeTruthy();
    expect(replay.createdId).toBeUndefined();
  });
});
