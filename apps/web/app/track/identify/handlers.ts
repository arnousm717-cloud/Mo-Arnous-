import { resolveOrganizationContextForTrackingSite, verifyIdentityAssertion } from "@ai-revenue-os/auth";
import { identifyVisitor } from "@ai-revenue-os/intelligence";
import { checkTrackingRateLimit } from "../_shared/rate-limit";
import { InvalidJsonError, PayloadTooLargeError, readBoundedJsonBody } from "../_shared/request";
import { ValidationError } from "../_shared/validation";
import { validateIdentifyRequest, type IdentifyRequestFields } from "../_shared/identify-validation";
import { resolveTrustedSourceIp } from "../_shared/ip";
import {
  internalErrorResponse,
  invalidRequestResponse,
  noContentResponse,
  payloadTooLargeResponse,
  rateLimitedResponse,
} from "../_shared/responses";

/**
 * POST /track/identify orchestration (Milestone 3.2D). Kept out of
 * route.ts deliberately, same reasoning as every other handlers.ts in
 * this route family — a plain Request in, directly callable from tests
 * without a running server.
 *
 * Order (deliberately corrected from the Design Resolution Report's own
 * illustrative pseudoflow — see identify.ts's own header comment for the
 * matching correction on the domain-transaction side): parse/validate
 * (cheapest) → IP + anon rate limits → resolve site → site rate limit
 * (using the RESOLVED trackingSiteId, mirroring collect/consent's own
 * established rule) → verify the signed assertion (structural parse →
 * claims shape → aud/org/anonymousId binding → freshness → DB key
 * lookup → signature) — deliberately AFTER the cheap rate limits, so a
 * flood of garbage assertions against a nonexistent/revoked/over-budget
 * site is rejected before any crypto or DB-key-lookup work — then the
 * email-hash rate-limit dimension (only now, since the email claim is
 * only trustworthy once the signature itself has verified — checking it
 * on an unverified claim would let an attacker spray arbitrary emails
 * through the limiter with no valid signature at all) → the one atomic
 * identifyVisitor(...) call → the uniform 204 every rejection reason
 * (malformed token, expired, wrong site, replayed jti, consent absent,
 * no matching contact, suppressed visitor, conflict) already collapses
 * to, mirroring collect/consent's own non-oracle design exactly.
 */
export async function handleIdentifyRequest(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await readBoundedJsonBody(request);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return payloadTooLargeResponse();
    }
    if (err instanceof InvalidJsonError) {
      return invalidRequestResponse();
    }
    return internalErrorResponse();
  }

  let fields: IdentifyRequestFields;
  try {
    fields = validateIdentifyRequest(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return invalidRequestResponse();
    }
    return internalErrorResponse();
  }

  const sourceIp = resolveTrustedSourceIp(request.headers);

  try {
    if (!(await checkTrackingRateLimit("identify", "ip", sourceIp))) {
      return rateLimitedResponse();
    }
    if (!(await checkTrackingRateLimit("identify", "anon", fields.anonymousId))) {
      return rateLimitedResponse();
    }
  } catch {
    return internalErrorResponse();
  }

  let siteContext;
  try {
    siteContext = await resolveOrganizationContextForTrackingSite(fields.siteKey);
  } catch {
    return internalErrorResponse();
  }

  if (!siteContext) {
    return noContentResponse();
  }

  try {
    if (!(await checkTrackingRateLimit("identify", "site", siteContext.trackingSiteId))) {
      return rateLimitedResponse();
    }
  } catch {
    return internalErrorResponse();
  }

  let claims;
  try {
    claims = await verifyIdentityAssertion({
      assertion: fields.assertion,
      organizationId: siteContext.organizationId,
      trackingSiteId: siteContext.trackingSiteId,
      anonymousId: fields.anonymousId,
    });
  } catch {
    return internalErrorResponse();
  }

  if (!claims) {
    return noContentResponse();
  }

  try {
    // Lowercased to match contacts_org_active_email_idx's own
    // case-insensitive matching -- otherwise "Person@Example.com" and
    // "person@example.com" would occupy two independent rate-limit
    // buckets despite resolving to the identical contact lookup.
    if (!(await checkTrackingRateLimit("identify", "email", claims.email.toLowerCase()))) {
      return rateLimitedResponse();
    }
  } catch {
    return internalErrorResponse();
  }

  try {
    await identifyVisitor(
      { organizationId: siteContext.organizationId },
      {
        trackingSiteId: siteContext.trackingSiteId,
        anonymousId: fields.anonymousId,
        contactEmail: claims.email,
        tokenJti: claims.jti,
      },
    );
  } catch {
    return internalErrorResponse();
  }

  // accepted / consent_not_granted / tracking_site_revoked / contact_not_found /
  // visitor_suppressed / conflict / replayed_jti all map here — no tenant-state oracle.
  return noContentResponse();
}
