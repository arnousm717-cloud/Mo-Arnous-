/**
 * Milestone 2.2-P0. Deliberately split from ./owner-options.ts: this file
 * has zero server-only imports (no @ai-revenue-os/database, no `pg`), so
 * it is safe to import from "use client" components. Bundlers include a
 * whole module's own import graph when ANY real (non-type) export is
 * imported from client code — a single shared file mixing this file's
 * pure helpers with owner-options.ts's withTenantContext-based
 * listActiveOwnerOptions would pull `pg` (and its Node-only `net`/`tls`
 * dependencies) into the client bundle the moment a client component
 * imported the pure helper alone, breaking the production build. Proven
 * empirically: this split was made specifically because the unsplit
 * version failed `next build` with "Module not found: Can't resolve
 * 'net'/'tls'", not as a speculative precaution.
 */

export interface OwnerOption {
  userId: string;
  /** Safe, ready-to-render display label — prefers full_name when
   * non-empty, falls back to email. Never a raw UUID. Callers should
   * render this directly rather than re-deriving a label from raw
   * fields, so every consumer applies the same fallback rule. */
  label: string;
}

/**
 * For an edit form's owner <select>: ensures the record's currently
 * assigned ownerId always appears as a selectable option, even if that
 * member's own membership has since become inactive
 * (get_organization_member_identities only ever returns active members,
 * by design). Without this, a <select> whose defaultValue matches no
 * <option> silently renders (and, on submit, silently sends) its first
 * option's value instead — which would clear a still-real owner
 * assignment as a side effect of an entirely unrelated field edit.
 * Mirrors the exact lesson from the Contacts deleted-company relationship
 * fix. Never a raw UUID label — a generic, safe placeholder is used since
 * (unlike a soft-deleted company) an inactive member's name cannot be
 * resolved by this function at all, by design.
 */
export function withResolvedOwnerFallback(activeOptions: OwnerOption[], currentOwnerId: string | null): OwnerOption[] {
  if (!currentOwnerId || activeOptions.some((option) => option.userId === currentOwnerId)) {
    return activeOptions;
  }
  return [...activeOptions, { userId: currentOwnerId, label: "Unknown member" }];
}

/** For a read-only display (list column, detail view): resolves a single
 * ownerId to its safe label, or the same generic fallback used by
 * withResolvedOwnerFallback above — never a raw UUID, never null when
 * ownerId itself is set. */
export function resolveOwnerLabel(activeOptions: OwnerOption[], ownerId: string | null): string | null {
  if (!ownerId) {
    return null;
  }
  return activeOptions.find((option) => option.userId === ownerId)?.label ?? "Unknown member";
}
