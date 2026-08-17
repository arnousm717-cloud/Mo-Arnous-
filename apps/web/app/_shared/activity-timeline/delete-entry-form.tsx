"use client";

import { useState, useActionState } from "react";
import { deleteActivityAction, deleteNoteAction } from "./actions";
import styles from "../../companies/companies.module.css";

/** Milestone 2.3E. Same two-step disclosure as
 * contacts/[id]/delete-contact-form.tsx exactly — no Dialog primitive,
 * click "Delete" reveals an inline confirm panel with a second
 * "Yes, remove" button + Cancel. Two thin exports (Activity/Note) since
 * they bind genuinely different Server Actions — not the
 * per-record-type duplication the frozen 2.3E decision forbids, which is
 * about company/contact/deal, not about activity-vs-note. */

export function DeleteActivityForm({
  activityId,
  returnPath,
}: {
  activityId: string;
  returnPath: string;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const boundAction = deleteActivityAction.bind(null, activityId, returnPath);
  const [state, formAction, isPending] = useActionState(boundAction, {});

  if (!confirming) {
    return (
      <button type="button" className={styles.dangerButton} onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }

  return (
    <div className={styles.confirmPanel}>
      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}
      <p>This removes the activity from the timeline. It can be restored later; this does not erase any data.</p>
      <form action={formAction} className={styles.confirmActions}>
        <button type="submit" className={styles.dangerButton} disabled={isPending}>
          {isPending ? "Removing…" : "Yes, remove this activity"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => setConfirming(false)} disabled={isPending}>
          Cancel
        </button>
      </form>
    </div>
  );
}

export function DeleteNoteForm({ noteId, returnPath }: { noteId: string; returnPath: string }): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const boundAction = deleteNoteAction.bind(null, noteId, returnPath);
  const [state, formAction, isPending] = useActionState(boundAction, {});

  if (!confirming) {
    return (
      <button type="button" className={styles.dangerButton} onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }

  return (
    <div className={styles.confirmPanel}>
      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}
      <p>This removes the note from the timeline. It can be restored later; this does not erase any data.</p>
      <form action={formAction} className={styles.confirmActions}>
        <button type="submit" className={styles.dangerButton} disabled={isPending}>
          {isPending ? "Removing…" : "Yes, remove this note"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => setConfirming(false)} disabled={isPending}>
          Cancel
        </button>
      </form>
    </div>
  );
}
