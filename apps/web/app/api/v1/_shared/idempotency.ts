import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";

/**
 * Idempotency-Key foundation (Milestone 2.1F-A, docs/13-Technical-Design-
 * Review.md "Milestone 2.1F-A"). Generic and error-type-agnostic — this
 * file has no knowledge of Company/Contact, packages/crm's error classes,
 * or RBAC. It only knows: run this callback; if it returns a value,
 * persist and replay that; if it throws, let the whole transaction roll
 * back and persist nothing. The route-specific mapping (which packages/crm
 * error becomes which HTTP status) stays entirely inside each route's own
 * callback, keeping this helper reusable for any future idempotent
 * mutation endpoint.
 *
 * MUST only be called after authentication, organization resolution, and
 * can() have already succeeded for the current request — a cached replay
 * must never bypass fresh authorization. This is enforced by convention
 * (the caller's own responsibility), not by anything in this file, since
 * this module has no knowledge of auth/RBAC at all.
 */

const TTL = "24 hours";
// Bounded: a request only ever loops back here when the previous
// reservation owner's transaction rolled back between our INSERT attempt
// and our subsequent SELECT ... FOR UPDATE — an inherently rare race, not
// something expected to happen repeatedly for the same key. 3 attempts is
// enough to absorb that race without risking an unbounded loop; a fourth
// consecutive rollback for the very same key would indicate a genuine bug
// elsewhere, which the thrown error below surfaces as a 500 rather than
// silently spinning.
const MAX_RESERVATION_ATTEMPTS = 3;

export interface IdempotencyResult {
  status: number;
  body: unknown;
}

export type IdempotencyOutcome = { kind: "result"; status: number; body: unknown } | { kind: "conflict" };

interface IdempotencyRow {
  id: string;
  status: "in_progress" | "completed";
  request_fingerprint: string;
  response_status: number | null;
  response_body: unknown;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Recursively sorts object keys so semantically identical bodies with
 * differently-ordered keys produce the same fingerprint — a plain
 * JSON.stringify would not guarantee this. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  return `{${entries.join(",")}}`;
}

/** The raw Idempotency-Key header value is never persisted — only this
 * hash. Never the raw request body either — only a fingerprint of the
 * normalized (method, route, body) identity (2.1F-A approved decisions). */
export function hashIdempotencyKey(rawKey: string): string {
  return sha256Hex(rawKey);
}

export function computeRequestFingerprint(method: string, route: string, body: unknown): string {
  return sha256Hex(`${method}\n${route}\n${stableStringify(body)}`);
}

/**
 * Wraps a mutation `fn` with Idempotency-Key reservation/replay. `fn`
 * receives the same PoolClient the reservation itself is running under
 * (already tenant-scoped by the outer withTenantContext) — passing that
 * client straight into a packages/crm mutation function's optional
 * `existingClient` parameter is what makes reservation + mutation +
 * response persistence one atomic transaction, never three separate ones.
 *
 * Concurrency algorithm (empirically verified against real local Postgres
 * with two independent connections, not merely reasoned about):
 *   1. Reclaim an expired row for this key inline, if one exists (no
 *      background job — 2.1F-A approved decision).
 *   2. INSERT ... ON CONFLICT (organization_id, idempotency_key_hash) DO
 *      NOTHING RETURNING. A returned row means this transaction owns the
 *      reservation.
 *   3. If no row was returned, another transaction already holds this key.
 *      SELECT ... FOR UPDATE on it — this blocks until that transaction
 *      resolves:
 *        - It commits -> our SELECT unblocks and sees the row with
 *          status='completed' and a real response.
 *        - It rolls back (an unexpected 5xx in that request) -> its INSERT
 *          never persisted, so our SELECT unblocks and finds no row at
 *          all -> loop back to step 1 and become the new owner ourselves.
 *   4. A found, completed row: fingerprint match -> replay; mismatch ->
 *      409 conflict (not persisted as its own result — re-evaluated fresh
 *      on every retry, per the 2.1F-A approved decision).
 */
export async function withIdempotency(
  ctx: RequestContext & { organizationId: string },
  params: { idempotencyKeyHash?: string; rawIdempotencyKey: string; method: string; route: string; body: unknown },
  fn: (client: PoolClient) => Promise<IdempotencyResult>,
): Promise<IdempotencyOutcome> {
  const keyHash = params.idempotencyKeyHash ?? hashIdempotencyKey(params.rawIdempotencyKey);
  const fingerprint = computeRequestFingerprint(params.method, params.route, params.body);

  return withTenantContext(ctx, async (client) => {
    for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt++) {
      await client.query(
        `delete from public.idempotency_keys
         where organization_id = $1 and idempotency_key_hash = $2 and expires_at <= now()`,
        [ctx.organizationId, keyHash],
      );

      const inserted = await client.query<IdempotencyRow>(
        `insert into public.idempotency_keys
           (organization_id, idempotency_key_hash, method, route, request_fingerprint, expires_at)
         values ($1, $2, $3, $4, $5, now() + interval '${TTL}')
         on conflict (organization_id, idempotency_key_hash) do nothing
         returning id, status, request_fingerprint, response_status, response_body`,
        [ctx.organizationId, keyHash, params.method, params.route, fingerprint],
      );

      const ownedRow = inserted.rows[0];
      if (ownedRow) {
        // Unexpected errors from fn() propagate out of this entire
        // withTenantContext callback, rolling back the whole transaction
        // — including this INSERT — so no row survives a 5xx failure.
        const result = await fn(client);
        await client.query(
          `update public.idempotency_keys
           set status = 'completed', response_status = $1, response_body = $2
           where id = $3`,
          [result.status, JSON.stringify(result.body), ownedRow.id],
        );
        return { kind: "result", status: result.status, body: result.body };
      }

      const existing = await client.query<IdempotencyRow>(
        `select id, status, request_fingerprint, response_status, response_body
         from public.idempotency_keys
         where organization_id = $1 and idempotency_key_hash = $2
         for update`,
        [ctx.organizationId, keyHash],
      );

      const row = existing.rows[0];
      if (!row) {
        // The prior owner rolled back between our INSERT attempt and this
        // SELECT — retry the reservation from the top of the loop.
        continue;
      }

      if (row.request_fingerprint !== fingerprint) {
        return { kind: "conflict" };
      }

      // status is guaranteed 'completed' here: FOR UPDATE only unblocks
      // after the owning transaction resolves, and a resolved-but-still-
      // present row can only be the committed, completed one (a rolled-
      // back reservation leaves no row at all, handled above).
      return { kind: "result", status: row.response_status as number, body: row.response_body };
    }

    throw new Error(
      `Could not reserve an idempotency key after ${MAX_RESERVATION_ATTEMPTS} attempts — this should be exceptionally rare.`,
    );
  });
}
