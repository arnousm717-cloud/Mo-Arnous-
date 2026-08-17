import type { ReactNode } from "react";
import styles from "./activity-timeline.module.css";

/**
 * Milestone 2.3E. Presentation only, mirroring entity-table.tsx's own
 * discipline exactly: no data fetching, no organization-context
 * resolution, no can() checks, no idempotency, no logging. The caller
 * (apps/web/app/_shared/activity-timeline/section.tsx) owns all of that —
 * this component never knows which record it's showing, whether the
 * viewer is allowed to mutate anything, or how "load more" is fetched.
 *
 * A merged Activities+Notes stream — the caller is responsible for
 * merging and sorting (newest first) before handing entries here; this
 * component only renders whatever order it's given.
 */

export type TimelineEntryKind = "activity" | "note";
export type TimelineActivityType = "call" | "email" | "meeting" | "note" | "task";

export interface TimelineEntry {
  id: string;
  kind: TimelineEntryKind;
  /** Only present for kind === "activity". */
  activityType?: TimelineActivityType;
  /** Activities only — always null for a standalone Note. */
  subject: string | null;
  body: string | null;
  /** Pre-resolved, safe-to-render display name — never a raw id. Null
   * when createdBy itself was null (never fabricated). */
  creatorLabel: string | null;
  createdAt: string;
  /** Edit/delete controls, injected by the caller — same slot pattern as
   * EntityTable's own rowActions. */
  actions?: ReactNode;
}

export type ActivityTimelineState = "loading" | "empty" | "error" | "ready";

export interface ActivityTimelineProps {
  entries: TimelineEntry[];
  state?: ActivityTimelineState;
  emptyMessage?: string;
  errorMessage?: string;
  /** A real, working link-based "load more" (matching this app's
   * established cursor-Link convention) — never a client onLoadMore
   * callback. Omitted entirely when there is nothing more to load. */
  hasMore?: boolean;
  loadMoreLabel?: string;
  loadMoreHref?: string;
  /** Slot for the create-Activity / create-Note forms, rendered above the
   * list. Entirely optional — omitted when the viewer lacks create
   * permission for both. */
  createControls?: ReactNode;
}

const DEFAULT_EMPTY_MESSAGE = "No activity yet.";
const DEFAULT_ERROR_MESSAGE = "Something went wrong while loading this timeline.";
const DEFAULT_LOAD_MORE_LABEL = "Load more";

function activityTypeLabel(type: TimelineActivityType): string {
  // "note"-typed Activities are chronological logged events, deliberately
  // distinct from a standalone Note (frozen 2.3 design) — labeled
  // differently so the two are never visually confused in one merged
  // stream.
  if (type === "note") {
    return "Logged note";
  }
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function ActivityTimeline({
  entries,
  state = "ready",
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
  errorMessage = DEFAULT_ERROR_MESSAGE,
  hasMore = false,
  loadMoreLabel = DEFAULT_LOAD_MORE_LABEL,
  loadMoreHref,
  createControls,
}: ActivityTimelineProps): ReactNode {
  if (state === "error") {
    return (
      <section className={styles.wrapper} aria-label="Activity timeline">
        <p role="alert" className={styles.errorMessage}>
          {errorMessage}
        </p>
      </section>
    );
  }

  const isLoading = state === "loading";

  return (
    <section className={styles.wrapper} aria-label="Activity timeline">
      {createControls ? <div className={styles.createControls}>{createControls}</div> : null}

      {isLoading ? (
        <p role="status" aria-live="polite" className={styles.statusMessage}>
          Loading…
        </p>
      ) : state === "empty" || entries.length === 0 ? (
        <p className={styles.statusMessage}>{emptyMessage}</p>
      ) : (
        <ol className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.entry}>
              <article className={styles.entryCard}>
                <header className={styles.entryHeader}>
                  <span className={entry.kind === "note" ? styles.noteBadge : styles.activityBadge}>
                    {entry.kind === "note" ? "Note" : activityTypeLabel(entry.activityType ?? "task")}
                  </span>
                  <time className={styles.timestamp} dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleString()}
                  </time>
                </header>

                {entry.subject ? <p className={styles.subject}>{entry.subject}</p> : null}
                {entry.body ? <p className={styles.body}>{entry.body}</p> : null}

                <footer className={styles.entryFooter}>
                  <span className={styles.creator}>{entry.creatorLabel ?? "Unknown"}</span>
                  {entry.actions ? <span className={styles.actions}>{entry.actions}</span> : null}
                </footer>
              </article>
            </li>
          ))}
        </ol>
      )}

      {hasMore && loadMoreHref ? (
        <a href={loadMoreHref} className={styles.loadMoreLink}>
          {loadMoreLabel}
        </a>
      ) : null}
    </section>
  );
}
