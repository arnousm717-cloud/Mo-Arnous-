"use server";

import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import {
  createActivityForResolvedContext,
  updateActivityForResolvedContext,
  deleteActivityForResolvedContext,
  type ActivityFormState,
  type DeleteActivityFormState,
} from "./activity-logic";
import {
  createNoteForResolvedContext,
  updateNoteForResolvedContext,
  deleteNoteForResolvedContext,
  type NoteFormState,
  type DeleteNoteFormState,
} from "./note-logic";
import {
  attachExistingTagForResolvedContext,
  createAndAttachTagForResolvedContext,
  removeTaggingForResolvedContext,
  type TagFormState,
  type RemoveTaggingFormState,
} from "./tag-logic";
import type { CrmRecordType } from "./types";

/**
 * Milestone 2.3E. Server Actions — the ONE shared set reused by Company/
 * Contact/Deal detail pages (frozen 2.3E decision), each bound to that
 * page's own relatedToType/relatedToId/returnPath via `.bind(null, ...)`
 * in its form component, mirroring
 * apps/web/app/contacts/[id]/actions.ts's own updateContactAction.bind
 * pattern exactly. redirect(returnPath) on every successful mutation —
 * same full-page-reload-shows-fresh-state convention as every existing
 * Companies/Contacts/Deals form, never a client-side optimistic update.
 */

export type {
  ActivityFormState,
  DeleteActivityFormState,
  NoteFormState,
  DeleteNoteFormState,
  TagFormState,
  RemoveTaggingFormState,
};

export async function createActivityAction(
  relatedToType: CrmRecordType,
  relatedToId: string,
  returnPath: string,
  _prevState: ActivityFormState,
  formData: FormData,
): Promise<ActivityFormState> {
  const user = await getAuthenticatedUser();
  const result = await createActivityForResolvedContext(user?.id ?? null, relatedToType, relatedToId, formData);
  if (!result.error) {
    redirect(returnPath);
  }
  return result;
}

export async function updateActivityAction(
  activityId: string,
  returnPath: string,
  _prevState: ActivityFormState,
  formData: FormData,
): Promise<ActivityFormState> {
  const user = await getAuthenticatedUser();
  const result = await updateActivityForResolvedContext(user?.id ?? null, activityId, formData);
  if (!result.error) {
    redirect(returnPath);
  }
  return result;
}

export async function deleteActivityAction(
  activityId: string,
  returnPath: string,
  _prevState: DeleteActivityFormState,
  _formData: FormData,
): Promise<DeleteActivityFormState> {
  const user = await getAuthenticatedUser();
  const result = await deleteActivityForResolvedContext(user?.id ?? null, activityId);
  if (result.deleted) {
    redirect(returnPath);
  }
  return result;
}

export async function createNoteAction(
  relatedToType: CrmRecordType,
  relatedToId: string,
  returnPath: string,
  _prevState: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  const user = await getAuthenticatedUser();
  const result = await createNoteForResolvedContext(user?.id ?? null, relatedToType, relatedToId, formData);
  if (!result.error) {
    redirect(returnPath);
  }
  return result;
}

export async function updateNoteAction(
  noteId: string,
  returnPath: string,
  _prevState: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  const user = await getAuthenticatedUser();
  const result = await updateNoteForResolvedContext(user?.id ?? null, noteId, formData);
  if (!result.error) {
    redirect(returnPath);
  }
  return result;
}

export async function deleteNoteAction(
  noteId: string,
  returnPath: string,
  _prevState: DeleteNoteFormState,
  _formData: FormData,
): Promise<DeleteNoteFormState> {
  const user = await getAuthenticatedUser();
  const result = await deleteNoteForResolvedContext(user?.id ?? null, noteId);
  if (result.deleted) {
    redirect(returnPath);
  }
  return result;
}

export async function attachExistingTagAction(
  taggableType: CrmRecordType,
  taggableId: string,
  returnPath: string,
  _prevState: TagFormState,
  formData: FormData,
): Promise<TagFormState> {
  const user = await getAuthenticatedUser();
  const result = await attachExistingTagForResolvedContext(user?.id ?? null, taggableType, taggableId, formData);
  if (!result.error) {
    redirect(returnPath);
  }
  return result;
}

export async function createAndAttachTagAction(
  taggableType: CrmRecordType,
  taggableId: string,
  returnPath: string,
  _prevState: TagFormState,
  formData: FormData,
): Promise<TagFormState> {
  const user = await getAuthenticatedUser();
  const result = await createAndAttachTagForResolvedContext(user?.id ?? null, taggableType, taggableId, formData);
  if (!result.error) {
    redirect(returnPath);
  }
  return result;
}

export async function removeTaggingAction(
  taggingId: string,
  returnPath: string,
  _prevState: RemoveTaggingFormState,
  _formData: FormData,
): Promise<RemoveTaggingFormState> {
  const user = await getAuthenticatedUser();
  const result = await removeTaggingForResolvedContext(user?.id ?? null, taggingId);
  if (result.removed) {
    redirect(returnPath);
  }
  return result;
}
