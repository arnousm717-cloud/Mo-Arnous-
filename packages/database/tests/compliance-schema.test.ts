import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Schema/RLS/grants for the four M1.6 compliance tables
 * (docs/03-Database-Architecture.md §2.8), built and tested before any
 * app-layer code per the approved M1.6 implementation order. Uses the
 * lighter direct-auth.users-row fixture pattern (matching
 * custom-domains.test.ts) since these tests only need a real users(id) to
 * satisfy FK constraints, not a full real GoTrue session.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `compliance-schema-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createStandaloneOrgAdmin(label: string, orgName: string): Promise<{ userId: string; organizationId: string }> {
  const userId = await createAuthUser(label);
  const organizationId = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      orgName,
      `compliance-schema-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0].organization_id as string;
  });
  return { userId, organizationId };
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("consent_records: org_admin read/write, cross-org isolation", () => {
  it("an org_admin can record consent for their own org", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("consent-write", "Consent Write Org");

    const row = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "insert into public.consent_records (organization_id, subject_type, subject_id, consent_type, status) values ($1, 'contact', $2, 'marketing_email', 'granted') returning id, status",
          [organizationId, randomUUID()],
        );
        return r.rows[0];
      },
    );
    expect(row.status).toBe("granted");
  });

  it("rejects an invalid consent_type", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("consent-bad-type", "Consent Bad Type Org");

    await expect(
      withTenantContext({ userId, organizationId, roleKey: "org_admin" }, async (client) => {
        await client.query(
          "insert into public.consent_records (organization_id, subject_type, subject_id, consent_type, status) values ($1, 'contact', $2, 'not_a_real_type', 'granted')",
          [organizationId, randomUUID()],
        );
      }),
    ).rejects.toThrow();
  });

  it("org A cannot read org B's consent records", async () => {
    const orgB = await createStandaloneOrgAdmin("consent-isolation-b", "Consent Isolation B");
    const orgA = await createStandaloneOrgAdmin("consent-isolation-a", "Consent Isolation A");

    await withTenantContext(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: "org_admin" },
      async (client) => {
        await client.query(
          "insert into public.consent_records (organization_id, subject_type, subject_id, consent_type, status) values ($1, 'contact', $2, 'marketing_email', 'granted')",
          [orgB.organizationId, randomUUID()],
        );
      },
    );

    const rows = await withTenantContext(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("select id from public.consent_records where organization_id = $1", [
          orgB.organizationId,
        ]);
        return r.rows;
      },
    );
    expect(rows).toHaveLength(0);
  });

  it("a non-org_admin role (org_member) cannot record consent", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("consent-member-denied", "Consent Member Denied Org");

    await expect(
      withTenantContext({ userId, organizationId, roleKey: "org_member" }, async (client) => {
        await client.query(
          "insert into public.consent_records (organization_id, subject_type, subject_id, consent_type, status) values ($1, 'contact', $2, 'marketing_email', 'granted')",
          [organizationId, randomUUID()],
        );
      }),
    ).rejects.toThrow();
  });
});

describe("data_subject_requests: due_at auto-set, org isolation", () => {
  it("due_at is automatically set to 30 days after requested_at", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("dsr-due-at", "DSR Due At Org");

    const row = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type) values ($1, 'user', $2, 'delete') returning requested_at, due_at",
          [organizationId, randomUUID()],
        );
        return r.rows[0];
      },
    );

    const requestedAt = new Date(row.requested_at).getTime();
    const dueAt = new Date(row.due_at).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(dueAt - requestedAt).toBe(thirtyDaysMs);
  });

  it("defaults to status=pending", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("dsr-default-status", "DSR Default Status Org");

    const row = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type) values ($1, 'user', $2, 'delete') returning status",
          [organizationId, randomUUID()],
        );
        return r.rows[0];
      },
    );
    expect(row.status).toBe("pending");
  });

  it("org A cannot read org B's data subject requests", async () => {
    const orgB = await createStandaloneOrgAdmin("dsr-isolation-b", "DSR Isolation B");
    const orgA = await createStandaloneOrgAdmin("dsr-isolation-a", "DSR Isolation A");

    await withTenantContext(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: "org_admin" },
      async (client) => {
        await client.query(
          "insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type) values ($1, 'user', $2, 'delete')",
          [orgB.organizationId, randomUUID()],
        );
      },
    );

    const rows = await withTenantContext(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "select id from public.data_subject_requests where organization_id = $1",
          [orgB.organizationId],
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(0);
  });

  it("an ordinary org_admin UPDATE is rejected — status transitions only happen via execute_user_erasure()", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("dsr-no-direct-update", "DSR No Direct Update Org");

    const dsrId = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type) values ($1, 'user', $2, 'delete') returning id",
          [organizationId, randomUUID()],
        );
        return r.rows[0].id as string;
      },
    );

    const updated = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "update public.data_subject_requests set status = 'completed' where id = $1 returning id",
          [dsrId],
        );
        return r.rows;
      },
    );
    // No RLS UPDATE policy exists at all — the statement succeeds (no
    // permission error) but matches zero rows, since RLS filters the
    // UPDATE's own row visibility to nothing without a policy granting it.
    expect(updated).toHaveLength(0);
  });
});

describe("audit_logs: append-only at the grant level", () => {
  it("an org_admin can insert an audit entry for their own org", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("audit-insert", "Audit Insert Org");

    const row = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "insert into public.audit_logs (organization_id, actor_user_id, action, resource_type, resource_id) values ($1, $2, 'test.action', 'test_resource', $3) returning id",
          [organizationId, userId, randomUUID()],
        );
        return r.rows[0];
      },
    );
    expect(row.id).toBeDefined();
  });

  it("UPDATE is rejected at the grant level — permission denied, not merely zero rows matched", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("audit-no-update", "Audit No Update Org");

    const logId = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "insert into public.audit_logs (organization_id, actor_user_id, action, resource_type, resource_id) values ($1, $2, 'test.action', 'test_resource', $3) returning id",
          [organizationId, userId, randomUUID()],
        );
        return r.rows[0].id as string;
      },
    );

    await expect(
      withTenantContext({ userId, organizationId, roleKey: "org_admin" }, async (client) => {
        await client.query("update public.audit_logs set action = 'tampered' where id = $1", [logId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("DELETE is rejected at the grant level", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("audit-no-delete", "Audit No Delete Org");

    const logId = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "insert into public.audit_logs (organization_id, actor_user_id, action, resource_type, resource_id) values ($1, $2, 'test.action', 'test_resource', $3) returning id",
          [organizationId, userId, randomUUID()],
        );
        return r.rows[0].id as string;
      },
    );

    await expect(
      withTenantContext({ userId, organizationId, roleKey: "org_admin" }, async (client) => {
        await client.query("delete from public.audit_logs where id = $1", [logId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("org A cannot read org B's audit log", async () => {
    const orgB = await createStandaloneOrgAdmin("audit-isolation-b", "Audit Isolation B");
    const orgA = await createStandaloneOrgAdmin("audit-isolation-a", "Audit Isolation A");

    await withTenantContext(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: "org_admin" },
      async (client) => {
        await client.query(
          "insert into public.audit_logs (organization_id, actor_user_id, action, resource_type, resource_id) values ($1, $2, 'test.action', 'test_resource', $3)",
          [orgB.organizationId, orgB.userId, randomUUID()],
        );
      },
    );

    const rows = await withTenantContext(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("select id from public.audit_logs where organization_id = $1", [
          orgB.organizationId,
        ]);
        return r.rows;
      },
    );
    expect(rows).toHaveLength(0);
  });
});

describe("data_retention_policies: read-only, platform defaults visible", () => {
  it("an org_admin can see platform-default rows (organization_id null)", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("retention-defaults", "Retention Defaults Org");

    const rows = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "select data_type from public.data_retention_policies where organization_id is null order by data_type",
        );
        return r.rows;
      },
    );
    // "contacts" joined the platform-default set in Milestone 2.1C
    // (docs/13-Technical-Design-Review.md "Milestone 2.1") — the first
    // CRM-table retention policy, alongside the three M1.6 originals.
    expect(rows.map((r) => r.data_type)).toEqual(["audit_logs", "consent_records", "contacts", "data_subject_requests"]);
  });
});

describe("data_subject_request_breaches: overdue detection (Decision E)", () => {
  it("a request with due_at in the past and status != completed is detectable via the breach view", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("breach-detect", "Breach Detect Org");

    const dsrId = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type) values ($1, 'user', $2, 'delete') returning id",
          [organizationId, randomUUID()],
        );
        return r.rows[0].id as string;
      },
    );

    // Backdate requested_at (and therefore due_at, via the same trigger
    // logic applied manually here since UPDATE doesn't re-fire the
    // BEFORE INSERT trigger) as the admin pool — simulating a request
    // filed 31 days ago that's still pending.
    await seedAsAdmin(async (client) => {
      await client.query(
        "update public.data_subject_requests set requested_at = now() - interval '31 days', due_at = now() - interval '1 day' where id = $1",
        [dsrId],
      );
    });

    const breaches = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("select id from public.data_subject_request_breaches where id = $1", [
          dsrId,
        ]);
        return r.rows;
      },
    );
    expect(breaches).toHaveLength(1);
  });

  it("a request with due_at in the future does NOT appear in the breach view", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("breach-not-yet", "Breach Not Yet Org");

    const dsrId = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type) values ($1, 'user', $2, 'delete') returning id",
          [organizationId, randomUUID()],
        );
        return r.rows[0].id as string;
      },
    );

    const breaches = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("select id from public.data_subject_request_breaches where id = $1", [
          dsrId,
        ]);
        return r.rows;
      },
    );
    expect(breaches).toHaveLength(0);
  });

  it("a completed request past due_at does NOT appear in the breach view", async () => {
    const { userId, organizationId } = await createStandaloneOrgAdmin("breach-completed", "Breach Completed Org");

    const dsrId = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query(
          "insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type) values ($1, 'user', $2, 'delete') returning id",
          [organizationId, randomUUID()],
        );
        return r.rows[0].id as string;
      },
    );

    await seedAsAdmin(async (client) => {
      await client.query(
        "update public.data_subject_requests set requested_at = now() - interval '31 days', due_at = now() - interval '1 day', status = 'completed' where id = $1",
        [dsrId],
      );
    });

    const breaches = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("select id from public.data_subject_request_breaches where id = $1", [
          dsrId,
        ]);
        return r.rows;
      },
    );
    expect(breaches).toHaveLength(0);
  });
});
