import { handleCreateNote } from "../../api/v1/notes/handlers";
import { handleUpdateNote, handleDeleteNote } from "../../api/v1/notes/[id]/handlers";
import type { CrmRecordType } from "./types";

/** Milestone 2.3E. Mirrors activity-logic.ts exactly — see its own
 * comment for the full rationale, not repeated here. Notes have a single
 * mutable field (body), matching UpdateNoteInput's own shape (2.3B). */

export interface NoteFormState {
  error?: string;
}

function requireNonEmpty(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : value;
}

export async function createNoteForResolvedContext(
  userId: string | null,
  relatedToType: CrmRecordType,
  relatedToId: string,
  formData: FormData,
): Promise<NoteFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const body = requireNonEmpty(formData.get("body"));
  if (body === null) {
    return { error: "Note text is required." };
  }

  const response = await handleCreateNote(userId, { relatedToType, relatedToId, body }, idempotencyKey);
  const data = (await response.json()) as { note?: { id: string }; error?: string };

  if (response.status === 201 && data.note) {
    return {};
  }
  return { error: typeof data.error === "string" ? data.error : "Failed to create the note. Please try again." };
}

export async function updateNoteForResolvedContext(
  userId: string | null,
  noteId: string,
  formData: FormData,
): Promise<NoteFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const body = requireNonEmpty(formData.get("body"));
  if (body === null) {
    return { error: "Note text is required." };
  }

  const response = await handleUpdateNote(userId, noteId, { body }, idempotencyKey);
  const data = (await response.json()) as { note?: { id: string }; error?: string };

  if (response.status === 200 && data.note) {
    return {};
  }
  return { error: typeof data.error === "string" ? data.error : "Failed to update the note. Please try again." };
}

export interface DeleteNoteFormState {
  error?: string;
  deleted?: boolean;
}

export async function deleteNoteForResolvedContext(
  userId: string | null,
  noteId: string,
): Promise<DeleteNoteFormState> {
  const response = await handleDeleteNote(userId, noteId);
  if (response.status === 200) {
    return { deleted: true };
  }
  const data = (await response.json()) as { error?: string };
  return { error: typeof data.error === "string" ? data.error : "Failed to remove the note. Please try again." };
}
