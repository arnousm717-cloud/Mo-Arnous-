import { ValidationError } from "./errors";

/**
 * Cursor pagination (Milestone 2.1D, docs/04-API-Architecture.md §1's
 * documented convention — this is the first concrete implementation of it
 * in this repository, shared between companies.ts and contacts.ts so it
 * becomes the one template every later paginated resource copies, rather
 * than each resource inventing its own cursor shape).
 *
 * Cursor is opaque to the caller: base64url(JSON({ createdAt, id })).
 * Ordering is always created_at DESC, id DESC (id as a stable tie-breaker
 * — created_at alone is not unique). "Next page" means rows strictly
 * after the cursor in that DESC ordering, i.e. (created_at, id) <
 * (cursor.createdAt, cursor.id) as a row comparison. No offset pagination
 * — avoids page-drift under concurrent writes (docs/04 §1).
 */

export interface Cursor {
  createdAt: string;
  id: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Never leaks implementation detail on failure — every malformed-input
 * path (bad base64url, bad JSON, wrong shape, invalid createdAt/id)
 * collapses to the same ValidationError message, not a distinct one per
 * failure mode.
 */
export function decodeCursor(raw: string): Cursor {
  const invalid = () => new ValidationError("cursor is invalid");

  let json: string;
  try {
    json = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw invalid();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalid();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid();
  }
  const { createdAt, id } = parsed as Record<string, unknown>;

  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    throw invalid();
  }
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw invalid();
  }

  return { createdAt, id };
}

/** limit is optional; undefined resolves to DEFAULT_LIMIT. Anything else
 * that isn't a positive integer <= MAX_LIMIT is a ValidationError. */
export function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError("limit must be a positive integer");
  }
  if (limit > MAX_LIMIT) {
    throw new ValidationError(`limit must not exceed ${MAX_LIMIT}`);
  }
  return limit;
}

/**
 * Given limit+1 rows fetched in (created_at DESC, id DESC) order, splits
 * off the extra row (used only to detect whether another page exists,
 * never returned to the caller) and computes the next cursor from the
 * last item actually returned.
 */
export function buildPage<Row extends { created_at: string; id: string }, T>(
  rows: Row[],
  limit: number,
  toItem: (row: Row) => T,
): Page<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;
  return { items: pageRows.map(toItem), nextCursor };
}
