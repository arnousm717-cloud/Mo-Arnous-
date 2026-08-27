import { resolveOrganizationContextForTrackingSite } from "@ai-revenue-os/auth";
import { ingestTrackingEvent } from "@ai-revenue-os/intelligence";
import { checkTrackingRateLimit } from "../_shared/rate-limit";
import { InvalidJsonError, PayloadTooLargeError, readBoundedJsonBody } from "../_shared/request";
import { ValidationError, validateCollectRequest } from "../_shared/validation";
import { resolveTrustedSourceIp } from "../_shared/ip";
import {
  internalErrorResponse,
  invalidRequestResponse,
  noContentResponse,
  payloadTooLargeResponse,
  rateLimitedResponse,
} from "../_shared/responses";

/**
 * POST /track/collect orchestration (Milestone 3.1C-C). Kept out of
 * route.ts deliberately — same reasoning as every other handlers.ts in
 * this codebase (see apps/web/app/api/v1/consent/handlers.ts): takes a
 * plain Request, directly callable from tests without a running server.
 *
 * Order matches the accepted design exactly: validate/parse first
 * (cheapest, no DB), then IP + anonymous rate limits (cheap, hash+counter
 * only), then site resolution (the one real table lookup), then the site
 * aggregate rate limit using the RESOLVED/TRUSTED canonical
 * trackingSiteId — never a pre-resolution siteKey — then the one
 * ingestTrackingEvent(...) call.
 *
 * Deliberately does NOT perform a separate consent-check DB call:
 * ingestTrackingEvent already performs the authoritative consent check
 * inside its own atomic transaction and returns a discriminated result
 * (accepted / consent_not_granted / tracking_site_revoked) — every branch
 * of that result maps to the identical 204 below, so there is nothing for
 * a standalone pre-check to add except a redundant round trip.
 *
 * Every rate-limit check is fail-closed: a thrown error from
 * checkTrackingRateLimit stops the request immediately (500), never
 * falling through to resolution or ingestion.
 */
export async function handleCollectRequest(request: Request): Promise<Response> {
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
    fields = validateCollectRequest(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return invalidRequestResponse();
    }
    return internalErrorResponse();
  }

  const sourceIp = resolveTrustedSourceIp(request.headers);

  try {
    if (!(await checkTrackingRateLimit("collect", "ip", sourceIp))) {
      return rateLimitedResponse();
    }
    if (!(await checkTrackingRateLimit("collect", "anon", fields.anonymousId))) {
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
    if (!(await checkTrackingRateLimit("collect", "site", siteContext.trackingSiteId))) {
      return rateLimitedResponse();
    }
  } catch {
    return internalErrorResponse();
  }

  try {
    await ingestTrackingEvent(
      { organizationId: siteContext.organizationId },
      {
        trackingSiteId: siteContext.trackingSiteId,
        anonymousId: fields.anonymousId,
        anonymousSessionId: fields.anonymousSessionId,
        eventType: fields.eventType,
        ...(fields.url !== undefined ? { url: fields.url } : {}),
        ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
        ...(fields.referrer !== undefined ? { referrer: fields.referrer } : {}),
        ...(fields.utmSource !== undefined ? { utmSource: fields.utmSource } : {}),
        ...(fields.utmMedium !== undefined ? { utmMedium: fields.utmMedium } : {}),
        ...(fields.utmCampaign !== undefined ? { utmCampaign: fields.utmCampaign } : {}),
        ...(fields.deviceType !== undefined ? { deviceType: fields.deviceType } : {}),
        ...(fields.landingPage !== undefined ? { landingPage: fields.landingPage } : {}),
      },
    );
  } catch {
    return internalErrorResponse();
  }

  // accepted / consent_not_granted / tracking_site_revoked all map here —
  // no tenant-state oracle.
  return noContentResponse();
}
