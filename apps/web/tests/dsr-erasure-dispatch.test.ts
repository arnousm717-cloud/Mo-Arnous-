import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withTenantContext, getPool, closePool } from "@ai-revenue-os/database";
import {
  previewUserErasure,
  executeUserErasure,
  previewContactErasure,
  executeContactErasure,
} from "@ai-revenue-os/compliance";
import { handleFileDataSubjectRequest } from "../app/api/v1/data-subject-requests/handlers";
import { handlePreviewErasure } from "../app/api/v1/data-subject-requests/[id]/preview/handlers";
import { handleExecuteErasure } from "../app/api/v1/data-subject-requests/[id]/execute/handlers";

/**
 * Milestone 2.1F-C: subject_type dispatch for the preview/execute erasure
 * flow. Companion to compliance-api.test.ts (which already covers the
 * subject_type='user' path end-to-end and is unmodified in substance here,
 * only renamed to match the dispatch handlers) — this file is specifically
 * about the dispatch decision itself: reading subject_type from a
 * tenant-scoped, server-fetched DSR row and routing to the correct
 * existing erasure implementation, never trusting client input for it.
 */

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminPool = getPool();

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  const client = await adminPool.connect();
  try {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `dsr-dispatch-${label}-${userId}@example.test`,
    ]);
  } finally {
    client.release();
  }
  return userId;
}

async function createStandaloneOrg(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `dsr-dispatch-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.organization_id as string;
}

async function addMembership(userId: string, organizationId: string, roleKey: string): Promise<void> {
  const client = await adminPool.connect();
  try {
    const roleRow = await client.query<{ id: string }>("select id from public.roles where key = $1", [roleKey]);
    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, organizationId, roleRow.rows[0]?.id],
    );
  } finally {
    client.release();
  }
}

async function createContact(organizationId: string, firstName = "Dispatch Test Contact"): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, email) values ($1, $2, $3) returning id",
      [organizationId, firstName, `dsr-dispatch-${randomUUID()}@example.test`],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function rowExists(table: string, column: string, value: string): Promise<boolean> {
  const client = await adminPool.connect();
  try {
    const r = await client.query(`select 1 from ${table} where ${column} = $1`, [value]);
    return r.rows.length > 0;
  } finally {
    client.release();
  }
}

async function fileDsr(
  userId: string,
  subjectType: "user" | "contact" | "visitor" | "portal_user",
  subjectId: string,
): Promise<string> {
  const res = await handleFileDataSubjectRequest(userId, { subjectType, subjectId, requestType: "delete" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { dataSubjectRequest: { id: string } };
  return body.dataSubjectRequest.id;
}

afterAll(async () => {
  await closePool();
});

describe("dispatch: subject_type=user (regression)", () => {
  it("preview and execute still dispatch to the user erasure path end-to-end", async () => {
    const admin = await createAuthUser("user-regress-admin");
    const orgId = await createStandaloneOrg(admin, "Dispatch User Regress Org");
    const target = await createAuthUser("user-regress-target");
    await addMembership(target, orgId, "org_member");

    const dsrId = await fileDsr(admin, "user", target);

    const previewRes = await handlePreviewErasure(admin, dsrId);
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as { preview: { canProceed: boolean; targetUserId: string } };
    expect(previewBody.preview.canProceed).toBe(true);
    expect(previewBody.preview.targetUserId).toBe(target);

    const executeRes = await handleExecuteErasure(admin, dsrId);
    expect(executeRes.status).toBe(200);

    expect(await rowExists("auth.users", "id", target)).toBe(false);

    const replay = await handleExecuteErasure(admin, dsrId);
    expect(replay.status).toBe(409);
  });
});

describe("dispatch: subject_type=contact", () => {
  it("preview and execute dispatch to the contact erasure path end-to-end", async () => {
    const admin = await createAuthUser("contact-admin");
    const orgId = await createStandaloneOrg(admin, "Dispatch Contact Org");
    const contactId = await createContact(orgId);

    const dsrId = await fileDsr(admin, "contact", contactId);

    const previewRes = await handlePreviewErasure(admin, dsrId);
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as { preview: { canProceed: boolean; targetContactId: string } };
    expect(previewBody.preview.canProceed).toBe(true);
    expect(previewBody.preview.targetContactId).toBe(contactId);

    expect(await rowExists("public.contacts", "id", contactId)).toBe(true);

    const executeRes = await handleExecuteErasure(admin, dsrId);
    expect(executeRes.status).toBe(200);
    const executeBody = (await executeRes.json()) as { result: { targetContactId: string } };
    expect(executeBody.result.targetContactId).toBe(contactId);

    expect(await rowExists("public.contacts", "id", contactId)).toBe(false);

    const replay = await handleExecuteErasure(admin, dsrId);
    expect(replay.status).toBe(409);
  });

  it("a cross-org contact reference is rejected, not silently erased", async () => {
    const adminA = await createAuthUser("contact-cross-admin-a");
    const adminB = await createAuthUser("contact-cross-admin-b");
    await createStandaloneOrg(adminA, "Dispatch Contact Cross Org A");
    const orgB = await createStandaloneOrg(adminB, "Dispatch Contact Cross Org B");
    const contactB = await createContact(orgB);

    const dsrId = await fileDsr(adminA, "contact", contactB);

    const previewRes = await handlePreviewErasure(adminA, dsrId);
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as { preview: { canProceed: boolean } };
    expect(previewBody.preview.canProceed).toBe(false);

    expect(await rowExists("public.contacts", "id", contactB)).toBe(true);
  });
});

describe("dispatch: unsupported subject_type (visitor / portal_user)", () => {
  it.each(["visitor", "portal_user"] as const)(
    "preview and execute both return 400 for subject_type=%s, with no mutation",
    async (subjectType) => {
      const admin = await createAuthUser(`unsupported-${subjectType}-admin`);
      await createStandaloneOrg(admin, `Dispatch Unsupported ${subjectType} Org`);
      const dsrId = await fileDsr(admin, subjectType, randomUUID());

      const previewRes = await handlePreviewErasure(admin, dsrId);
      expect(previewRes.status).toBe(400);

      const executeRes = await handleExecuteErasure(admin, dsrId);
      expect(executeRes.status).toBe(400);

      const client = await adminPool.connect();
      try {
        const r = await client.query<{ status: string }>(
          "select status from public.data_subject_requests where id = $1",
          [dsrId],
        );
        expect(r.rows[0]?.status).toBe("pending");
      } finally {
        client.release();
      }
    },
  );
});

describe("dispatch: nonexistent DSR", () => {
  it("preview and execute both return 404 for a random id", async () => {
    const admin = await createAuthUser("nonexistent-admin");
    await createStandaloneOrg(admin, "Dispatch Nonexistent Org");

    const previewRes = await handlePreviewErasure(admin, randomUUID());
    expect(previewRes.status).toBe(404);

    const executeRes = await handleExecuteErasure(admin, randomUUID());
    expect(executeRes.status).toBe(404);
  });
});

describe("dispatch: cross-org DSR", () => {
  it("a DSR filed in a different organization is indistinguishable from nonexistent, for both user and contact subject types", async () => {
    const adminA = await createAuthUser("cross-dsr-admin-a");
    const adminB = await createAuthUser("cross-dsr-admin-b");
    const orgA = await createStandaloneOrg(adminA, "Dispatch Cross DSR Org A");
    const orgB = await createStandaloneOrg(adminB, "Dispatch Cross DSR Org B");

    const userDsrId = await fileDsr(adminB, "user", adminB);
    const previewUserRes = await handlePreviewErasure(adminA, userDsrId);
    expect(previewUserRes.status).toBe(404);
    const executeUserRes = await handleExecuteErasure(adminA, userDsrId);
    expect(executeUserRes.status).toBe(404);

    const contactBId = await createContact(orgB);
    const contactDsrId = await fileDsr(adminB, "contact", contactBId);
    const previewContactRes = await handlePreviewErasure(adminA, contactDsrId);
    expect(previewContactRes.status).toBe(404);
    const executeContactRes = await handleExecuteErasure(adminA, contactDsrId);
    expect(executeContactRes.status).toBe(404);

    expect(orgA).toBeTruthy();
  });
});

describe("dispatch: RBAC/auth boundaries", () => {
  it("unauthenticated callers get 401 for preview and execute", async () => {
    expect((await handlePreviewErasure(null, randomUUID())).status).toBe(401);
    expect((await handleExecuteErasure(null, randomUUID())).status).toBe(401);
  });

  it("a non-org_admin (org_member) is rejected with 403 for a contact-type DSR", async () => {
    const admin = await createAuthUser("rbac-contact-admin");
    const orgId = await createStandaloneOrg(admin, "Dispatch RBAC Contact Org");
    const member = await createAuthUser("rbac-contact-member");
    await addMembership(member, orgId, "org_member");
    const contactId = await createContact(orgId);
    const dsrId = await fileDsr(admin, "contact", contactId);

    expect((await handlePreviewErasure(member, dsrId)).status).toBe(403);
    expect((await handleExecuteErasure(member, dsrId)).status).toBe(403);
  });

  it("an authenticated user with no org membership at all is rejected with 403, before any DSR lookup", async () => {
    const unaffiliated = await createAuthUser("rbac-unaffiliated");
    expect((await handlePreviewErasure(unaffiliated, randomUUID())).status).toBe(403);
    expect((await handleExecuteErasure(unaffiliated, randomUUID())).status).toBe(403);
  });
});

describe("database-level subject_type guards (defense-in-depth)", () => {
  it("preview_contact_erasure rejects a subject_type=user DSR even if called directly", async () => {
    const admin = await createAuthUser("guard-contact-vs-user-admin");
    const orgId = await createStandaloneOrg(admin, "Dispatch Guard Contact Vs User Org");
    const target = await createAuthUser("guard-contact-vs-user-target");
    await addMembership(target, orgId, "org_member");
    const dsrId = await fileDsr(admin, "user", target);

    await expect(previewContactErasure({ userId: admin }, dsrId)).rejects.toThrow(
      /preview_contact_erasure only supports subject_type=contact/,
    );
    await expect(executeContactErasure({ userId: admin }, dsrId)).rejects.toThrow(
      /execute_contact_erasure only supports subject_type=contact/,
    );
  });

  it("preview_user_erasure rejects a subject_type=contact DSR even if called directly", async () => {
    const admin = await createAuthUser("guard-user-vs-contact-admin");
    const orgId = await createStandaloneOrg(admin, "Dispatch Guard User Vs Contact Org");
    const contactId = await createContact(orgId);
    const dsrId = await fileDsr(admin, "contact", contactId);

    await expect(previewUserErasure({ userId: admin }, dsrId)).rejects.toThrow(
      /preview_user_erasure only supports subject_type=user/,
    );
    await expect(executeUserErasure({ userId: admin }, dsrId)).rejects.toThrow(
      /execute_user_erasure only supports subject_type=user/,
    );
  });
});
