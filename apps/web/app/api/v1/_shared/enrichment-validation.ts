import { isValidUuid } from "./uuid";

/**
 * Milestone 3.3E — strict request-shape validation for the enrichment
 * write-back endpoints. Mirrors validateIdentifyRequest's own style: a
 * fixed allowed-field set, one error type for every rejection reason.
 * `workflowKey` is deliberately NOT an accepted field — it is always the
 * fixed, server-side 'lead_enrichment' constant (the only workflow this
 * milestone ships), never caller-supplied, matching the "no arbitrary
 * event-type/workflow parameter" discipline emit_visitor_identified_event
 * already established.
 */

const MAX_PROVIDER_LENGTH = 100;
const MAX_ERROR_LENGTH = 2000;
const ERROR_CLASSIFICATIONS = new Set(["timeout", "provider_4xx", "provider_5xx", "malformed_response", "internal_error"]);
const ENRICHMENT_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "provider",
  "status",
  "normalizedResult",
  "rawPayload",
  "error",
  "errorClassification",
  "costUsd",
  "sourceEventId",
  "fetchedAt",
]);

export class ValidationError extends Error {}

export interface ValidatedEnrichmentWriteBack {
  provider: string;
  status: "completed" | "failed";
  normalizedResult?: unknown;
  rawPayload?: unknown;
  error?: string;
  errorClassification?: "timeout" | "provider_4xx" | "provider_5xx" | "malformed_response" | "internal_error";
  costUsd?: number;
  sourceEventId?: string;
  fetchedAt?: string;
}

export function validateEnrichmentWriteBack(body: unknown): ValidatedEnrichmentWriteBack {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ENRICHMENT_ALLOWED_FIELDS.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  if (typeof raw.provider !== "string" || raw.provider.length === 0 || raw.provider.length > MAX_PROVIDER_LENGTH) {
    throw new ValidationError(`provider must be a non-empty string of at most ${MAX_PROVIDER_LENGTH} characters`);
  }
  if (raw.status !== "completed" && raw.status !== "failed") {
    throw new ValidationError("status must be 'completed' or 'failed'");
  }
  if (raw.normalizedResult !== undefined && (raw.normalizedResult === null || typeof raw.normalizedResult !== "object" || Array.isArray(raw.normalizedResult))) {
    throw new ValidationError("normalizedResult must be a JSON object when present");
  }
  if (raw.rawPayload !== undefined && (raw.rawPayload === null || typeof raw.rawPayload !== "object")) {
    throw new ValidationError("rawPayload must be a JSON object when present");
  }
  if (raw.error !== undefined && (typeof raw.error !== "string" || raw.error.length > MAX_ERROR_LENGTH)) {
    throw new ValidationError(`error must be a string of at most ${MAX_ERROR_LENGTH} characters when present`);
  }
  if (raw.errorClassification !== undefined && (typeof raw.errorClassification !== "string" || !ERROR_CLASSIFICATIONS.has(raw.errorClassification))) {
    throw new ValidationError("errorClassification must be one of the recognized values when present");
  }
  if (raw.costUsd !== undefined && (typeof raw.costUsd !== "number" || !Number.isFinite(raw.costUsd) || raw.costUsd < 0)) {
    throw new ValidationError("costUsd must be a non-negative finite number when present");
  }
  if (raw.sourceEventId !== undefined && !isValidUuid(raw.sourceEventId)) {
    throw new ValidationError("sourceEventId must be a valid UUID when present");
  }
  if (raw.fetchedAt !== undefined && (typeof raw.fetchedAt !== "string" || Number.isNaN(Date.parse(raw.fetchedAt)))) {
    throw new ValidationError("fetchedAt must be a valid ISO timestamp string when present");
  }
  if (raw.status === "failed" && raw.normalizedResult !== undefined) {
    throw new ValidationError("normalizedResult must not be present when status is 'failed'");
  }

  const result: ValidatedEnrichmentWriteBack = {
    provider: raw.provider,
    status: raw.status,
  };
  if (raw.normalizedResult !== undefined) result.normalizedResult = raw.normalizedResult;
  if (raw.rawPayload !== undefined) result.rawPayload = raw.rawPayload;
  if (typeof raw.error === "string") result.error = raw.error;
  if (typeof raw.errorClassification === "string") {
    result.errorClassification = raw.errorClassification as NonNullable<ValidatedEnrichmentWriteBack["errorClassification"]>;
  }
  if (typeof raw.costUsd === "number") result.costUsd = raw.costUsd;
  if (typeof raw.sourceEventId === "string") result.sourceEventId = raw.sourceEventId;
  if (typeof raw.fetchedAt === "string") result.fetchedAt = raw.fetchedAt;
  return result;
}
