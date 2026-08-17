import type { CrmRecordType } from "./types";

/**
 * Milestone 2.3E, frozen GDPR fallback (docs/13 "Milestone 2.3" GDPR
 * correction). NOT currently wired into any visible UI: every timeline
 * entry rendered by ActivityTimeline already belongs, by construction, to
 * the single record whose own detail page is being viewed — there is no
 * per-entry "related to <record>" label anywhere in this milestone's
 * actual UI for this string to appear in, since that would be redundant
 * with the page the viewer is already on. It exists, and is tested in
 * isolation, purely for correctness: a directly-related Activity/Note
 * whose relatedToId has been nulled by execute_contact_erasure() (2.3A)
 * is structurally UNREACHABLE through this milestone's own per-record
 * relatedToType+relatedToId exact-match filter (the erased contact's own
 * detail page 404s, since the contact itself is hard-deleted, so no live
 * page could ever fetch that row) — but the function is built and proven
 * correct now regardless, so any future page that DOES need a
 * relationship label (e.g. a cross-record activity feed) has a
 * ready-made, already-tested, compliant implementation to reuse rather
 * than reinventing this exact rule under time pressure later.
 */
export function resolveRelatedToLabel(relatedToType: CrmRecordType, relatedToId: string | null): string | null {
  if (relatedToId === null) {
    return relatedToType === "contact" ? "Erased contact" : null;
  }
  return null;
}
