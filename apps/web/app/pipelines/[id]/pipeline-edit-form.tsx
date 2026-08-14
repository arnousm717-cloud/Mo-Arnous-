"use client";

import { useState } from "react";
import { useActionState } from "react";
import { updatePipelineAction, type UpdatePipelineFormState } from "./actions";
import styles from "../../companies/companies.module.css";

const initialState: UpdatePipelineFormState = {};

/**
 * Milestone 2.2F. Edits pipeline METADATA (name) only — deliberately has
 * no isDefault control anywhere, so this form can never be confused with
 * or substitute for ./set-default-form.tsx, which is rendered as its own
 * separate, clearly-labeled section on the detail page.
 */
export function PipelineEditForm({ pipelineId, name }: { pipelineId: string; name: string }): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const boundAction = updatePipelineAction.bind(null, pipelineId);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  return (
    <form action={formAction} className={styles.section}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor="edit-pipeline-name">Name</label>
        <input id="edit-pipeline-name" type="text" name="name" defaultValue={name} required disabled={isPending} />
      </div>

      <button type="submit" className={styles.submitButton} disabled={isPending}>
        {isPending ? "Saving…" : "Save name"}
      </button>
    </form>
  );
}
