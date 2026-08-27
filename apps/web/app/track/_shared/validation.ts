import { isValidUuid } from "../../api/v1/_shared/uuid";
import type { EventType } from "@ai-revenue-os/intelligence";
import type { TrackingConsentStatus } from "@ai-revenue-os/compliance";

/**
 * Request-shape validation and canonicalization for the public /track/*
 * routes (Milestone 3.1C-C). One error type for every rejection reason —
 * the route maps ValidationError to the single, non-oracle 400
 * invalid_request response; this module never leaks which field failed
 * or why, by construction (the message is developer-facing only, never
 * surfaced to the caller).
 *
 * UUID canonicalization: validate shape first with the existing
 * case-insensitive regex (apps/web/app/api/v1/_shared/uuid.ts, reused
 * rather than reinvented), then .toLowerCase(). A full UUID parse/
 * restringify was considered and rejected as unnecessary — the regex
 * already forces canonical hyphen placement and segment lengths, so the
 * only remaining non-canonical degree of freedom a matching string can
 * have is letter case, which .toLowerCase() fully resolves. Only the
 * normalized value is ever used downstream (site resolution, rate-limit
 * hashing, the intelligence/compliance wrapper calls).
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// Mirrors packages/intelligence/src/events.ts's own EVENT_TYPES exactly —
// that module keeps this array private (only the EventType *type* is
// exported), so the runtime membership list is necessarily duplicated
// here rather than imported. Keep in sync with events.ts by hand.
const EVENT_TYPES: readonly EventType[] = ["pageview", "form_submit", "click"];

// Mirrors the exact "granted" | "withdrawn" union TrackingConsentStatus
// resolves to — @ai-revenue-os/compliance exports the type only, not a
// runtime array, for the identical reason as EVENT_TYPES above.
const CONSENT_STATUSES: readonly TrackingConsentStatus[] = ["granted", "withdrawn"];

const MAX_URL_LENGTH = 2048;
const MAX_REFERRER_LENGTH = 2048;
const MAX_LANDING_PAGE_LENGTH = 2048;
const MAX_UTM_LENGTH = 255;
const MAX_DEVICE_TYPE_LENGTH = 50;

const METADATA_MAX_BYTES = 4096;
const METADATA_MAX_DEPTH = 3;
const METADATA_MAX_KEYS = 50;
const METADATA_MAX_KEY_LENGTH = 100;
const METADATA_MAX_STRING_LENGTH = 500;

function normalizeUuid(value: unknown): string {
  if (typeof value !== "string" || !isValidUuid(value)) {
    throw new ValidationError("field must be a valid UUID");
  }
  return value.toLowerCase();
}

function validateOptionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new ValidationError(`field must be a string of at most ${maxLength} characters`);
  }
  return value;
}

interface MetadataWalkState {
  keyCount: number;
}

/**
 * One bounded recursive walk over the parsed metadata value, enforcing
 * depth/key-count/key-length/string-length together in a single pass.
 * Maximum recursion depth is METADATA_MAX_DEPTH (3) plus one — trivially
 * safe, no stack-overflow surface. The top-level metadata object itself
 * is depth 1; each object OR array nested one level deeper is depth+1 —
 * arrays count toward depth identically to objects (closing the
 * array-nesting depth-limit bypass), but only object keys ever count
 * toward the global key budget (arrays contribute no keys of their own,
 * only objects nested inside them do, once the walk reaches them).
 *
 * The parsed value is never mutated, copied key-by-key, or merged into
 * any other object — it is validated in place and, on success, passed
 * through to the caller by reference. JSON.parse's own well-defined
 * behavior (a "__proto__" key becomes an ordinary own property on the
 * resulting plain object, never a real prototype-chain mutation) combined
 * with never manually reconstructing the object means there is no
 * prototype-pollution surface here at all.
 */
function walkMetadataValue(value: unknown, depth: number, state: MetadataWalkState): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    if (value.length > METADATA_MAX_STRING_LENGTH) {
      throw new ValidationError("metadata string value too long");
    }
    return;
  }
  if (depth > METADATA_MAX_DEPTH) {
    throw new ValidationError("metadata nested too deeply");
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkMetadataValue(item, depth + 1, state);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (key.length > METADATA_MAX_KEY_LENGTH) {
        throw new ValidationError("metadata key too long");
      }
      state.keyCount += 1;
      if (state.keyCount > METADATA_MAX_KEYS) {
        throw new ValidationError("metadata has too many keys");
      }
      walkMetadataValue(nestedValue, depth + 1, state);
    }
    return;
  }
  // Not reachable from JSON.parse output (e.g. undefined/function) —
  // rejected defensively rather than silently ignored.
  throw new ValidationError("metadata contains an unsupported value");
}

function validateMetadata(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("metadata must be a JSON object");
  }
  const state: MetadataWalkState = { keyCount: 0 };
  walkMetadataValue(value, 1, state);

  const serializedByteLength = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (serializedByteLength > METADATA_MAX_BYTES) {
    throw new ValidationError("metadata is too large");
  }

  return value as Record<string, unknown>;
}

export interface CollectRequestFields {
  siteKey: string;
  anonymousId: string;
  anonymousSessionId: string;
  eventType: EventType;
  url?: string;
  metadata?: Record<string, unknown>;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  deviceType?: string;
  landingPage?: string;
}

const COLLECT_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "siteKey",
  "anonymousId",
  "anonymousSessionId",
  "eventType",
  "url",
  "metadata",
  "referrer",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "deviceType",
  "landingPage",
]);

/**
 * Validates and canonicalizes a parsed POST /track/collect body.
 * Rejects any top-level field outside the fixed allowed set — this is
 * not a general-purpose public API requiring forward compatibility for
 * third-party integrators; the tracking script is a first-party artifact,
 * so a smaller, stricter surface is unambiguously safer.
 */
export function validateCollectRequest(body: unknown): CollectRequestFields {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!COLLECT_ALLOWED_FIELDS.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  const siteKey = normalizeUuid(raw.siteKey);
  const anonymousId = normalizeUuid(raw.anonymousId);
  const anonymousSessionId = normalizeUuid(raw.anonymousSessionId);

  if (typeof raw.eventType !== "string" || !EVENT_TYPES.includes(raw.eventType as EventType)) {
    throw new ValidationError(`eventType must be one of: ${EVENT_TYPES.join(", ")}`);
  }
  const eventType = raw.eventType as EventType;

  const url = validateOptionalString(raw.url, MAX_URL_LENGTH);
  const referrer = validateOptionalString(raw.referrer, MAX_REFERRER_LENGTH);
  const landingPage = validateOptionalString(raw.landingPage, MAX_LANDING_PAGE_LENGTH);
  const utmSource = validateOptionalString(raw.utmSource, MAX_UTM_LENGTH);
  const utmMedium = validateOptionalString(raw.utmMedium, MAX_UTM_LENGTH);
  const utmCampaign = validateOptionalString(raw.utmCampaign, MAX_UTM_LENGTH);
  const deviceType = validateOptionalString(raw.deviceType, MAX_DEVICE_TYPE_LENGTH);
  const metadata = raw.metadata !== undefined ? validateMetadata(raw.metadata) : undefined;

  return {
    siteKey,
    anonymousId,
    anonymousSessionId,
    eventType,
    ...(url !== undefined ? { url } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(referrer !== undefined ? { referrer } : {}),
    ...(utmSource !== undefined ? { utmSource } : {}),
    ...(utmMedium !== undefined ? { utmMedium } : {}),
    ...(utmCampaign !== undefined ? { utmCampaign } : {}),
    ...(deviceType !== undefined ? { deviceType } : {}),
    ...(landingPage !== undefined ? { landingPage } : {}),
  };
}

export interface ConsentRequestFields {
  siteKey: string;
  anonymousId: string;
  status: TrackingConsentStatus;
}

const CONSENT_ALLOWED_FIELDS: ReadonlySet<string> = new Set(["siteKey", "anonymousId", "status"]);

/**
 * Validates and canonicalizes a parsed POST /track/consent body. Exactly
 * three fields are ever accepted — anonymousSessionId, metadata,
 * organizationId, IP, userId, and roleKey are all rejected the same way
 * any other unknown field is, via the fixed allowed-field set below,
 * rather than needing individual special-case checks.
 */
export function validateConsentRequest(body: unknown): ConsentRequestFields {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!CONSENT_ALLOWED_FIELDS.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  const siteKey = normalizeUuid(raw.siteKey);
  const anonymousId = normalizeUuid(raw.anonymousId);

  if (typeof raw.status !== "string" || !CONSENT_STATUSES.includes(raw.status as TrackingConsentStatus)) {
    throw new ValidationError(`status must be one of: ${CONSENT_STATUSES.join(", ")}`);
  }

  return { siteKey, anonymousId, status: raw.status as TrackingConsentStatus };
}
