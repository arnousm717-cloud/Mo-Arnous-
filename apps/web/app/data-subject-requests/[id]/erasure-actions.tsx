"use client";

import { useActionState } from "react";
import {
  executeErasureAction,
  previewErasureAction,
  type ExecuteErasureState,
  type PreviewErasureState,
} from "./actions";

const initialPreviewState: PreviewErasureState = {};
const initialExecuteState: ExecuteErasureState = {};

/**
 * Preview before execute (M1.6 Decision D) — the two buttons are
 * independent form submissions, not one combined action, so a preview can
 * never be silently skipped on the way to execution. Execute re-validates
 * everything itself server-side regardless of what a prior preview showed.
 */
export function ErasureActions({ dsrId, status }: { dsrId: string; status: string }): React.ReactElement {
  const [previewState, previewFormAction, isPreviewing] = useActionState(
    previewErasureAction.bind(null, dsrId),
    initialPreviewState,
  );
  const [executeState, executeFormAction, isExecuting] = useActionState(
    executeErasureAction.bind(null, dsrId),
    initialExecuteState,
  );

  if (status === "completed") {
    return <p>This request has already been completed.</p>;
  }

  return (
    <div>
      <form action={previewFormAction}>
        <button type="submit" disabled={isPreviewing}>
          {isPreviewing ? "Previewing…" : "Preview erasure"}
        </button>
      </form>
      {previewState.error ? <p role="alert">{previewState.error}</p> : null}
      {previewState.preview ? (
        <div>
          <p>Can proceed: {previewState.preview.canProceed ? "yes" : "no"}</p>
          {previewState.preview.blockerReason ? <p role="alert">{previewState.preview.blockerReason}</p> : null}
          <p>Memberships that will be removed: {previewState.preview.membershipCount}</p>
        </div>
      ) : null}

      <form action={executeFormAction}>
        <button type="submit" disabled={isExecuting}>
          {isExecuting ? "Executing…" : "Execute erasure (irreversible)"}
        </button>
      </form>
      {executeState.error ? <p role="alert">{executeState.error}</p> : null}
      {executeState.result ? <p>Erasure completed at {executeState.result.completedAt}.</p> : null}
    </div>
  );
}
