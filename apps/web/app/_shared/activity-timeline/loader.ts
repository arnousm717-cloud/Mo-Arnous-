import type { Activity, Note } from "@ai-revenue-os/crm";
import type { TimelineEntry, TimelineActivityType } from "@ai-revenue-os/ui";
import { handleListActivities } from "../../api/v1/activities/handlers";
import { handleListNotes } from "../../api/v1/notes/handlers";
import type { OwnerOption } from "../owner-option";
import { resolveOwnerLabel } from "../owner-option";
import type { CrmRecordType } from "./types";

/**
 * Milestone 2.3E. Server-only — merges Activities + Notes into one
 * chronological stream for a single CRM record's own detail page.
 *
 * Reuses the 2.3D API handlers directly, in-process (ADR-004, the exact
 * pattern apps/web/app/contacts/page.tsx already uses for
 * handleListContacts) — never a raw domain-layer call, so RBAC/tenant
 * resolution/error-shaping all happen exactly once, in the handler,
 * never duplicated here.
 *
 * PAGINATION (frozen 2.3E decision, docs/13): Activities and Notes are
 * two independently-cursored resources — there is no genuine unified
 * cursor across them without an API/domain change, which is out of this
 * milestone's scope. Instead, both are fetched with the SAME `limit`
 * (starting bounded, e.g. 20, matching packages/crm's own DEFAULT_LIMIT
 * convention) and "load more" re-fetches both with a larger `limit`
 * (existing, already-tested API parameter — no fabricated cursor, no API
 * change). `hasMore` is true whenever either underlying list itself still
 * has more (`nextCursor !== null`) OR the combined raw fetch already
 * exceeded the display limit — so "load more" never silently caps a
 * genuinely larger dataset without a visible affordance to see more.
 */

const ACTIVITY_TYPE_LABELS = new Set(["call", "email", "meeting", "note", "task"]);

export interface TimelineLoadResult {
  entries: TimelineEntry[];
  hasMore: boolean;
  error: string | null;
}

function toActivityEntry(activity: Activity, ownerOptions: OwnerOption[]): TimelineEntry {
  return {
    id: activity.id,
    kind: "activity",
    activityType: (ACTIVITY_TYPE_LABELS.has(activity.type) ? activity.type : "task") as TimelineActivityType,
    // Both are already null for a GDPR-erased row (execute_contact_erasure,
    // 2.3A) — rendered as-is, never fabricated, never repaired. Never
    // crashes: a null value here is not a special case at all, it is
    // handled identically to an ordinary activity whose subject/body was
    // simply never filled in.
    subject: activity.subject,
    body: activity.body,
    creatorLabel: resolveOwnerLabel(ownerOptions, activity.createdBy),
    createdAt: activity.createdAt,
  };
}

function toNoteEntry(note: Note, ownerOptions: OwnerOption[]): TimelineEntry {
  return {
    id: note.id,
    kind: "note",
    subject: null,
    body: note.body,
    creatorLabel: resolveOwnerLabel(ownerOptions, note.createdBy),
    createdAt: note.createdAt,
  };
}

/** Deterministic newest-first merge: createdAt DESC, id DESC as a stable
 * tie-break (matches the DB's own ordering discipline, packages/crm's
 * pagination.ts) — never relies on the two source arrays' own relative
 * order, which is meaningless once interleaved. */
function mergeNewestFirst(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => {
    const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (byDate !== 0) {
      return byDate;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

export async function loadTimeline(
  userId: string,
  relatedToType: CrmRecordType,
  relatedToId: string,
  limit: number,
  ownerOptions: OwnerOption[],
): Promise<TimelineLoadResult> {
  const activitiesUrl = new URL(
    `http://internal/activities?relatedToType=${relatedToType}&relatedToId=${relatedToId}&limit=${limit}`,
  );
  const notesUrl = new URL(
    `http://internal/notes?relatedToType=${relatedToType}&relatedToId=${relatedToId}&limit=${limit}`,
  );

  const [activitiesRes, notesRes] = await Promise.all([
    handleListActivities(userId, activitiesUrl),
    handleListNotes(userId, notesUrl),
  ]);

  if (activitiesRes.status !== 200 || notesRes.status !== 200) {
    return { entries: [], hasMore: false, error: "Failed to load the activity timeline." };
  }

  const activitiesData = (await activitiesRes.json()) as { activities: Activity[]; nextCursor: string | null };
  const notesData = (await notesRes.json()) as { notes: Note[]; nextCursor: string | null };

  const rawEntries = [
    ...activitiesData.activities.map((a) => toActivityEntry(a, ownerOptions)),
    ...notesData.notes.map((n) => toNoteEntry(n, ownerOptions)),
  ];
  const merged = mergeNewestFirst(rawEntries);
  const entries = merged.slice(0, limit);

  const hasMore = merged.length > limit || activitiesData.nextCursor !== null || notesData.nextCursor !== null;

  return { entries, hasMore, error: null };
}
