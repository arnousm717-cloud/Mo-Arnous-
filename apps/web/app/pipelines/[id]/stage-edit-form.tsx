"use client";

import { useState } from "react";
import { useActionState } from "react";
import { updateStageAction, deleteStageAction, type UpdateStageFormState, type DeleteStageFormState } from "./actions";
import styles from "../../companies/companies.module.css";

const initialUpdateState: UpdateStageFormState = {};
const initialDeleteState: DeleteStageFormState = {};

export interface EditableStage {
  id: string;
  name: string;
  sortOrder: number;
  probability: number | null;
  isWonStage: boolean;
  isLostStage: boolean;
}

/**
 * Milestone 2.2F. One always-visible inline edit form per stage row
 * (deliberately not toggle-based — matches every other edit form in this
 * app, which pre-fills current values rather than requiring an extra
 * "Edit" click) plus its own two-step soft-delete confirm, mirroring
 * ../../deals/[id]/delete-deal-form.tsx. Soft-deleting a stage never
 * moves, nulls, or hides historical deals still pointing at it (2.2B) —
 * this component has no code path that could do so even if it wanted to.
 *
 * canUpdate (pipelines:update) and canDelete (pipelines:delete) are
 * independent props, gated separately — the current RBAC matrix happens
 * to grant both only to org_admin, but this component does not assume
 * that coincidence; each control is absent (not merely disabled) exactly
 * per its own permission, matching every other RBAC-gated control in
 * this app.
 */
export function StageEditForm({
  pipelineId,
  stage,
  canUpdate,
  canDelete,
}: {
  pipelineId: string;
  stage: EditableStage;
  canUpdate: boolean;
  canDelete: boolean;
}): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const boundUpdateAction = updateStageAction.bind(null, pipelineId, stage.id);
  const [updateState, updateFormAction, isUpdating] = useActionState(boundUpdateAction, initialUpdateState);

  const boundDeleteAction = deleteStageAction.bind(null, pipelineId, stage.id);
  const [deleteState, deleteFormAction, isDeleting] = useActionState(boundDeleteAction, initialDeleteState);

  if (!canUpdate) {
    return (
      <li className={styles.section}>
        <p>
          {stage.name} — order {stage.sortOrder}
          {stage.probability !== null ? `, ${stage.probability}%` : ""}
          {stage.isWonStage ? ", won" : ""}
          {stage.isLostStage ? ", lost" : ""}
        </p>
        {canDelete ? (
          <StageDeleteControls
            confirmingDelete={confirmingDelete}
            setConfirmingDelete={setConfirmingDelete}
            deleteState={deleteState}
            deleteFormAction={deleteFormAction}
            isDeleting={isDeleting}
          />
        ) : null}
      </li>
    );
  }

  return (
    <li className={styles.section}>
      <form action={updateFormAction} className={styles.section}>
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

        {updateState.error ? (
          <p role="alert" className={styles.formError}>
            {updateState.error}
          </p>
        ) : null}

        <div className={styles.field}>
          <label htmlFor={`stage-name-${stage.id}`}>Name</label>
          <input id={`stage-name-${stage.id}`} type="text" name="name" defaultValue={stage.name} required disabled={isUpdating} />
        </div>

        <div className={styles.field}>
          <label htmlFor={`stage-sort-order-${stage.id}`}>Sort order</label>
          <input
            id={`stage-sort-order-${stage.id}`}
            type="number"
            name="sortOrder"
            step={1}
            defaultValue={stage.sortOrder}
            required
            disabled={isUpdating}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor={`stage-probability-${stage.id}`}>Probability (%)</label>
          <input
            id={`stage-probability-${stage.id}`}
            type="number"
            name="probability"
            min={0}
            max={100}
            step={1}
            defaultValue={stage.probability ?? ""}
            disabled={isUpdating}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor={`stage-is-won-${stage.id}`}>
            <input
              id={`stage-is-won-${stage.id}`}
              type="checkbox"
              name="isWonStage"
              defaultChecked={stage.isWonStage}
              disabled={isUpdating}
            />{" "}
            Won stage
          </label>
        </div>

        <div className={styles.field}>
          <label htmlFor={`stage-is-lost-${stage.id}`}>
            <input
              id={`stage-is-lost-${stage.id}`}
              type="checkbox"
              name="isLostStage"
              defaultChecked={stage.isLostStage}
              disabled={isUpdating}
            />{" "}
            Lost stage
          </label>
        </div>

        <button type="submit" className={styles.submitButton} disabled={isUpdating}>
          {isUpdating ? "Saving…" : "Save stage"}
        </button>
      </form>

      {canDelete ? (
        <StageDeleteControls
          confirmingDelete={confirmingDelete}
          setConfirmingDelete={setConfirmingDelete}
          deleteState={deleteState}
          deleteFormAction={deleteFormAction}
          isDeleting={isDeleting}
        />
      ) : null}
    </li>
  );
}

function StageDeleteControls({
  confirmingDelete,
  setConfirmingDelete,
  deleteState,
  deleteFormAction,
  isDeleting,
}: {
  confirmingDelete: boolean;
  setConfirmingDelete: (value: boolean) => void;
  deleteState: DeleteStageFormState;
  deleteFormAction: (formData: FormData) => void;
  isDeleting: boolean;
}): React.ReactElement {
  return (
    <>
      {deleteState.error ? (
        <p role="alert" className={styles.formError}>
          {deleteState.error}
        </p>
      ) : null}
      {!confirmingDelete ? (
        <button type="button" className={styles.dangerButton} onClick={() => setConfirmingDelete(true)}>
          Delete stage
        </button>
      ) : (
        <div className={styles.confirmPanel}>
          <p>
            This removes the stage from the active list. Deals already on this stage keep pointing at it and remain
            fully readable and editable; this does not erase any data.
          </p>
          <form action={deleteFormAction} className={styles.confirmActions}>
            <button type="submit" className={styles.dangerButton} disabled={isDeleting}>
              {isDeleting ? "Removing…" : "Yes, remove this stage"}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setConfirmingDelete(false)}
              disabled={isDeleting}
            >
              Cancel
            </button>
          </form>
        </div>
      )}
    </>
  );
}
