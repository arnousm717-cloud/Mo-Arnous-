"use client";

import { useState } from "react";
import { useActionState } from "react";
import { deletePipelineAction, type DeletePipelineFormState } from "./actions";
import styles from "../../companies/companies.module.css";

const initialState: DeletePipelineFormState = {};

/**
 * Milestone 2.2F. Mirrors ../../deals/[id]/delete-deal-form.tsx exactly
 * — two-step disclosure, non-GDPR copy (soft-delete only, recoverable).
 * If deletePipelineForResolvedContext still returns a 409 domain error
 * (e.g. a concurrent request made this the default between page load and
 * submit), it surfaces as-is via role="alert" — this component never
 * auto-picks a replacement default itself.
 */
export function DeletePipelineForm({ pipelineId, isDefault }: { pipelineId: string; isDefault: boolean }): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const boundAction = deletePipelineAction.bind(null, pipelineId);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  if (isDefault) {
    return (
      <p role="alert" className={styles.formError}>
        This is the active default pipeline and cannot be deleted. Set another pipeline as default first.
      </p>
    );
  }

  if (!confirming) {
    return (
      <button type="button" className={styles.dangerButton} onClick={() => setConfirming(true)}>
        Delete pipeline
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
      <p>This removes the pipeline from the active list. It can be restored later; this does not erase any data.</p>
      <form action={formAction} className={styles.confirmActions}>
        <button type="submit" className={styles.dangerButton} disabled={isPending}>
          {isPending ? "Removing…" : "Yes, remove this pipeline"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => setConfirming(false)} disabled={isPending}>
          Cancel
        </button>
      </form>
    </div>
  );
}
