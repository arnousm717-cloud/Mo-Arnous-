import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  adminPool,
  createOrgWithRole,
  seedCompany,
  seedContact,
  seedPipelineWithStage,
  seedDeal,
  seedActivity,
  seedNote,
  seedTag,
  seedTagging,
} from "./crm-api-fixtures";
import { listActiveOwnerOptions } from "../app/_shared/owner-options";
import { loadTimeline } from "../app/_shared/activity-timeline/loader";
import { resolveRelatedToLabel } from "../app/_shared/activity-timeline/related-label";
import { resolveCreatorLabel } from "../app/_shared/activity-timeline/creator-label";
import { parseTimelineLimit } from "../app/_shared/activity-timeline/timeline-limit";
import {
  createActivityForResolvedContext,
  updateActivityForResolvedContext,
  deleteActivityForResolvedContext,
} from "../app/_shared/activity-timeline/activity-logic";
import {
  createNoteForResolvedContext,
  updateNoteForResolvedContext,
  deleteNoteForResolvedContext,
} from "../app/_shared/activity-timeline/note-logic";
import {
  listAttachedTagsForResolvedContext,
  attachExistingTagForResolvedContext,
  createAndAttachTagForResolvedContext,
  removeTaggingForResolvedContext,
} from "../app/_shared/activity-timeline/tag-logic";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function fd(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

async function makeDeal(organizationId: string): Promise<string> {
  const { pipelineId, stageId } = await seedPipelineWithStage(organizationId);
  return seedDeal(organizationId, pipelineId, stageId);
}

afterAll(async () => {
  await closePool();
});

describe("loadTimeline: per-record scoping", () => {
  it("a Contact's timeline never includes another record's activities/notes, even in the same organization", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);
    const otherContact = await seedContact(organizationId, { firstName: "Other" });
    await seedActivity(organizationId, "contact", contact, { subject: "Belongs to contact" });
    await seedActivity(organizationId, "contact", otherContact, { subject: "Belongs to OTHER contact" });
    await seedNote(organizationId, "contact", contact, { body: "Belongs to contact" });

    const ownerOptions = await listActiveOwnerOptions({ userId, organizationId, roleKey: "org_admin" });
    const result = await loadTimeline(userId, "contact", contact, 25, ownerOptions);

    expect(result.error).toBeNull();
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e) => e.subject !== "Belongs to OTHER contact")).toBe(true);
  });

  it("Company and Deal timelines are independently scoped the same way", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const company = await seedCompany(organizationId);
    const dealId = await makeDeal(organizationId);
    await seedActivity(organizationId, "company", company, { subject: "Company activity" });
    await seedActivity(organizationId, "deal", dealId, { subject: "Deal activity" });

    const ownerOptions = await listActiveOwnerOptions({ userId, organizationId, roleKey: "org_admin" });
    const companyResult = await loadTimeline(userId, "company", company, 25, ownerOptions);
    const dealResult = await loadTimeline(userId, "deal", dealId, 25, ownerOptions);

    expect(companyResult.entries.map((e) => e.subject)).toEqual(["Company activity"]);
    expect(dealResult.entries.map((e) => e.subject)).toEqual(["Deal activity"]);
  });

  it("cross-org: an org A actor loading org B's own record id gets an empty stream, not a leak or a crash", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-timeline");
    const orgB = await createOrgWithRole("org_admin", "org-b-timeline");
    const dealB = await makeDeal(orgB.organizationId);
    await seedActivity(orgB.organizationId, "deal", dealB);

    const ownerOptionsA = await listActiveOwnerOptions({ userId: orgA.userId, organizationId: orgA.organizationId, roleKey: "org_admin" });
    const result = await loadTimeline(orgA.userId, "deal", dealB, 25, ownerOptionsA);

    expect(result.error).toBeNull();
    expect(result.entries).toEqual([]);
  });
});

describe("loadTimeline: merged chronology", () => {
  it("interleaves Activities and Notes correctly, newest first", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);

    const first = await seedActivity(organizationId, "contact", contact, { subject: "1st" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await seedNote(organizationId, "contact", contact, { body: "2nd" });
    await new Promise((r) => setTimeout(r, 5));
    const third = await seedActivity(organizationId, "contact", contact, { subject: "3rd" });

    const ownerOptions = await listActiveOwnerOptions({ userId, organizationId, roleKey: "org_admin" });
    const result = await loadTimeline(userId, "contact", contact, 25, ownerOptions);

    expect(result.entries.map((e) => e.id)).toEqual([third, second, first]);
    expect(result.entries.map((e) => e.kind)).toEqual(["activity", "note", "activity"]);
  });

  it("empty stream: a record with zero activities/notes returns an empty, non-error result", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);
    const ownerOptions = await listActiveOwnerOptions({ userId, organizationId, roleKey: "org_admin" });

    const result = await loadTimeline(userId, "contact", contact, 25, ownerOptions);
    expect(result.error).toBeNull();
    expect(result.entries).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it("handler error behavior: an actor with no resolvable organization context surfaces a safe error, not a throw", async () => {
    const bogusUserId = randomUUID();
    const result = await loadTimeline(bogusUserId, "contact", randomUUID(), 25, []);
    expect(result.error).not.toBeNull();
    expect(result.entries).toEqual([]);
  });

  it("hasMore reflects a bounded page correctly", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);
    for (let i = 0; i < 5; i++) {
      await seedActivity(organizationId, "contact", contact);
    }
    const ownerOptions = await listActiveOwnerOptions({ userId, organizationId, roleKey: "org_admin" });

    const bounded = await loadTimeline(userId, "contact", contact, 3, ownerOptions);
    expect(bounded.entries).toHaveLength(3);
    expect(bounded.hasMore).toBe(true);

    const full = await loadTimeline(userId, "contact", contact, 10, ownerOptions);
    expect(full.entries).toHaveLength(5);
    expect(full.hasMore).toBe(false);
  });
});

describe("loadTimeline: GDPR historical state — empirically confirmed unreachability, and ordinary-null-field safety", () => {
  it("EMPIRICAL FINDING: once related_to_id is nulled by execute_contact_erasure(), the row becomes structurally invisible to loadTimeline's own relatedToId-filtered fetch — never a stale/dangling reference on any live page, by construction", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const company = await seedCompany(organizationId);
    const activityId = await seedActivity(organizationId, "company", company, { subject: "Before erasure" });
    await adminPool.query(
      "update public.activities set related_to_id = null, subject = null, body = null where id = $1",
      [activityId],
    );

    const ownerOptions = await listActiveOwnerOptions({ userId, organizationId, roleKey: "org_admin" });
    const result = await loadTimeline(userId, "company", company, 25, ownerOptions);

    // Confirms the design analysis in this milestone's own plan: a row
    // whose related_to_id has been erased can never again match any
    // relatedToType+relatedToId exact-match filter (the only fetch
    // mechanism loadTimeline ever uses) — including the filter for the
    // very record it used to belong to. No crash, no error, the row is
    // simply, correctly absent — never surfaced with a dangling/stale
    // identifier on any live detail page.
    expect(result.error).toBeNull();
    expect(result.entries.some((e) => e.id === activityId)).toBe(false);
  });

  it("ordinary (non-erasure) null subject/body — the actually-reachable case — maps safely with no crash and no fabricated content", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);
    // A perfectly normal activity that simply has no subject/body filled
    // in — this null-field shape IS reachable through the real fetch
    // path (unlike the erasure case above), and is exercised via direct
    // SQL here only to control the fixture precisely, not to simulate
    // anything GDPR-specific.
    const activityId = await adminPool
      .query(
        "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'task', 'contact', $2) returning id",
        [organizationId, contact],
      )
      .then((r) => r.rows[0].id as string);

    const ownerOptions = await listActiveOwnerOptions({ userId, organizationId, roleKey: "org_admin" });
    const result = await loadTimeline(userId, "contact", contact, 25, ownerOptions);

    expect(result.error).toBeNull();
    const entry = result.entries.find((e) => e.id === activityId);
    expect(entry).toBeDefined();
    expect(entry?.subject).toBeNull();
    expect(entry?.body).toBeNull();
  });

  it("Milestone 2.3F: an Activity whose created_by has been nulled (simulating the execute_user_erasure() ON DELETE SET NULL cascade) is REACHABLE, unlike the contact-erasure case above — and the section.tsx mapping composition (loadTimeline's creatorLabel piped through resolveCreatorLabel) yields 'Erased user', never 'Unknown' or a raw id", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);
    const activityId = await seedActivity(organizationId, "contact", contact, { subject: "Survives creator erasure" });
    // created_by going null on an EXISTING row, with related_to_id left
    // untouched, is exactly the shape execute_user_erasure()'s FK cascade
    // produces (packages/database) — distinct from the contact-erasure
    // case, which nulls related_to_id instead and is unreachable.
    await adminPool.query("update public.activities set created_by = null where id = $1", [activityId]);

    const ownerOptions = await listActiveOwnerOptions({ userId, organizationId, roleKey: "org_admin" });
    const result = await loadTimeline(userId, "contact", contact, 25, ownerOptions);

    expect(result.error).toBeNull();
    const entry = result.entries.find((e) => e.id === activityId);
    expect(entry).toBeDefined();
    expect(entry?.creatorLabel).toBeNull(); // raw loader output — not yet resolved to display copy
    // This is the exact composition apps/web/app/_shared/activity-timeline/section.tsx
    // applies before handing entries to packages/ui's <ActivityTimeline>.
    expect(resolveCreatorLabel(entry!.creatorLabel)).toBe("Erased user");
    expect(resolveCreatorLabel(entry!.creatorLabel)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it("a normal, non-erased creator's resolved label passes through resolveCreatorLabel unchanged", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const contact = await seedContact(organizationId);
    const activityId = await seedActivity(organizationId, "contact", contact, { createdBy: userId });

    const ownerOptions = await listActiveOwnerOptions({ userId, organizationId, roleKey: "org_admin" });
    const result = await loadTimeline(userId, "contact", contact, 25, ownerOptions);
    const entry = result.entries.find((e) => e.id === activityId);

    expect(entry?.creatorLabel).not.toBeNull();
    expect(resolveCreatorLabel(entry!.creatorLabel)).toBe(entry!.creatorLabel);
  });
});

describe("resolveCreatorLabel", () => {
  it("returns 'Erased user' for a null creatorLabel (createdBy nulled by GDPR user erasure)", () => {
    expect(resolveCreatorLabel(null)).toBe("Erased user");
  });

  it("passes a resolved label through unchanged", () => {
    expect(resolveCreatorLabel("Jane Doe")).toBe("Jane Doe");
  });

  it("never renders 'Unknown', 'Deleted user', or a raw UUID for the null case", () => {
    const label = resolveCreatorLabel(null);
    expect(label).not.toBe("Unknown");
    expect(label).not.toMatch(/Deleted/);
    expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});

describe("resolveRelatedToLabel", () => {
  it("returns 'Erased contact' for a null relatedToId on a contact-typed relationship", () => {
    expect(resolveRelatedToLabel("contact", null)).toBe("Erased contact");
  });

  it("returns null for a non-null relatedToId", () => {
    expect(resolveRelatedToLabel("contact", randomUUID())).toBeNull();
  });

  it("never renders 'Deleted contact', a raw UUID, or fabricated content for the null case", () => {
    const label = resolveRelatedToLabel("contact", null);
    expect(label).not.toContain("Deleted");
    expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it("company/deal types with a null id (defensive — should not occur given NOT NULL elsewhere) do not fabricate a contact-specific label", () => {
    expect(resolveRelatedToLabel("company", null)).toBeNull();
    expect(resolveRelatedToLabel("deal", null)).toBeNull();
  });
});

describe("parseTimelineLimit", () => {
  it("defaults when absent", () => {
    expect(parseTimelineLimit(undefined)).toBe(10);
  });

  it("passes through a valid larger value", () => {
    expect(parseTimelineLimit("30")).toBe(30);
  });

  it("falls back to the default for a value below it", () => {
    expect(parseTimelineLimit("1")).toBe(10);
  });

  it("caps at the maximum", () => {
    expect(parseTimelineLimit("999999")).toBe(100);
  });

  it("falls back to the default for garbage input", () => {
    expect(parseTimelineLimit("not-a-number")).toBe(10);
    expect(parseTimelineLimit("12.5")).toBe(10);
  });
});

describe("activity-logic: create/update/delete", () => {
  it("org_admin can create, update, and soft-delete", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);

    const created = await createActivityForResolvedContext(
      userId,
      "deal",
      dealId,
      fd({ idempotencyKey: randomUUID(), type: "call", subject: "Hello" }),
    );
    expect(created.error).toBeUndefined();

    const row = await adminPool.query("select id from public.activities where organization_id = $1", [organizationId]);
    const activityId = row.rows[0].id as string;

    const updated = await updateActivityForResolvedContext(
      userId,
      activityId,
      fd({ idempotencyKey: randomUUID(), type: "email", subject: "Updated" }),
    );
    expect(updated.error).toBeUndefined();

    const deleted = await deleteActivityForResolvedContext(userId, activityId);
    expect(deleted.deleted).toBe(true);

    const stillInDb = await adminPool.query("select deleted_at from public.activities where id = $1", [activityId]);
    expect(stillInDb.rows[0].deleted_at).not.toBeNull();
  });

  it("org_member can create/update but not delete", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const dealId = await makeDeal(organizationId);
    const activityId = await seedActivity(organizationId, "deal", dealId);

    const updated = await updateActivityForResolvedContext(
      userId,
      activityId,
      fd({ idempotencyKey: randomUUID(), type: "call", subject: "x" }),
    );
    expect(updated.error).toBeUndefined();

    const deleted = await deleteActivityForResolvedContext(userId, activityId);
    expect(deleted.error).toBeDefined();
    expect(deleted.deleted).toBeUndefined();
  });

  it("org_viewer cannot create or update", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const dealId = await makeDeal(organizationId);
    const activityId = await seedActivity(organizationId, "deal", dealId);

    const created = await createActivityForResolvedContext(
      userId,
      "deal",
      dealId,
      fd({ idempotencyKey: randomUUID(), type: "call" }),
    );
    expect(created.error).toBeDefined();

    const updated = await updateActivityForResolvedContext(userId, activityId, fd({ idempotencyKey: randomUUID(), type: "call" }));
    expect(updated.error).toBeDefined();
  });

  it("missing idempotency key -> error, no mutation attempted", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const result = await createActivityForResolvedContext(userId, "deal", dealId, fd({ type: "call" }));
    expect(result.error).toBe("Missing idempotency key.");
  });

  it("invalid type -> error", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const result = await createActivityForResolvedContext(
      userId,
      "deal",
      dealId,
      fd({ idempotencyKey: randomUUID(), type: "sms" }),
    );
    expect(result.error).toBeDefined();
  });

  it("HTML/script-looking subject/body round-trips as inert stored text, never sanitized/mangled server-side (React's own escaping is the sole safety net)", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const payload = "<script>alert(1)</script>";

    await createActivityForResolvedContext(
      userId,
      "deal",
      dealId,
      fd({ idempotencyKey: randomUUID(), type: "call", subject: payload, body: payload }),
    );

    const row = await adminPool.query("select subject, body from public.activities where organization_id = $1", [
      organizationId,
    ]);
    expect(row.rows[0].subject).toBe(payload);
    expect(row.rows[0].body).toBe(payload);
  });

  it("cross-org: an org A actor cannot update or delete org B's activity", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-act-logic");
    const orgB = await createOrgWithRole("org_admin", "org-b-act-logic");
    const dealB = await makeDeal(orgB.organizationId);
    const activityB = await seedActivity(orgB.organizationId, "deal", dealB);

    const updated = await updateActivityForResolvedContext(
      orgA.userId,
      activityB,
      fd({ idempotencyKey: randomUUID(), type: "call" }),
    );
    expect(updated.error).toBeDefined();

    const deleted = await deleteActivityForResolvedContext(orgA.userId, activityB);
    expect(deleted.error).toBeDefined();
  });
});

describe("note-logic: create/update/delete", () => {
  it("org_admin can create, update, and soft-delete", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);

    const created = await createNoteForResolvedContext(
      userId,
      "deal",
      dealId,
      fd({ idempotencyKey: randomUUID(), body: "Hello note" }),
    );
    expect(created.error).toBeUndefined();

    const row = await adminPool.query("select id from public.notes where organization_id = $1", [organizationId]);
    const noteId = row.rows[0].id as string;

    const updated = await updateNoteForResolvedContext(userId, noteId, fd({ idempotencyKey: randomUUID(), body: "Updated note" }));
    expect(updated.error).toBeUndefined();

    const deleted = await deleteNoteForResolvedContext(userId, noteId);
    expect(deleted.deleted).toBe(true);

    const stillInDb = await adminPool.query("select deleted_at from public.notes where id = $1", [noteId]);
    expect(stillInDb.rows[0].deleted_at).not.toBeNull();
  });

  it("org_member can create/update but not delete", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const dealId = await makeDeal(organizationId);
    const noteId = await seedNote(organizationId, "deal", dealId);

    const updated = await updateNoteForResolvedContext(userId, noteId, fd({ idempotencyKey: randomUUID(), body: "x" }));
    expect(updated.error).toBeUndefined();

    const deleted = await deleteNoteForResolvedContext(userId, noteId);
    expect(deleted.error).toBeDefined();
  });

  it("org_viewer cannot create or update", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const dealId = await makeDeal(organizationId);
    const noteId = await seedNote(organizationId, "deal", dealId);

    const created = await createNoteForResolvedContext(userId, "deal", dealId, fd({ idempotencyKey: randomUUID(), body: "x" }));
    expect(created.error).toBeDefined();

    const updated = await updateNoteForResolvedContext(userId, noteId, fd({ idempotencyKey: randomUUID(), body: "x" }));
    expect(updated.error).toBeDefined();
  });

  it("whitespace-only body -> error", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const result = await createNoteForResolvedContext(userId, "deal", dealId, fd({ idempotencyKey: randomUUID(), body: "   " }));
    expect(result.error).toBeDefined();
  });

  it("cross-org: an org A actor cannot update or delete org B's note", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-note-logic");
    const orgB = await createOrgWithRole("org_admin", "org-b-note-logic");
    const dealB = await makeDeal(orgB.organizationId);
    const noteB = await seedNote(orgB.organizationId, "deal", dealB);

    const updated = await updateNoteForResolvedContext(
      orgA.userId,
      noteB,
      fd({ idempotencyKey: randomUUID(), body: "hijacked" }),
    );
    expect(updated.error).toBeDefined();
    expect(updated.error).not.toMatch(/SQLSTATE|duplicate key value violates|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);

    const deleted = await deleteNoteForResolvedContext(orgA.userId, noteB);
    expect(deleted.error).toBeDefined();
    expect(deleted.error).not.toMatch(/SQLSTATE|duplicate key value violates|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);

    // No cross-org mutation occurred: org B's note is untouched.
    const stillInDb = await adminPool.query("select body, deleted_at from public.notes where id = $1", [noteB]);
    expect(stillInDb.rows[0].body).not.toBe("hijacked");
    expect(stillInDb.rows[0].deleted_at).toBeNull();
  });
});

describe("tag-logic: list/attach/create+attach/remove", () => {
  it("listAttachedTagsForResolvedContext splits attached vs available correctly", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const attachedTag = await seedTag(organizationId, { name: "Attached" });
    await seedTag(organizationId, { name: "Available" });
    await seedTagging(organizationId, attachedTag, "deal", dealId);

    const result = await listAttachedTagsForResolvedContext(userId, "deal", dealId);
    expect(result.error).toBeNull();
    expect(result.attached.map((t) => t.name)).toEqual(["Attached"]);
    expect(result.availableToAttach.map((t) => t.name)).toContain("Available");
    expect(result.availableToAttach.map((t) => t.name)).not.toContain("Attached");
  });

  it("attach existing tag succeeds and is reflected in a subsequent list", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId, { name: "Hot" });

    const result = await attachExistingTagForResolvedContext(userId, "deal", dealId, fd({ tagId }));
    expect(result.error).toBeUndefined();

    const list = await listAttachedTagsForResolvedContext(userId, "deal", dealId);
    expect(list.attached.map((t) => t.tagId)).toEqual([tagId]);
  });

  it("create-and-attach a new tag succeeds", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);

    const result = await createAndAttachTagForResolvedContext(userId, "deal", dealId, fd({ name: "Brand New Tag" }));
    expect(result.error).toBeUndefined();

    const list = await listAttachedTagsForResolvedContext(userId, "deal", dealId);
    expect(list.attached.map((t) => t.name)).toEqual(["Brand New Tag"]);
  });

  it("duplicate Tagging surfaces a human-readable conflict message, never a raw DB error", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    await attachExistingTagForResolvedContext(userId, "deal", dealId, fd({ tagId }));

    const conflict = await attachExistingTagForResolvedContext(userId, "deal", dealId, fd({ tagId }));
    expect(conflict.error).toBeDefined();
    expect(conflict.error).not.toMatch(/SQLSTATE|duplicate key value violates/i);
  });

  it("remove Tagging physically deletes the row", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    const taggingId = await seedTagging(organizationId, tagId, "deal", dealId);

    const result = await removeTaggingForResolvedContext(userId, taggingId);
    expect(result.removed).toBe(true);

    const stillInDb = await adminPool.query("select id from public.taggings where id = $1", [taggingId]);
    expect(stillInDb.rows).toEqual([]);
  });

  it("org_member cannot remove a Tagging (lacks tags:delete)", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);
    const taggingId = await seedTagging(organizationId, tagId, "deal", dealId);

    const result = await removeTaggingForResolvedContext(userId, taggingId);
    expect(result.error).toBeDefined();
    expect(result.removed).toBeUndefined();

    const stillInDb = await adminPool.query("select id from public.taggings where id = $1", [taggingId]);
    expect(stillInDb.rows).toHaveLength(1);
  });

  it("org_viewer cannot attach or create tags", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const dealId = await makeDeal(organizationId);
    const tagId = await seedTag(organizationId);

    const attach = await attachExistingTagForResolvedContext(userId, "deal", dealId, fd({ tagId }));
    expect(attach.error).toBeDefined();

    const create = await createAndAttachTagForResolvedContext(userId, "deal", dealId, fd({ name: "x" }));
    expect(create.error).toBeDefined();
  });

  it("cross-org: an org A actor cannot attach org B's tag or remove org B's tagging", async () => {
    const orgA = await createOrgWithRole("org_admin", "org-a-tag-logic");
    const orgB = await createOrgWithRole("org_admin", "org-b-tag-logic");
    const dealA = await makeDeal(orgA.organizationId);
    const dealB = await makeDeal(orgB.organizationId);
    const tagB = await seedTag(orgB.organizationId);
    const taggingB = await seedTagging(orgB.organizationId, tagB, "deal", dealB);

    // Org A actor tries to attach Org B's tag to Org A's own deal.
    const attached = await attachExistingTagForResolvedContext(orgA.userId, "deal", dealA, fd({ tagId: tagB }));
    expect(attached.error).toBeDefined();
    expect(attached.error).not.toMatch(/SQLSTATE|duplicate key value violates|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);

    // Org A actor tries to remove Org B's tagging outright.
    const removed = await removeTaggingForResolvedContext(orgA.userId, taggingB);
    expect(removed.error).toBeDefined();
    expect(removed.removed).toBeUndefined();
    expect(removed.error).not.toMatch(/SQLSTATE|duplicate key value violates|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);

    // No cross-org leak or mutation: org B's tagging is untouched, and org
    // A's deal never received a Tagging row for org B's tag.
    const stillInDb = await adminPool.query("select id from public.taggings where id = $1", [taggingB]);
    expect(stillInDb.rows).toHaveLength(1);
    const noCrossOrgTagging = await adminPool.query(
      "select id from public.taggings where organization_id = $1 and tag_id = $2",
      [orgA.organizationId, tagB],
    );
    expect(noCrossOrgTagging.rows).toEqual([]);
  });
});

describe("security: no dangerouslySetInnerHTML / raw HTML rendering anywhere in the 2.3E UI", () => {
  const files = [
    "packages/ui/src/activity-timeline.tsx",
    "packages/ui/src/tag-list.tsx",
    "apps/web/app/_shared/activity-timeline/activity-form.tsx",
    "apps/web/app/_shared/activity-timeline/note-form.tsx",
    "apps/web/app/_shared/activity-timeline/entry-actions.tsx",
    "apps/web/app/_shared/activity-timeline/tag-controls.tsx",
    "apps/web/app/_shared/activity-timeline/section.tsx",
  ];

  it.each(files)("%s contains no dangerouslySetInnerHTML, no HTML-string parsing, no iframe", (relativePath) => {
    const source = readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).not.toMatch(/<iframe/i);
  });
});
