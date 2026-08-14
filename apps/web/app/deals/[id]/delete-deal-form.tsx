"use client";

import { useState } from "react";
import { useActionState } from "react";
import { deleteDealAction, type DeleteDealFormState } from "./actions";
import styles from "../../companies/companies.module.css";

const initialState: DeleteDealFormState = {};

/**
 * Mirrors ../../contacts/[id]/delete-contact-form.tsx exactly — same
 * two-step disclosure, no Dialog primitive, same non-GDPR copy
 * discipline (soft-delete only, no restore UI in 2.2E).
 */
export function DeleteDealForm({ dealId }: { dealId: string }): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const boundAction = deleteDealAction.bind(null, dealId);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  if (!confirming) {
    return (
      <button type="button" className={styles.dangerButton} onClick={() => setConfirming(true)}>
        Delete deal
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
      <p>This removes the deal from the active CRM. It can be restored later; this does not erase any data.</p>
      <form action={formAction} className={styles.confirmActions}>
        <button type="submit" className={styles.dangerButton} disabled={isPending}>
          {isPending ? "Removing…" : "Yes, remove this deal"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => setConfirming(false)} disabled={isPending}>
          Cancel
        </button>
      </form>
    </div>
  );
}
