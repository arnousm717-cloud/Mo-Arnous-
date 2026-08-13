import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withTenantContext, getPool, closePool } from "@ai-revenue-os/database";
import { handleRecordConsent } from "../app/api/v1/consent/handlers";
import { handleFileDataSubjectRequest } from "../app/api/v1/data-subject-requests/handlers";
import { handleGetDataSubjectRequest } from "../app/api/v1/data-subject-requests/[id]/handlers";
import { handlePreviewErasure } from "../app/api/v1/data-subject-requests/[id]/preview/handlers";
import { handleExecuteErasure } from "../app/api/v1/data-subject-requests/[id]/execute/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// getPool() connects via DATABASE_URL, which locally is the postgres
// superuser — used here for admin-bypass fixture setup, same pattern
// organizations-api.test.ts already established.
const adminPool = getPool();

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  const client = await adminPool.connect();
  try {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `compliance-api-${label}-${userId}@example.test`,
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
      `compliance-api-${randomUUID()}`,
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

async function jsonOf<T>(response: Response): Promise<T> {
  return response.json();
}

afterAll(async () => {
  await closePool();
});

describe("POST /api/v1/consent", () => {
  it("unauthenticated returns 401", async () => {
    const response = await handleRecordConsent(null, {});
    expect(response.status).toBe(401);
  });

  it("an org_admin can record consent", async () => {
    const userId = await createAuthUser("consent-admin");
    await createStandaloneOrg(userId, "Compliance API Consent Org");

    const response = await handleRecordConsent(userId, {
      subjectType: "contact",
      subjectId: randomUUID(),
      consentType: "marketing_email",
      status: "granted",
    });
    expect(response.status).toBe(201);
    const body = await jsonOf<{ consent: { status: string } }>(response);
    expect(body.consent.status).toBe("granted");
  });

  it("an org_member (non-admin) is rejected with 403", async () => {
    const admin = await createAuthUser("consent-member-admin");
    const orgId = await createStandaloneOrg(admin, "Compliance API Consent Member Org");
    const member = await createAuthUser("consent-member");
    await addMembership(member, orgId, "org_member");

    const response = await handleRecordConsent(member, {
      subjectType: "contact",
      subjectId: randomUUID(),
      consentType: "marketing_email",
      status: "granted",
    });
    expect(response.status).toBe(403);
  });

  it("rejects an invalid consentType with 400", async () => {
    const userId = await createAuthUser("consent-bad-type");
    await createStandaloneOrg(userId, "Compliance API Consent Bad Type Org");

    const response = await handleRecordConsent(userId, {
      subjectType: "contact",
      subjectId: randomUUID(),
      consentType: "not_a_real_type",
      status: "granted",
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/v1/data-subject-requests", () => {
  it("unauthenticated returns 401", async () => {
    const response = await handleFileDataSubjectRequest(null, {});
    expect(response.status).toBe(401);
  });

  it("an org_admin can file a delete request", async () => {
    const userId = await createAuthUser("dsr-file-admin");
    await createStandaloneOrg(userId, "Compliance API DSR File Org");

    const response = await handleFileDataSubjectRequest(userId, {
      subjectType: "user",
      subjectId: randomUUID(),
      requestType: "delete",
    });
    expect(response.status).toBe(201);
    const body = await jsonOf<{ dataSubjectRequest: { status: string } }>(response);
    expect(body.dataSubjectRequest.status).toBe("pending");
  });

  it("an org_viewer is rejected with 403", async () => {
    const admin = await createAuthUser("dsr-file-viewer-admin");
    const orgId = await createStandaloneOrg(admin, "Compliance API DSR Viewer Org");
    const viewer = await createAuthUser("dsr-file-viewer");
    await addMembership(viewer, orgId, "org_viewer");

    const response = await handleFileDataSubjectRequest(viewer, {
      subjectType: "user",
      subjectId: randomUUID(),
      requestType: "delete",
    });
    expect(response.status).toBe(403);
  });

  it("rejects requestType=access with 400 — only delete has fulfillment logic in M1.6", async () => {
    const userId = await createAuthUser("dsr-file-access-rejected");
    await createStandaloneOrg(userId, "Compliance API DSR Access Rejected Org");

    const response = await handleFileDataSubjectRequest(userId, {
      subjectType: "user",
      subjectId: randomUUID(),
      requestType: "access",
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /api/v1/data-subject-requests/{id}", () => {
  it("returns 404 for a request in a different organization", async () => {
    const ownerA = await createAuthUser("dsr-get-isolation-a");
    await createStandaloneOrg(ownerA, "Compliance API DSR Get Isolation A");
    const ownerB = await createAuthUser("dsr-get-isolation-b");
    const orgB = await createStandaloneOrg(ownerB, "Compliance API DSR Get Isolation B");

    const filed = await handleFileDataSubjectRequest(ownerB, {
      subjectType: "user",
      subjectId: randomUUID(),
      requestType: "delete",
    });
    const filedBody = await jsonOf<{ dataSubjectRequest: { id: string } }>(filed);

    const response = await handleGetDataSubjectRequest(ownerA, filedBody.dataSubjectRequest.id);
    expect(response.status).toBe(404);
    // The org actually exists — this asserts isolation, not a genuinely
    // nonexistent row.
    expect(orgB).toBeTruthy();
  });

  it("an org_admin can read their own org's request", async () => {
    const userId = await createAuthUser("dsr-get-own");
    await createStandaloneOrg(userId, "Compliance API DSR Get Own Org");

    const filed = await handleFileDataSubjectRequest(userId, {
      subjectType: "user",
      subjectId: randomUUID(),
      requestType: "delete",
    });
    const filedBody = await jsonOf<{ dataSubjectRequest: { id: string } }>(filed);

    const response = await handleGetDataSubjectRequest(userId, filedBody.dataSubjectRequest.id);
    expect(response.status).toBe(200);
  });
});

describe("POST /api/v1/data-subject-requests/{id}/preview and /execute", () => {
  it("preview and execute are rejected with 403 for a non-org_admin", async () => {
    const admin = await createAuthUser("dsr-exec-perm-admin");
    const orgId = await createStandaloneOrg(admin, "Compliance API DSR Exec Perm Org");
    const member = await createAuthUser("dsr-exec-perm-member");
    await addMembership(member, orgId, "org_member");

    const filed = await handleFileDataSubjectRequest(admin, {
      subjectType: "user",
      subjectId: randomUUID(),
      requestType: "delete",
    });
    const filedBody = await jsonOf<{ dataSubjectRequest: { id: string } }>(filed);

    const previewResponse = await handlePreviewErasure(member, filedBody.dataSubjectRequest.id);
    expect(previewResponse.status).toBe(403);

    const executeResponse = await handleExecuteErasure(member, filedBody.dataSubjectRequest.id);
    expect(executeResponse.status).toBe(403);
  });

  it("execute on the sole org_admin of another organization returns 409, not a silent failure", async () => {
    const caller = await createAuthUser("dsr-exec-blocker-caller");
    const target = await createAuthUser("dsr-exec-blocker-target");

    const orgX = await createStandaloneOrg(caller, "Compliance API DSR Exec Blocker Org X");
    await addMembership(target.toString(), orgX, "org_member");
    const orgY = await createStandaloneOrg(target, "Compliance API DSR Exec Blocker Org Y");

    const filed = await handleFileDataSubjectRequest(caller, {
      subjectType: "user",
      subjectId: target,
      requestType: "delete",
    });
    const filedBody = await jsonOf<{ dataSubjectRequest: { id: string } }>(filed);

    const previewResponse = await handlePreviewErasure(caller, filedBody.dataSubjectRequest.id);
    const previewBody = await jsonOf<{ preview: { canProceed: boolean; blockerReason: string } }>(previewResponse);
    expect(previewResponse.status).toBe(200);
    expect(previewBody.preview.canProceed).toBe(false);

    const executeResponse = await handleExecuteErasure(caller, filedBody.dataSubjectRequest.id);
    expect(executeResponse.status).toBe(409);

    // orgY is otherwise unused beyond being created as the blocking org —
    // referencing it keeps the fixture's intent explicit for a reader.
    expect(orgY).toBeTruthy();
  });
});
