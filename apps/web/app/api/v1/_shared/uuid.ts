/**
 * Milestone 2.3D. Malformed-UUID hardening at the API boundary. No route
 * before this milestone validated UUID *shape* anywhere — packages/crm's
 * own validators (e.g. relationship-validation.ts) only reject an empty
 * string, never a well-formed-but-wrong-shape one, so a malformed value
 * (e.g. "not-a-uuid") previously reached Postgres unvalidated and surfaced
 * as a raw `invalid input syntax for type uuid` error. This is the single
 * shared check every new Activities/Notes/Tags/Taggings route uses to
 * reject that input before it ever reaches a query — not a change to any
 * domain-layer contract (packages/crm's own required-string checks are
 * untouched).
 *
 * Same pattern as packages/crm/src/pagination.ts's own UUID_PATTERN
 * (cursor.id validation) — deliberately identical regex, not a
 * independently-invented one.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
