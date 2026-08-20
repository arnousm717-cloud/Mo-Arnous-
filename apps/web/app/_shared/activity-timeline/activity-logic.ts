import { handleCreateActivity } from "../../api/v1/activities/handlers";
import { handleUpdateActivity, handleDeleteActivity } from "../../api/v1/activities/[id]/handlers";
import type { CrmRecordType } from "./types";

/**
 * Milestone 2.3E. Server-Action-body logic — mirrors
 * apps/web/app/contacts/[id]/update-logic.ts's own shape exactly: parses
 * FormData, calls the 2.3D API handler directly (in-process, ADR-004),
 * maps the JSON response to a small form-state shape. Shared by
 * Company/Contact/Deal — parameterized only by relatedToType/relatedToId
 * (frozen 2.3E decision: one implementation, not three near-identical
 * copies).
 *
 * Deliberately minimal fields for this first cut: type/subject/body only
 * — dueAt/completedAt remain fully supported at the domain/API layer but
 * are not exposed in this milestone's create/edit forms (no existing
 * date-time input precedent to reuse, and the frozen 2.3E scope is
 * explicitly minimal). relatedToType/relatedToId are never form fields —
 * always supplied by the calling page's own context, never
 * client-editable, matching the domain layer's own "not reassignable"
 * rule for updates structurally (the update form has no such field at
 * all).
 */

export interface ActivityFormState {
  error?: string;
}

const ACTIVITY_TYPES = ["call", "email", "meeting", "note", "task"];

function toNullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function createActivityForResolvedContext(
  userId: string | null,
  relatedToType: CrmRecordType,
  relatedToId: string,
  formData: FormData,
): Promise<ActivityFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const type = formData.get("type");
  if (typeof type !== "string" || !ACTIVITY_TYPES.includes(type)) {
    return { error: `type must be one of ${ACTIVITY_TYPES.join(", ")}` };
  }

  const body = {
    type,
    relatedToType,
    relatedToId,
    subject: toNullableString(formData.get("subject")),
    body: toNullableString(formData.get("body")),
  };

  const response = await handleCreateActivity(userId, body, idempotencyKey);
  const data = (await response.json()) as { activity?: { id: string }; error?: { code: string; message: string; request_id: string } };

  if (response.status === 201 && data.activity) {
    return {};
  }
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to create the activity. Please try again." };
}

export async function updateActivityForResolvedContext(
  userId: string | null,
  activityId: string,
  formData: FormData,
): Promise<ActivityFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const type = formData.get("type");
  if (typeof type !== "string" || !ACTIVITY_TYPES.includes(type)) {
    return { error: `type must be one of ${ACTIVITY_TYPES.join(", ")}` };
  }

  const body = {
    type,
    subject: toNullableString(formData.get("subject")),
    body: toNullableString(formData.get("body")),
  };

  const response = await handleUpdateActivity(userId, activityId, body, idempotencyKey);
  const data = (await response.json()) as { activity?: { id: string }; error?: { code: string; message: string; request_id: string } };

  if (response.status === 200 && data.activity) {
    return {};
  }
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to update the activity. Please try again." };
}

export interface DeleteActivityFormState {
  error?: string;
  deleted?: boolean;
}

export async function deleteActivityForResolvedContext(
  userId: string | null,
  activityId: string,
): Promise<DeleteActivityFormState> {
  const response = await handleDeleteActivity(userId, activityId);
  if (response.status === 200) {
    return { deleted: true };
  }
  const data = (await response.json()) as { error?: { code: string; message: string; request_id: string } };
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to remove the activity. Please try again." };
}
