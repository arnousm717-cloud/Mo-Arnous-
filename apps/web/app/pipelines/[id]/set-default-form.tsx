"use client";

import { useActionState } from "react";
import { setDefaultPipelineAction, type SetDefaultPipelineFormState } from "./actions";
import styles from "../../companies/companies.module.css";

const initialState: SetDefaultPipelineFormState = {};

/**
 * Milestone 2.2F. The ONLY way to switch the organization's default
 * pipeline — a single-button action, deliberately separate from
 * ./pipeline-edit-form.tsx (which edits name only) so the two operations
 * can never be confused. Calls POST /api/v1/pipelines/{id}/set-default
 * through set-default-logic.ts, in-process (ADR-004). No idempotency key
 * (matching this route's own no-Idempotency-Key design, 2.2D) —
 * setDefaultPipeline already no-ops safely if this pipeline is already
 * the default.
 */
export function SetDefaultForm({ pipelineId, isDefault }: { pipelineId: string; isDefault: boolean }): React.ReactElement {
  const boundAction = setDefaultPipelineAction.bind(null, pipelineId);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  if (isDefault) {
    return <p>This is the organization&apos;s default pipeline.</p>;
  }

  return (
    <form action={formAction} className={styles.section}>
      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}
      <button type="submit" className={styles.secondaryButton} disabled={isPending}>
        {isPending ? "Setting…" : "Set as default pipeline"}
      </button>
    </form>
  );
}
