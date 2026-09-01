import { withTenantContext } from "@ai-revenue-os/database";
import { resolveOrganizationContextForTrackingSite } from "@ai-revenue-os/auth";
import { recordVisitorCookieTrackingConsent } from "@ai-revenue-os/compliance";
import { unlinkVisitorIdentityOnWithdrawal } from "@ai-revenue-os/intelligence";
import { checkTrackingRateLimit } from "../_shared/rate-limit";
import { InvalidJsonError, PayloadTooLargeError, readBoundedJsonBody } from "../_shared/request";
import { ValidationError, validateConsentRequest } from "../_shared/validation";
import { resolveTrustedSourceIp } from "../_shared/ip";
import {
  internalErrorResponse,
  invalidRequestResponse,
  noContentResponse,
  payloadTooLargeResponse,
  rateLimitedResponse,
} from "../_shared/responses";

/**
 * POST /track/consent orchestration (Milestone 3.1C-C). Same shape and
 * ordering discipline as collect/handlers.ts. Unlike collect, the
 * standalone site-resolution round trip here is NOT redundant with
 * anything downstream: recordVisitorCookieTrackingConsent returns only a
 * boolean, never a resolved trackingSiteId, so this is the only way the
 * route can obtain the canonical identifier the site-aggregate rate
 * limit needs.
 *
 * recordVisitorCookieTrackingConsent's own internal second site
 * resolution (its established TOCTOU defense — revocation between this
 * route's own resolution and the write is caught there) is never
 * bypassed or short-circuited; both resolutions are deliberate,
 * independent defense-in-depth, exactly like ingestTrackingEvent's own
 * internal re-check on the collect side.
 */
export async function handleConsentRequest(request: Request): Promise<Response> {
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

  let fields;
  try {
    fields = validateConsentRequest(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return invalidRequestResponse();
    }
    return internalErrorResponse();
  }

  const sourceIp = resolveTrustedSourceIp(request.headers);

  try {
    if (!(await checkTrackingRateLimit("consent", "ip", sourceIp))) {
      return rateLimitedResponse();
    }
    if (!(await checkTrackingRateLimit("consent", "anon", fields.anonymousId))) {
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
    if (!(await checkTrackingRateLimit("consent", "site", siteContext.trackingSiteId))) {
      return rateLimitedResponse();
    }
  } catch {
    return internalErrorResponse();
  }

  try {
    if (fields.status === "withdrawn") {
      // Milestone 3.2F: withdrawal must atomically unlink any active
      // identity binding, not merely record the consent-status change —
      // both happen on the SAME PoolClient/transaction, via
      // existingClient pass-through (the 2.5B-established composition
      // primitive), never two independently-committed round trips.
      // recordVisitorCookieTrackingConsent's own SQL function is called
      // completely unmodified; only this call site changed. The granted
      // path immediately below is untouched — byte-identical to its
      // pre-3.2F behavior.
      await withTenantContext({ organizationId: siteContext.organizationId }, async (client) => {
        const written = await recordVisitorCookieTrackingConsent(fields.siteKey, fields.anonymousId, fields.status, client);
        if (written) {
          await unlinkVisitorIdentityOnWithdrawal({ organizationId: siteContext.organizationId }, fields.anonymousId, client);
        }
      });
    } else {
      await recordVisitorCookieTrackingConsent(fields.siteKey, fields.anonymousId, fields.status);
    }
  } catch {
    return internalErrorResponse();
  }

  // true / false (revoked between resolution and write) both map here —
  // no tenant-state oracle.
  return noContentResponse();
}
