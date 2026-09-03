import type { HighScoreContact } from "@ai-revenue-os/intelligence";

/**
 * Milestone 3.5D — pure transform for the M3.5A high-score-contacts
 * projection. Maps each contact 1:1, in the EXACT order the domain
 * function returned (`order by score desc, computed_at desc, contact_id
 * asc` -- packages/intelligence/src/dashboard-metrics.ts) — this
 * function contains no `.sort()`/`.reverse()` call anywhere, deliberately,
 * so the domain's own tie-break ordering is never silently reimplemented
 * or reordered here.
 *
 * Only the fields the accepted M3.5A projection already returns are
 * touched (firstName/lastName/email/score/grade/computedAt) — this
 * function narrows to a display name, never widens toward breakdown,
 * enrichment, or any other field getHighScoreContacts doesn't already
 * expose.
 *
 * Name fallback mirrors apps/web/app/contacts/[id]/page.tsx's own exact
 * convention (`displayName`) — never a fabricated name: first+last name,
 * falling back to email, falling back to a literal "(no name)".
 */

export interface HighScoreContactViewModel {
  contactId: string;
  displayName: string;
  email: string | null;
  score: number;
  grade: HighScoreContact["grade"];
  computedAt: string;
}

export function buildHighScoreContactsViewModel(contacts: HighScoreContact[]): HighScoreContactViewModel[] {
  return contacts.map((c) => ({
    contactId: c.contactId,
    displayName: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "(no name)",
    email: c.email,
    score: c.score,
    grade: c.grade,
    computedAt: c.computedAt,
  }));
}
