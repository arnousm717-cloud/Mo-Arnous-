import { applyCorsHeaders } from "./cors";

/**
 * The complete, closed response vocabulary for the public /track/* routes
 * (Milestone 3.1C-C) — deliberately smaller than the existing /api/v1
 * error envelope (`_shared/api-error.ts`'s `{error:{code,message,
 * request_id}}`). This is an intentional divergence, not an oversight:
 * these are anonymous, adversarial, non-oracle endpoints where a smaller,
 * flatter vocabulary is itself a security property — no per-field
 * validation detail, no request_id correlating a client-visible response
 * to server-side state, nothing beyond the fixed code needed to build a
 * conforming caller. Every response carries the CORS headers (see
 * cors.ts's own doc comment for why every response class needs them).
 */

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({ "content-type": "application/json" });
  applyCorsHeaders(headers);
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers.set(name, value);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * The one success/non-action response for both routes — persisted,
 * consent-not-granted, revoked site, and nonexistent site are ALL
 * represented identically. No tenant-state oracle: a caller can never
 * distinguish "your event was recorded" from "that site doesn't exist"
 * from "no consent was on file" by inspecting the response.
 */
export function noContentResponse(): Response {
  const headers = new Headers();
  applyCorsHeaders(headers);
  return new Response(null, { status: 204, headers });
}

export function invalidRequestResponse(): Response {
  return jsonResponse(400, { error: "invalid_request" });
}

export function payloadTooLargeResponse(): Response {
  return jsonResponse(413, { error: "payload_too_large" });
}

export function rateLimitedResponse(): Response {
  return jsonResponse(429, { error: "rate_limited" }, { "Retry-After": "60", "X-RateLimit-Remaining": "0" });
}

export function internalErrorResponse(): Response {
  return jsonResponse(500, { error: "internal_error" });
}
