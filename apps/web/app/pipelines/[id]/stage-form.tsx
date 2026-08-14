"use client";

import { useState } from "react";
import { useActionState } from "react";
import { createStageAction, type CreateStageFormState } from "./actions";
import styles from "../../companies/companies.module.css";

const initialState: CreateStageFormState = {};

/**
 * Milestone 2.2F. Creates a stage under the parent pipeline this form is
 * mounted under (pipelineId is bound server-side, never a form field —
 * see ../create-stage-logic.ts's own comment). isWonStage/isLostStage
 * are plain checkboxes; the client-side note below is a hint only — the
 * server/domain layer remains the sole authority on mutual exclusivity
 * (packages/crm's validateWonLostExclusivity, 2.2B).
 */
export function StageForm({ pipelineId, nextSortOrder }: { pipelineId: string; nextSortOrder: number }): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const boundAction = createStageAction.bind(null, pipelineId);
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
        <label htmlFor="stage-name">Name</label>
        <input id="stage-name" type="text" name="name" required disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="stage-sort-order">Sort order</label>
        <input
          id="stage-sort-order"
          type="number"
          name="sortOrder"
          step={1}
          defaultValue={nextSortOrder}
          required
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="stage-probability">Probability (%)</label>
        <input id="stage-probability" type="number" name="probability" min={0} max={100} step={1} disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="stage-is-won">
          <input id="stage-is-won" type="checkbox" name="isWonStage" disabled={isPending} /> Won stage
        </label>
      </div>

      <div className={styles.field}>
        <label htmlFor="stage-is-lost">
          <input id="stage-is-lost" type="checkbox" name="isLostStage" disabled={isPending} /> Lost stage
          {/* A stage cannot be both — server-authoritative, this is a
              client-side note only, not enforced here. */}
        </label>
      </div>

      <button type="submit" className={styles.submitButton} disabled={isPending}>
        {isPending ? "Creating…" : "Create stage"}
      </button>
    </form>
  );
}
