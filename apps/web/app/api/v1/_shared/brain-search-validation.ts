import { EMBEDDING_DIMENSION, isValidEmbeddingVector, isZeroNormVector, SEARCH_MAX_LIMIT } from "@ai-revenue-os/brain";
import type { EntityType } from "@ai-revenue-os/brain";

/**
 * Milestone 4.1 Phase 4 — strict request-shape validation for
 * POST /api/v1/brain/search, mirroring brain-embedding-validation.ts's
 * own style exactly: a fixed allowed-field set, one error type per
 * rejection reason, delegating dimension/finiteness/limit/entityType/
 * minSimilarity checks to the same shared validators
 * searchEntityProfilesByEmbedding itself uses internally as a defensive
 * backstop — never a second, independently-maintained set of rules.
 *
 * Deliberately does NOT accept `query`/`queryText`/`text`/`prompt` — this
 * route only ever accepts an already-computed vector; no query-text-to-
 * embedding step exists anywhere in this repository.
 */

const ENTITY_TYPES = new Set(["contact", "company", "deal"]);
const SEARCH_ALLOWED_FIELDS: ReadonlySet<string> = new Set(["queryVector", "limit", "entityType", "minSimilarity"]);

export class ValidationError extends Error {}

export interface ValidatedSearchRequest {
  queryVector: number[];
  limit?: number;
  entityType?: EntityType;
  minSimilarity?: number;
}

export function validateSearchRequest(body: unknown): ValidatedSearchRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!SEARCH_ALLOWED_FIELDS.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  if (!isValidEmbeddingVector(raw.queryVector)) {
    throw new ValidationError(`queryVector must be an array of exactly ${EMBEDDING_DIMENSION} finite numbers`);
  }
  if (isZeroNormVector(raw.queryVector)) {
    throw new ValidationError("queryVector must not be an all-zero vector (cosine similarity is undefined for a zero-norm vector)");
  }

  let limit: number | undefined;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > SEARCH_MAX_LIMIT) {
      throw new ValidationError(`limit must be a positive integer not exceeding ${SEARCH_MAX_LIMIT}`);
    }
    limit = raw.limit;
  }

  let entityType: EntityType | undefined;
  if (raw.entityType !== undefined) {
    if (typeof raw.entityType !== "string" || !ENTITY_TYPES.has(raw.entityType)) {
      throw new ValidationError("entityType must be one of 'contact', 'company', 'deal'");
    }
    entityType = raw.entityType as EntityType;
  }

  let minSimilarity: number | undefined;
  if (raw.minSimilarity !== undefined) {
    if (typeof raw.minSimilarity !== "number" || !Number.isFinite(raw.minSimilarity) || raw.minSimilarity < -1 || raw.minSimilarity > 1) {
      throw new ValidationError("minSimilarity must be a finite number between -1 and 1");
    }
    minSimilarity = raw.minSimilarity;
  }

  return {
    queryVector: raw.queryVector as number[],
    ...(limit !== undefined ? { limit } : {}),
    ...(entityType !== undefined ? { entityType } : {}),
    ...(minSimilarity !== undefined ? { minSimilarity } : {}),
  };
}
