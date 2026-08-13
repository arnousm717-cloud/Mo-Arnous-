"use client";

import { useState } from "react";
import { useActionState } from "react";
import { deleteContactAction, type DeleteContactFormState } from "./actions";
import styles from "../../companies/companies.module.css";

const initialState: DeleteContactFormState = {};

/**
 * Mirrors ../../companies/[id]/delete-company-form.tsx exactly — same
 * two-step disclosure, no Dialog primitive, same non-GDPR copy
 * discipline.
 */
export function DeleteContactForm({ contactId }: { contactId: string }): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const boundAction = deleteContactAction.bind(null, contactId);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  if (!confirming) {
    return (
      <button type="button" className={styles.dangerButton} onClick={() => setConfirming(true)}>
        Delete contact
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
      <p>This removes the contact from the active CRM. It can be restored later; this does not erase any data.</p>
      <form action={formAction} className={styles.confirmActions}>
        <button type="submit" className={styles.dangerButton} disabled={isPending}>
          {isPending ? "Removing…" : "Yes, remove this contact"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => setConfirming(false)} disabled={isPending}>
          Cancel
        </button>
      </form>
    </div>
  );
}
