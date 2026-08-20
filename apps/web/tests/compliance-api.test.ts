import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withTenantContext, getPool, closePool } from "@ai-revenue-os/database";
import { recordConsent, fileDataSubjectRequest } from "@ai-revenue-os/compliance";
import { handleRecordConsent } from "../app/api/v1/consent/handlers";
import { handleFileDataSubjectRequest } from "../app/api/v1/data-subject-requests/handlers";
import { handleGetDataSubjectRequest } from "../app/api/v1/data-subject-requests/[id]/handlers";
import { handlePreviewErasure } from "../app/api/v1/data-subject-requests/[id]/preview/handlers";
import { handleExecuteErasure } from "../app/api/v1/data-subject-requests/[id]/execute/handlers";
import { withIdempotency } from "../app/api/v1/_shared/idempotency";

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

async function setMembershipStatus(userId: string, organizationId: string, status: string): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("update public.memberships set status = $1 where user_id = $2 and organization_id = $3", [
      status,
      userId,
      organizationId,
    ]);
  } finally {
    client.release();
  }
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ n: string }>(sql, params);
    return Number(r.rows[0]?.n ?? 0);
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await closePool();
});

describe("POST /api/v1/consent", () => {
  it("unauthenticated returns 401", async () => {
    const response = await handleRecordConsent(null, {}, null);
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
    }, null);
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
    }, null);
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
    }, null);
    expect(response.status).toBe(400);
  });
});

describe("POST /api/v1/data-subject-requests", () => {
  it("unauthenticated returns 401", async () => {
    const response = await handleFileDataSubjectRequest(null, {}, null);
    expect(response.status).toBe(401);
  });

  it("an org_admin can file a delete request", async () => {
    const userId = await createAuthUser("dsr-file-admin");
    await createStandaloneOrg(userId, "Compliance API DSR File Org");

    const response = await handleFileDataSubjectRequest(userId, {
      subjectType: "user",
      subjectId: randomUUID(),
      requestType: "delete",
    }, null);
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
    }, null);
    expect(response.status).toBe(403);
  });

  it("rejects requestType=access with 400 — only delete has fulfillment logic in M1.6", async () => {
    const userId = await createAuthUser("dsr-file-access-rejected");
    await createStandaloneOrg(userId, "Compliance API DSR Access Rejected Org");

    const response = await handleFileDataSubjectRequest(userId, {
      subjectType: "user",
      subjectId: randomUUID(),
      requestType: "access",
    }, null);
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
    }, null);
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
    }, null);
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
    }, null);
    const filedBody = await jsonOf<{ dataSubjectRequest: { id: string } }>(filed);

    const previewResponse = await handlePreviewErasure(member, filedBody.dataSubjectRequest.id);
    expect(previewResponse.status).toBe(403);

    const executeResponse = await handleExecuteErasure(member, filedBody.dataSubjectRequest.id, null);
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
    }, null);
    const filedBody = await jsonOf<{ dataSubjectRequest: { id: string } }>(filed);

    const previewResponse = await handlePreviewErasure(caller, filedBody.dataSubjectRequest.id);
    const previewBody = await jsonOf<{ preview: { canProceed: boolean; blockerReason: string } }>(previewResponse);
    expect(previewResponse.status).toBe(200);
    expect(previewBody.preview.canProceed).toBe(false);

    const executeResponse = await handleExecuteErasure(caller, filedBody.dataSubjectRequest.id, null);
    expect(executeResponse.status).toBe(409);

    // orgY is otherwise unused beyond being created as the blocking org —
    // referencing it keeps the fixture's intent explicit for a reader.
    expect(orgY).toBeTruthy();
  });
});

/**
 * Milestone 2.5B. Same idempotency contract every other resource already
 * has (companies-api.test.ts is the template): optional Idempotency-Key,
 * exact replay on same key+body, 409 IDEMPOTENCY_CONFLICT on same key +
 * different body, cross-org isolation, auth/RBAC re-run before any replay
 * is ever consulted. What's new here (not present in the CRM resources'
 * own tests): a direct row-count assertion that a replay never re-runs
 * the mutation's own side effect (the audit_logs entry), since that's the
 * entire reason 2.5B needed the Option A atomicity fix in the first
 * place.
 */
describe("POST /api/v1/consent: idempotency", () => {
  it("no Idempotency-Key: behavior is unchanged from before 2.5B", async () => {
    const userId = await createAuthUser("consent-idem-no-key");
    await createStandaloneOrg(userId, "Compliance API Consent Idem No-Key Org");

    const response = await handleRecordConsent(
      userId,
      { subjectType: "contact", subjectId: randomUUID(), consentType: "marketing_email", status: "granted" },
      null,
    );
    expect(response.status).toBe(201);
  });

  it("same key + same body: exact replay, the mutation and its audit side effect run exactly once", async () => {
    const userId = await createAuthUser("consent-idem-replay");
    const orgId = await createStandaloneOrg(userId, "Compliance API Consent Idem Replay Org");
    const key = randomUUID();
    const body = { subjectType: "contact", subjectId: randomUUID(), consentType: "marketing_email", status: "granted" };

    const first = await handleRecordConsent(userId, body, key);
    const second = await handleRecordConsent(userId, body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await jsonOf(first)).toEqual(await jsonOf(second));

    const n = await countRows(
      "select count(*)::int as n from public.consent_records where organization_id = $1 and subject_id = $2",
      [orgId, body.subjectId],
    );
    expect(n).toBe(1);
    const auditN = await countRows(
      "select count(*)::int as n from public.audit_logs where action = 'consent.recorded' and organization_id = $1",
      [orgId],
    );
    expect(auditN).toBe(1);
  });

  it("same key + different body: 409 IDEMPOTENCY_CONFLICT, structured envelope, no second record created", async () => {
    const userId = await createAuthUser("consent-idem-conflict");
    const orgId = await createStandaloneOrg(userId, "Compliance API Consent Idem Conflict Org");
    const key = randomUUID();

    await handleRecordConsent(
      userId,
      { subjectType: "contact", subjectId: randomUUID(), consentType: "marketing_email", status: "granted" },
      key,
    );
    const conflict = await handleRecordConsent(
      userId,
      { subjectType: "contact", subjectId: randomUUID(), consentType: "marketing_email", status: "withdrawn" },
      key,
    );
    expect(conflict.status).toBe(409);
    const body = (await jsonOf<{ error: { code: string; message: string; request_id: string } }>(conflict)) as {
      error: { code: string; message: string; request_id: string };
    };
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(typeof body.error.request_id).toBe("string");
    expect(body.error.request_id.length).toBeGreaterThan(0);

    const n = await countRows("select count(*)::int as n from public.consent_records where organization_id = $1", [
      orgId,
    ]);
    expect(n).toBe(1);
  });

  it("legitimate distinct consent events (no key, or a fresh key) are never suppressed", async () => {
    const userId = await createAuthUser("consent-idem-distinct");
    const orgId = await createStandaloneOrg(userId, "Compliance API Consent Idem Distinct Org");
    const subjectId = randomUUID();

    await handleRecordConsent(
      userId,
      { subjectType: "contact", subjectId, consentType: "marketing_email", status: "granted" },
      null,
    );
    await handleRecordConsent(
      userId,
      { subjectType: "contact", subjectId, consentType: "marketing_email", status: "withdrawn" },
      null,
    );

    const n = await countRows(
      "select count(*)::int as n from public.consent_records where organization_id = $1 and subject_id = $2",
      [orgId, subjectId],
    );
    expect(n).toBe(2);
  });

  it("same key in a different organization is fully isolated", async () => {
    const userA = await createAuthUser("consent-idem-iso-a");
    const userB = await createAuthUser("consent-idem-iso-b");
    await createStandaloneOrg(userA, "Compliance API Consent Idem Iso Org A");
    await createStandaloneOrg(userB, "Compliance API Consent Idem Iso Org B");
    const key = randomUUID();

    const resA = await handleRecordConsent(
      userA,
      { subjectType: "contact", subjectId: randomUUID(), consentType: "marketing_email", status: "granted" },
      key,
    );
    const resB = await handleRecordConsent(
      userB,
      { subjectType: "contact", subjectId: randomUUID(), consentType: "marketing_email", status: "granted" },
      key,
    );
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
  });

  it("a demoted/forbidden caller cannot retrieve a cached replay — 403 before idempotency is ever consulted", async () => {
    const admin = await createAuthUser("consent-idem-demoted-admin");
    const orgId = await createStandaloneOrg(admin, "Compliance API Consent Idem Demoted Org");
    const key = randomUUID();
    const body = { subjectType: "contact", subjectId: randomUUID(), consentType: "marketing_email", status: "granted" };

    const first = await handleRecordConsent(admin, body, key);
    expect(first.status).toBe(201);

    await setMembershipStatus(admin, orgId, "removed");
    const replay = await handleRecordConsent(admin, body, key);
    expect(replay.status).toBe(403);
  });
});

describe("POST /api/v1/data-subject-requests: idempotency", () => {
  it("no Idempotency-Key: behavior is unchanged from before 2.5B", async () => {
    const userId = await createAuthUser("dsr-idem-no-key");
    await createStandaloneOrg(userId, "Compliance API DSR Idem No-Key Org");

    const response = await handleFileDataSubjectRequest(
      userId,
      { subjectType: "user", subjectId: randomUUID(), requestType: "delete" },
      null,
    );
    expect(response.status).toBe(201);
  });

  it("same key + same body: exact replay, one DSR and one audit entry only", async () => {
    const userId = await createAuthUser("dsr-idem-replay");
    const orgId = await createStandaloneOrg(userId, "Compliance API DSR Idem Replay Org");
    const key = randomUUID();
    const subjectId = randomUUID();
    const body = { subjectType: "user", subjectId, requestType: "delete" };

    const first = await handleFileDataSubjectRequest(userId, body, key);
    const second = await handleFileDataSubjectRequest(userId, body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await jsonOf(first)).toEqual(await jsonOf(second));

    const n = await countRows(
      "select count(*)::int as n from public.data_subject_requests where organization_id = $1 and subject_id = $2",
      [orgId, subjectId],
    );
    expect(n).toBe(1);
    const auditN = await countRows(
      "select count(*)::int as n from public.audit_logs where action = 'data_subject_request.created' and organization_id = $1",
      [orgId],
    );
    expect(auditN).toBe(1);
  });

  it("same key + different body: 409 IDEMPOTENCY_CONFLICT, structured envelope, no second DSR created", async () => {
    const userId = await createAuthUser("dsr-idem-conflict");
    const orgId = await createStandaloneOrg(userId, "Compliance API DSR Idem Conflict Org");
    const key = randomUUID();

    await handleFileDataSubjectRequest(userId, { subjectType: "user", subjectId: randomUUID(), requestType: "delete" }, key);
    const conflict = await handleFileDataSubjectRequest(
      userId,
      { subjectType: "user", subjectId: randomUUID(), requestType: "delete" },
      key,
    );
    expect(conflict.status).toBe(409);
    const body = (await jsonOf<{ error: { code: string } }>(conflict)) as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    const n = await countRows("select count(*)::int as n from public.data_subject_requests where organization_id = $1", [
      orgId,
    ]);
    expect(n).toBe(1);
  });

  it("same key in a different organization is fully isolated", async () => {
    const userA = await createAuthUser("dsr-idem-iso-a");
    const userB = await createAuthUser("dsr-idem-iso-b");
    await createStandaloneOrg(userA, "Compliance API DSR Idem Iso Org A");
    await createStandaloneOrg(userB, "Compliance API DSR Idem Iso Org B");
    const key = randomUUID();

    const resA = await handleFileDataSubjectRequest(
      userA,
      { subjectType: "user", subjectId: randomUUID(), requestType: "delete" },
      key,
    );
    const resB = await handleFileDataSubjectRequest(
      userB,
      { subjectType: "user", subjectId: randomUUID(), requestType: "delete" },
      key,
    );
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
  });

  it("a demoted/forbidden caller cannot retrieve a cached replay — 403 before idempotency is ever consulted", async () => {
    const admin = await createAuthUser("dsr-idem-demoted-admin");
    const orgId = await createStandaloneOrg(admin, "Compliance API DSR Idem Demoted Org");
    const key = randomUUID();
    const body = { subjectType: "user", subjectId: randomUUID(), requestType: "delete" };

    const first = await handleFileDataSubjectRequest(admin, body, key);
    expect(first.status).toBe(201);

    await setMembershipStatus(admin, orgId, "removed");
    const replay = await handleFileDataSubjectRequest(admin, body, key);
    expect(replay.status).toBe(403);
  });
});

/**
 * Milestone 2.5B failure-injection proof — the exact atomicity issue that
 * paused this milestone (packages/compliance functions previously always
 * opened their own independent transaction, so a failure between the
 * mutation committing and the idempotency reservation completing could
 * leave a real side effect with no idempotency record to prevent a
 * duplicate on retry). Forces that exact failure window via a raw SQL
 * fault injected inside the SAME transaction, after recordConsent's own
 * insert has run on the shared client — proving the whole thing rolls
 * back together, not just proving the two functions can share a client.
 */
describe("POST /api/v1/consent: failure-injection atomicity proof", () => {
  it("recordConsent's insert commits, then an injected failure before idempotency completion rolls back BOTH — no orphaned consent record, no orphaned audit row, no idempotency row; a real retry then succeeds exactly once", async () => {
    const userId = await createAuthUser("consent-idem-failure");
    const orgId = await createStandaloneOrg(userId, "Compliance API Consent Idem Failure Org");
    const rawKey = randomUUID();
    const subjectId = randomUUID();

    // Drives withIdempotency directly (not through the handler) so a
    // failure can be injected AFTER recordConsent's own INSERT has run on
    // the shared client but BEFORE withIdempotency's own reservation
    // ever reaches its completion UPDATE/commit — the exact window that
    // caused this milestone's STOP. recordConsent(actor, input, client)
    // is called exactly as handleRecordConsent itself calls it.
    await expect(
      withIdempotency(
        { userId, organizationId: orgId, roleKey: "org_admin" },
        {
          rawIdempotencyKey: rawKey,
          method: "POST",
          route: "/api/v1/consent",
          body: { subjectType: "contact", subjectId, consentType: "marketing_email", status: "granted" },
        },
        async (client) => {
          await recordConsent(
            { userId, organizationId: orgId, roleKey: "org_admin" },
            { subjectType: "contact", subjectId, consentType: "marketing_email", status: "granted" },
            client,
          );
          // Injected failure — simulates any unexpected error occurring
          // between the mutation and the reservation's own completion.
          throw new Error("injected failure: simulated crash before idempotency completion");
        },
      ),
    ).rejects.toThrow("injected failure");

    // Nothing survived — the consent record, its audit entry, AND the
    // idempotency reservation itself must all be gone, proving they
    // really shared one atomic transaction boundary.
    const consentN = await countRows(
      "select count(*)::int as n from public.consent_records where organization_id = $1 and subject_id = $2",
      [orgId, subjectId],
    );
    expect(consentN).toBe(0);
    const auditN = await countRows(
      "select count(*)::int as n from public.audit_logs where action = 'consent.recorded' and organization_id = $1",
      [orgId],
    );
    expect(auditN).toBe(0);
    const idempotencyN = await countRows(
      "select count(*)::int as n from public.idempotency_keys where organization_id = $1",
      [orgId],
    );
    expect(idempotencyN).toBe(0);

    // A genuine retry through the real API (same key) now succeeds —
    // nothing left behind to conflict with or falsely replay.
    const retry = await handleRecordConsent(
      userId,
      { subjectType: "contact", subjectId, consentType: "marketing_email", status: "granted" },
      rawKey,
    );
    expect(retry.status).toBe(201);

    const finalN = await countRows(
      "select count(*)::int as n from public.consent_records where organization_id = $1 and subject_id = $2",
      [orgId, subjectId],
    );
    expect(finalN).toBe(1);
  });
});

describe("POST /api/v1/data-subject-requests: failure-injection atomicity proof", () => {
  it("fileDataSubjectRequest's insert commits, then an injected failure before idempotency completion rolls back BOTH — retry then succeeds exactly once", async () => {
    const userId = await createAuthUser("dsr-idem-failure");
    const orgId = await createStandaloneOrg(userId, "Compliance API DSR Idem Failure Org");
    const rawKey = randomUUID();
    const subjectId = randomUUID();

    await expect(
      withIdempotency(
        { userId, organizationId: orgId, roleKey: "org_admin" },
        {
          rawIdempotencyKey: rawKey,
          method: "POST",
          route: "/api/v1/data-subject-requests",
          body: { subjectType: "user", subjectId, requestType: "delete" },
        },
        async (client) => {
          await fileDataSubjectRequest(
            { userId, organizationId: orgId, roleKey: "org_admin" },
            { subjectType: "user", subjectId, requestType: "delete" },
            client,
          );
          throw new Error("injected failure: simulated crash before idempotency completion");
        },
      ),
    ).rejects.toThrow("injected failure");

    const dsrN = await countRows(
      "select count(*)::int as n from public.data_subject_requests where organization_id = $1 and subject_id = $2",
      [orgId, subjectId],
    );
    expect(dsrN).toBe(0);
    const auditN = await countRows(
      "select count(*)::int as n from public.audit_logs where action = 'data_subject_request.created' and organization_id = $1",
      [orgId],
    );
    expect(auditN).toBe(0);
    const idempotencyN = await countRows(
      "select count(*)::int as n from public.idempotency_keys where organization_id = $1",
      [orgId],
    );
    expect(idempotencyN).toBe(0);

    const retry = await handleFileDataSubjectRequest(
      userId,
      { subjectType: "user", subjectId, requestType: "delete" },
      rawKey,
    );
    expect(retry.status).toBe(201);

    const finalN = await countRows(
      "select count(*)::int as n from public.data_subject_requests where organization_id = $1 and subject_id = $2",
      [orgId, subjectId],
    );
    expect(finalN).toBe(1);
  });
});
