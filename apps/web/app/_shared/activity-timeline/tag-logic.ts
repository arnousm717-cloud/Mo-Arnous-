import { MAX_LIMIT } from "@ai-revenue-os/crm";
import { handleListTags, handleCreateTag } from "../../api/v1/tags/handlers";
import { handleListTaggings, handleCreateTagging } from "../../api/v1/taggings/handlers";
import { handleDeleteTagging } from "../../api/v1/taggings/[id]/handlers";
import type { CrmRecordType } from "./types";

/**
 * Milestone 2.3E. Mirrors activity-logic.ts's own in-process-handler-reuse
 * discipline. Taggings carry no name/color of their own (2.3A schema) —
 * displaying a chip requires joining a record's Taggings against the
 * organization's own Tags by id, done here in-memory rather than as a new
 * API capability (out of scope, no domain/API contract change).
 *
 * KNOWN, DOCUMENTED LIMITATION (same class as the timeline's own bounded
 * pagination, docs/13 Milestone 2.3E): the org's active-tag list is
 * fetched with limit=MAX_LIMIT (100, packages/crm's own existing ceiling
 * — not a new number invented for this milestone). An organization with
 * more than 100 active tags would have some tags silently fail to
 * resolve a name for THIS join only (an attached tag whose row wasn't in
 * the fetched batch renders with its id truncated as a fallback label,
 * never a raw full UUID) — not a data-loss or security issue, a display
 * completeness one, and out of scope to fully solve without a dedicated
 * Tag-management/search UI (explicitly excluded from 2.3E).
 */

export interface TagOption {
  id: string;
  name: string;
  color: string | null;
}

export interface AttachedTag {
  taggingId: string;
  tagId: string;
  name: string;
  color: string | null;
}

export interface TagFormState {
  error?: string;
}

async function listOrgTags(userId: string): Promise<{ tags: TagOption[]; error: string | null }> {
  const url = new URL(`http://internal/tags?limit=${MAX_LIMIT}`);
  const response = await handleListTags(userId, url);
  if (response.status !== 200) {
    return { tags: [], error: "Failed to load tags." };
  }
  const data = (await response.json()) as { tags: TagOption[] };
  return { tags: data.tags, error: null };
}

export async function listAttachedTagsForResolvedContext(
  userId: string,
  taggableType: CrmRecordType,
  taggableId: string,
): Promise<{ attached: AttachedTag[]; availableToAttach: TagOption[]; error: string | null }> {
  const [{ tags, error: tagsError }, taggingsRes] = await Promise.all([
    listOrgTags(userId),
    handleListTaggings(
      userId,
      new URL(`http://internal/taggings?taggableType=${taggableType}&taggableId=${taggableId}&limit=${MAX_LIMIT}`),
    ),
  ]);

  if (tagsError || taggingsRes.status !== 200) {
    return { attached: [], availableToAttach: [], error: tagsError ?? "Failed to load tags for this record." };
  }

  const taggingsData = (await taggingsRes.json()) as {
    taggings: Array<{ id: string; tagId: string }>;
  };
  const tagsById = new Map(tags.map((t) => [t.id, t]));

  const attached: AttachedTag[] = taggingsData.taggings.map((tagging) => {
    const tag = tagsById.get(tagging.tagId);
    return {
      taggingId: tagging.id,
      tagId: tagging.tagId,
      // Never a raw full UUID — a truncated, clearly-synthetic fallback
      // when the tag genuinely can't be resolved from the fetched batch
      // (see this module's own top comment).
      name: tag?.name ?? `Tag ${tagging.tagId.slice(0, 8)}…`,
      color: tag?.color ?? null,
    };
  });

  const attachedTagIds = new Set(attached.map((a) => a.tagId));
  const availableToAttach = tags.filter((t) => !attachedTagIds.has(t.id));

  return { attached, availableToAttach, error: null };
}

export async function attachExistingTagForResolvedContext(
  userId: string | null,
  taggableType: CrmRecordType,
  taggableId: string,
  formData: FormData,
): Promise<TagFormState> {
  const tagId = formData.get("tagId");
  if (typeof tagId !== "string" || tagId.length === 0) {
    return { error: "Select a tag to attach." };
  }

  const response = await handleCreateTagging(userId, { tagId, taggableType, taggableId });
  const data = (await response.json()) as { tagging?: { id: string }; error?: { code: string; message: string; request_id: string } };

  if (response.status === 201 && data.tagging) {
    return {};
  }
  // DuplicateTaggingError/InvalidTagRelationshipError etc. already map to
  // a safe, human-readable message in handleCreateTagging — never a raw
  // DB error reaches this far.
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to attach the tag. Please try again." };
}

export async function createAndAttachTagForResolvedContext(
  userId: string | null,
  taggableType: CrmRecordType,
  taggableId: string,
  formData: FormData,
): Promise<TagFormState> {
  const name = formData.get("name");
  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "Tag name is required." };
  }

  const createRes = await handleCreateTag(userId, { name }, null);
  const createData = (await createRes.json()) as { tag?: { id: string }; error?: { code: string; message: string; request_id: string } };
  if (createRes.status !== 201 || !createData.tag) {
    return { error: typeof createData.error === "object" && createData.error !== null ? createData.error.message : "Failed to create the tag." };
  }

  const taggingRes = await handleCreateTagging(userId, { tagId: createData.tag.id, taggableType, taggableId });
  const taggingData = (await taggingRes.json()) as { tagging?: { id: string }; error?: { code: string; message: string; request_id: string } };
  if (taggingRes.status === 201 && taggingData.tagging) {
    return {};
  }
  return {
    error: typeof taggingData.error === "object" && taggingData.error !== null ? taggingData.error.message : "Tag was created but could not be attached.",
  };
}

export interface RemoveTaggingFormState {
  error?: string;
  removed?: boolean;
}

export async function removeTaggingForResolvedContext(
  userId: string | null,
  taggingId: string,
): Promise<RemoveTaggingFormState> {
  const response = await handleDeleteTagging(userId, taggingId);
  if (response.status === 200) {
    return { removed: true };
  }
  const data = (await response.json()) as { error?: { code: string; message: string; request_id: string } };
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to remove the tag. Please try again." };
}
