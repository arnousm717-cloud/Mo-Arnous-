import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Milestone 2.5A. The one canonical way every /api/v1 route constructs an
 * error response — replaces ~190 independent `NextResponse.json({ error:
 * "..." }, { status })` call sites across every resource's handlers.ts/
 * route.ts, converging on the structured envelope `docs/04-API-
 * Architecture.md` §1 always specified but was never actually built
 * (previously flat `{ error: "<string>" }`, disclosed as a doc/code
 * discrepancy in that same section).
 *
 * A deliberately small, closed vocabulary — one code per HTTP-status
 * *class* actually in use, not a code per route/message. Do not add a
 * new code without also updating this comment and `docs/04-API-
 * Architecture.md` §1's own vocabulary table.
 */
export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    request_id: string;
  };
}

/**
 * `message` must already be safe to show a client (a developer-authored
 * string, a domain `ValidationError`'s own message, etc.) — this function
 * does no redaction/sanitization of its own, mirroring how `mapCrmError`
 * implementations already only ever pass through messages their own
 * typed domain-error classes produce, never a raw caught exception.
 *
 * `request_id` is freshly generated per error response (`crypto.
 * randomUUID()`, matching this repo's existing `node:crypto` usage
 * elsewhere, e.g. `_shared/idempotency.ts`) — there is no existing
 * request-scoped correlation-id mechanism anywhere in this repository
 * (confirmed by search) to thread through instead, and inventing a new
 * cross-cutting request-context mechanism (e.g. AsyncLocalStorage) purely
 * to unify this with `_shared/logger.ts`'s own structured log line is out
 * of this phase's scope — every error response still gets a real,
 * non-empty, client-reportable id, just not (yet) the same id as its own
 * log line.
 */
export function buildApiErrorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message, request_id: randomUUID() } };
}

/** Thin `NextResponse` wrapper around `buildApiErrorBody` for the common
 * case of returning the error directly. `mapCrmError`-style functions that
 * return a plain `{ status, body }` pair (later passed to `NextResponse.
 * json(mapped.body, { status: mapped.status })` at the call site) use
 * `buildApiErrorBody` directly instead — both go through the same body
 * constructor either way. */
export function apiError(code: ApiErrorCode, message: string, status: number): NextResponse {
  return NextResponse.json(buildApiErrorBody(code, message), { status });
}
