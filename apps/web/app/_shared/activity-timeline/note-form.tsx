"use client";

import { useState, useActionState } from "react";
import { createNoteAction, updateNoteAction } from "./actions";
import type { CrmRecordType } from "./types";
import styles from "../../companies/companies.module.css";

/** Milestone 2.3E. Mirrors activity-form.tsx exactly — see its own
 * comment for the full rationale, not repeated here. Notes have a single
 * field (body), matching NoteFormState's own minimal shape. */

export function NoteCreateForm({
  relatedToType,
  relatedToId,
  returnPath,
}: {
  relatedToType: CrmRecordType;
  relatedToId: string;
  returnPath: string;
}): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const boundAction = createNoteAction.bind(null, relatedToType, relatedToId, returnPath);
  const [state, formAction, isPending] = useActionState(boundAction, {});

  return (
    <form action={formAction} className={styles.section} aria-label="Add a note">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor="new-note-body">Note</label>
        <textarea id="new-note-body" name="body" rows={3} disabled={isPending} required />
      </div>

      <button type="submit" className={styles.submitButton} disabled={isPending}>
        {isPending ? "Adding…" : "Add note"}
      </button>
    </form>
  );
}

export interface EditableNote {
  id: string;
  body: string | null;
}

export function NoteEditForm({
  note,
  returnPath,
  onCancel,
}: {
  note: EditableNote;
  returnPath: string;
  onCancel: () => void;
}): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const boundAction = updateNoteAction.bind(null, note.id, returnPath);
  const [state, formAction, isPending] = useActionState(boundAction, {});

  return (
    <form action={formAction} className={styles.section} aria-label="Edit note">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor={`edit-note-body-${note.id}`}>Note</label>
        <textarea
          id={`edit-note-body-${note.id}`}
          name="body"
          rows={3}
          defaultValue={note.body ?? ""}
          disabled={isPending}
          required
        />
      </div>

      <div className={styles.confirmActions}>
        <button type="submit" className={styles.submitButton} disabled={isPending}>
          {isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
