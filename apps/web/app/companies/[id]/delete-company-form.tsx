"use client";

import { useState } from "react";
import { useActionState } from "react";
import { deleteCompanyAction, type DeleteCompanyFormState } from "./actions";
import styles from "../companies.module.css";

const initialState: DeleteCompanyFormState = {};

/**
 * Smallest accessible confirmation without a Dialog primitive (none
 * exists in packages/ui, and none is being added in 2.1G-B): a plain
 * two-step disclosure using local component state — a "Delete company"
 * button reveals an inline confirm panel with an explicit confirm/cancel
 * pair, both real buttons, both keyboard-reachable, no focus trap or
 * portal needed for something this small.
 *
 * Soft-delete only — copy deliberately says "remove... from the active
 * CRM," never "permanently erase"/"GDPR erase"/"permanently destroy".
 * GDPR erasure remains a separate, deliberate action on
 * /data-subject-requests; nothing here calls that flow.
 */
export function DeleteCompanyForm({ companyId }: { companyId: string }): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const boundAction = deleteCompanyAction.bind(null, companyId);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  if (!confirming) {
    return (
      <button type="button" className={styles.dangerButton} onClick={() => setConfirming(true)}>
        Delete company
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
      <p>This removes the company from the active CRM. It can be restored later; this does not erase any data.</p>
      <form action={formAction} className={styles.confirmActions}>
        <button type="submit" className={styles.dangerButton} disabled={isPending}>
          {isPending ? "Removing…" : "Yes, remove this company"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => setConfirming(false)} disabled={isPending}>
          Cancel
        </button>
      </form>
    </div>
  );
}
