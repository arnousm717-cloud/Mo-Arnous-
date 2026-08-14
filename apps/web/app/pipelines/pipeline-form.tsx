"use client";

import { useState } from "react";
import { useActionState } from "react";
import { createPipelineAction, type CreatePipelineFormState } from "./actions";
import styles from "../companies/companies.module.css";

const initialState: CreatePipelineFormState = {};

/**
 * Milestone 2.2F. Inline create form on /pipelines (mirrors
 * ../deals/deal-form.tsx's own idempotency discipline). "Set as default
 * pipeline" is deliberately offered ONLY here, at create time — see
 * ../create-logic.ts's own comment for why this is safe and distinct
 * from the ordinary-PATCH isDefault bypass that remains impossible.
 */
export function PipelineForm(): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [state, formAction, isPending] = useActionState(createPipelineAction, initialState);

  return (
    <form action={formAction} className={styles.section}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor="pipeline-name">Name</label>
        <input id="pipeline-name" type="text" name="name" required disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="pipeline-is-default">
          <input id="pipeline-is-default" type="checkbox" name="isDefault" disabled={isPending} /> Set as default
          pipeline
        </label>
      </div>

      <button type="submit" className={styles.submitButton} disabled={isPending}>
        {isPending ? "Creating…" : "Create pipeline"}
      </button>
    </form>
  );
}
