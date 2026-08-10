import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withTenantContext, closePool } from "@ai-revenue-os/database";
import { fileDataSubjectRequest, recordConsent } from "../src";
import { adminPool, seedAsAdmin } from "./helpers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * M1.6 constraint #9/#13: audit logging must be synchronous and
 * transactionally aligned with the action being logged, and every DSR
 * lifecycle transition must produce a complete audit entry. The
 * data_subject_request.executed transition (the highest-stakes one) is
 * already covered end-to-end in user-erasure.test.ts, including its
 * synchronicity with the actual hard delete; this file covers the two
 * lighter-weight write paths — consent recording and DSR filing — which
 * don't go through a SECURITY DEFINER function and instead write both rows
 * from the application layer inside one withTenantContext transaction.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `audit-completeness-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createOrgWithOwner(ownerId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId: ownerId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `audit-completeness-${randomUUID()}`,
      ownerId,
    ]);
    return r.rows[0];
  });
  return result.organization_id as string;
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("audit-log completeness: consent.recorded", () => {
  it("recording consent produces exactly one matching audit_logs entry", async () => {
    const admin = await createAuthUser("consent-audit");
    const orgId = await createOrgWithOwner(admin, "Audit Completeness Consent Org");
    const subjectId = randomUUID();

    const consent = await recordConsent(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId, consentType: "marketing_email", status: "granted" },
    );

    const auditRows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select actor_user_id, organization_id, resource_type, resource_id, after from public.audit_logs where action = 'consent.recorded' and resource_id = $1",
        [consent.id],
      );
      return r.rows;
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor_user_id).toBe(admin);
    expect(auditRows[0].organization_id).toBe(orgId);
    expect(auditRows[0].resource_type).toBe("consent_record");
    expect(auditRows[0].after.subject_id).toBe(subjectId);
    expect(auditRows[0].after.status).toBe("granted");
  });
});

describe("audit-log completeness: data_subject_request.created", () => {
  it("filing a request produces exactly one matching audit_logs entry", async () => {
    const admin = await createAuthUser("dsr-created-audit");
    const orgId = await createOrgWithOwner(admin, "Audit Completeness DSR Org");
    const subjectId = randomUUID();

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "user", subjectId, requestType: "delete" },
    );

    const auditRows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select actor_user_id, organization_id, resource_type, resource_id, after from public.audit_logs where action = 'data_subject_request.created' and resource_id = $1",
        [dsr.id],
      );
      return r.rows;
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor_user_id).toBe(admin);
    expect(auditRows[0].organization_id).toBe(orgId);
    expect(auditRows[0].resource_type).toBe("data_subject_request");
    expect(auditRows[0].after.subject_id).toBe(subjectId);
    expect(auditRows[0].after.request_type).toBe("delete");
  });

  it("a failed filing attempt (unsupported request_type) writes no audit entry at all", async () => {
    const admin = await createAuthUser("dsr-created-audit-failure");
    const orgId = await createOrgWithOwner(admin, "Audit Completeness DSR Failure Org");
    const subjectId = randomUUID();

    await expect(
      fileDataSubjectRequest(
        { userId: admin, organizationId: orgId, roleKey: "org_admin" },
        { subjectType: "user", subjectId, requestType: "access" },
      ),
    ).rejects.toThrow();

    const auditRows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select id from public.audit_logs where actor_user_id = $1 and action = 'data_subject_request.created'",
        [admin],
      );
      return r.rows;
    });
    expect(auditRows).toHaveLength(0);
  });
});
