"use client";

import { useState } from "react";
import { useActionState } from "react";
import { moveDealToStageAction, type MoveDealFormState } from "./actions";
import styles from "../../companies/companies.module.css";

const initialState: MoveDealFormState = {};

export interface MoveStageOption {
  id: string;
  name: string;
}

/**
 * Milestone 2.2F §12 — the REQUIRED keyboard-accessible way to move a
 * deal to another active stage in the same pipeline (docs/07 §5's own
 * "kanban drag-to-change-stage has a keyboard-accessible equivalent"
 * baseline, satisfied here as the ONLY mechanism — no drag-and-drop
 * exists in this milestone, see ../page.tsx's own comment). A plain
 * <select> + explicit submit button, fully operable via keyboard/screen
 * reader with no pointer required. Calls moveDealToStageAction, which
 * reuses handleUpdateDeal through move-logic.ts — the exact same Deal
 * PATCH path ../[id]/update-logic.ts uses, not a second write path.
 */
export function StageMoveForm({ dealId, otherStages }: { dealId: string; otherStages: MoveStageOption[] }): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const boundAction = moveDealToStageAction.bind(null, dealId);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  if (otherStages.length === 0) {
    return <p className={styles.formError}>No other active stage to move to.</p>;
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <label htmlFor={`move-stage-${dealId}`}>Move to stage</label>
      <select id={`move-stage-${dealId}`} name="stageId" disabled={isPending} defaultValue="">
        <option value="" disabled>
          Choose a stage…
        </option>
        {otherStages.map((stage) => (
          <option key={stage.id} value={stage.id}>
            {stage.name}
          </option>
        ))}
      </select>
      <button type="submit" className={styles.secondaryButton} disabled={isPending}>
        {isPending ? "Moving…" : "Move"}
      </button>
    </form>
  );
}
