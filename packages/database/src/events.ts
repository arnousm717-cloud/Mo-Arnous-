import { getPool } from "./pool";

/**
 * The in-process outbox dispatcher (M1.7, docs/02-Software-Architecture.md
 * §5). Reads pending events, invokes registered consumers, records
 * per-consumer delivery.
 *
 * Milestone 3.3 Reliability Remediation — redesigned (batching/locking).
 * The original Milestone 3.3A/F design ran an entire dispatch pass (every
 * pending event across every tenant, unbounded) inside ONE database
 * transaction shared with the caller's own advisory lock, holding that
 * transaction open across every consumer's external HTTP call, serially,
 * with a single COMMIT at the very end. The Milestone 3.3 Final
 * Implementation Acceptance Audit found this unsafe: no LIMIT on the
 * pending-events query meant a real pre-existing backlog could hold a
 * pooled connection and the global lock open for the entire batch's
 * wall-clock duration and risk a live-lock under a serverless function
 * timeout.
 *
 * Redesign (batching/locking):
 *
 *   1. BOUNDED BATCH — at most DISPATCH_BATCH_SIZE pending events per call
 *      (a fixed, code-defined constant, never caller/request-controlled).
 *      Bounds one invocation's worst-case wall-clock time to
 *      (batch size) x (a consumer's own external-call timeout), keeping
 *      every invocation short regardless of total backlog size, and
 *      guaranteeing forward progress: a large backlog is drained across
 *      several dispatch ticks rather than requiring one unbounded pass to
 *      ever fully complete.
 *
 *   2. NO LOCK — event_deliveries' own UNIQUE (event_id, consumer)
 *      constraint, via an atomic acquire/reclaim statement (below), is the
 *      ENTIRE concurrency-safety mechanism. No advisory lock, session- or
 *      transaction-scoped, is needed to prevent two overlapping dispatch
 *      invocations from both delivering the same (event, consumer) pair.
 *      A transaction-scoped advisory lock specifically could not have been
 *      mechanically preserved here even if desired: it can only span ONE
 *      transaction, and this design deliberately no longer runs the batch
 *      inside one transaction — reusing it would mean either reintroducing
 *      the single batch-wide transaction or upgrading to a session-scoped
 *      lock, unsafe under this deployment's Supavisor transaction-pooling
 *      mode. Removing the lock entirely also means overlapping invocations
 *      under a large backlog contribute PARALLEL forward progress instead
 *      of one blocking/skipping the other.
 *
 *   3. NO TRANSACTION SPANS ANY EXTERNAL CALL — every database statement is
 *      a single, independent `getPool().query(...)` call (no explicit
 *      BEGIN/COMMIT, no held PoolClient). Each statement is its own
 *      complete, self-contained transaction, checked out and returned to
 *      the pool immediately — the natural fit for Supavisor's
 *      transaction-pooling mode.
 *
 * A single failing statement now affects only the one event/consumer pair
 * it belongs to — there is no batch-wide transaction left for it to roll
 * back, so one event's bookkeeping failure can never discard another,
 * unrelated event's already-recorded delivery.
 *
 * Milestone 3.3 Reliability Remediation — redesigned (claim-lease, Second
 * Final Implementation Acceptance Audit remediation). The first
 * remediation pass replaced "record delivery after success" with
 * "durably insert a claim row BEFORE calling handle(), delete it on a
 * caught failure" — reasoning that since the claim was committed before
 * any external effect, nothing could ever lose track of a genuine
 * success. The audit found this reasoning incomplete: a row's mere
 * EXISTENCE meant "delivered" under that design, but the row was written
 * before handle() ran, not after it succeeded — so a process crash
 * (a Vercel function timeout/kill, an OOM, a deploy rollover) strictly
 * BETWEEN the insert and either delivery completing or the catch block's
 * own cleanup left a row indistinguishable from a real success:
 * permanently un-retried, with no automated recovery. A passing
 * concurrency test does not prove this — concurrency and crash-recovery
 * are different properties.
 *
 * The fix: event_deliveries now models three real states, not two —
 *
 *   unclaimed (no row) -> leased (status='leased', in flight, possibly by
 *   a since-crashed process) -> delivered (status='delivered', terminal).
 *
 * Acquisition and stale-lease reclamation are the SAME single atomic
 * statement (see the per-consumer loop below):
 *
 *   insert into event_deliveries (event_id, consumer, status, lease_expires_at)
 *   values ($1, $2, 'leased', now() + (LEASE_DURATION_SECONDS seconds))
 *   on conflict (event_id, consumer) do update set
 *     status = 'leased', lease_expires_at = excluded.lease_expires_at
 *   where event_deliveries.status = 'leased'
 *     and event_deliveries.lease_expires_at < now()
 *   returning id
 *
 * Three cases, one statement: never claimed before -> the plain INSERT
 * succeeds. A prior lease has expired -> the conflict path's UPDATE fires
 * (this IS the crash-recovery path — no separate sweeper process exists
 * or is needed). A lease is still active, or the pair is already
 * 'delivered' -> the UPDATE's own WHERE clause evaluates false, RETURNING
 * yields zero rows, and this dispatcher correctly skips it. A 'delivered'
 * row can never be reclaimed, by construction: the WHERE clause only ever
 * matches status='leased'. Correct under arbitrary real concurrency
 * without any lock: Postgres's row-level locking on the UPDATE serializes
 * two simultaneous attempts against the SAME (event_id, consumer) — the
 * second re-evaluates its WHERE clause against the first's just-committed
 * values under READ COMMITTED semantics, so at most one of two
 * simultaneous acquire/reclaim attempts can ever see the pre-reclaim state
 * and win (proven empirically, not merely asserted — see
 * packages/database/tests/dispatcher.test.ts's own stale-lease
 * concurrency test).
 *
 * On success, a SEPARATE, explicit statement transitions 'leased' ->
 * 'delivered' — an independently persisted terminal-success record,
 * distinct from the lease itself, exactly what the audit required. On a
 * DEFINITE caught failure (we know it failed; we are not crashed), the row
 * is deleted immediately rather than waiting out the lease duration, so a
 * legitimate retry can happen on the very next tick. A process that
 * crashes instead of reaching either of those two outcomes leaves the
 * lease in place; it self-heals once lease_expires_at passes, via the
 * SAME acquire/reclaim statement above.
 *
 * At-least-once delivery, not exactly-once external side effects — this is
 * an unavoidable distributed-systems boundary, not something this design
 * (or any purely-local one) can close: if the external system (n8n)
 * successfully receives and begins processing a trigger, but this process
 * dies before the terminal 'delivered' write commits, the lease will
 * eventually expire and a future tick WILL retry — correctly, by this
 * dispatcher's own contract, but from n8n's perspective this is a second
 * delivery of the same logical trigger. This dispatcher closes the
 * "silently lost forever" failure mode; it does not and cannot make the
 * external call itself exactly-once. This is why every outbound trigger
 * this dispatcher's own consumer sends carries event.id verbatim
 * (`eventId` in leadEnrichmentConsumer's payload, apps/web/app/api/
 * internal/dispatch-events/handlers.ts) — a stable identifier, identical
 * across every retry of the same (event, consumer) pair, that downstream
 * processing can use to deduplicate. Whether n8n's own workflow actually
 * does so is outside this repository's control (Milestone 3.3 Architecture
 * Resolution Report §D/§E already disclosed this boundary); the write-back
 * endpoint's own `sourceEventId`-keyed workflow_runs uniqueness constraint
 * independently guarantees this system's own cost/observability
 * bookkeeping cannot double-count regardless of how many times n8n itself
 * is triggered for the same event (proven in packages/intelligence/tests/
 * enrichment.test.ts).
 *
 * Tenant-agnostic, deliberately (unchanged from M1.7): does NOT use
 * withTenantContext (which scopes to one organization's RLS session) — it
 * reads across every tenant's pending events in a single pass, the same
 * documented "service-role bypass" pattern docs/03-Database-Architecture.md
 * §5 already names for scheduled/system jobs, never reachable from an
 * ordinary request handler (events/event_deliveries carry zero grants to
 * `authenticated` — see the M1.7 RLS migration). It must NOT (and does
 * not) infer tenant permissions, broaden tenant access, or run an
 * arbitrary query on a consumer's behalf — a consumer receives the full
 * DomainEvent, including organization_id, and is solely responsible for
 * scoping its own side effects to it.
 */

/**
 * At most this many pending events are considered per dispatchPendingEvents()
 * call. Fixed, code-defined, never derived from a request/caller parameter.
 * Conservative: with the one consumer this milestone ships (a single
 * outbound webhook POST, 10s timeout), a full batch's worst case is
 * DISPATCH_BATCH_SIZE x 10s = 100s — short enough to comfortably complete
 * within an ordinary serverless function's execution budget even in the
 * worst case, while still processing meaningfully many events per minute
 * under Vercel Cron's own 1-minute schedule (vercel.json). A larger backlog
 * is drained across multiple ticks, never by growing this constant.
 */
export const DISPATCH_BATCH_SIZE = 10;

/**
 * How long an acquired delivery lease remains exclusive before it becomes
 * eligible for reclamation by a later dispatch tick (Milestone 3.3
 * Claim-Lease Reliability Remediation). Fixed, code-defined, never derived
 * from a request/caller parameter — same discipline as DISPATCH_BATCH_SIZE.
 * Chosen with generous headroom over the single external call a
 * consumer's own handle() performs today (a 10s fetch timeout, e.g.
 * leadEnrichmentConsumer) plus ordinary DB-round-trip overhead — no
 * legitimate in-flight attempt can plausibly still be running at 120s —
 * while still being short enough, relative to Vercel Cron's own 1-minute
 * schedule (vercel.json), that a genuinely crashed lease recovers within a
 * small, bounded number of ticks rather than sitting stuck for a long
 * time.
 */
export const LEASE_DURATION_SECONDS = 120;

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

export async function dispatchPendingEvents(consumers: EventConsumer[]): Promise<DispatchSummary> {
  const pool = getPool();
  const summary: DispatchSummary = {
    eventsSeen: 0,
    deliveriesAttempted: 0,
    deliveriesSucceeded: 0,
    deliveriesFailed: 0,
  };

  // Scoped to event types the CALLER's own currently-registered consumers
  // actually care about. Without this, an event of a type no registered
  // consumer matches would still occupy a batch slot forever (it is never
  // marked processed_at, since `applicable.length === 0` skips that
  // bookkeeping below) — meaning the SAME oldest, permanently-irrelevant
  // events would be re-selected on every single call, starving newer,
  // genuinely actionable events behind them (a real head-of-line-blocking
  // regression the original unbounded design never had, since it visited
  // every pending event on every call regardless). Scoping the SELECT
  // itself closes this: an irrelevant event is never selected at all by a
  // call whose consumers don't cover it, so it can never consume a slot in
  // that call's batch. If a future caller registers a NEW consumer for a
  // previously-uncovered event type, that call's own eventTypes list
  // naturally includes it, and the (still processed_at IS NULL) backlog of
  // that type becomes visible again — no less capable than before.
  const eventTypes = [...new Set(consumers.flatMap((c) => c.eventTypes))];
  if (eventTypes.length === 0) {
    return summary;
  }

  const pending = await pool.query<EventRow>(
    "select * from public.events where processed_at is null and event_type = any($1) order by created_at asc limit $2",
    [eventTypes, DISPATCH_BATCH_SIZE],
  );

  for (const row of pending.rows) {
    const event = toDomainEvent(row);
    summary.eventsSeen += 1;

    const applicable = consumers.filter((c) => c.eventTypes.includes(event.eventType));
    if (applicable.length === 0) {
      continue;
    }

    for (const consumer of applicable) {
      // Atomic lease acquire-or-reclaim — the entire concurrency-safety
      // AND crash-recovery mechanism (see this module's own header
      // comment for the full reasoning). Zero rows means: already
      // terminally 'delivered', OR a still-active lease held by another
      // in-flight attempt (this dispatcher's own or a concurrent
      // invocation's) — either way, skip cleanly.
      const lease = await pool.query<{ id: string }>(
        `insert into public.event_deliveries (event_id, consumer, status, lease_expires_at)
         values ($1, $2, 'leased', now() + ($3::int * interval '1 second'))
         on conflict (event_id, consumer) do update set
           status = 'leased',
           lease_expires_at = excluded.lease_expires_at
         where public.event_deliveries.status = 'leased'
           and public.event_deliveries.lease_expires_at < now()
         returning id`,
        [event.id, consumer.name, LEASE_DURATION_SECONDS],
      );
      if (lease.rows.length === 0) {
        continue;
      }

      summary.deliveriesAttempted += 1;
      try {
        await consumer.handle(event);
        // Terminal success — independently persisted, distinct from the
        // lease itself. Once this commits, the pair can never be
        // reclaimed or redelivered again: the acquire/reclaim statement's
        // own WHERE clause only ever matches status='leased'.
        await pool.query(
          "update public.event_deliveries set status = 'delivered' where event_id = $1 and consumer = $2 and status = 'leased'",
          [event.id, consumer.name],
        );
        summary.deliveriesSucceeded += 1;
      } catch {
        // A DEFINITE, caught failure — we know it failed, we are not
        // crashed. Release immediately rather than waiting out the lease
        // duration, so a legitimate retry can happen on the very next
        // tick. (A process that crashes instead of reaching this catch
        // leaves the lease in place — it self-heals once
        // lease_expires_at passes, via the same acquire/reclaim statement
        // above; no separate sweeper is needed.) Failure isolation: this
        // only affects this one pair, never any other event or consumer
        // in the batch.
        await pool.query(
          "delete from public.event_deliveries where event_id = $1 and consumer = $2 and status = 'leased'",
          [event.id, consumer.name],
        );
        summary.deliveriesFailed += 1;
      }
    }

    // Observability convenience ONLY (M1.7 Decision A) — NOT the
    // idempotency mechanism (event_deliveries' own unique constraint,
    // together with its status/lease_expires_at columns, is). A harmless
    // best-effort flag; its own failure or omission cannot compromise
    // delivery correctness. Counts only TERMINALLY delivered rows — an
    // active or stale lease must never count toward this, or an event
    // could be marked globally processed while a consumer's delivery is
    // still genuinely outstanding.
    //
    // Milestone 3.3 processed_at Completion Remediation — the Final
    // Implementation Acceptance Audit found this query scoped to ANY
    // status='delivered' row for the event, with no restriction on WHICH
    // consumer delivered it. Reproduced directly: a historical/renamed/
    // removed consumer's own (unrelated) delivered row could satisfy the
    // count even while the CURRENT invocation's own applicable consumer
    // had just failed — silently, permanently excluding a genuinely
    // undelivered event from all future retry once processed_at is set
    // (WHERE processed_at IS NULL gates every future selection). The
    // fix: the completion decision is scoped to exactly the consumer
    // names applicable IN THIS CALL, both in the query's own WHERE
    // clause (parameterized, never interpolated) and in what it is
    // compared against — a deduplicated count of applicable consumer
    // NAMES, not applicable.length itself, since nothing in EventConsumer
    // or this dispatcher structurally guarantees a caller never registers
    // two entries sharing the same name (event_deliveries' own UNIQUE
    // (event_id, consumer) constraint means such a duplicate could never
    // produce two delivered rows either way, but comparing against a
    // possibly-inflated applicable.length would still be wrong on its
    // own terms).
    const applicableConsumerNames = [...new Set(applicable.map((c) => c.name))];
    const deliveredCount = await pool.query<{ count: string }>(
      "select count(*)::text as count from public.event_deliveries where event_id = $1 and status = 'delivered' and consumer = any($2)",
      [event.id, applicableConsumerNames],
    );
    if (Number(deliveredCount.rows[0]?.count ?? 0) >= applicableConsumerNames.length) {
      await pool.query("update public.events set processed_at = now() where id = $1 and processed_at is null", [
        event.id,
      ]);
    }
  }

  return summary;
}
