/**
 * Milestone 2.3F. Mirrors related-label.ts's structure exactly: a pure,
 * no-DB, no-actor-resolution, no-tenant, no-RBAC function.
 *
 * A creatorLabel of null coming out of loadTimeline (packages/ui's
 * TimelineEntry, resolved via resolveOwnerLabel in loader.ts) means
 * createdBy itself was null — and resolveOwnerLabel's own `if (!ownerId)
 * return null` check means this is the ONLY reason it is ever null: an
 * inactive-but-still-identified member instead resolves to the
 * deliberately different "Unknown member" (docs/13, Milestone 2.3F
 * vocabulary distinction). In this codebase, createdBy on an EXISTING row
 * only ever becomes null via the ON DELETE SET NULL cascade fired by
 * execute_user_erasure() (packages/database) — creation always populates
 * it from the acting user's own id. "Erased user" is therefore precise,
 * not a guess.
 */
export function resolveCreatorLabel(creatorLabel: string | null): string {
  return creatorLabel ?? "Erased user";
}
