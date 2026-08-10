import { getPool } from "./pool";

/**
 * The in-process outbox dispatcher (M1.7, docs/02-Software-Architecture.md
 * §5). Reads pending events, invokes registered consumers, records
 * per-consumer delivery. Fan-out to n8n/Edge Functions is explicitly
 * Phase 3 — this is the in-process-only skeleton docs/12-Implementation-
 * Milestones.md's M1.7 entry scopes this milestone to.
 */

export interface DomainEvent {
  id: string;
  eventType: string;
  eventVersion: number;
  organizationId: string;
  payload: unknown;
  createdAt: string;
  processedAt: string | null;
}

/**
 * `name` is a static, code-defined identifier supplied by the caller that
 * registers this consumer — never looked up or constructed from a database
 * column, an event payload, or any other runtime input (M1.7 requirement
 * #2: no dynamic execution of consumer names from database/user input).
 */
export interface EventConsumer {
  name: string;
  eventTypes: string[];
  handle: (event: DomainEvent) => Promise<void>;
}

export interface DispatchSummary {
  eventsSeen: number;
  deliveriesAttempted: number;
  deliveriesSucceeded: number;
  deliveriesFailed: number;
}

interface EventRow {
  id: string;
  event_type: string;
  event_version: number;
  organization_id: string;
  payload: unknown;
  created_at: string;
  processed_at: string | null;
}

function toDomainEvent(row: EventRow): DomainEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    organizationId: row.organization_id,
    payload: row.payload,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

/**
 * Tenant-agnostic infrastructure, deliberately. Does NOT use
 * withTenantContext (which scopes to one organization's RLS session) — it
 * reads across every tenant's pending events in a single pass, the same
 * documented "service-role bypass" pattern
 * docs/03-Database-Architecture.md §5 already names for scheduled/system
 * jobs, never reachable from an ordinary request handler (events/
 * event_deliveries carry zero grants to `authenticated` — see the M1.7
 * RLS migration). It must NOT (and does not) infer tenant permissions,
 * broaden tenant access, or run an arbitrary query on a consumer's
 * behalf — a consumer receives the full DomainEvent, including
 * organization_id, and is solely responsible for scoping its own side
 * effects to it.
 *
 * At-least-once delivery, not exactly-once: if this process crashes AFTER
 * a consumer's handle() succeeds but BEFORE the corresponding
 * event_deliveries row commits, the next dispatch call will invoke that
 * consumer again for the same event — event_deliveries prevents
 * DOUBLE-COUNTING once a delivery is recorded, it does not (and cannot)
 * make an arbitrary external side effect (an API call, an email send)
 * exactly-once across a crash in that specific window. Any consumer whose
 * handle() has a non-transactional external effect must be idempotent on
 * its own terms (e.g., keyed by event.id) — this dispatcher does not, and
 * cannot, provide that guarantee on a consumer's behalf.
 */
export async function dispatchPendingEvents(consumers: EventConsumer[]): Promise<DispatchSummary> {
  const pool = getPool();
  const client = await pool.connect();
  const summary: DispatchSummary = {
    eventsSeen: 0,
    deliveriesAttempted: 0,
    deliveriesSucceeded: 0,
    deliveriesFailed: 0,
  };
  try {
    const pending = await client.query<EventRow>(
      "select * from public.events where processed_at is null order by created_at asc",
    );

    for (const row of pending.rows) {
      const event = toDomainEvent(row);
      summary.eventsSeen += 1;

      const applicable = consumers.filter((c) => c.eventTypes.includes(event.eventType));
      if (applicable.length === 0) {
        continue;
      }

      for (const consumer of applicable) {
        const already = await client.query(
          "select 1 from public.event_deliveries where event_id = $1 and consumer = $2",
          [event.id, consumer.name],
        );
        if (already.rows.length > 0) {
          // Already delivered — idempotent skip. This is the actual
          // (event_id, consumer) guarantee (M1.7 Decision A), not
          // events.processed_at, which is set below only as a convenience.
          continue;
        }

        summary.deliveriesAttempted += 1;
        try {
          await consumer.handle(event);
          await client.query(
            "insert into public.event_deliveries (event_id, consumer) values ($1, $2) on conflict (event_id, consumer) do nothing",
            [event.id, consumer.name],
          );
          summary.deliveriesSucceeded += 1;
        } catch {
          // Failure isolation: this consumer's failure must not prevent
          // the NEXT applicable consumer from being attempted for this
          // same event. No delivery row is written, so this
          // (event, consumer) pair remains eligible for retry on the next
          // dispatchPendingEvents() call — never silently dropped.
          summary.deliveriesFailed += 1;
        }
      }

      const deliveredCount = await client.query<{ count: string }>(
        "select count(*)::text as count from public.event_deliveries where event_id = $1",
        [event.id],
      );
      if (Number(deliveredCount.rows[0]?.count ?? 0) >= applicable.length) {
        // Every currently-registered consumer for this event's type has a
        // successful delivery record — set the observability convenience
        // flag. Guarded by "processed_at is null" so this is a harmless
        // no-op on an event a concurrent dispatch call already marked.
        await client.query(
          "update public.events set processed_at = now() where id = $1 and processed_at is null",
          [event.id],
        );
      }
    }
  } finally {
    client.release();
  }
  return summary;
}
