import { isValidUuid } from "../../api/v1/_shared/uuid";
import { MAX_ASSERTION_STRING_LENGTH } from "@ai-revenue-os/auth";
import { ValidationError } from "./validation";

/**
 * Request-shape validation for POST /track/identify (Milestone 3.2D).
 * Mirrors validateCollectRequest/validateConsentRequest exactly: one
 * error type for every rejection reason, a fixed allowed-field set, UUID
 * canonicalization via the same case-insensitive regex + toLowerCase()
 * already used everywhere else in this route family. Reuses
 * ValidationError from ./validation rather than declaring a second,
 * redundant error class.
 *
 * Deliberately does NOT parse/verify the assertion itself here — that is
 * a cryptographic concern (packages/auth's tracking-identity-assertions),
 * not a request-shape one. This module only proves the three fields
 * exist, are the right primitive type, and nothing else was smuggled in.
 */

export interface IdentifyRequestFields {
  siteKey: string;
  anonymousId: string;
  assertion: string;
}

const IDENTIFY_ALLOWED_FIELDS: ReadonlySet<string> = new Set(["siteKey", "anonymousId", "assertion"]);

function normalizeUuid(value: unknown): string {
  if (typeof value !== "string" || !isValidUuid(value)) {
    throw new ValidationError("field must be a valid UUID");
  }
  return value.toLowerCase();
}

/**
 * Validates and canonicalizes a parsed POST /track/identify body. Rejects
 * any top-level field outside the fixed allowed set — no contactId, no
 * raw email, no organizationId can ever reach this far, structurally
 * (there is no field for them to occupy), matching the accepted design's
 * own "public input MUST NOT contain authoritative organizationId/
 * contactId/raw email outside the signed assertion" requirement.
 */
export function validateIdentifyRequest(body: unknown): IdentifyRequestFields {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!IDENTIFY_ALLOWED_FIELDS.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  const siteKey = normalizeUuid(raw.siteKey);
  const anonymousId = normalizeUuid(raw.anonymousId);

  if (
    typeof raw.assertion !== "string" ||
    raw.assertion.length === 0 ||
    raw.assertion.length > MAX_ASSERTION_STRING_LENGTH
  ) {
    throw new ValidationError(`assertion must be a non-empty string of at most ${MAX_ASSERTION_STRING_LENGTH} characters`);
  }

  return { siteKey, anonymousId, assertion: raw.assertion };
}
