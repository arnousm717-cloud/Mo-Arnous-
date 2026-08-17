"use client";

import { useState, useActionState } from "react";
import { createActivityAction, updateActivityAction } from "./actions";
import type { CrmRecordType } from "./types";
import styles from "../../companies/companies.module.css";

/**
 * Milestone 2.3E. Two small components in one file — mirrors the
 * existing Contacts precedent of a separate create form
 * (contact-form.tsx) and edit form (contact-edit-form.tsx) as distinct
 * components, not one polymorphic component with mode branching.
 * Deliberately minimal fields (type/subject/body only) — see
 * activity-logic.ts's own comment for why dueAt/completedAt are omitted
 * from this first cut.
 *
 * Reuses companies/companies.module.css directly rather than a new
 * near-duplicate stylesheet — the existing, established convention
 * already has every detail page (Companies/Contacts/Deals) share this
 * one module for page-level form/button/error classes
 * (contacts/[id]/page.tsx, deals/[id]/page.tsx both import it too).
 */

const ACTIVITY_TYPES = ["call", "email", "meeting", "note", "task"] as const;

export function ActivityCreateForm({
  relatedToType,
  relatedToId,
  returnPath,
}: {
  relatedToType: CrmRecordType;
  relatedToId: string;
  returnPath: string;
}): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const boundAction = createActivityAction.bind(null, relatedToType, relatedToId, returnPath);
  const [state, formAction, isPending] = useActionState(boundAction, {});

  return (
    <form action={formAction} className={styles.section} aria-label="Log an activity">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor="new-activity-type">Type</label>
        <select id="new-activity-type" name="type" defaultValue="call" disabled={isPending}>
          {ACTIVITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="new-activity-subject">Subject</label>
        <input id="new-activity-subject" type="text" name="subject" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="new-activity-body">Details</label>
        <textarea id="new-activity-body" name="body" rows={3} disabled={isPending} />
      </div>

      <button type="submit" className={styles.submitButton} disabled={isPending}>
        {isPending ? "Logging…" : "Log activity"}
      </button>
    </form>
  );
}

export interface EditableActivity {
  id: string;
  type: string;
  subject: string | null;
  body: string | null;
}

export function ActivityEditForm({
  activity,
  returnPath,
  onCancel,
}: {
  activity: EditableActivity;
  returnPath: string;
  onCancel: () => void;
}): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const boundAction = updateActivityAction.bind(null, activity.id, returnPath);
  const [state, formAction, isPending] = useActionState(boundAction, {});

  return (
    <form action={formAction} className={styles.section} aria-label="Edit activity">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor={`edit-activity-type-${activity.id}`}>Type</label>
        <select id={`edit-activity-type-${activity.id}`} name="type" defaultValue={activity.type} disabled={isPending}>
          {ACTIVITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor={`edit-activity-subject-${activity.id}`}>Subject</label>
        <input
          id={`edit-activity-subject-${activity.id}`}
          type="text"
          name="subject"
          defaultValue={activity.subject ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor={`edit-activity-body-${activity.id}`}>Details</label>
        <textarea
          id={`edit-activity-body-${activity.id}`}
          name="body"
          rows={3}
          defaultValue={activity.body ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.confirmActions}>
        <button type="submit" className={styles.submitButton} disabled={isPending}>
          {isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
