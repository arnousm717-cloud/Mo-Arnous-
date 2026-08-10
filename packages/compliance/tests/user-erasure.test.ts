import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenantContext } from "@ai-revenue-os/database";
import { executeUserErasure, fileDataSubjectRequest, previewUserErasure } from "../src";
import { adminPool, rowExistsIn, seedAsAdmin } from "./helpers";

// Same well-known local Supabase CLI demo keys used throughout this
// monorepo's test suites — never valid against a real project.
const API_URL = "http://127.0.0.1:54321";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonClient = createClient(API_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * The single most important test file in M1.6 (TDR: "the highest
 * correctness bar in this milestone"). Exercises the actual
 * packages/compliance wrapper functions (fileDataSubjectRequest,
 * previewUserErasure, executeUserErasure) an API route will call, but
 * every assertion that matters verifies against the database directly —
 * never only a function's own return value — per the TDR's explicit
 * testing-strategy note: "the critical test is direct database inspection
 * post-DSR, not an API-level check." Uses real Supabase Auth identities
 * (matching packages/auth's tenant-isolation.test.ts/
 * rls-defense-in-depth.test.ts) rather than a bare auth.users row insert,
 * specifically because Decision B requires proving a real login attempt
 * fails post-erasure.
 */

const TEST_PASSWORD = "Correct horse battery staple 1!";

async function createRealUser(label: string): Promise<{ id: string; email: string }> {
  const email = `user-erasure-${label}-${randomUUID()}@example.test`;
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Test setup failed to create auth user: ${error?.message}`);
  return { id: data.user.id, email };
}

async function createOrgWithOwner(ownerId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId: ownerId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `user-erasure-${randomUUID()}`,
      ownerId,
    ]);
    return r.rows[0];
  });
  return result.organization_id as string;
}

async function addMembership(userId: string, organizationId: string, roleKey: string): Promise<void> {
  await seedAsAdmin(async (client) => {
    const roleRow = await client.query<{ id: string }>("select id from public.roles where key = $1", [roleKey]);
    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, organizationId, roleRow.rows[0]?.id],
    );
  });
}

const cleanupUserIds: string[] = [];

afterAll(async () => {
  // Best-effort — most fixtures are deleted BY the test itself (that's the
  // thing under test); this only cleans up survivors from a failed path.
  for (const id of cleanupUserIds) {
    await adminClient.auth.admin.deleteUser(id).catch(() => undefined);
  }
  await adminPool.end();
  await closePool();
});

describe("fileDataSubjectRequest / previewUserErasure / executeUserErasure: happy path", () => {
  it("erases a target org_member: auth.users, public.users, memberships all gone; login blocked; audit trail complete", async () => {
    const admin = await createRealUser("happy-admin");
    const target = await createRealUser("happy-target");
    cleanupUserIds.push(admin.id, target.id);

    const orgId = await createOrgWithOwner(admin.id, "Erasure Happy Path Org");
    await addMembership(target.id, orgId, "org_member");

    const dsr = await fileDataSubjectRequest(
      { userId: admin.id, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "user", subjectId: target.id, requestType: "delete" },
    );
    expect(dsr.status).toBe("pending");

    // --- preview: must not mutate anything ---
    const preview = await previewUserErasure({ userId: admin.id }, dsr.id);
    expect(preview.canProceed).toBe(true);
    expect(preview.blockerReason).toBeNull();
    expect(preview.targetUserId).toBe(target.id);
    expect(preview.membershipCount).toBe(1);
    expect(preview.affectedOrganizationIds).toEqual([orgId]);

    // Direct DB inspection — preview must be a true no-op.
    expect(await rowExistsIn("auth.users", "id", target.id)).toBe(true);
    const dsrAfterPreview = await seedAsAdmin(async (client) => {
      const r = await client.query("select status from public.data_subject_requests where id = $1", [dsr.id]);
      return r.rows[0];
    });
    expect(dsrAfterPreview.status).toBe("pending");

    // --- execute ---
    const execution = await executeUserErasure({ userId: admin.id }, dsr.id);
    expect(execution.targetUserId).toBe(target.id);
    expect(execution.membershipsRemoved).toBe(1);

    // --- direct database inspection (TDR's own required test shape) ---
    expect(await rowExistsIn("auth.users", "id", target.id)).toBe(false);
    expect(await rowExistsIn("public.users", "id", target.id)).toBe(false);
    expect(await rowExistsIn("public.memberships", "user_id", target.id)).toBe(false);

    const dsrAfterExecute = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select status, completed_at, handled_by from public.data_subject_requests where id = $1",
        [dsr.id],
      );
      return r.rows[0];
    });
    expect(dsrAfterExecute.status).toBe("completed");
    expect(dsrAfterExecute.completed_at).not.toBeNull();
    expect(dsrAfterExecute.handled_by).toBe(admin.id);

    const auditRows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select actor_user_id, resource_type, resource_id, organization_id from public.audit_logs where action = 'data_subject_request.executed' and resource_id = $1",
        [target.id],
      );
      return r.rows;
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor_user_id).toBe(admin.id);
    expect(auditRows[0].resource_type).toBe("user");
    expect(auditRows[0].organization_id).toBe(orgId);

    const filingAuditRows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select id from public.audit_logs where action = 'data_subject_request.created' and resource_id = $1",
        [dsr.id],
      );
      return r.rows;
    });
    expect(filingAuditRows).toHaveLength(1);

    // --- Decision B: a real login attempt must fail post-erasure ---
    const { data: signInAttempt, error: signInError } = await anonClient.auth.signInWithPassword({
      email: target.email,
      password: TEST_PASSWORD,
    });
    expect(signInAttempt.session).toBeNull();
    expect(signInError).not.toBeNull();

    // Only the admin fixture survives to be cleaned up — target is gone.
    cleanupUserIds.length = 0;
    cleanupUserIds.push(admin.id);
  });

  it("execute succeeds without any prior preview call — proves execute re-validates independently, not chained from preview", async () => {
    const admin = await createRealUser("no-preview-admin");
    const target = await createRealUser("no-preview-target");
    cleanupUserIds.push(admin.id, target.id);

    const orgId = await createOrgWithOwner(admin.id, "Erasure No Preview Org");
    await addMembership(target.id, orgId, "org_viewer");

    const dsr = await fileDataSubjectRequest(
      { userId: admin.id, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "user", subjectId: target.id, requestType: "delete" },
    );

    const execution = await executeUserErasure({ userId: admin.id }, dsr.id);
    expect(execution.targetUserId).toBe(target.id);
    expect(await rowExistsIn("auth.users", "id", target.id)).toBe(false);

    cleanupUserIds.length = 0;
    cleanupUserIds.push(admin.id);
  });

  it("filing a request_type other than delete is rejected before any database write", async () => {
    const admin = await createRealUser("non-delete-admin");
    cleanupUserIds.push(admin.id);
    const orgId = await createOrgWithOwner(admin.id, "Erasure Non Delete Org");

    await expect(
      fileDataSubjectRequest(
        { userId: admin.id, organizationId: orgId, roleKey: "org_admin" },
        { subjectType: "user", subjectId: randomUUID(), requestType: "access" },
      ),
    ).rejects.toThrow(/only 'delete' is supported/);
  });
});

describe("executeUserErasure: sole org_admin blocker (Decision C)", () => {
  it("preview reports the blocker and execute independently rejects it — nothing is deleted", async () => {
    const caller = await createRealUser("blocker-caller");
    const target = await createRealUser("blocker-target");
    cleanupUserIds.push(caller.id, target.id);

    // orgX: caller is org_admin, target is an ordinary member — this is
    // what makes caller authorized to file/act on a DSR against target.
    const orgX = await createOrgWithOwner(caller.id, "Erasure Blocker Org X");
    await addMembership(target.id, orgX, "org_member");

    // orgY: target created it themselves — target is its SOLE org_admin.
    const orgY = await createOrgWithOwner(target.id, "Erasure Blocker Org Y (target is sole admin)");

    const dsr = await fileDataSubjectRequest(
      { userId: caller.id, organizationId: orgX, roleKey: "org_admin" },
      { subjectType: "user", subjectId: target.id, requestType: "delete" },
    );

    const preview = await previewUserErasure({ userId: caller.id }, dsr.id);
    expect(preview.canProceed).toBe(false);
    expect(preview.blockerReason).toMatch(/sole active org_admin/i);
    expect(preview.affectedOrganizationIds).toEqual([orgY]);

    await expect(executeUserErasure({ userId: caller.id }, dsr.id)).rejects.toThrow(/sole active org_admin/i);

    // Direct DB inspection — the blocker must have prevented ANY deletion,
    // and the DSR must remain pending (preview surfaced this BEFORE any
    // destructive action, per Decision C).
    expect(await rowExistsIn("auth.users", "id", target.id)).toBe(true);
    expect(await rowExistsIn("public.memberships", "user_id", target.id)).toBe(true);
    const dsrAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select status from public.data_subject_requests where id = $1", [dsr.id]);
      return r.rows[0];
    });
    expect(dsrAfter.status).toBe("pending");
  });
});

describe("previewUserErasure / executeUserErasure: authorization boundary", () => {
  it("a caller with no shared organization with the target is rejected", async () => {
    const caller = await createRealUser("unrelated-caller");
    const target = await createRealUser("unrelated-target");
    cleanupUserIds.push(caller.id, target.id);

    await createOrgWithOwner(caller.id, "Erasure Unrelated Caller Org");
    const targetOrgId = await createOrgWithOwner(target.id, "Erasure Unrelated Target Org");

    // Filed by the target's own (legitimate) org_admin context — caller
    // has no relationship to it at all.
    const dsr = await fileDataSubjectRequest(
      { userId: target.id, organizationId: targetOrgId, roleKey: "org_admin" },
      { subjectType: "user", subjectId: target.id, requestType: "delete" },
    );

    await expect(previewUserErasure({ userId: caller.id }, dsr.id)).rejects.toThrow(/not an active org_admin/i);
    await expect(executeUserErasure({ userId: caller.id }, dsr.id)).rejects.toThrow(/not an active org_admin/i);

    expect(await rowExistsIn("auth.users", "id", target.id)).toBe(true);
  });

  it("p_caller_user_id must match the authenticated caller — cannot impersonate another user id", async () => {
    const admin = await createRealUser("impersonation-admin");
    const impersonated = await createRealUser("impersonation-victim");
    cleanupUserIds.push(admin.id, impersonated.id);

    const orgId = await createOrgWithOwner(admin.id, "Erasure Impersonation Org");
    const dsr = await fileDataSubjectRequest(
      { userId: admin.id, organizationId: orgId, roleKey: "org_admin" },
      // subject_id is irrelevant to this test — the impersonation check is
      // the first thing either function does, before the DSR row (or its
      // subject) is even looked up.
      { subjectType: "user", subjectId: randomUUID(), requestType: "delete" },
    );

    // Authenticated as `admin` (auth.uid() = admin.id via withTenantContext
    // inside previewUserErasure) but the SQL call's p_caller_user_id param
    // is forced to a different id by calling the function directly under
    // admin's own session — this proves the SQL-level guard independent of
    // the wrapper always passing ctx.userId honestly.
    await expect(
      withTenantContext({ userId: admin.id }, async (client) => {
        await client.query("select * from public.preview_user_erasure($1, $2)", [dsr.id, impersonated.id]);
      }),
    ).rejects.toThrow(/p_caller_user_id must match the authenticated caller/);
  });
});
