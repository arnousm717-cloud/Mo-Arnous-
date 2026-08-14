import type { ReactNode } from "react";
import styles from "./pipeline-board.module.css";

/**
 * Milestone 2.2F. Deliberately the smallest presentation-only kanban
 * surface for Deals — one column per active pipeline stage, deals
 * grouped by stage, loading/empty/error/ready states (same shape as
 * entity-table.tsx's own EntityTableState) — not the full docs/07 vision
 * (drag-and-drop, activities, saved views); those are explicitly out of
 * scope for this milestone.
 *
 * Presentation only: no data fetching, no organization-context
 * resolution, no can() checks, no idempotency, no fetch. The caller owns
 * all of that and passes in already-resolved, already-safe display
 * strings — this component never receives a raw id to render as a label.
 *
 * moveControl is an opaque, caller-supplied ReactNode per card (e.g. a
 * small "Move to stage" form) rather than an onMove callback — this
 * keeps the component free of any assumption about HOW a move happens
 * (server action, form, or otherwise), matching entity-table.tsx's own
 * rowActions render-prop precedent. Drag-and-drop is not implemented
 * here (2.2F: optional, explicitly deferred) — moveControl is the sole,
 * required, keyboard-accessible way to move a card.
 */

export type PipelineBoardState = "loading" | "empty" | "error" | "ready";

export interface PipelineBoardCard {
  id: string;
  /** Safe, ready-to-render display label — never a raw UUID. */
  label: string;
  /** Pre-formatted by the caller (e.g. "500 EUR") — this component does
   * no currency/number formatting of its own. */
  amountLabel?: string;
  /** Pre-formatted company/contact context, if useful — kept short by
   * the caller; this component does not truncate it. */
  contextLabel?: string;
  /** Caller-supplied, keyboard-accessible control for moving this card
   * to another stage. Optional so a read-only board can omit it
   * entirely — the control is then absent, not merely disabled. */
  moveControl?: ReactNode;
}

export interface PipelineBoardStage {
  id: string;
  name: string;
  cards: PipelineBoardCard[];
}

export interface PipelineBoardProps {
  stages: PipelineBoardStage[];
  state?: PipelineBoardState;
  emptyMessage?: string;
  errorMessage?: string;
  emptyStageMessage?: string;
}

const DEFAULT_EMPTY_MESSAGE = "No stages to show.";
const DEFAULT_ERROR_MESSAGE = "Something went wrong while loading the board.";
const DEFAULT_EMPTY_STAGE_MESSAGE = "No deals in this stage.";

export function PipelineBoard({
  stages,
  state = "ready",
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
  errorMessage = DEFAULT_ERROR_MESSAGE,
  emptyStageMessage = DEFAULT_EMPTY_STAGE_MESSAGE,
}: PipelineBoardProps): ReactNode {
  // Same "error never renders stale data underneath it" discipline as
  // entity-table.tsx — the caller's `stages` may be stale from a prior
  // successful load.
  if (state === "error") {
    return (
      <div className={styles.wrapper}>
        <p role="alert" className={styles.errorMessage}>
          {errorMessage}
        </p>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className={styles.wrapper}>
        <p role="status" aria-live="polite" className={styles.statusMessage}>
          Loading…
        </p>
      </div>
    );
  }

  if (state === "empty" || stages.length === 0) {
    return (
      <div className={styles.wrapper}>
        <p className={styles.statusMessage}>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.board}>
        {stages.map((stage) => (
          <section key={stage.id} className={styles.column} aria-label={stage.name}>
            <h3 className={styles.columnHeader}>
              {stage.name} <span className={styles.columnCount}>({stage.cards.length})</span>
            </h3>
            {stage.cards.length === 0 ? (
              <p className={styles.emptyColumn}>{emptyStageMessage}</p>
            ) : (
              <ul className={styles.cardList}>
                {stage.cards.map((card) => (
                  <li key={card.id} className={styles.card}>
                    <p className={styles.cardLabel}>{card.label}</p>
                    {card.amountLabel ? <p className={styles.cardMeta}>{card.amountLabel}</p> : null}
                    {card.contextLabel ? <p className={styles.cardMeta}>{card.contextLabel}</p> : null}
                    {card.moveControl ? <div className={styles.cardMove}>{card.moveControl}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
