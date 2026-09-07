import { createHash } from "node:crypto";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import type { EntityType } from "./types";

/**
 * Milestone 4.1 Phase 3 — embedding write-back for entity profiles.
 *
 * This repository never calls an embedding provider and holds no provider
 * credential — n8n computes the vector externally (Milestone 4.1 Phase 3
 * Detailed Design, matching the exact `packages/intelligence`
 * `recordEnrichmentResult` precedent for Lead Enrichment). This module's
 * only job is to accept an already-generated result and persist it
 * idempotently, concurrency-safely, and freshness-checked against the
 * CURRENT `brain_entity_profiles` row — reusing `upsertEntityProfile`'s
 * proven reconciliation-loop design (`repository.ts`) verbatim, not a new
 * mechanism.
 */

/** OpenAI text-embedding-3-small/ada-002 width — matches the provisional,
 * schema-only `vector(1536)` column Phase 1 shipped (no provider was
 * selected then; this is the first phase to give that dimension a real
 * caller-facing contract). */
export const EMBEDDING_DIMENSION = 1536;

export function isValidEmbeddingVector(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSION) {
    return false;
  }
  return value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Content-hash contract (explicit, in code, per Milestone 4.1 Phase 3
 * Detailed Design §4): sha256 hex digest of
 * `JSON.stringify({ entityType, entityId, chunkText })`.
 *
 * - `chunkText` alone binds the hash to CONTENT — two write-backs for the
 *   SAME entity carrying byte-identical text hash identically, which is
 *   what makes a truly-duplicate redelivered write-back a real no-op
 *   (see `upsertEntityEmbedding` below).
 * - `entityType`/`entityId` are included so the hash also binds to SOURCE
 *   IDENTITY: two different entities that happen to produce identical
 *   chunk_text (a real possibility for small structured profiles, e.g.
 *   two contacts with no data yet) still hash differently, and — more
 *   importantly — a chunk accidentally attached to the wrong entity by a
 *   caller-side bug produces a hash that visibly does not match what the
 *   receiving row's own identity would predict, rather than silently
 *   looking like a legitimate duplicate.
 * - `sourceVersionAt`/timestamps are deliberately EXCLUDED — the point of
 *   this hash is "is this exact content already stored," and a
 *   redelivery of identical content computed at a later wall-clock time
 *   must still hash the same, or duplicate-detection would never work.
 *
 * Built-in `node:crypto` only — no hashing dependency added.
 */
export function computeContentHash(input: { entityType: EntityType; entityId: string; chunkText: string }): string {
  const canonical = JSON.stringify({
    entityType: input.entityType,
    entityId: input.entityId,
    chunkText: input.chunkText,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface EmbeddingWriteBackInput {
  entityType: EntityType;
  entityId: string;
  chunkText: string;
  embedding: readonly number[];
  /** The source `brain_entity_profiles.computed_at` this embedding was
   * generated from — never wall-clock write-completion time. See the
   * migration's own column comment for the full freshness-token
   * rationale (identical to `upsertEntityProfile`'s `sourceUpdatedAt`). */
  sourceVersionAt: string;
}

export type EmbeddingWriteBackResult =
  | { status: "created"; embeddingId: string }
  | { status: "updated"; embeddingId: string }
  | { status: "unchanged"; embeddingId: string }
  | { status: "stale"; embeddingId: string | null }
  | { status: "entity_not_found" };

const ENTITY_ID_COLUMN: Record<EntityType, "contact_id" | "company_id" | "deal_id"> = {
  contact: "contact_id",
  company: "company_id",
  deal: "deal_id",
};

interface ExistingEmbeddingRow {
  id: string;
  content_hash: string;
  source_version_at: string;
}

/** Bounded reconciliation attempts for the first-insert race below —
 * PROVABLY sufficient, by the exact same argument `upsertEntityProfile`'s
 * own header comment already makes for `brain_entity_profiles`: `SELECT
 * ... FOR UPDATE` cannot lock a row that doesn't exist yet, so two
 * concurrent first-time write-backs for the same entity profile can both
 * observe "no row" and both attempt `INSERT ... ON CONFLICT DO NOTHING`.
 * The loser's own INSERT returning zero rows is itself proof the winner
 * is now durably committed and visible (a conflicting INSERT blocks on
 * the winner's row-level lock until the winner resolves), so the loop
 * below re-runs the existing-row branch on the very next iteration,
 * which is guaranteed to find the winner's row. */
const MAX_UPSERT_ATTEMPTS = 2;

/**
 * Idempotent, concurrency-safe upsert of one entity's current embedding.
 *
 * Reuses `upsertEntityProfile`'s exact design (`repository.ts`'s own
 * header comment has the full argument, not repeated in full here):
 * `SELECT ... FOR UPDATE` serializes concurrent reconciliations for the
 * SAME entity; a freshness guard rejects a result computed from an
 * already-superseded profile snapshot; a first-insert race is resolved by
 * looping back to the now-guaranteed-to-succeed existing-row branch.
 *
 * Three additional properties specific to embeddings, not profiles:
 * - The profile itself must currently exist — an embedding can only ever
 *   attach to a live `brain_entity_profiles` row. `entity_not_found`
 *   covers both "never had a profile" and "the owning entity was hard-
 *   erased since this embedding job started" identically, since Phase
 *   1's own `ON DELETE CASCADE` removes the profile row structurally on
 *   erasure — there is nothing further this function needs to do for
 *   GDPR correctness, and a late/stale write-back arriving after erasure
 *   is rejected here, never resurrecting anything.
 * - `content_hash` equality against the currently-stored row makes a
 *   truly-duplicate redelivery (identical content) a real no-op — no
 *   UPDATE, no history-equivalent write, `status: "unchanged"`.
 * - `entity_profile_id` is set exactly once, at first creation, and never
 *   changes on subsequent updates to the same row — only content/
 *   embedding/hash/freshness are ever touched in place.
 */
export async function upsertEntityEmbedding(
  ctx: RequestContext & { organizationId: string },
  input: EmbeddingWriteBackInput,
): Promise<EmbeddingWriteBackResult> {
  if (!isValidEmbeddingVector(input.embedding)) {
    throw new RangeError(`embedding must be an array of ${EMBEDDING_DIMENSION} finite numbers`);
  }
  const column = ENTITY_ID_COLUMN[input.entityType];
  const contentHash = computeContentHash(input);
  const vectorLiteral = `[${input.embedding.join(",")}]`;

  return withTenantContext(ctx, async (client) => {
    const profileResult = await client.query<{ id: string; computed_at: string }>(
      `select id, computed_at from public.brain_entity_profiles
       where organization_id = $1 and ${column} = $2
       for update`,
      [ctx.organizationId, input.entityId],
    );
    const profile = profileResult.rows[0];
    if (!profile) {
      return { status: "entity_not_found" };
    }
    if (new Date(input.sourceVersionAt).getTime() < new Date(profile.computed_at).getTime()) {
      return { status: "stale", embeddingId: null };
    }

    for (let attempt = 0; attempt < MAX_UPSERT_ATTEMPTS; attempt++) {
      const existing = await client.query<ExistingEmbeddingRow>(
        `select id, content_hash, source_version_at from public.brain_embeddings
         where organization_id = $1 and entity_profile_id = $2
         for update`,
        [ctx.organizationId, profile.id],
      );
      const existingRow = existing.rows[0];

      if (existingRow) {
        if (new Date(input.sourceVersionAt).getTime() < new Date(existingRow.source_version_at).getTime()) {
          return { status: "stale", embeddingId: existingRow.id };
        }
        if (existingRow.content_hash === contentHash) {
          return { status: "unchanged", embeddingId: existingRow.id };
        }
        await client.query(
          `update public.brain_embeddings
           set chunk_text = $1, embedding = $2::vector, content_hash = $3, source_version_at = $4, metadata = $5::jsonb
           where id = $6`,
          [input.chunkText, vectorLiteral, contentHash, input.sourceVersionAt, JSON.stringify({}), existingRow.id],
        );
        return { status: "updated", embeddingId: existingRow.id };
      }

      // No existing row under this lock — attempt a fresh insert. The
      // conflict target must exactly match brain_embeddings_entity_profile_uidx
      // (a partial unique index), so the ON CONFLICT clause repeats its
      // own WHERE predicate verbatim — the same Postgres arbiter-inference
      // requirement upsertEntityProfile's own insert branch documents.
      const inserted = await client.query<{ id: string }>(
        `insert into public.brain_embeddings
           (organization_id, source_type, entity_profile_id, chunk_text, embedding, content_hash, source_version_at, metadata)
         values ($1, 'entity_profile', $2, $3, $4::vector, $5, $6, $7::jsonb)
         on conflict (organization_id, entity_profile_id) where entity_profile_id is not null do nothing
         returning id`,
        [ctx.organizationId, profile.id, input.chunkText, vectorLiteral, contentHash, input.sourceVersionAt, JSON.stringify({})],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow) {
        await client.query(
          `insert into public.brain_embedding_entity_refs (organization_id, embedding_id, entity_type, ${column})
           values ($1, $2, $3, $4)`,
          [ctx.organizationId, insertedRow.id, input.entityType, input.entityId],
        );
        return { status: "created", embeddingId: insertedRow.id };
      }
      // Lost the first-insert race — loop back to reconcile against the
      // now-durably-existing winner via the existing-row branch above.
    }

    // Unreachable: MAX_UPSERT_ATTEMPTS = 2 is provably sufficient above
    // (same argument as upsertEntityProfile's own identical loop).
    throw new Error(
      `upsertEntityEmbedding: first-insert reconciliation did not converge within ${MAX_UPSERT_ATTEMPTS} attempts for entityType=${input.entityType} entityId=${input.entityId} — this should be unreachable.`,
    );
  });
}
