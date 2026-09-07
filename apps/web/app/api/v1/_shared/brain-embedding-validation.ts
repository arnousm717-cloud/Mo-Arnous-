import { EMBEDDING_DIMENSION, isValidEmbeddingVector } from "@ai-revenue-os/brain";
import { isValidUuid } from "./uuid";

/**
 * Milestone 4.1 Phase 3 — strict request-shape validation for
 * POST /api/v1/brain/embeddings, mirroring
 * enrichment-validation.ts's own style exactly: a fixed allowed-field
 * set, one error type for every rejection reason, dimension/finiteness
 * checked here (before the value ever reaches persistent state) using the
 * one shared validator `packages/brain` itself also uses internally as a
 * defensive backstop — not a second, independently-maintained check.
 */

const MAX_CHUNK_TEXT_LENGTH = 20000;
const ENTITY_TYPES = new Set(["contact", "company", "deal"]);
const EMBEDDING_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "entityType",
  "entityId",
  "chunkText",
  "embedding",
  "sourceVersionAt",
]);

export class ValidationError extends Error {}

export interface ValidatedEmbeddingWriteBack {
  entityType: "contact" | "company" | "deal";
  entityId: string;
  chunkText: string;
  embedding: number[];
  sourceVersionAt: string;
}

export function validateEmbeddingWriteBack(body: unknown): ValidatedEmbeddingWriteBack {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!EMBEDDING_ALLOWED_FIELDS.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  if (typeof raw.entityType !== "string" || !ENTITY_TYPES.has(raw.entityType)) {
    throw new ValidationError("entityType must be one of 'contact', 'company', 'deal'");
  }
  if (!isValidUuid(raw.entityId)) {
    throw new ValidationError("entityId must be a valid UUID");
  }
  if (typeof raw.chunkText !== "string" || raw.chunkText.length === 0 || raw.chunkText.length > MAX_CHUNK_TEXT_LENGTH) {
    throw new ValidationError(`chunkText must be a non-empty string of at most ${MAX_CHUNK_TEXT_LENGTH} characters`);
  }
  if (!isValidEmbeddingVector(raw.embedding)) {
    throw new ValidationError(`embedding must be an array of exactly ${EMBEDDING_DIMENSION} finite numbers`);
  }
  if (typeof raw.sourceVersionAt !== "string" || Number.isNaN(Date.parse(raw.sourceVersionAt))) {
    throw new ValidationError("sourceVersionAt must be a valid ISO timestamp string");
  }

  return {
    entityType: raw.entityType as "contact" | "company" | "deal",
    entityId: raw.entityId,
    chunkText: raw.chunkText,
    embedding: raw.embedding as number[],
    sourceVersionAt: raw.sourceVersionAt,
  };
}
