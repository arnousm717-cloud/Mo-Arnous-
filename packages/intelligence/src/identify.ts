import type { PoolClient } from "pg";
import { withTenantContext, runInClientOrTransaction, type RequestContext } from "@ai-revenue-os/database";
import { getContactByEmail } from "@ai-revenue-os/crm";
import { checkCookieTrackingConsent } from "./consent";
import { resolveOrCreateVisitor, type WebsiteVisitor } from "./visitors";

/**
 * Visitor Identification (Milestone 3.2C, docs/13-Technical-Design-
 * Review.md "Milestone 3.2 Design Resolution" §N). The one atomic
 * operation POST /track/identify (3.2D) calls after it has already
 * verified the Ed25519 assertion's signature and claims shape
 * (packages/auth's tracking-identity-assertions/tracking-signing-keys) --
 * this function takes only the already-trusted contactEmail evidence and
 * a fresh tokenJti, exactly mirroring how ingestTrackingEvent
 * deliberately does not call resolve_tracking_site() itself: crypto/
 * assertion verification is 3.2D's own boundary responsibility, never
 * duplicated here.
 *
 * Deliberately reuses resolveOrCreateVisitor (not a strict "must already
 * exist" lookup) for the visitor row -- a real-world identify() call can
 * legitimately race ahead of the tracker's own automatic-pageview write
 * (two independent fetch calls, no ordering guarantee between them), and
 * this is the exact same race-safe idiom ingestTrackingEvent already
 * relies on for the identical table. This is a considered refinement of
 * the Design Resolution Report's own illustrative pseudoflow (which
 * described a "resolve visitor -> missing: reject" step) rather than a
 * deviation from an accepted invariant: no security/privacy guarantee
 * changes, it only makes identification robust to inter-request timing
 * that was always possible.
 */

export interface IdentifyVisitorInput {
  trackingSiteId: string;
  anonymousId: string;
  /** Already-verified evidence from the signed assertion -- never a raw, unverified browser-supplied value. */
  contactEmail: string;
  /** Already shape-validated (UUID) -- consumed here via visitor_identifications' own UNIQUE(organization_id, token_jti), structural single-use enforcement. */
  tokenJti: string;
}

export type IdentifyRejectionReason =
  | "tracking_site_revoked"
  | "consent_not_granted"
  | "visitor_suppressed"
  | "contact_not_found"
  | "conflict"
  | "replayed_jti";

export type IdentifyResult =
  | { accepted: true; visitor: WebsiteVisitor; contactId: string }
  | { accepted: false; reason: IdentifyRejectionReason };

const JTI_UNIQUE_VIOLATION_CODE = "23505";
const JTI_UNIQUE_CONSTRAINT = "visitor_identifications_org_jti_key";

interface PgUniqueViolationError {
  code?: string;
  constraint?: string;
}

function isJtiReplay(err: unknown): boolean {
  const e = err as PgUniqueViolationError;
  return e?.code === JTI_UNIQUE_VIOLATION_CODE && e?.constraint === JTI_UNIQUE_CONSTRAINT;
}

/**
 * Atomic. Mirrors ingestTrackingEvent's own transaction shape and
 * indistinguishable-rejection doctrine exactly (every IdentifyResult's
 * false branch is data, never a thrown exception, matching this
 * package's own established IngestResult precedent) -- the eventual
 * HTTP layer (3.2D) collapses every reason to the same non-oracle 204,
 * same as /track/collect already does for its own four rejection kinds.
 */
export async function identifyVisitor(
  ctx: RequestContext & { organizationId: string },
  input: IdentifyVisitorInput,
): Promise<IdentifyResult> {
  return withTenantContext(ctx, async (client) => {
    // Step 1: re-check the tracking site inside this tenant-scoped
    // transaction -- TOCTOU defense against revocation happening between
    // 3.2D's earlier resolution/key-verification and this write, same
    // reasoning as ingestTrackingEvent's own site re-check.
    const siteCheck = await client.query<{ id: string }>(
      `select id from public.tracking_sites where id = $1 and organization_id = $2 and revoked_at is null`,
      [input.trackingSiteId, ctx.organizationId],
    );
    if (siteCheck.rows.length === 0) {
      return { accepted: false, reason: "tracking_site_revoked" };
    }

    // Step 2: live consent re-check -- identification fails closed
    // without a currently-granted cookie_tracking consent, regardless of
    // how recently the assertion itself was signed.
    const consentGranted = await checkCookieTrackingConsent(ctx, input.anonymousId, client);
    if (!consentGranted) {
      return { accepted: false, reason: "consent_not_granted" };
    }

    // Step 3: resolve (or create) the visitor row.
    const visitor = await resolveOrCreateVisitor(ctx, input.anonymousId, client);

    // Step 4: erasure anti-relink guard (Milestone 3.2F) -- a visitor
    // permanently suppressed by a prior contact erasure can never be
    // identified again, to any contact, regardless of how this
    // assertion's evidence resolves.
    if (visitor.identificationSuppressedAt !== null) {
      return { accepted: false, reason: "visitor_suppressed" };
    }

    // Step 5: resolve the active contact from the assertion's own
    // (already-verified) email evidence -- never a raw contactId.
    const contact = await getContactByEmail(ctx, input.contactEmail, client);
    if (!contact) {
      return { accepted: false, reason: "contact_not_found" };
    }

    // Step 6: conflict policy. A->A is idempotent (falls through to the
    // identical INSERT/UPDATE below, re-confirming the same binding is
    // legitimate audit signal). A->B is rejected -- Contact A's own
    // binding is left completely untouched, and the attempt is recorded
    // internally for later investigation, never surfaced externally as
    // anything other than the same non-oracle outcome.
    //
    // Hardened (Final Implementation Acceptance Audit remediation
    // pass): this INSERT uses the identical (organization_id,
    // token_jti) UNIQUE constraint Step 7's does, and can be hit by a
    // jti that was already consumed by an earlier, unrelated
    // identification (e.g. a stale/replayed assertion arriving after
    // the visitor has since been legitimately re-bound to a different
    // contact). Previously this case threw an uncaught unique-violation
    // exception, which surfaced as an HTTP 500 -- a response
    // distinguishable from every other rejection's uniform 204,
    // breaking this endpoint's own non-oracle design. Wrapped in the
    // same isJtiReplay handling Step 7 already uses, so a jti that is
    // simply spent is reported as "replayed_jti" (the token itself is
    // invalid, which is the more precise, and the safe, non-throwing,
    // reason) rather than letting the constraint violation escape --
    // consistent replay semantics on both INSERT paths.
    if (visitor.identifiedContactId !== null && visitor.identifiedContactId !== contact.id) {
      try {
        await client.query(
          `insert into public.visitor_identifications (organization_id, website_visitor_id, contact_id, event_type, token_jti)
           values ($1, $2, $3, 'rejected_conflict', $4)`,
          [ctx.organizationId, visitor.id, contact.id, input.tokenJti],
        );
      } catch (err) {
        if (isJtiReplay(err)) {
          return { accepted: false, reason: "replayed_jti" };
        }
        throw err;
      }
      return { accepted: false, reason: "conflict" };
    }

    // Step 7: consume the assertion's jti -- structural single-use via
    // the (organization_id, token_jti) UNIQUE constraint. A replayed jti
    // fails this INSERT and the whole transaction rolls back naturally,
    // leaving every prior step's read-only work undone (nothing to undo,
    // since nothing was mutated before this point).
    try {
      await client.query(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, contact_id, event_type, token_jti)
         values ($1, $2, $3, 'identified', $4)`,
        [ctx.organizationId, visitor.id, contact.id, input.tokenJti],
      );
    } catch (err) {
      if (isJtiReplay(err)) {
        return { accepted: false, reason: "replayed_jti" };
      }
      throw err;
    }

    // Step 8: update the active identity pointer. Idempotent no-op for
    // A->A (identical value written back), the real binding write for
    // unidentified->A.
    await client.query(`update public.website_visitors set identified_contact_id = $1 where id = $2 and organization_id = $3`, [
      contact.id,
      visitor.id,
      ctx.organizationId,
    ]);

    // Step 9: transactional outbox (Milestone 3.2K), via the narrow
    // emit_visitor_identified_event() SECURITY DEFINER function
    // (20260821090500) -- `events` itself has zero direct grants to
    // authenticated (M1.7), matching every other event emission's own
    // established SQL-function-only write path. No raw PII in the
    // payload -- bare identifiers only, matching every other emitted
    // event's own shape.
    //
    // Hardened (Final Implementation Acceptance Audit remediation
    // pass): the function no longer accepts organization_id as a
    // parameter at all -- it derives it from website_visitors itself
    // and independently re-proves the visitor's current
    // identified_contact_id equals contact.id before inserting. That
    // is always true here, since Step 8's UPDATE (same transaction,
    // read-your-own-writes) already set it to contact.id.
    await client.query("select public.emit_visitor_identified_event($1, $2)", [visitor.id, contact.id]);

    return { accepted: true, visitor: { ...visitor, identifiedContactId: contact.id }, contactId: contact.id };
  });
}

/**
 * Consent-withdrawal unlink (Milestone 3.2F, Design Resolution Report
 * §I). Called by POST /track/consent's own handler (apps/web) INSIDE the
 * same PoolClient/transaction as the consent write itself, via
 * existingClient -- never a second, independently-committed round trip --
 * so the consent status change and the identity unlink either both land
 * or neither does. record_visitor_cookie_tracking_consent() (3.1C-A)
 * remains completely unmodified; this composes alongside it at the
 * application layer, exactly the pattern the accepted design called for
 * instead of touching the existing SQL function.
 *
 * A pure no-op (no write of any kind) when the visitor doesn't exist yet
 * or was never identified -- withdrawal has nothing to unlink in the
 * overwhelmingly common case, and this must not manufacture audit noise
 * for it. Deliberately does NOT set identification_suppressed_at --
 * withdrawal is reversible (a later re-grant + fresh identification is
 * allowed), unlike erasure's own permanent suppression (Milestone 3.2F's
 * other half, in the erasure migration).
 */
export async function unlinkVisitorIdentityOnWithdrawal(
  ctx: RequestContext & { organizationId: string },
  anonymousId: string,
  existingClient?: PoolClient,
): Promise<void> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const visitor = await client.query<{ id: string; identified_contact_id: string | null }>(
      `select id, identified_contact_id from public.website_visitors where organization_id = $1 and anonymous_id = $2`,
      [ctx.organizationId, anonymousId],
    );
    const row = visitor.rows[0];
    if (!row || row.identified_contact_id === null) {
      return; // nothing to unlink.
    }

    await client.query(
      `insert into public.visitor_identifications (organization_id, website_visitor_id, contact_id, event_type, token_jti)
       values ($1, $2, $3, 'unlinked_withdrawal', gen_random_uuid())`,
      [ctx.organizationId, row.id, row.identified_contact_id],
    );
    await client.query(`update public.website_visitors set identified_contact_id = null where id = $1 and organization_id = $2`, [
      row.id,
      ctx.organizationId,
    ]);
  });
}
