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
import { withIdempotency } from "../app/api/v1/_shared/idempotency";

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

async function fileDsr(
  userId: string,
  subjectType: "user" | "contact" | "visitor" | "portal_user",
  subjectId: string,
): Promise<string> {
  const res = await handleFileDataSubjectRequest(userId, { subjectType, subjectId, requestType: "delete" }, null);
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

    const executeRes = await handleExecuteErasure(admin, dsrId, null);
    expect(executeRes.status).toBe(200);

    expect(await rowExists("auth.users", "id", target)).toBe(false);

    const replay = await handleExecuteErasure(admin, dsrId, null);
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

    const executeRes = await handleExecuteErasure(admin, dsrId, null);
    expect(executeRes.status).toBe(200);
    const executeBody = (await executeRes.json()) as { result: { targetContactId: string } };
    expect(executeBody.result.targetContactId).toBe(contactId);

    expect(await rowExists("public.contacts", "id", contactId)).toBe(false);

    const replay = await handleExecuteErasure(admin, dsrId, null);
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

      const executeRes = await handleExecuteErasure(admin, dsrId, null);
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

    const executeRes = await handleExecuteErasure(admin, randomUUID(), null);
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
    const executeUserRes = await handleExecuteErasure(adminA, userDsrId, null);
    expect(executeUserRes.status).toBe(404);

    const contactBId = await createContact(orgB);
    const contactDsrId = await fileDsr(adminB, "contact", contactBId);
    const previewContactRes = await handlePreviewErasure(adminA, contactDsrId);
    expect(previewContactRes.status).toBe(404);
    const executeContactRes = await handleExecuteErasure(adminA, contactDsrId, null);
    expect(executeContactRes.status).toBe(404);

    expect(orgA).toBeTruthy();
  });
});

describe("dispatch: RBAC/auth boundaries", () => {
  it("unauthenticated callers get 401 for preview and execute", async () => {
    expect((await handlePreviewErasure(null, randomUUID())).status).toBe(401);
    expect((await handleExecuteErasure(null, randomUUID(), null)).status).toBe(401);
  });

  it("a non-org_admin (org_member) is rejected with 403 for a contact-type DSR", async () => {
    const admin = await createAuthUser("rbac-contact-admin");
    const orgId = await createStandaloneOrg(admin, "Dispatch RBAC Contact Org");
    const member = await createAuthUser("rbac-contact-member");
    await addMembership(member, orgId, "org_member");
    const contactId = await createContact(orgId);
    const dsrId = await fileDsr(admin, "contact", contactId);

    expect((await handlePreviewErasure(member, dsrId)).status).toBe(403);
    expect((await handleExecuteErasure(member, dsrId, null)).status).toBe(403);
  });

  it("an authenticated user with no org membership at all is rejected with 403, before any DSR lookup", async () => {
    const unaffiliated = await createAuthUser("rbac-unaffiliated");
    expect((await handlePreviewErasure(unaffiliated, randomUUID())).status).toBe(403);
    expect((await handleExecuteErasure(unaffiliated, randomUUID(), null)).status).toBe(403);
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

/**
 * Milestone 2.5B. DSR execute is the highest-sensitivity route in this
 * milestone's approved scope — irreversible, and the entire reason 2.5B
 * paused to add atomic existingClient support to executeUserErasure/
 * executeContactErasure before wiring any of this. "no-key second
 * execution preserves existing DB-native rejection behavior" is already
 * covered by the pre-existing, unmodified "dispatch: subject_type=user
 * (regression)" test above (its own no-key replay already asserts 409) —
 * not duplicated here.
 */
describe("POST /api/v1/data-subject-requests/{id}/execute: idempotency", () => {
  it("first authorized request erases once; identical retry replays the exact cached success without erasing again", async () => {
    const admin = await createAuthUser("execute-idem-admin");
    const target = await createAuthUser("execute-idem-target");
    const orgId = await createStandaloneOrg(admin, "Dispatch Execute Idem Org");
    await addMembership(target, orgId, "org_member");
    const dsrId = await fileDsr(admin, "user", target);
    const key = randomUUID();

    const first = await handleExecuteErasure(admin, dsrId, key);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(await rowExists("auth.users", "id", target)).toBe(false);

    const auditNAfterFirst = await countRows(
      "select count(*)::int as n from public.audit_logs where action = 'data_subject_request.executed' and resource_id = $1",
      [target],
    );
    expect(auditNAfterFirst).toBe(1);

    const replay = await handleExecuteErasure(admin, dsrId, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    // The replay must not have invoked the erasure callback again — still
    // exactly one execution audit entry.
    const auditNAfterReplay = await countRows(
      "select count(*)::int as n from public.audit_logs where action = 'data_subject_request.executed' and resource_id = $1",
      [target],
    );
    expect(auditNAfterReplay).toBe(1);
  });

  it("same key + different body (a different dsrId): 409 IDEMPOTENCY_CONFLICT, structured envelope", async () => {
    const admin = await createAuthUser("execute-idem-conflict-admin");
    const targetA = await createAuthUser("execute-idem-conflict-target-a");
    const targetB = await createAuthUser("execute-idem-conflict-target-b");
    const orgId = await createStandaloneOrg(admin, "Dispatch Execute Idem Conflict Org");
    await addMembership(targetA, orgId, "org_member");
    await addMembership(targetB, orgId, "org_member");
    const dsrA = await fileDsr(admin, "user", targetA);
    const dsrB = await fileDsr(admin, "user", targetB);
    const key = randomUUID();

    const first = await handleExecuteErasure(admin, dsrA, key);
    expect(first.status).toBe(200);

    const conflict = await handleExecuteErasure(admin, dsrB, key);
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(body.error.request_id.length).toBeGreaterThan(0);

    // targetB must be untouched — the conflict must never have dispatched
    // to the real erasure at all.
    expect(await rowExists("auth.users", "id", targetB)).toBe(true);
  });

  it("revoked permission between the original request and a retry returns 403 — never the cached success", async () => {
    const admin = await createAuthUser("execute-idem-revoked-admin");
    const target = await createAuthUser("execute-idem-revoked-target");
    const orgId = await createStandaloneOrg(admin, "Dispatch Execute Idem Revoked Org");
    await addMembership(target, orgId, "org_member");
    const dsrId = await fileDsr(admin, "user", target);
    const key = randomUUID();

    const first = await handleExecuteErasure(admin, dsrId, key);
    expect(first.status).toBe(200);

    await setMembershipStatus(admin, orgId, "removed");
    const replay = await handleExecuteErasure(admin, dsrId, key);
    expect(replay.status).toBe(403);
  });

  it("same key in a different organization is fully isolated", async () => {
    const adminA = await createAuthUser("execute-idem-iso-admin-a");
    const targetA = await createAuthUser("execute-idem-iso-target-a");
    const orgA = await createStandaloneOrg(adminA, "Dispatch Execute Idem Iso Org A");
    await addMembership(targetA, orgA, "org_member");
    const dsrA = await fileDsr(adminA, "user", targetA);

    const adminB = await createAuthUser("execute-idem-iso-admin-b");
    const targetB = await createAuthUser("execute-idem-iso-target-b");
    const orgB = await createStandaloneOrg(adminB, "Dispatch Execute Idem Iso Org B");
    await addMembership(targetB, orgB, "org_member");
    const dsrB = await fileDsr(adminB, "user", targetB);

    const key = randomUUID();
    const resA = await handleExecuteErasure(adminA, dsrA, key);
    const resB = await handleExecuteErasure(adminB, dsrB, key);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(await rowExists("auth.users", "id", targetA)).toBe(false);
    expect(await rowExists("auth.users", "id", targetB)).toBe(false);
  });

  it("concurrency: two simultaneous identical requests result in exactly one real erasure and one replay", async () => {
    const admin = await createAuthUser("execute-idem-concurrent-admin");
    const target = await createAuthUser("execute-idem-concurrent-target");
    const orgId = await createStandaloneOrg(admin, "Dispatch Execute Idem Concurrent Org");
    await addMembership(target, orgId, "org_member");
    const dsrId = await fileDsr(admin, "user", target);
    const key = randomUUID();

    const [a, b] = await Promise.all([
      handleExecuteErasure(admin, dsrId, key),
      handleExecuteErasure(admin, dsrId, key),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await rowExists("auth.users", "id", target)).toBe(false);

    // Exactly one erasure ran — the callback was never invoked twice, even
    // though two identical requests arrived simultaneously.
    const auditN = await countRows(
      "select count(*)::int as n from public.audit_logs where action = 'data_subject_request.executed' and resource_id = $1",
      [target],
    );
    expect(auditN).toBe(1);
  });
});

describe("POST /api/v1/data-subject-requests/{id}/execute: failure-injection atomicity proof", () => {
  it("an injected failure after the erasure but before idempotency completion rolls back BOTH — the target survives, retry then erases exactly once", async () => {
    const admin = await createAuthUser("execute-idem-failure-admin");
    const target = await createAuthUser("execute-idem-failure-target");
    const orgId = await createStandaloneOrg(admin, "Dispatch Execute Idem Failure Org");
    await addMembership(target, orgId, "org_member");
    const dsrId = await fileDsr(admin, "user", target);
    const rawKey = randomUUID();

    await expect(
      withIdempotency(
        { userId: admin, organizationId: orgId, roleKey: "org_admin" },
        {
          rawIdempotencyKey: rawKey,
          method: "POST",
          route: `/api/v1/data-subject-requests/${dsrId}/execute`,
          body: {},
        },
        async (client) => {
          await executeUserErasure({ userId: admin }, dsrId, client);
          throw new Error("injected failure: simulated crash before idempotency completion");
        },
      ),
    ).rejects.toThrow("injected failure");

    // Rolled back entirely — the target must still exist, the DSR must
    // still be pending, and no idempotency row survives.
    expect(await rowExists("auth.users", "id", target)).toBe(true);
    expect(await rowExists("public.memberships", "user_id", target)).toBe(true);
    const dsrStatus = await countRows(
      "select count(*)::int as n from public.data_subject_requests where id = $1 and status = 'pending'",
      [dsrId],
    );
    expect(dsrStatus).toBe(1);
    const idempotencyN = await countRows("select count(*)::int as n from public.idempotency_keys where organization_id = $1", [
      orgId,
    ]);
    expect(idempotencyN).toBe(0);

    // A genuine retry through the real API now succeeds and actually
    // erases — nothing left behind to falsely replay or block it.
    const retry = await handleExecuteErasure(admin, dsrId, rawKey);
    expect(retry.status).toBe(200);
    expect(await rowExists("auth.users", "id", target)).toBe(false);
  });
});
