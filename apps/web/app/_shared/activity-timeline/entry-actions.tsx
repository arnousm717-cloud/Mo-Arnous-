"use client";

import { useState } from "react";
import { ActivityEditForm, type EditableActivity } from "./activity-form";
import { NoteEditForm, type EditableNote } from "./note-form";
import { DeleteActivityForm, DeleteNoteForm } from "./delete-entry-form";
import styles from "../../companies/companies.module.css";

/**
 * Milestone 2.3E. Small client wrapper owning the "am I currently
 * editing this one entry" toggle — ActivityTimeline itself (packages/ui)
 * is presentation-only and holds no state of its own; this is the
 * caller-supplied `actions` slot content for a single entry. Editing
 * appends the edit form into this same footer area rather than replacing
 * the card's already-rendered subject/body above it — simpler than a
 * whole-card swap, and the static text stays visible as a reference
 * while editing (submission still fully reloads the page via
 * redirect(returnPath), same as every other form in this app).
 */

export function ActivityEntryActions({
  activity,
  returnPath,
  canUpdate,
  canDelete,
}: {
  activity: EditableActivity;
  returnPath: string;
  canUpdate: boolean;
  canDelete: boolean;
}): React.ReactElement | null {
  const [editing, setEditing] = useState(false);

  if (!canUpdate && !canDelete) {
    return null;
  }

  return (
    <div>
      <div className={styles.confirmActions}>
        {canUpdate ? (
          <button type="button" className={styles.secondaryButton} onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel edit" : "Edit"}
          </button>
        ) : null}
        {canDelete ? <DeleteActivityForm activityId={activity.id} returnPath={returnPath} /> : null}
      </div>
      {editing ? <ActivityEditForm activity={activity} returnPath={returnPath} onCancel={() => setEditing(false)} /> : null}
    </div>
  );
}

export function NoteEntryActions({
  note,
  returnPath,
  canUpdate,
  canDelete,
}: {
  note: EditableNote;
  returnPath: string;
  canUpdate: boolean;
  canDelete: boolean;
}): React.ReactElement | null {
  const [editing, setEditing] = useState(false);

  if (!canUpdate && !canDelete) {
    return null;
  }

  return (
    <div>
      <div className={styles.confirmActions}>
        {canUpdate ? (
          <button type="button" className={styles.secondaryButton} onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel edit" : "Edit"}
          </button>
        ) : null}
        {canDelete ? <DeleteNoteForm noteId={note.id} returnPath={returnPath} /> : null}
      </div>
      {editing ? <NoteEditForm note={note} returnPath={returnPath} onCancel={() => setEditing(false)} /> : null}
    </div>
  );
}
