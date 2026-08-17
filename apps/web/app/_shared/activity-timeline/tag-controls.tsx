"use client";

import { useActionState } from "react";
import { attachExistingTagAction, createAndAttachTagAction, removeTaggingAction } from "./actions";
import type { TagOption } from "./tag-logic";
import type { CrmRecordType } from "./types";
import styles from "../../companies/companies.module.css";

/**
 * Milestone 2.3E. No idempotency key on any of these — matches
 * POST /api/v1/taggings' own deliberate no-idempotency design (2.3D);
 * tag creation (POST /api/v1/tags) does support Idempotency-Key at the
 * API layer but this minimal UI does not wire it, consistent with "keep
 * it minimal" for the Tags area specifically. No confirm step on remove
 * (unlike Activity/Note delete) — a Tagging is the lowest-stakes,
 * trivially-reversible action in this feature (re-attaching costs one
 * click), matching the same reasoning already accepted for its
 * server-side hard-delete design (docs/13 Milestone 2.3).
 */

export function AttachExistingTagForm({
  taggableType,
  taggableId,
  returnPath,
  options,
}: {
  taggableType: CrmRecordType;
  taggableId: string;
  returnPath: string;
  options: TagOption[];
}): React.ReactElement | null {
  const boundAction = attachExistingTagAction.bind(null, taggableType, taggableId, returnPath);
  const [state, formAction, isPending] = useActionState(boundAction, {});

  if (options.length === 0) {
    return null;
  }

  return (
    <form action={formAction} className={styles.filterForm} aria-label="Attach an existing tag">
      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}
      <div className={styles.field}>
        <label htmlFor="attach-tag-select">Add existing tag</label>
        <select id="attach-tag-select" name="tagId" disabled={isPending} defaultValue="">
          <option value="" disabled>
            Select a tag…
          </option>
          {options.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className={styles.secondaryButton} disabled={isPending}>
        {isPending ? "Attaching…" : "Attach"}
      </button>
    </form>
  );
}

export function CreateAndAttachTagForm({
  taggableType,
  taggableId,
  returnPath,
}: {
  taggableType: CrmRecordType;
  taggableId: string;
  returnPath: string;
}): React.ReactElement {
  const boundAction = createAndAttachTagAction.bind(null, taggableType, taggableId, returnPath);
  const [state, formAction, isPending] = useActionState(boundAction, {});

  return (
    <form action={formAction} className={styles.filterForm} aria-label="Create and attach a new tag">
      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}
      <div className={styles.field}>
        <label htmlFor="new-tag-name">New tag</label>
        <input id="new-tag-name" type="text" name="name" placeholder="Tag name" disabled={isPending} required />
      </div>
      <button type="submit" className={styles.secondaryButton} disabled={isPending}>
        {isPending ? "Creating…" : "Create & attach"}
      </button>
    </form>
  );
}

export function RemoveTaggingButton({
  taggingId,
  returnPath,
}: {
  taggingId: string;
  returnPath: string;
}): React.ReactElement {
  const boundAction = removeTaggingAction.bind(null, taggingId, returnPath);
  const [, formAction, isPending] = useActionState(boundAction, {});

  return (
    <form action={formAction}>
      <button type="submit" className={styles.secondaryButton} disabled={isPending} aria-label="Remove tag">
        {isPending ? "Removing…" : "×"}
      </button>
    </form>
  );
}
