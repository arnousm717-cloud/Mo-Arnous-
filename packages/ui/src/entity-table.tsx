import type { ReactNode } from "react";
import styles from "./entity-table.module.css";

/**
 * Milestone 2.1G-A. Deliberately the smallest reusable table shared by
 * Companies/Contacts (and later CRM lists) — columns/rows/loading/empty/
 * error/row-actions/cursor-pagination only. No sorting, no inline editing,
 * no saved views, no bulk actions (docs/07-UI-UX-System.md §5's full
 * EntityTable vision) — those are deferred to a later, separately-scoped
 * step once more than one real consumer exists to prove the abstraction
 * against, per the locked 2.1G-A decision.
 *
 * Presentation only: no data fetching, no organization-context resolution,
 * no can() checks, no idempotency, no logging. The caller owns all of that.
 */

export type EntityTableState = "loading" | "empty" | "error" | "ready";

export interface EntityTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

export interface EntityTableProps<T> {
  columns: EntityTableColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;

  state?: EntityTableState;

  emptyMessage?: string;
  errorMessage?: string;

  rowActions?: (row: T) => ReactNode;

  hasMore?: boolean;
  loadMoreLabel?: string;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
}

const DEFAULT_EMPTY_MESSAGE = "No items found.";
const DEFAULT_ERROR_MESSAGE = "Something went wrong while loading this list.";
const DEFAULT_LOAD_MORE_LABEL = "Load more";

export function EntityTable<T>({
  columns,
  rows,
  getRowId,
  state = "ready",
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
  errorMessage = DEFAULT_ERROR_MESSAGE,
  rowActions,
  hasMore = false,
  loadMoreLabel = DEFAULT_LOAD_MORE_LABEL,
  isLoadingMore = false,
  onLoadMore,
}: EntityTableProps<T>): ReactNode {
  const columnCount = columns.length + (rowActions ? 1 : 0);

  // A fatal error state never renders the table body underneath it — the
  // caller's `rows` may be stale from a prior successful load, and showing
  // stale data next to an error message would misrepresent what actually
  // happened.
  if (state === "error") {
    return (
      <div className={styles.wrapper}>
        <p role="alert" className={styles.errorMessage}>
          {errorMessage}
        </p>
      </div>
    );
  }

  const isInitialLoading = state === "loading";

  return (
    <div className={styles.wrapper}>
      <table className={styles.table} aria-busy={isInitialLoading}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={styles.headerCell}>
                {column.header}
              </th>
            ))}
            {rowActions ? (
              <th scope="col" className={styles.headerCell}>
                <span className={styles.visuallyHidden}>Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {isInitialLoading ? (
            <tr>
              <td colSpan={columnCount} className={styles.statusCell} role="status" aria-live="polite">
                Loading…
              </td>
            </tr>
          ) : state === "empty" || rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount} className={styles.statusCell}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const rowId = getRowId(row);
              return (
                <tr key={rowId} data-row-id={rowId}>
                  {columns.map((column) => (
                    <td key={column.key} className={styles.cell}>
                      {column.render(row)}
                    </td>
                  ))}
                  {rowActions ? <td className={styles.cell}>{rowActions(row)}</td> : null}
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {onLoadMore && (hasMore || isLoadingMore) ? (
        <div className={styles.loadMoreRow}>
          <button
            type="button"
            className={styles.loadMoreButton}
            onClick={onLoadMore}
            disabled={isLoadingMore}
            aria-disabled={isLoadingMore}
          >
            {isLoadingMore ? "Loading…" : loadMoreLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
