import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { isValidEmbeddingVector } from "./embeddings";
import { BrainError } from "./errors";
import type { EntityType } from "./types";

/**
 * Milestone 4.1 Phase 4 — Tenant-Safe Semantic Retrieval Foundation.
 *
 * A foundation, not the target `brain.semantic_search` agent tool
 * (`docs/11-AI-Revenue-Brain.md` §5) — no query text, no agent tool
 * layer, no provider call anywhere in this module or its callers. The
 * caller supplies an already-computed 1536-dimension query vector (the
 * exact same boundary Phase 3's write-back already established — this
 * repository never calls an embedding provider) and this module performs
 * an exact (non-ANN) pgvector cosine-similarity search over the current
 * organization's own fresh entity-profile embeddings only.
 */

export class SearchValidationError extends BrainError {
  constructor(message: string) {
    super(message, "search_validation_error");
    this.name = "SearchValidationError";
  }
}

/** Mirrors packages/crm/src/pagination.ts's own DEFAULT_LIMIT/MAX_LIMIT/
 * resolveLimit discipline exactly, as a small local equivalent rather than
 * a cross-package import — this is a Brain-domain search concept, not a
 * CRM list-pagination one, even though the validation shape is identical. */
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;

const SUPPORTED_ENTITY_TYPES: ReadonlySet<EntityType> = new Set(["contact", "company", "deal"]);

/**
 * Phase 3's `isValidEmbeddingVector` only checks dimension/finiteness — it
 * does not, and must not (it's a stable, already-accepted write contract),
 * reject an all-zero vector. Phase 4 is the first CONSUMER that computes
 * WITH a vector (pgvector's cosine distance divides by each side's own
 * L2 norm), so an all-zero vector — legal on write — produces a
 * mathematically undefined (NaN) distance on read: silently serializes as
 * `null` over JSON despite the declared `similarity: number` contract,
 * and — because Postgres's float8 total ordering defines NaN as the
 * maximum value — satisfies `minSimilarity` at any threshold including
 * 1.0. This is a Phase-4-local guard, not a Phase-3 contract change.
 *
 * Checking every element is exactly `0` is the precise, epsilon-free
 * equivalent of "L2 norm is exactly zero" for real numbers (a sum of
 * squares is zero iff every term is zero) — and is actually MORE
 * numerically robust than computing `sqrt(sum(x^2))` directly, which
 * could itself underflow to `0` in floating point for a technically
 * nonzero vector of extremely small magnitude. A normal small-but-nonzero
 * vector is never affected.
 */
export function isZeroNormVector(vector: readonly number[]): boolean {
  return vector.every((n) => n === 0);
}

export function resolveSearchLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return SEARCH_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SearchValidationError("limit must be a positive integer");
  }
  if (limit > SEARCH_MAX_LIMIT) {
    throw new SearchValidationError(`limit must not exceed ${SEARCH_MAX_LIMIT}`);
  }
  return limit;
}

/** Cosine similarity's own mathematical range is [-1, 1] — validated
 * against that exact range, not a narrower empirically-observed one, since
 * nothing in this codebase can guarantee which range a future caller's
 * embedding model actually produces. */
function validateMinSimilarity(minSimilarity: number | undefined): number | undefined {
  if (minSimilarity === undefined) {
    return undefined;
  }
  if (!Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1) {
    throw new SearchValidationError("minSimilarity must be a finite number between -1 and 1");
  }
  return minSimilarity;
}

function validateEntityType(entityType: EntityType | undefined): EntityType | undefined {
  if (entityType === undefined) {
    return undefined;
  }
  if (!SUPPORTED_ENTITY_TYPES.has(entityType)) {
    throw new SearchValidationError("entityType must be one of 'contact', 'company', 'deal'");
  }
  return entityType;
}

export interface SearchEntityProfilesInput {
  queryVector: readonly number[];
  limit?: number;
  entityType?: EntityType;
  minSimilarity?: number;
}

export interface EntityProfileSearchResult {
  entityProfileId: string;
  entityType: EntityType;
  entityId: string;
  similarity: number;
  sourceVersionAt: string;
}

interface SearchRow {
  entity_profile_id: string;
  entity_type: EntityType;
  entity_id: string;
  similarity: number;
  source_version_at: string;
}

/**
 * Tenant-safe exact (non-ANN) pgvector cosine-similarity search over the
 * current organization's own FRESH entity-profile embeddings only.
 *
 * Tenant isolation is defense-in-depth, not RLS-alone (`08-Security.md`
 * §5's own "Aggregation risk" doctrine, already named for exactly this
 * feature before it existed): `withTenantContext` sets the RLS session
 * context (`current_org()`), AND this query's own WHERE clause repeats
 * `organization_id = $1` explicitly against BOTH joined tables — a caller
 * can never observe another organization's rows even if RLS were somehow
 * misconfigured or bypassed.
 *
 * Freshness (Detailed Design §7): only embeddings whose own
 * `source_version_at` is at least as new as the CURRENT
 * `brain_entity_profiles.computed_at` are candidates at all — excluded
 * from the SQL predicate itself, never ranked-then-filtered afterward.
 * This comparison runs entirely inside Postgres (`timestamptz >=
 * timestamptz`), never round-tripped through node-pg's own
 * millisecond-truncating `Date` parser first, so it is not subject to the
 * precision limitation `upsertEntityEmbedding`'s own JS-side comparison
 * carries (packages/brain/src/embeddings.ts) — a genuine improvement, not
 * merely a repetition of that design.
 *
 * `entity_profile_id is not null` and `embedding is not null` are both
 * explicit guards: Phase 1's own general, entity-profile-id-less
 * `brain_embeddings` shape (a chunk with no single-entity identity) is
 * structurally excluded from this Phase-4 result set entirely, and a
 * defensive guard against a theoretical (never produced by
 * `upsertEntityEmbedding`, which always sets both together) row with
 * `entity_profile_id` set but `embedding` still null.
 *
 * Cosine similarity (`<=>`, pgvector's cosine DISTANCE operator; this
 * function returns `1 - distance` as SIMILARITY) — not inner product
 * (`<#>`) — deliberately: nothing in this codebase normalizes a
 * caller-supplied query or stored vector (verified: zero normalization
 * logic exists anywhere in `embeddings.ts`), and cosine similarity is
 * scale-invariant by definition, so ranking correctness never depends on
 * an unenforced normalization assumption the way inner-product ranking
 * would. No ANN index (HNSW/IVFFlat) exists or is added — an exact scan,
 * intentional for this milestone's realistic per-tenant row scale
 * (`docs/02-Software-Architecture.md` §6's own named pgvector revisit
 * trigger points at Phase 5 email/meeting volume, not this).
 *
 * Deterministic ordering: `ORDER BY <cosine distance> ASC,
 * entity_profile_id ASC` — a stable UUID tie-break for equal-distance
 * rows, never a timestamp (avoiding any variant of the millisecond-
 * precision class of issue Phase 2's pagination fix already closed once).
 *
 * Result shape is deliberately minimized: entity identity, similarity,
 * and freshness token only — never `chunk_text`, the raw vector, or any
 * CRM field. A caller wanting profile/CRM content must make its own,
 * separately-permission-checked read call; this function cannot leak
 * content it never returns.
 */
export async function searchEntityProfilesByEmbedding(
  ctx: RequestContext & { organizationId: string },
  input: SearchEntityProfilesInput,
): Promise<EntityProfileSearchResult[]> {
  if (!isValidEmbeddingVector(input.queryVector)) {
    throw new SearchValidationError("queryVector must be an array of 1536 finite numbers");
  }
  if (isZeroNormVector(input.queryVector)) {
    throw new SearchValidationError("queryVector must not be an all-zero vector (cosine similarity is undefined for a zero-norm vector)");
  }
  const limit = resolveSearchLimit(input.limit);
  const entityType = validateEntityType(input.entityType);
  const minSimilarity = validateMinSimilarity(input.minSimilarity);

  const vectorLiteral = `[${input.queryVector.join(",")}]`;

  return withTenantContext(ctx, async (client) => {
    const conditions = [
      "be.organization_id = $1",
      "ep.organization_id = $1",
      "be.entity_profile_id is not null",
      "be.embedding is not null",
      // Excludes a zero-norm STORED embedding from candidacy entirely —
      // Phase 3's write-back contract permits one (dimension/finiteness
      // only), so a historical row may already exist. `vector_norm` is a
      // real pgvector 0.8.2 function (verified live); this predicate runs
      // before similarity projection, minSimilarity filtering, ordering,
      // and limit, so a degenerate row can never become a candidate at
      // all, let alone survive a threshold or occupy a limited slot.
      "vector_norm(be.embedding) > 0",
      "be.source_version_at >= ep.computed_at",
    ];
    const params: unknown[] = [ctx.organizationId, vectorLiteral];

    if (entityType) {
      params.push(entityType);
      conditions.push(`ep.entity_type = $${params.length}`);
    }
    if (minSimilarity !== undefined) {
      params.push(minSimilarity);
      conditions.push(`(1 - (be.embedding <=> $2::vector)) >= $${params.length}`);
    }
    params.push(limit);
    const limitParamIndex = params.length;

    const query = `
      select
        be.entity_profile_id as entity_profile_id,
        ep.entity_type as entity_type,
        coalesce(ep.contact_id, ep.company_id, ep.deal_id) as entity_id,
        (1 - (be.embedding <=> $2::vector)) as similarity,
        be.source_version_at as source_version_at
      from public.brain_embeddings be
      join public.brain_entity_profiles ep
        on ep.organization_id = be.organization_id and ep.id = be.entity_profile_id
      where ${conditions.join(" and ")}
      order by be.embedding <=> $2::vector asc, be.entity_profile_id asc
      limit $${limitParamIndex}
    `;

    const result = await client.query<SearchRow>(query, params);
    return result.rows.map((row) => ({
      entityProfileId: row.entity_profile_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      similarity: row.similarity,
      sourceVersionAt: row.source_version_at,
    }));
  });
}
