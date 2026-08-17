import type { CSSProperties, ReactNode } from "react";
import styles from "./tag-list.module.css";

/**
 * Milestone 2.3E. Presentation only, same discipline as
 * activity-timeline.tsx/entity-table.tsx — no data fetching, no can()
 * checks, no tenant context. Displays Taggings as chips; the caller owns
 * fetching, permission gating, and every mutation.
 *
 * color validation lives here (not in the caller) because it is a pure,
 * deterministic rendering-safety concern — the same class of "formatting
 * responsibility" EntityTable's own column `render` callbacks already
 * have, not a data-fetching/authorization concern this component is
 * forbidden from owning. tags.color is completely unvalidated free-form
 * text at the domain layer (2.3B decision — no design-token/palette
 * system) — only a strict hex-color match is ever used as a swatch;
 * anything else renders as a neutral chip with no color at all, never
 * interpolated into a raw CSS string (React's style object only ever
 * assigns to a single known CSSStyleDeclaration property, never parsed
 * as CSS text, so there is no injection surface either way — this
 * validation exists for visual predictability and to follow the explicit
 * "render a neutral style when safety isn't guaranteed" requirement, not
 * because an unvalidated value could execute anything).
 */

const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export interface TagChip {
  /** The Tagging's own id — used for the remove control, never the Tag's
   * own id (removing detaches this specific relationship, never deletes
   * the Tag itself). */
  id: string;
  tagId: string;
  name: string;
  color: string | null;
  /** Remove-tagging control, injected by the caller — omitted entirely
   * when the viewer lacks tags:delete. */
  removeAction?: ReactNode;
}

export interface TagListProps {
  tags: TagChip[];
  emptyMessage?: string;
  /** Slot for the "attach existing tag" / "create and attach new tag"
   * controls, rendered below the chip list. */
  addControls?: ReactNode;
}

const DEFAULT_EMPTY_MESSAGE = "No tags yet.";

function safeSwatchStyle(color: string | null): CSSProperties | undefined {
  if (color && HEX_COLOR_PATTERN.test(color)) {
    return { backgroundColor: color };
  }
  return undefined;
}

export function TagList({ tags, emptyMessage = DEFAULT_EMPTY_MESSAGE, addControls }: TagListProps): ReactNode {
  return (
    <div className={styles.wrapper} aria-label="Tags">
      {tags.length === 0 ? (
        <p className={styles.emptyMessage}>{emptyMessage}</p>
      ) : (
        <ul className={styles.chipList}>
          {tags.map((tag) => (
            <li key={tag.id} className={styles.chip}>
              <span className={styles.swatch} style={safeSwatchStyle(tag.color)} aria-hidden="true" />
              <span className={styles.chipLabel}>{tag.name}</span>
              {tag.removeAction ? <span className={styles.chipRemove}>{tag.removeAction}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {addControls ? <div className={styles.addControls}>{addControls}</div> : null}
    </div>
  );
}
