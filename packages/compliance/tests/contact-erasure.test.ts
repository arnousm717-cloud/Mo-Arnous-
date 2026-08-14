import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, withTenantContext } from "@ai-revenue-os/database";
import {
  executeContactErasure,
  executeUserErasure,
  fileDataSubjectRequest,
  previewContactErasure,
} from "../src";
import { adminPool, rowExistsIn, seedAsAdmin } from "./helpers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.1C: contacts GDPR/DSR erasure (docs/13-Technical-Design-
 * Review.md "Milestone 2.1" — Detailed design). Mirrors
 * user-erasure.test.ts's own rigor and shape exactly — every assertion
 * that matters verifies against the database directly, never only a
 * function's own return value. Unlike user erasure, a contact has no
 * memberships/roles of its own, so the authorization boundary under test
 * here is specifically the DSR-organization-to-contact-organization
 * binding, not a "sole org_admin" blocker (contacts have no analog to
 * that — nothing depends on a contact the way an organization depends on
 * having at least one admin).
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `contact-erasure-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createOrgWithOwner(ownerId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId: ownerId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `contact-erasure-${randomUUID()}`,
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

async function createContact(
  organizationId: string,
  overrides: { firstName?: string; email?: string; companyId?: string | null; deletedAt?: Date } = {},
): Promise<{ id: string; firstName: string; email: string }> {
  const firstName = overrides.firstName ?? "Erasure Test Contact";
  const email = overrides.email ?? `contact-${randomUUID()}@example.test`;
  const row = await seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, email, company_id, deleted_at) values ($1, $2, $3, $4, $5) returning id",
      [organizationId, firstName, email, overrides.companyId ?? null, overrides.deletedAt ?? null],
    );
    return r.rows[0]!;
  });
  return { id: row.id, firstName, email };
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("data_retention_policies: contacts platform default", () => {
  it("a platform-default retention row exists for contacts with the approved 2555-day value", async () => {
    const row = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select retention_days from public.data_retention_policies where data_type = 'contacts' and organization_id is null",
      );
      return r.rows[0];
    });
    expect(row).toBeDefined();
    expect(row.retention_days).toBe(2555);
  });
});

describe("previewContactErasure: own-organization success and non-mutation", () => {
  it("previews an own-org contact successfully with no PII in the response", async () => {
    const admin = await createAuthUser("preview-admin");
    const orgId = await createOrgWithOwner(admin, "Contact Preview Org");
    const contact = await createContact(orgId, { firstName: "Should Not Appear", email: "should-not-appear@example.test" });

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contact.id, requestType: "delete" },
    );
    expect(dsr.status).toBe("pending");

    const preview = await previewContactErasure({ userId: admin }, dsr.id);
    expect(preview.canProceed).toBe(true);
    expect(preview.blockerReason).toBeNull();
    expect(preview.targetContactId).toBe(contact.id);
    // The preview return shape itself has no field capable of carrying
    // first_name/email/phone/etc. — asserted structurally, not just by
    // absence of a specific value.
    expect(Object.keys(preview).sort()).toEqual(["blockerReason", "canProceed", "targetContactId"]);

    // --- direct DB inspection: preview must be a true no-op ---
    expect(await rowExistsIn("public.contacts", "id", contact.id)).toBe(true);
    const dsrAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select status from public.data_subject_requests where id = $1", [dsr.id]);
      return r.rows[0];
    });
    expect(dsrAfter.status).toBe("pending");
  });

  it("performs zero audit_logs writes of its own (only the earlier filing entry exists)", async () => {
    const admin = await createAuthUser("preview-audit-admin");
    const orgId = await createOrgWithOwner(admin, "Contact Preview Audit Org");
    const contact = await createContact(orgId);

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contact.id, requestType: "delete" },
    );
    await previewContactErasure({ userId: admin }, dsr.id);

    // The filing audit entry's resource_id is the DSR's own id, not the
    // target contact's id (fileDataSubjectRequest's existing, unchanged
    // behavior — matches the same pattern user-erasure.test.ts's
    // "filingAuditRows" check already relies on).
    const auditRows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select action from public.audit_logs where resource_id = $1 order by occurred_at",
        [dsr.id],
      );
      return r.rows;
    });
    expect(auditRows.map((r) => r.action)).toEqual(["data_subject_request.created"]);
  });

  it("a soft-deleted contact is still a valid preview/erasure target", async () => {
    const admin = await createAuthUser("preview-soft-deleted-admin");
    const orgId = await createOrgWithOwner(admin, "Contact Preview Soft Deleted Org");
    const contact = await createContact(orgId, { deletedAt: new Date() });

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contact.id, requestType: "delete" },
    );

    const preview = await previewContactErasure({ userId: admin }, dsr.id);
    expect(preview.canProceed).toBe(true);
    expect(preview.targetContactId).toBe(contact.id);
  });
});

describe("previewContactErasure: cross-tenant isolation, no existence leak", () => {
  it("Org A cannot preview Org B's contact, and a cross-org target is indistinguishable from a missing one", async () => {
    const adminA = await createAuthUser("cross-preview-admin-a");
    const adminB = await createAuthUser("cross-preview-admin-b");
    const orgA = await createOrgWithOwner(adminA, "Cross Preview Org A");
    const orgB = await createOrgWithOwner(adminB, "Cross Preview Org B");
    const contactB = await createContact(orgB);

    // Filed against org A but pointing at org B's contact — this is
    // exactly what "DSR organization_id must match the target contact's
    // organization_id" is meant to catch, independent of who's calling.
    const dsr = await fileDataSubjectRequest(
      { userId: adminA, organizationId: orgA, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contactB.id, requestType: "delete" },
    );

    const crossOrgPreview = await previewContactErasure({ userId: adminA }, dsr.id);

    const missingDsr = await fileDataSubjectRequest(
      { userId: adminA, organizationId: orgA, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: randomUUID(), requestType: "delete" },
    );
    const missingPreview = await previewContactErasure({ userId: adminA }, missingDsr.id);

    // Identical shape and content — a caller cannot tell "exists in
    // another org" apart from "doesn't exist at all."
    expect(crossOrgPreview).toEqual(missingPreview);
    expect(crossOrgPreview.canProceed).toBe(false);
    expect(crossOrgPreview.targetContactId).toBeNull();

    expect(await rowExistsIn("public.contacts", "id", contactB.id)).toBe(true);
  });
});

describe("executeContactErasure: own-organization success", () => {
  it("hard-deletes the contact row, completes the DSR, and writes a PII-free audit entry", async () => {
    const admin = await createAuthUser("execute-admin");
    const orgId = await createOrgWithOwner(admin, "Contact Execute Org");
    const contact = await createContact(orgId, {
      firstName: "Must Not Leak Into Audit",
      email: "must-not-leak@example.test",
    });

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contact.id, requestType: "delete" },
    );

    const result = await executeContactErasure({ userId: admin }, dsr.id);
    expect(result.targetContactId).toBe(contact.id);
    expect(result.completedAt).not.toBeNull();

    // --- direct database inspection: physically gone, not deleted_at ---
    expect(await rowExistsIn("public.contacts", "id", contact.id)).toBe(false);

    const dsrAfter = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select status, completed_at, handled_by from public.data_subject_requests where id = $1",
        [dsr.id],
      );
      return r.rows[0];
    });
    expect(dsrAfter.status).toBe("completed");
    expect(dsrAfter.completed_at).not.toBeNull();
    expect(dsrAfter.handled_by).toBe(admin);

    const auditRows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select actor_user_id, resource_type, resource_id, organization_id, before, after from public.audit_logs where action = 'data_subject_request.executed' and resource_id = $1",
        [contact.id],
      );
      return r.rows;
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor_user_id).toBe(admin);
    expect(auditRows[0].resource_type).toBe("contact");
    expect(auditRows[0].organization_id).toBe(orgId);

    // The forbidden-PII assertion — checks the full serialized audit
    // payload, not just specific keys, so a future change that
    // accidentally adds a new PII field would still be caught.
    const serializedAudit = JSON.stringify(auditRows[0].before) + JSON.stringify(auditRows[0].after);
    expect(serializedAudit).not.toContain("Must Not Leak Into Audit");
    expect(serializedAudit).not.toContain("must-not-leak@example.test");
    expect(serializedAudit).not.toMatch(/@example\.test/);
  });

  it("erasure does not merely set deleted_at on an unrelated contact — soft-delete and hard-erasure are structurally distinct", async () => {
    const admin = await createAuthUser("distinct-admin");
    const orgId = await createOrgWithOwner(admin, "Contact Distinct Org");
    const erasedContact = await createContact(orgId);
    const untouchedContact = await createContact(orgId);

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: erasedContact.id, requestType: "delete" },
    );
    await executeContactErasure({ userId: admin }, dsr.id);

    expect(await rowExistsIn("public.contacts", "id", erasedContact.id)).toBe(false);
    // A completely unrelated contact in the same org must be entirely
    // unaffected — proves the erasure is scoped to exactly one row, not a
    // blanket operation.
    const untouchedRow = await seedAsAdmin(async (client) => {
      const r = await client.query("select deleted_at from public.contacts where id = $1", [untouchedContact.id]);
      return r.rows[0];
    });
    expect(untouchedRow).toBeDefined();
    expect(untouchedRow.deleted_at).toBeNull();
  });

  it("succeeds without any prior preview call — proves execute re-validates independently, not chained from preview", async () => {
    const admin = await createAuthUser("no-preview-admin");
    const orgId = await createOrgWithOwner(admin, "Contact No Preview Org");
    const contact = await createContact(orgId);

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contact.id, requestType: "delete" },
    );

    const result = await executeContactErasure({ userId: admin }, dsr.id);
    expect(result.targetContactId).toBe(contact.id);
    expect(await rowExistsIn("public.contacts", "id", contact.id)).toBe(false);
  });

  it("rejects replay against an already-completed request, with no further effect", async () => {
    const admin = await createAuthUser("replay-admin");
    const orgId = await createOrgWithOwner(admin, "Contact Replay Org");
    const contact = await createContact(orgId);

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contact.id, requestType: "delete" },
    );
    await executeContactErasure({ userId: admin }, dsr.id);

    await expect(executeContactErasure({ userId: admin }, dsr.id)).rejects.toThrow(/already completed/i);

    const auditRows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select id from public.audit_logs where action = 'data_subject_request.executed' and resource_id = $1",
        [contact.id],
      );
      return r.rows;
    });
    expect(auditRows).toHaveLength(1);
  });
});

describe("tenant binding: DSR organization must match the target contact's organization", () => {
  it("execute fails when the DSR's organization differs from the target contact's organization", async () => {
    const adminA = await createAuthUser("bind-admin-a");
    const adminB = await createAuthUser("bind-admin-b");
    const orgA = await createOrgWithOwner(adminA, "Bind Org A");
    const orgB = await createOrgWithOwner(adminB, "Bind Org B");
    const contactB = await createContact(orgB);

    const dsr = await fileDataSubjectRequest(
      { userId: adminA, organizationId: orgA, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contactB.id, requestType: "delete" },
    );

    await expect(previewContactErasure({ userId: adminA }, dsr.id)).resolves.toMatchObject({ canProceed: false });
    await expect(executeContactErasure({ userId: adminA }, dsr.id)).rejects.toThrow(
      /not found in the requesting organization/i,
    );
    expect(await rowExistsIn("public.contacts", "id", contactB.id)).toBe(true);
  });

  it("an org_admin of Org A cannot use that authority against Org B, even though they are genuinely org_admin somewhere", async () => {
    const adminA = await createAuthUser("multi-org-admin-a");
    const orgA = await createOrgWithOwner(adminA, "Multi Org Admin's Own Org A");
    const orgB = await createOrgWithOwner(await createAuthUser("multi-org-owner-b"), "Multi Org Unrelated Org B");
    const contactB = await createContact(orgB);

    // The DSR is legitimately filed against Org B by adminA acting with an
    // (unearned) org_admin roleKey claim — fileDataSubjectRequest itself
    // doesn't re-verify roleKey against real membership, so this models
    // exactly the attack this test is for: adminA has real org_admin
    // authority in Org A only, and attempts to act on Org B's contact.
    const dsr = await fileDataSubjectRequest(
      { userId: adminA, organizationId: orgB, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contactB.id, requestType: "delete" },
    );

    await expect(previewContactErasure({ userId: adminA }, dsr.id)).rejects.toThrow(
      /not an active org_admin of the requesting organization/i,
    );
    await expect(executeContactErasure({ userId: adminA }, dsr.id)).rejects.toThrow(
      /not an active org_admin of the requesting organization/i,
    );
    expect(await rowExistsIn("public.contacts", "id", contactB.id)).toBe(true);
    void orgA; // held only to make the "adminA's own real org" fact explicit in the fixture
  });

  it("a caller holding memberships in both organizations cannot exploit the wrong one — org_admin in Org A, org_viewer in Org B", async () => {
    const caller = await createAuthUser("dual-membership-caller");
    const orgA = await createOrgWithOwner(caller, "Dual Membership Org A");
    const ownerB = await createAuthUser("dual-membership-owner-b");
    const orgB = await createOrgWithOwner(ownerB, "Dual Membership Org B");
    await addMembership(caller, orgB, "org_viewer");
    const contactB = await createContact(orgB);

    const dsr = await fileDataSubjectRequest(
      { userId: ownerB, organizationId: orgB, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contactB.id, requestType: "delete" },
    );

    // caller is a real, active org_admin — just not of orgB, where the
    // target contact and the DSR both live. Their org_viewer role in orgB
    // must not satisfy the org_admin requirement either.
    await expect(previewContactErasure({ userId: caller }, dsr.id)).rejects.toThrow(
      /not an active org_admin of the requesting organization/i,
    );
    expect(await rowExistsIn("public.contacts", "id", contactB.id)).toBe(true);
    void orgA;
  });

  it("a forged tenant context (mismatched organizationId in the calling context) does not authorize erasure — the SQL function's own check is authoritative", async () => {
    const admin = await createAuthUser("forged-context-admin");
    const orgId = await createOrgWithOwner(admin, "Forged Context Org");
    const contact = await createContact(orgId);
    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contact.id, requestType: "delete" },
    );

    // withTenantContext's organizationId/roleKey are irrelevant to these
    // SQL functions — they never read app.current_org/app.current_role at
    // all, only auth.uid() (via p_caller_user_id) and their own live
    // membership lookups. Forging an unrelated organizationId/roleKey in
    // the calling context changes nothing, which is itself the point:
    // there is no app.current_org-based shortcut to bypass.
    const result = await withTenantContext(
      { userId: admin, organizationId: randomUUID(), roleKey: "org_viewer" },
      async (client) => {
        const r = await client.query("select * from public.execute_contact_erasure($1, $2)", [dsr.id, admin]);
        return r.rows[0];
      },
    );
    expect(result.target_contact_id).toBe(contact.id);
    expect(await rowExistsIn("public.contacts", "id", contact.id)).toBe(false);
  });

  it("p_caller_user_id must match the authenticated caller — cannot impersonate another user id", async () => {
    const admin = await createAuthUser("impersonation-admin");
    const impersonated = await createAuthUser("impersonation-victim");
    const orgId = await createOrgWithOwner(admin, "Contact Impersonation Org");
    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: randomUUID(), requestType: "delete" },
    );

    await expect(
      withTenantContext({ userId: admin }, async (client) => {
        await client.query("select * from public.preview_contact_erasure($1, $2)", [dsr.id, impersonated]);
      }),
    ).rejects.toThrow(/p_caller_user_id must match the authenticated caller/);
  });
});

describe("consent history: preserved across contact erasure", () => {
  it("consent_records referencing the erased contact survive; the contact row itself is gone", async () => {
    const admin = await createAuthUser("consent-admin");
    const orgId = await createOrgWithOwner(admin, "Contact Consent History Org");
    const contact = await createContact(orgId);

    const consentId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        `insert into public.consent_records (organization_id, subject_type, subject_id, consent_type, status)
         values ($1, 'contact', $2, 'marketing_email', 'granted') returning id`,
        [orgId, contact.id],
      );
      return r.rows[0]!.id;
    });

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contact.id, requestType: "delete" },
    );
    await executeContactErasure({ userId: admin }, dsr.id);

    expect(await rowExistsIn("public.contacts", "id", contact.id)).toBe(false);
    // The consent record is untouched — a non-resolving subject_id
    // reference is the expected, approved post-erasure state (Milestone
    // 2.1C decision: preserve consent history, never delete/anonymize it).
    expect(await rowExistsIn("public.consent_records", "id", consentId)).toBe(true);
    const consentRow = await seedAsAdmin(async (client) => {
      const r = await client.query("select subject_id, status from public.consent_records where id = $1", [
        consentId,
      ]);
      return r.rows[0];
    });
    expect(consentRow.subject_id).toBe(contact.id);
    expect(consentRow.status).toBe("granted");
  });
});

describe("deal relationship: primary_contact_id survives contact erasure", () => {
  it("a deal referencing the erased contact survives, with primary_contact_id set to null and every other field intact (deals_contact_org_fk ON DELETE SET NULL, Milestone 2.2A)", async () => {
    const admin = await createAuthUser("deal-relationship-admin");
    const orgId = await createOrgWithOwner(admin, "Contact Erasure Deal Org");
    const contact = await createContact(orgId, { firstName: "Referenced By Deal" });

    const { pipelineId, stageId } = await seedAsAdmin(async (client) => {
      const pipeline = await client.query<{ id: string }>(
        "insert into public.pipelines (organization_id, name, is_default) values ($1, $2, false) returning id",
        [orgId, "Erasure Test Pipeline"],
      );
      const stage = await client.query<{ id: string }>(
        "insert into public.pipeline_stages (organization_id, pipeline_id, name, sort_order) values ($1, $2, $3, $4) returning id",
        [orgId, pipeline.rows[0]!.id, "Erasure Test Stage", 10],
      );
      return { pipelineId: pipeline.rows[0]!.id, stageId: stage.rows[0]!.id };
    });

    const dealId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        `insert into public.deals (organization_id, primary_contact_id, pipeline_id, stage_id, amount, currency, status)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [orgId, contact.id, pipelineId, stageId, "500", "EUR", "open"],
      );
      return r.rows[0]!.id;
    });

    const dealColumns =
      "id, organization_id, primary_contact_id, pipeline_id, stage_id, status, amount, currency, deleted_at";
    const before = await seedAsAdmin(async (client) => {
      const r = await client.query(`select ${dealColumns} from public.deals where id = $1`, [dealId]);
      return r.rows[0];
    });
    expect(before.primary_contact_id).toBe(contact.id);
    expect(before.deleted_at).toBeNull();

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contact.id, requestType: "delete" },
    );
    // The real application/compliance erasure path — never a direct DELETE
    // in this test — mirrors executeContactErasure's own "own-organization
    // success" test above exactly.
    const result = await executeContactErasure({ userId: admin }, dsr.id);
    expect(result.targetContactId).toBe(contact.id);

    // The contact is genuinely, physically gone — same assertion shape as
    // the existing "hard-deletes the contact row" test above.
    expect(await rowExistsIn("public.contacts", "id", contact.id)).toBe(false);

    // The deal survives (neither soft-deleted nor physically removed) with
    // every field except primary_contact_id unchanged — proves
    // deals_contact_org_fk's ON DELETE SET NULL (primary_contact_id) is
    // the only thing that touched this row, nothing broader.
    const after = await seedAsAdmin(async (client) => {
      const r = await client.query(`select ${dealColumns} from public.deals where id = $1`, [dealId]);
      return r.rows[0];
    });
    expect(after).toBeDefined();
    expect(after.id).toBe(before.id);
    expect(after.organization_id).toBe(before.organization_id);
    expect(after.pipeline_id).toBe(before.pipeline_id);
    expect(after.stage_id).toBe(before.stage_id);
    expect(after.status).toBe(before.status);
    expect(after.amount).toBe(before.amount);
    expect(after.currency).toBe(before.currency);
    expect(after.deleted_at).toBeNull();
    expect(after.primary_contact_id).toBeNull();
  });
});

describe("transactional safety: audit-write failure rolls back the entire erasure", () => {
  it("a forced audit_logs insert failure rolls back the contact delete and the DSR status update together", async () => {
    const admin = await createAuthUser("chaos-admin");
    const orgId = await createOrgWithOwner(admin, "Contact Chaos Org");
    const contact = await createContact(orgId);
    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contact.id, requestType: "delete" },
    );

    try {
      await seedAsAdmin(async (client) => {
        await client.query(`
          create or replace function public._chaos_fail_contact_erasure_audit()
          returns trigger language plpgsql as $$
          begin
            if new.action = 'data_subject_request.executed' and new.resource_type = 'contact' then
              raise exception 'chaos-injected failure: contact erasure audit insert';
            end if;
            return new;
          end;
          $$;
          create trigger _chaos_contact_erasure_audit_trigger
            before insert on public.audit_logs
            for each row execute function public._chaos_fail_contact_erasure_audit();
        `);
      });

      await expect(executeContactErasure({ userId: admin }, dsr.id)).rejects.toThrow(
        /chaos-injected failure: contact erasure audit insert/,
      );
    } finally {
      await seedAsAdmin(async (client) => {
        await client.query(`
          drop trigger if exists _chaos_contact_erasure_audit_trigger on public.audit_logs;
          drop function if exists public._chaos_fail_contact_erasure_audit();
        `);
      });
    }

    // Nothing must have taken effect — the contact must still exist and
    // the DSR must still be pending, proving the delete and the status
    // update rolled back together with the failed audit insert.
    expect(await rowExistsIn("public.contacts", "id", contact.id)).toBe(true);
    const dsrAfter = await seedAsAdmin(async (client) => {
      const r = await client.query("select status, completed_at from public.data_subject_requests where id = $1", [
        dsr.id,
      ]);
      return r.rows[0];
    });
    expect(dsrAfter.status).toBe("pending");
    expect(dsrAfter.completed_at).toBeNull();
  });
});

describe("regression: existing user-erasure behavior is unaffected by the new contact-erasure functions", () => {
  it("executeUserErasure still works end-to-end after the contact-erasure functions were added", async () => {
    const admin = await createAuthUser("regression-admin");
    const target = await createAuthUser("regression-target");
    const orgId = await createOrgWithOwner(admin, "Regression Check Org");
    await addMembership(target, orgId, "org_member");

    const dsr = await fileDataSubjectRequest(
      { userId: admin, organizationId: orgId, roleKey: "org_admin" },
      { subjectType: "user", subjectId: target, requestType: "delete" },
    );
    const result = await executeUserErasure({ userId: admin }, dsr.id);
    expect(result.targetUserId).toBe(target);
    expect(await rowExistsIn("auth.users", "id", target)).toBe(false);
  });
});
