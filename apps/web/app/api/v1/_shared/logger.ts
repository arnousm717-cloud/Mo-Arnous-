import { redactDeep } from "./redaction";

/**
 * Structured JSON request logging (M1.8, docs/12-Implementation-
 * Milestones.md, docs/02-Software-Architecture.md §6). Emits one JSON
 * object per line to stdout — Vercel's own Runtime Logs is the sink, no
 * new log-aggregation vendor. Every string field is passed through the
 * shared redaction module (_shared/redaction.ts) before being logged, the
 * same function Sentry's beforeSend hook uses, so there is exactly one
 * place the redaction rule set is defined.
 *
 * Deliberately narrow: only the fields explicitly approved for M1.8 are
 * accepted. Raw request bodies, full headers, cookies, and Authorization
 * headers are never parameters here at all — there is no field for them to
 * flow through, not just a redaction rule hoping to catch them after the
 * fact.
 */

export type LogLevel = "info" | "warn" | "error";

export interface StructuredLogFields {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  /** Only ever the already-resolved actor id — never a client-supplied value. */
  actorId?: string | null;
  /** Only ever the already-resolved organization id — never a client-supplied value. */
  organizationId?: string | null;
  /** A short, developer-authored, safe description — never a raw thrown error's own message/stack verbatim. */
  message: string;
  /** A coarse error category (e.g. an Error constructor name), not full error detail. */
  errorType?: string;
}

const ALLOWED_KEYS = [
  "timestamp",
  "level",
  "method",
  "route",
  "status",
  "durationMs",
  "actorId",
  "organizationId",
  "message",
  "errorType",
] as const;

function pickAllowedFields(entry: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) {
    if (key in entry) {
      result[key] = entry[key];
    }
  }
  return result;
}

/**
 * Logs one structured request entry. Fail-open by design (M1.8 requirement):
 * if serialization or the write itself throws for any reason, the failure
 * is swallowed here, never propagated — observability must never become a
 * new source of request failures.
 */
export function logRequest(level: LogLevel, fields: StructuredLogFields): void {
  try {
    const entry = pickAllowedFields({
      timestamp: new Date().toISOString(),
      level,
      ...fields,
    });
    const redacted = redactDeep(entry);
    // stdout is the intended structured-log sink (Vercel Runtime Logs); see docs/08-Security.md §7.
    console.log(JSON.stringify(redacted));
  } catch {
    // Deliberately swallowed — see the fail-open note above.
  }
}

/**
 * Wraps a Next.js route handler (any GET/POST/etc. export, regardless of
 * its specific argument shape) so it logs one structured entry per request
 * — the "every route now logs structured request/response metadata"
 * deliverable — without duplicating timing/logging boilerplate across
 * every route.ts file individually.
 *
 * Deliberately does not call Sentry here: structured logging and error
 * tracking are kept as two independent concerns (M1.8 Decision D) — this
 * wrapper's only job is the JSON log line; @sentry/nextjs's own automatic
 * instrumentation is what captures the exception itself.
 */
export function withRequestLogging<Args extends unknown[]>(
  method: string,
  route: string,
  handler: (...args: Args) => Response | Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    const start = Date.now();
    try {
      const response = await handler(...args);
      logRequest(response.status >= 500 ? "error" : "info", {
        method,
        route,
        status: response.status,
        durationMs: Date.now() - start,
        message: "request completed",
      });
      return response;
    } catch (error) {
      logRequest("error", {
        method,
        route,
        status: 500,
        durationMs: Date.now() - start,
        message: "request threw an unhandled error",
        errorType: error instanceof Error ? error.constructor.name : "UnknownError",
      });
      throw error;
    }
  };
}
