import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenantContext } from "@ai-revenue-os/database";
import { recordConsent, fileDataSubjectRequest, executeUserErasure, executeContactErasure } from "../src";
import { adminPool, rowExistsIn, seedAsAdmin } from "./helpers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.5B (pre-API-wiring atomicity proof, approved "Option A").
 * Proves the newly-added optional `existingClient` parameter on
 * recordConsent/fileDataSubjectRequest/executeUserErasure/
 * executeContactErasure actually participates in a caller-supplied
 * transaction — the entire reason 2.5B was paused and restarted, per the
 * STOP reported before this file existed. Every "participates" assertion
 * is proven by manually opening a transaction, running the mutation on
 * that same client, then rolling back and directly inspecting the
 * database — never by trusting the function's own return value alone,
 * matching this package's own established rigor (user-erasure.test.ts,
 * contact-erasure.test.ts).
 *
 * This file does not yet touch withIdempotency or any API route — it
 * proves the compliance functions are transaction-participation-capable
 * in isolation, exactly as Milestone 2.5B's Step 4 requires before any
 * route wiring begins.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `txn-participation-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createOrgWithOwner(ownerId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId: ownerId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `txn-participation-${randomUUID()}`,
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

async function createContact(organizationId: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, last_name) values ($1, 'Txn', 'Participation') returning id",
      [organizationId],
    );
    return r.rows[0]!.id;
  });
}

/** Opens a real transaction on its own admin connection and sets the
 * exact session state withTenantContext itself would set — mirrors
 * idempotency.test.ts's/pipeline-stages.test.ts's own established
 * "manually drive a transaction, pass its client in, then decide whether
 * to commit or roll back" pattern exactly. */
async function withManualTransaction<T>(
  ctx: { userId: string; organizationId?: string; roleKey?: string },
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<{ client: import("pg").PoolClient; result: T }> {
  const client = await adminPool.connect();
  await client.query("begin");
  await client.query("set local role authenticated");
  await client.query(
    "select set_config('request.jwt.claims', json_build_object('role','authenticated','sub',$1::text)::text, true)",
    [ctx.userId],
  );
  if (ctx.organizationId) {
    await client.query("select set_config('app.current_org', $1, true)", [ctx.organizationId]);
  }
  if (ctx.roleKey) {
    await client.query("select set_config('app.current_role', $1, true)", [ctx.roleKey]);
  }
  const result = await fn(client);
  return { client, result };
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("recordConsent: existingClient transaction participation", () => {
  it("existingClient omitted: behavior is unchanged — commits on its own", async () => {
    const admin = await createAuthUser("consent-no-client");
    const orgId = await createOrgWithOwner(admin, "Txn Participation Consent No-Client Org");
    const subjectId = randomUUID();

    const consent = await recordConsent(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId, consentType: "marketing_email", status: "granted" },
    );

    expect(await rowExistsIn("public.consent_records", "id", consent.id)).toBe(true);
    const auditRows = await seedAsAdmin((client) =>
      client.query("select id from public.audit_logs where action = 'consent.recorded' and resource_id = $1", [
        consent.id,
      ]),
    );
    expect(auditRows.rows).toHaveLength(1);
  });

  it("existingClient supplied: participates in the caller's transaction — a rollback removes both the consent record and its audit entry", async () => {
    const admin = await createAuthUser("consent-rollback");
    const orgId = await createOrgWithOwner(admin, "Txn Participation Consent Rollback Org");
    const subjectId = randomUUID();

    const { client, result: consent } = await withManualTransaction({ userId: admin, organizationId: orgId, roleKey: "org_admin" }, (txnClient) =>
      recordConsent(
        { userId: admin, organizationId: orgId, roleKey: "org_admin" },
        { subjectType: "contact", subjectId, consentType: "marketing_email", status: "granted" },
        txnClient,
      ),
    );

    // Visible inside the still-open outer transaction, on that same client
    // — proves the insert really ran there, not on a second connection.
    const insideTxn = await client.query("select id from public.consent_records where id = $1", [consent.id]);
    expect(insideTxn.rows).toHaveLength(1);

    await client.query("rollback");
    client.release();

    // Never committed — the row (and its audit entry) must not exist.
    expect(await rowExistsIn("public.consent_records", "id", consent.id)).toBe(false);
    const auditRows = await seedAsAdmin((adminClient) =>
      adminClient.query("select id from public.audit_logs where action = 'consent.recorded' and resource_id = $1", [
        consent.id,
      ]),
    );
    expect(auditRows.rows).toHaveLength(0);
  });
});

describe("fileDataSubjectRequest: existingClient transaction participation", () => {
  it("existingClient omitted: behavior is unchanged — commits on its own", async () => {
    const admin = await createAuthUser("dsr-no-client");
    const orgId = await createOrgWithOwner(admin, "Txn Participation DSR No-Client Org");

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "user", subjectId: randomUUID(), requestType: "delete" },
    );

    expect(await rowExistsIn("public.data_subject_requests", "id", dsr.id)).toBe(true);
    const auditRows = await seedAsAdmin((client) =>
      client.query(
        "select id from public.audit_logs where action = 'data_subject_request.created' and resource_id = $1",
        [dsr.id],
      ),
    );
    expect(auditRows.rows).toHaveLength(1);
  });

  it("existingClient supplied: participates in the caller's transaction — a rollback removes both the DSR row and its audit entry", async () => {
    const admin = await createAuthUser("dsr-rollback");
    const orgId = await createOrgWithOwner(admin, "Txn Participation DSR Rollback Org");

    const { client, result: dsr } = await withManualTransaction({ userId: admin, organizationId: orgId, roleKey: "org_admin" }, (txnClient) =>
      fileDataSubjectRequest(
        { userId: admin, organizationId: orgId, roleKey: "org_admin" },
        { subjectType: "user", subjectId: randomUUID(), requestType: "delete" },
        txnClient,
      ),
    );

    const insideTxn = await client.query("select id from public.data_subject_requests where id = $1", [dsr.id]);
    expect(insideTxn.rows).toHaveLength(1);

    await client.query("rollback");
    client.release();

    expect(await rowExistsIn("public.data_subject_requests", "id", dsr.id)).toBe(false);
    const auditRows = await seedAsAdmin((adminClient) =>
      adminClient.query(
        "select id from public.audit_logs where action = 'data_subject_request.created' and resource_id = $1",
        [dsr.id],
      ),
    );
    expect(auditRows.rows).toHaveLength(0);
  });
});

describe("executeUserErasure: existingClient transaction participation", () => {
  it("existingClient omitted: behavior is unchanged — commits on its own", async () => {
    const admin = await createAuthUser("execute-no-client-admin");
    const target = await createAuthUser("execute-no-client-target");
    const orgId = await createOrgWithOwner(admin, "Txn Participation Execute No-Client Org");
    await addMembership(target, orgId, "org_member");

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "user", subjectId: target, requestType: "delete" },
    );
    await executeUserErasure({ userId: admin }, dsr.id);

    expect(await rowExistsIn("auth.users", "id", target)).toBe(false);
  });

  it("existingClient supplied: participates in the caller's transaction — a rollback undoes the erasure entirely", async () => {
    const admin = await createAuthUser("execute-rollback-admin");
    const target = await createAuthUser("execute-rollback-target");
    const orgId = await createOrgWithOwner(admin, "Txn Participation Execute Rollback Org");
    await addMembership(target, orgId, "org_member");

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "user", subjectId: target, requestType: "delete" },
    );

    const { client } = await withManualTransaction({ userId: admin, organizationId: orgId, roleKey: "org_admin" }, (txnClient) =>
      executeUserErasure({ userId: admin }, dsr.id, txnClient),
    );

    // Visible as completed INSIDE the still-open transaction, on that same
    // client — proves the SECURITY DEFINER function's own writes really
    // ran on this connection, still uncommitted (auth.users itself isn't
    // readable under the `authenticated` role, so the DSR's own status is
    // the readable, RLS-scoped proxy for "did the erasure really run
    // here").
    const insideTxn = await client.query("select status from public.data_subject_requests where id = $1", [dsr.id]);
    expect(insideTxn.rows[0]?.status).toBe("completed");

    await client.query("rollback");
    client.release();

    // Never committed — the erasure must be fully undone.
    expect(await rowExistsIn("auth.users", "id", target)).toBe(true);
    expect(await rowExistsIn("public.memberships", "user_id", target)).toBe(true);
    const dsrAfterRollback = await seedAsAdmin((adminClient) =>
      adminClient.query("select status from public.data_subject_requests where id = $1", [dsr.id]),
    );
    expect(dsrAfterRollback.rows[0]?.status).toBe("pending");
  });
});

describe("executeContactErasure: existingClient transaction participation", () => {
  it("existingClient supplied: participates in the caller's transaction — a rollback undoes the erasure entirely", async () => {
    const admin = await createAuthUser("execute-contact-rollback-admin");
    const orgId = await createOrgWithOwner(admin, "Txn Participation Execute Contact Rollback Org");
    const contactId = await createContact(orgId);

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contactId, requestType: "delete" },
    );

    const { client } = await withManualTransaction({ userId: admin, organizationId: orgId, roleKey: "org_admin" }, (txnClient) =>
      executeContactErasure({ userId: admin }, dsr.id, txnClient),
    );

    // organizationId is set on this session, so RLS genuinely permits
    // seeing rows in this org — a 0-row result here is real evidence of
    // deletion, not RLS silently hiding everything.
    const insideTxn = await client.query("select 1 from public.contacts where id = $1", [contactId]);
    expect(insideTxn.rows).toHaveLength(0);
    const sanityCheck = await client.query("select count(*)::int as n from public.contacts where organization_id = $1", [
      orgId,
    ]);
    expect(sanityCheck.rows[0]?.n).toBe(0);

    await client.query("rollback");
    client.release();

    expect(await rowExistsIn("public.contacts", "id", contactId)).toBe(true);
  });
});
