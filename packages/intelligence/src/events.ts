import type { PoolClient } from "pg";
import { runInClientOrTransaction, type RequestContext } from "@ai-revenue-os/database";
import { InvalidEventTypeError, InvalidSessionRelationshipError } from "./errors";

export type EventType = "pageview" | "form_submit" | "click";

const EVENT_TYPES: readonly EventType[] = ["pageview", "form_submit", "click"];

const SESSION_ORG_FK_VIOLATION = "visitor_events_session_org_fk";

export interface VisitorEvent {
  id: string;
  organizationId: string;
  sessionId: string;
  eventType: EventType;
  url: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

interface VisitorEventRow {
  id: string;
  organization_id: string;
  session_id: string;
  event_type: string;
  url: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
}

function mapEventRow(row: VisitorEventRow): VisitorEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sessionId: row.session_id,
    eventType: row.event_type as EventType,
    url: row.url,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
  };
}

export interface AppendVisitorEventInput {
  sessionId: string;
  eventType: EventType;
  url?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an event row (Milestone 3.1B). eventType is validated against
 * the exact same set the database CHECK constraint enforces, rejected
 * here first with a typed, friendlier error — mirrors packages/crm's
 * established convention of a domain-level rejection ahead of the DB's
 * own backstop, never relying on the raw constraint violation alone.
 * occurred_at is always database-assigned (no input field exists on
 * AppendVisitorEventInput) — never accepted as client-supplied. No
 * payload-size enforcement here — that stays a 3.1C/HTTP-boundary
 * concern, not a domain invariant.
 */
export async function appendVisitorEvent(
  ctx: RequestContext & { organizationId: string },
  input: AppendVisitorEventInput,
  existingClient?: PoolClient,
): Promise<VisitorEvent> {
  if (!EVENT_TYPES.includes(input.eventType)) {
    throw new InvalidEventTypeError(
      `eventType must be one of ${EVENT_TYPES.join(", ")}, received "${String(input.eventType)}"`,
    );
  }

  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    try {
      const r = await client.query<VisitorEventRow>(
        `insert into public.visitor_events (organization_id, session_id, event_type, url, metadata)
         values ($1, $2, $3, $4, $5)
         returning id, organization_id, session_id, event_type, url, metadata, occurred_at`,
        [ctx.organizationId, input.sessionId, input.eventType, input.url ?? null, JSON.stringify(input.metadata ?? {})],
      );
      const row = r.rows[0];
      if (!row) {
        throw new Error("visitor_events insert returned no row — this should be unreachable.");
      }
      return mapEventRow(row);
    } catch (err) {
      if (isForeignKeyViolation(err, SESSION_ORG_FK_VIOLATION)) {
        throw new InvalidSessionRelationshipError(
          "sessionId does not resolve to a session in the caller's own organization",
        );
      }
      throw err;
    }
  });
}

interface PostgresError {
  code?: string;
  constraint?: string;
}

function isForeignKeyViolation(err: unknown, constraintName: string): boolean {
  const pgErr = err as PostgresError;
  return pgErr?.code === "23503" && pgErr?.constraint === constraintName;
}
