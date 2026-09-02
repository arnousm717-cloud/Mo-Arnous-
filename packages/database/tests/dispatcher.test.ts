import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";
import { dispatchPendingEvents, DISPATCH_BATCH_SIZE, type DomainEvent, type EventConsumer } from "../src/events";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Dispatcher idempotency and failure isolation (M1.7 requirement #4),
 * plus (Milestone 3.3 Reliability Remediation) bounded-batch and
 * lock-free concurrency behavior.
 *
 * Registers real EventConsumer callbacks (static, code-defined identifiers
 * — never looked up from the database, per requirement #2) against a real
 * membership.created event, and proves the exact four behaviors the
 * approved plan names: first dispatch invokes both once; second dispatch
 * invokes neither again; partial failure retries only the failed consumer;
 * already-successful consumers are never repeated.
 *
 * dispatchPendingEvents() is deliberately tenant-agnostic (M1.7
 * requirement #1) — it processes pending events across the whole table,
 * not just the ones this test just created. Other test files (and earlier
 * tests in this same file) also leave unprocessed events behind, so every
 * consumer here counts invocations PER EVENT ID (a map keyed by event.id),
 * and assertions check the count for this test's own eventId specifically
 * — never a bare top-level call counter.
 *
 * Milestone 3.3 Reliability Remediation changed dispatchPendingEvents from
 * "one call always drains the entire pending backlog" to "one call
 * processes at most DISPATCH_BATCH_SIZE pending events, oldest first" (see
 * events.ts's own header comment for the full rationale). That means a
 * single call is no longer guaranteed to reach any one specific event —
 * under a real ambient backlog (which this shared-database test
 * environment always has some of), a freshly created event can sit behind
 * older still-pending ones from other tests/files/event types. Every test
 * below that depends on its own event being reached now retries a bounded
 * number of times rather than asserting after exactly one call — this
 * mirrors production reality directly: a real cron tick under backlog
 * needs multiple ticks to reach a given event too, and that is the
 * intended, tested behavior, not a workaround.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `dispatcher-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createOrgAndGetEvent(label: string): Promise<{ organizationId: string; eventId: string }> {
  const userId = await createAuthUser(label);
  const organizationId = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      `Dispatcher ${label} Org`,
      `dispatcher-${label}-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0].organization_id as string;
  });
  const eventId = await seedAsAdmin(async (client) => {
    const r = await client.query(
      "select id from public.events where organization_id = $1 and event_type = 'membership.created'",
      [organizationId],
    );
    return r.rows[0].id as string;
  });
  return { organizationId, eventId };
}

async function seedOrg(label: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      [`Dispatcher ${label} Org`, `dispatcher-${label}-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  });
}

/** Raw event insert, bypassing any real domain emitter — used only by the
 * batch-size/concurrency probes below, which need many events of a
 * type/consumer no other test in the system will ever match, so ambient
 * backlog from elsewhere cannot corrupt their own counts. */
async function seedRawEvent(organizationId: string, eventType: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.events (event_type, organization_id, payload) values ($1, $2, '{}'::jsonb) returning id",
      [eventType, organizationId],
    );
    return r.rows[0]!.id;
  });
}

async function deliveryRows(eventId: string): Promise<{ consumer: string }[]> {
  return seedAsAdmin(async (client) => {
    const r = await client.query("select consumer from public.event_deliveries where event_id = $1 order by consumer", [
      eventId,
    ]);
    return r.rows;
  });
}

async function processedAt(eventId: string): Promise<string | null> {
  return seedAsAdmin(async (client) => {
    const r = await client.query("select processed_at from public.events where id = $1", [eventId]);
    return r.rows[0].processed_at;
  });
}

/** Counts invocations per event.id, so assertions can isolate this test's own event from unrelated pending events left by other tests. */
function countingHandler(counts: Map<string, number>, onCall?: (event: DomainEvent) => void) {
  return async (event: DomainEvent) => {
    counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
    onCall?.(event);
  };
}

/**
 * Retries dispatchPendingEvents until `isDone()` reports true or
 * `maxAttempts` is exhausted — the bounded-batch-aware replacement for
 * "call once and assume the whole backlog was drained." A generous but
 * finite bound: if the predicate is never satisfied, the loop simply ends
 * and the test's own assertions fail with a clear signal, rather than
 * hanging.
 */
async function dispatchUntil(consumers: EventConsumer[], isDone: () => boolean, maxAttempts = 50): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts && !isDone(); attempt++) {
    await dispatchPendingEvents(consumers);
  }
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("dispatchPendingEvents: idempotency with two consumers, both succeeding", () => {
  it("first dispatch invokes both consumers exactly once for this event; second dispatch invokes neither again", async () => {
    const { eventId } = await createOrgAndGetEvent("idempotency-happy");

    const callsA = new Map<string, number>();
    const callsB = new Map<string, number>();
    const consumerA: EventConsumer = {
      name: "test-consumer-a",
      eventTypes: ["membership.created"],
      handle: countingHandler(callsA),
    };
    const consumerB: EventConsumer = {
      name: "test-consumer-b",
      eventTypes: ["membership.created"],
      handle: countingHandler(callsB),
    };

    await dispatchUntil([consumerA, consumerB], () => callsA.has(eventId) && callsB.has(eventId));
    expect(callsA.get(eventId)).toBe(1);
    expect(callsB.get(eventId)).toBe(1);

    const deliveries = await deliveryRows(eventId);
    expect(deliveries.map((d) => d.consumer)).toEqual(["test-consumer-a", "test-consumer-b"]);
    expect(await processedAt(eventId)).not.toBeNull();

    // Redelivery must be a true no-op for THIS event — it is no longer
    // even selected (processed_at is set), so a single further call
    // suffices regardless of batch size or ambient backlog.
    await dispatchPendingEvents([consumerA, consumerB]);
    expect(callsA.get(eventId)).toBe(1);
    expect(callsB.get(eventId)).toBe(1);

    const deliveriesAfterSecondRun = await deliveryRows(eventId);
    expect(deliveriesAfterSecondRun).toHaveLength(2);
  });
});

describe("dispatchPendingEvents: failure isolation and partial-failure retry", () => {
  it("consumer A's failure does not prevent consumer B from being attempted for the same event", async () => {
    const { eventId } = await createOrgAndGetEvent("failure-isolation");

    const succeedingCalls = new Map<string, number>();
    const failingConsumer: EventConsumer = {
      name: "test-consumer-always-fails",
      eventTypes: ["membership.created"],
      handle: async () => {
        throw new Error("simulated consumer failure");
      },
    };
    const succeedingConsumer: EventConsumer = {
      name: "test-consumer-succeeds",
      eventTypes: ["membership.created"],
      handle: countingHandler(succeedingCalls),
    };

    await dispatchUntil([failingConsumer, succeedingConsumer], () => succeedingCalls.has(eventId));
    expect(succeedingCalls.get(eventId)).toBe(1);

    const deliveries = await deliveryRows(eventId);
    // Only the succeeding consumer produced a delivery row for THIS event —
    // the failing one produced none (its claim was released on failure),
    // per requirement #3.
    expect(deliveries).toEqual([{ consumer: "test-consumer-succeeds" }]);
    // Not all applicable consumers have delivered yet — processed_at must
    // still be null (M1.7 Decision A: only set once EVERY registered
    // consumer has succeeded).
    expect(await processedAt(eventId)).toBeNull();
  });

  it("a retried dispatch only re-invokes the previously-failed consumer, never the already-successful one", async () => {
    const { eventId } = await createOrgAndGetEvent("partial-retry");

    const flakyCalls = new Map<string, number>();
    let shouldFail = true;
    const flakyConsumer: EventConsumer = {
      name: "test-consumer-flaky",
      eventTypes: ["membership.created"],
      handle: countingHandler(flakyCalls, () => {
        if (shouldFail) {
          throw new Error("simulated transient failure");
        }
      }),
    };
    const reliableCalls = new Map<string, number>();
    const reliableConsumer: EventConsumer = {
      name: "test-consumer-reliable",
      eventTypes: ["membership.created"],
      handle: countingHandler(reliableCalls),
    };

    // First pass: flaky fails (claim released, retryable), reliable
    // succeeds (claim kept).
    await dispatchUntil([flakyConsumer, reliableConsumer], () => flakyCalls.has(eventId) && reliableCalls.has(eventId));
    expect(flakyCalls.get(eventId)).toBe(1);
    expect(reliableCalls.get(eventId)).toBe(1);
    expect(await processedAt(eventId)).toBeNull();

    // Second pass, flaky now succeeds — reliable must NOT be invoked again
    // (it already has a delivery record from the first pass, so it is
    // never re-claimed).
    shouldFail = false;
    await dispatchUntil([flakyConsumer, reliableConsumer], () => flakyCalls.get(eventId) === 2);
    expect(flakyCalls.get(eventId)).toBe(2); // retried
    expect(reliableCalls.get(eventId)).toBe(1); // NOT repeated

    const deliveries = await deliveryRows(eventId);
    expect(deliveries.map((d) => d.consumer)).toEqual(["test-consumer-flaky", "test-consumer-reliable"]);
    // Now every registered consumer has a delivery record — processed_at
    // becomes set as the observability convenience (Decision A).
    expect(await processedAt(eventId)).not.toBeNull();
  });
});

describe("dispatchPendingEvents: only applicable consumers are considered", () => {
  it("a consumer registered for a different event type is never invoked for this event, even though the event is genuinely visited", async () => {
    const { eventId } = await createOrgAndGetEvent("event-type-filter");

    const irrelevantCalls = new Map<string, number>();
    const irrelevantConsumer: EventConsumer = {
      name: "test-consumer-irrelevant",
      eventTypes: ["deal.stage_changed"], // does not match membership.created
      handle: countingHandler(irrelevantCalls),
    };
    // A second, matching consumer registered alongside it — its own
    // delivery is the independent, observable proof that the event was
    // actually visited by the dispatcher at least once, so the assertion
    // below on `irrelevantCalls` is meaningful rather than trivially true
    // because the event was never reached at all.
    const sentinelCalls = new Map<string, number>();
    const sentinelConsumer: EventConsumer = {
      name: "test-consumer-sentinel",
      eventTypes: ["membership.created"],
      handle: countingHandler(sentinelCalls),
    };

    await dispatchUntil([irrelevantConsumer, sentinelConsumer], () => sentinelCalls.has(eventId));
    expect(sentinelCalls.get(eventId)).toBe(1);
    expect(irrelevantCalls.get(eventId)).toBeUndefined();
  });
});

describe("dispatchPendingEvents: consumer receives the correct DomainEvent shape", () => {
  it("the event passed to a consumer carries the real organization_id and payload from the emitting transaction", async () => {
    const { organizationId, eventId } = await createOrgAndGetEvent("payload-shape");

    let received: DomainEvent | undefined;
    const consumer: EventConsumer = {
      name: "test-consumer-payload-shape",
      eventTypes: ["membership.created"],
      handle: async (event) => {
        if (event.id === eventId) {
          received = event;
        }
      },
    };

    await dispatchUntil([consumer], () => received !== undefined);
    expect(received).toBeDefined();
    expect(received?.organizationId).toBe(organizationId);
    expect(received?.eventType).toBe("membership.created");
    expect((received?.payload as { organization_id?: string })?.organization_id).toBe(organizationId);
  });
});

describe("dispatchPendingEvents: bounded batch size (Milestone 3.3 Reliability Remediation)", () => {
  it(`never delivers more than DISPATCH_BATCH_SIZE (${DISPATCH_BATCH_SIZE}) of a caller's own events in a single call, and drains a larger backlog across multiple calls`, async () => {
    const organizationId = await seedOrg("batch-probe");
    const uniqueType = `test.batch.probe.${randomUUID()}`;
    const seededCount = DISPATCH_BATCH_SIZE + 5;
    const seededIds: string[] = [];
    for (let i = 0; i < seededCount; i++) {
      seededIds.push(await seedRawEvent(organizationId, uniqueType));
    }

    const calls = new Map<string, number>();
    const consumer: EventConsumer = {
      name: "test-consumer-batch-probe",
      eventTypes: [uniqueType],
      handle: countingHandler(calls),
    };

    let callCount = 0;
    let previousSize = 0;
    // Bound generous enough to guarantee completion even if ambient
    // backlog from other tests means only a handful of MY OWN events get
    // through per call.
    while (calls.size < seededCount && callCount < seededCount * 2) {
      await dispatchPendingEvents([consumer]);
      callCount += 1;
      const deliveredThisCall = calls.size - previousSize;
      // The real safety property: no single call ever exceeds the batch
      // bound for this caller's own events, regardless of ambient state.
      expect(deliveredThisCall).toBeLessThanOrEqual(DISPATCH_BATCH_SIZE);
      previousSize = calls.size;
    }

    // Forward progress: every seeded event was eventually delivered.
    expect(calls.size).toBe(seededCount);
    seededIds.forEach((id) => expect(calls.get(id)).toBe(1)); // no duplicates
    // The bound is real, not coincidental: seededCount exceeds
    // DISPATCH_BATCH_SIZE, so this could not have completed in one call.
    expect(callCount).toBeGreaterThan(1);
  });
});

describe("dispatchPendingEvents: lock-free concurrency, active lease (Milestone 3.3 Reliability Remediation)", () => {
  it("two genuinely simultaneous calls never both deliver the same (event, consumer) pair — exactly one delivery per event while its lease is active", async () => {
    const organizationId = await seedOrg("concurrent-probe");
    const uniqueType = `test.concurrent.probe.${randomUUID()}`;
    const seededCount = 6;
    const seededIds: string[] = [];
    for (let i = 0; i < seededCount; i++) {
      seededIds.push(await seedRawEvent(organizationId, uniqueType));
    }

    const calls = new Map<string, number>();
    const consumer: EventConsumer = {
      name: "test-consumer-concurrent-probe",
      eventTypes: [uniqueType],
      handle: countingHandler(calls),
    };

    // No lock of any kind protects this — the atomic lease
    // acquire/reclaim statement (events.ts's own header comment) is the
    // entire concurrency-safety mechanism. Two REAL, genuinely concurrent
    // calls (Promise.all, not sequential awaits) against real Postgres
    // must still never double-deliver, because the second call's own
    // acquire attempt finds the first's lease already active (not yet
    // expired) and correctly gets zero rows back.
    await Promise.all([dispatchPendingEvents([consumer]), dispatchPendingEvents([consumer])]);

    for (const id of seededIds) {
      expect(calls.get(id) ?? 0).toBeLessThanOrEqual(1);
    }
    // Not just "no duplicates" — genuine, positive proof of delivery too:
    // between the two concurrent calls, every seeded event was actually
    // delivered exactly once (not merely "at most once, possibly zero").
    seededIds.forEach((id) => expect(calls.get(id)).toBe(1));
  });
});

describe("dispatchPendingEvents: claim-lease crash recovery (Milestone 3.3 Claim-Lease Reliability Remediation)", () => {
  /**
   * The Second Final Implementation Acceptance Audit's central finding:
   * the PRIOR remediation (a permanent claim row inserted before
   * consumer.handle() ran) could not distinguish "successfully delivered"
   * from "a process crashed between the claim and delivery completing" —
   * both looked identical: a row that would never be revisited. These
   * tests reproduce that exact crash window directly against real
   * Postgres, by inserting a 'leased' row with an already-past
   * lease_expires_at — the ONLY observable trace any crash (a Vercel
   * function timeout/kill, an OOM, a deploy rollover) leaves behind,
   * regardless of exactly when during the prior attempt it occurred.
   */

  it("Crash A: a lease acquired by a process that died before consumer.handle() ever ran becomes reclaimable once stale, and the next tick delivers successfully", async () => {
    const { eventId } = await createOrgAndGetEvent("crash-a");
    const consumerName = "test-consumer-crash-a";

    // Simulate: a prior process won the lease acquisition and then died —
    // consumer.handle() was NEVER invoked for it at all. This is the
    // narrowest, most severe version of the crash window: no external
    // effect of any kind occurred, yet the row alone (under the prior,
    // now-fixed design) would have permanently blocked retry.
    await seedAsAdmin((c) =>
      c.query(
        "insert into public.event_deliveries (event_id, consumer, status, lease_expires_at) values ($1, $2, 'leased', now() - interval '5 minutes')",
        [eventId, consumerName],
      ),
    );

    const calls = new Map<string, number>();
    const consumer: EventConsumer = { name: consumerName, eventTypes: ["membership.created"], handle: countingHandler(calls) };

    await dispatchUntil([consumer], () => calls.has(eventId));
    expect(calls.get(eventId)).toBe(1);

    const row = await seedAsAdmin((c) =>
      c.query("select status from public.event_deliveries where event_id = $1 and consumer = $2", [eventId, consumerName]),
    );
    expect(row.rows[0].status).toBe("delivered");
    expect(await processedAt(eventId)).not.toBeNull();
  });

  it("Crash B: a lease that crashed AFTER its consumer's external side effect already fired is still correctly reclaimed and retried — demonstrating the at-least-once (not exactly-once-externally) boundary this design cannot close", async () => {
    // A live handle() call cannot actually simulate a process dying
    // mid-flight — it always returns control to the dispatcher, which
    // then legitimately completes the delivery (that IS the "consumer
    // succeeded" case, already covered elsewhere). The only faithful way
    // to represent "a process died after its consumer's own external
    // effect had already fired, but before this dispatcher's bookkeeping
    // could react" is to seed that end-state directly, exactly as Crash A
    // does — the difference here is what the seed represents: not "never
    // even started" but "started, its real-world side effect genuinely
    // happened, and THEN the process died."
    const { eventId } = await createOrgAndGetEvent("crash-b");
    const consumerName = "test-consumer-crash-b";

    // externalEffectsObserved stands in for a real-world effect a
    // consumer's own handle() would perform (e.g. leadEnrichmentConsumer's
    // webhook POST to n8n) — recorded once here to represent the crashed
    // prior attempt's own call, which this test asserts genuinely
    // happened, is not undoable, and is not visible to event_deliveries
    // at all (the table only ever records THIS dispatcher's own
    // bookkeeping, never what a consumer did externally).
    const externalEffectsObserved: string[] = ["prior-crashed-attempts-own-external-call"];
    await seedAsAdmin((c) =>
      c.query(
        "insert into public.event_deliveries (event_id, consumer, status, lease_expires_at) values ($1, $2, 'leased', now() - interval '5 minutes')",
        [eventId, consumerName],
      ),
    );

    const consumer: EventConsumer = {
      name: consumerName,
      eventTypes: ["membership.created"],
      handle: async (event) => {
        externalEffectsObserved.push(event.id); // the retry's own (genuinely real, in production terms) external effect.
      },
    };

    await dispatchPendingEvents([consumer]);

    // The dispatcher's OWN state converges to exactly-once delivery
    // bookkeeping, despite the external effect having genuinely fired
    // twice (once before the crash, once on this retry) — this is
    // precisely the documented at-least-once, not
    // exactly-once-externally, boundary (see events.ts's own header
    // comment): this dispatcher guarantees ITS OWN bookkeeping is never
    // duplicated; it cannot, and does not claim to, guarantee an external
    // side effect a consumer performs is never repeated across a crash.
    expect(externalEffectsObserved).toEqual(["prior-crashed-attempts-own-external-call", eventId]);
    const row = await seedAsAdmin((c) =>
      c.query("select status from public.event_deliveries where event_id = $1 and consumer = $2", [eventId, consumerName]),
    );
    expect(row.rows[0].status).toBe("delivered");
  });

  it("success is terminal: once delivered, a delivered row can never be reclaimed, and later ticks never redeliver", async () => {
    const { eventId } = await createOrgAndGetEvent("crash-terminal-success");
    const consumerName = "test-consumer-terminal-success";

    const calls = new Map<string, number>();
    const consumer: EventConsumer = { name: consumerName, eventTypes: ["membership.created"], handle: countingHandler(calls) };

    await dispatchUntil([consumer], () => calls.has(eventId));
    expect(calls.get(eventId)).toBe(1);

    const delivered = await seedAsAdmin((c) =>
      c.query("select status, lease_expires_at from public.event_deliveries where event_id = $1 and consumer = $2", [
        eventId,
        consumerName,
      ]),
    );
    expect(delivered.rows[0].status).toBe("delivered");

    // Directly attempt the exact acquire/reclaim statement the dispatcher
    // itself uses, against this now-delivered row — must return zero rows
    // regardless of how long ago its lease_expires_at was, since the
    // WHERE clause requires status='leased', which a delivered row can
    // never satisfy again.
    const reclaimAttempt = await adminPool.query(
      `insert into public.event_deliveries (event_id, consumer, status, lease_expires_at)
       values ($1, $2, 'leased', now() + interval '120 seconds')
       on conflict (event_id, consumer) do update set status = 'leased', lease_expires_at = excluded.lease_expires_at
       where public.event_deliveries.status = 'leased' and public.event_deliveries.lease_expires_at < now()
       returning id`,
      [eventId, consumerName],
    );
    expect(reclaimAttempt.rows).toHaveLength(0);

    // A further dispatch tick must not invoke the consumer again either.
    await dispatchPendingEvents([consumer]);
    expect(calls.get(eventId)).toBe(1);
  });

  it("ordinary caught failure releases the lease immediately — retry does not have to wait out the lease duration", async () => {
    const { eventId } = await createOrgAndGetEvent("crash-caught-failure");
    const consumerName = "test-consumer-caught-failure";
    let shouldFail = true;

    const calls = new Map<string, number>();
    const consumer: EventConsumer = {
      name: consumerName,
      eventTypes: ["membership.created"],
      handle: countingHandler(calls, () => {
        if (shouldFail) throw new Error("simulated definite, caught failure");
      }),
    };

    await dispatchUntil([consumer], () => calls.has(eventId));
    expect(calls.get(eventId)).toBe(1);

    const afterFailure = await seedAsAdmin((c) =>
      c.query("select id from public.event_deliveries where event_id = $1 and consumer = $2", [eventId, consumerName]),
    );
    // The row is gone entirely (deleted, not merely left stale) — an
    // immediate caught failure does not need to wait out
    // LEASE_DURATION_SECONDS before becoming retryable.
    expect(afterFailure.rows).toHaveLength(0);

    shouldFail = false;
    await dispatchUntil([consumer], () => calls.get(eventId) === 2);
    expect(calls.get(eventId)).toBe(2);
  });

  it("stale-lease concurrency: two genuinely simultaneous dispatchers racing to reclaim the SAME expired lease — exactly one wins and delivers", async () => {
    const { eventId } = await createOrgAndGetEvent("stale-concurrency");
    const consumerName = "test-consumer-stale-concurrency";

    // A single stale lease, simulating one crashed prior process.
    await seedAsAdmin((c) =>
      c.query(
        "insert into public.event_deliveries (event_id, consumer, status, lease_expires_at) values ($1, $2, 'leased', now() - interval '5 minutes')",
        [eventId, consumerName],
      ),
    );

    const calls = new Map<string, number>();
    const consumer: EventConsumer = { name: consumerName, eventTypes: ["membership.created"], handle: countingHandler(calls) };

    // Two REAL, genuinely concurrent dispatch invocations (Promise.all,
    // not sequential calls) both racing to reclaim the identical stale
    // (event_id, consumer) row. Postgres's own row-level locking on the
    // UPDATE path serializes them — the loser re-evaluates its WHERE
    // clause against the winner's already-committed fresh lease and
    // correctly finds it no longer stale.
    await Promise.all([dispatchPendingEvents([consumer]), dispatchPendingEvents([consumer])]);

    expect(calls.get(eventId)).toBe(1); // exactly one reclaim won, exactly one delivery happened.

    const row = await seedAsAdmin((c) =>
      c.query("select status from public.event_deliveries where event_id = $1 and consumer = $2", [eventId, consumerName]),
    );
    expect(row.rows[0].status).toBe("delivered");
  });
});

describe("dispatchPendingEvents: processed_at scoped to current applicable consumers (Milestone 3.3 processed_at Completion Remediation)", () => {
  /**
   * The Final Implementation Acceptance Audit found and reproduced: the
   * completion check counted ANY status='delivered' row for an event,
   * regardless of which consumer delivered it — so a historical/renamed/
   * removed consumer's own unrelated delivered row could satisfy the
   * count even while the CURRENT invocation's own applicable consumer had
   * just failed, silently and permanently excluding a genuinely
   * undelivered event from all future retry. These tests reproduce the
   * exact audit scenario directly against real Postgres, then prove the
   * fix's full required invariant: an event may receive processed_at iff
   * every consumer applicable IN THE CURRENT CALL has its own terminal
   * 'delivered' row — never influenced by rows belonging to historical,
   * renamed, removed, or otherwise non-applicable consumer names.
   */

  async function seedHistoricalDelivered(eventId: string, consumerName: string): Promise<void> {
    await seedAsAdmin((c) =>
      c.query(
        "insert into public.event_deliveries (event_id, consumer, status, lease_expires_at) values ($1, $2, 'delivered', now())",
        [eventId, consumerName],
      ),
    );
  }

  it("HOSTILE AUDIT REPRODUCTION: a historical stale_consumer_v1 delivered row cannot mask the current applicable consumer's own failure — processed_at stays null until lead_enrichment itself succeeds, and the next tick correctly retries it", async () => {
    const { eventId } = await createOrgAndGetEvent("processed-at-hostile-repro");
    await seedHistoricalDelivered(eventId, "stale_consumer_v1");

    let shouldFail = true;
    const calls = new Map<string, number>();
    const consumer: EventConsumer = {
      name: "lead_enrichment",
      eventTypes: ["membership.created"],
      handle: countingHandler(calls, () => {
        if (shouldFail) throw new Error("simulated failure — the current applicable consumer's own genuine failure");
      }),
    };

    await dispatchUntil([consumer], () => calls.has(eventId));
    expect(calls.get(eventId)).toBe(1);
    // The historical row alone must NOT be enough — the current
    // applicable consumer (lead_enrichment) just failed.
    expect(await processedAt(eventId)).toBeNull();

    const deliveriesAfterFailure = await deliveryRows(eventId);
    expect(deliveriesAfterFailure.map((d) => d.consumer)).toEqual(["stale_consumer_v1"]); // lead_enrichment's own failed lease was released, not left behind.

    // Next tick: lead_enrichment genuinely succeeds.
    shouldFail = false;
    await dispatchUntil([consumer], () => calls.get(eventId) === 2);
    expect(await processedAt(eventId)).not.toBeNull();
  });

  it("stale historical delivered row + a currently ACTIVE (in-flight) lease for the real consumer: not yet processed", async () => {
    const { eventId } = await createOrgAndGetEvent("processed-at-active-lease");
    await seedHistoricalDelivered(eventId, "stale_consumer_v1");
    await seedAsAdmin((c) =>
      c.query(
        "insert into public.event_deliveries (event_id, consumer, status, lease_expires_at) values ($1, 'lead_enrichment', 'leased', now() + interval '2 minutes')",
        [eventId],
      ),
    );

    const consumer: EventConsumer = { name: "lead_enrichment", eventTypes: ["membership.created"], handle: async () => {} };
    // The lease is active, so this call's own acquire attempt correctly
    // gets zero rows and skips — but the completion check still runs for
    // this visited event, and must still correctly find lead_enrichment
    // has no 'delivered' row of its own.
    await dispatchPendingEvents([consumer]);
    expect(await processedAt(eventId)).toBeNull();
  });

  it("stale historical delivered row + a currently STALE (crashed) lease that gets reclaimed and then genuinely fails: still not processed", async () => {
    const { eventId } = await createOrgAndGetEvent("processed-at-stale-lease-then-fail");
    await seedHistoricalDelivered(eventId, "stale_consumer_v1");
    await seedAsAdmin((c) =>
      c.query(
        "insert into public.event_deliveries (event_id, consumer, status, lease_expires_at) values ($1, 'lead_enrichment', 'leased', now() - interval '5 minutes')",
        [eventId],
      ),
    );

    const calls = new Map<string, number>();
    const consumer: EventConsumer = {
      name: "lead_enrichment",
      eventTypes: ["membership.created"],
      handle: countingHandler(calls, () => {
        throw new Error("simulated failure after reclaiming the stale lease");
      }),
    };
    await dispatchUntil([consumer], () => calls.has(eventId));
    expect(calls.get(eventId)).toBe(1); // the stale lease WAS reclaimed and attempted.
    expect(await processedAt(eventId)).toBeNull(); // but it failed, so still not processed.
  });

  it("stale historical delivered row + current consumer ALSO delivered: processed", async () => {
    const { eventId } = await createOrgAndGetEvent("processed-at-both-delivered");
    await seedHistoricalDelivered(eventId, "stale_consumer_v1");
    await seedHistoricalDelivered(eventId, "lead_enrichment");

    const consumer: EventConsumer = { name: "lead_enrichment", eventTypes: ["membership.created"], handle: async () => {} };
    // lead_enrichment is already delivered — this call's own acquire
    // attempt correctly gets zero rows (nothing to do), but the
    // completion check must still recognize the pre-existing delivered
    // state and set processed_at.
    await dispatchPendingEvents([consumer]);
    expect(await processedAt(eventId)).not.toBeNull();
  });

  it("multiple current applicable consumers: N-1 delivered is not yet processed", async () => {
    const { eventId } = await createOrgAndGetEvent("processed-at-multi-n-minus-1");
    await seedHistoricalDelivered(eventId, "stale_consumer_v1"); // unrelated noise, must not help.

    const callsA = new Map<string, number>();
    const callsB = new Map<string, number>();
    const consumerA: EventConsumer = { name: "test-consumer-multi-a", eventTypes: ["membership.created"], handle: countingHandler(callsA) };
    const consumerB: EventConsumer = {
      name: "test-consumer-multi-b",
      eventTypes: ["membership.created"],
      handle: countingHandler(callsB, () => {
        throw new Error("consumer B always fails");
      }),
    };

    await dispatchUntil([consumerA, consumerB], () => callsA.has(eventId) && callsB.has(eventId));
    expect(callsA.get(eventId)).toBe(1);
    expect(callsB.get(eventId)).toBe(1);
    expect(await processedAt(eventId)).toBeNull(); // A delivered, B did not — 1 of 2 current consumers is not enough.
  });

  it("multiple current applicable consumers: all delivered is processed", async () => {
    const { eventId } = await createOrgAndGetEvent("processed-at-multi-all");
    await seedHistoricalDelivered(eventId, "stale_consumer_v1"); // unrelated noise.

    const callsA = new Map<string, number>();
    const callsB = new Map<string, number>();
    const consumerA: EventConsumer = { name: "test-consumer-multi-all-a", eventTypes: ["membership.created"], handle: countingHandler(callsA) };
    const consumerB: EventConsumer = { name: "test-consumer-multi-all-b", eventTypes: ["membership.created"], handle: countingHandler(callsB) };

    await dispatchUntil([consumerA, consumerB], () => callsA.has(eventId) && callsB.has(eventId));
    expect(await processedAt(eventId)).not.toBeNull();
  });

  it("piling on multiple unrelated extra delivered rows still cannot compensate for a missing current consumer", async () => {
    const { eventId } = await createOrgAndGetEvent("processed-at-multi-unrelated-noise");
    await seedHistoricalDelivered(eventId, "stale_consumer_v1");
    await seedHistoricalDelivered(eventId, "stale_consumer_v2");
    await seedHistoricalDelivered(eventId, "some_other_removed_consumer");

    const calls = new Map<string, number>();
    const consumer: EventConsumer = {
      name: "lead_enrichment",
      eventTypes: ["membership.created"],
      handle: countingHandler(calls, () => {
        throw new Error("the current consumer fails despite three unrelated delivered rows already existing");
      }),
    };
    await dispatchUntil([consumer], () => calls.has(eventId));
    expect(await processedAt(eventId)).toBeNull();
  });

  it("a delivered row from a RENAMED consumer's old name cannot satisfy its own replacement consumer", async () => {
    const { eventId } = await createOrgAndGetEvent("processed-at-renamed-consumer");
    // Simulates: lead_enrichment was renamed from lead_enrichment_v1 to
    // lead_enrichment_v2 in a later code change. The old name's own
    // (real, historical) delivered row must not satisfy the new name.
    await seedHistoricalDelivered(eventId, "lead_enrichment_v1");

    const calls = new Map<string, number>();
    const consumer: EventConsumer = {
      name: "lead_enrichment_v2",
      eventTypes: ["membership.created"],
      handle: countingHandler(calls, () => {
        throw new Error("the renamed consumer's own first attempt fails");
      }),
    };
    await dispatchUntil([consumer], () => calls.has(eventId));
    expect(await processedAt(eventId)).toBeNull();

    // The renamed consumer must still be independently, genuinely retried
    // and delivered — the old name's row is permanently irrelevant to it.
    const deliveries = await deliveryRows(eventId);
    expect(deliveries.map((d) => d.consumer).sort()).toEqual(["lead_enrichment_v1"]);
  });

  it("zero applicable consumers for an event retains the existing (pre-remediation) behavior: processed_at is never set, unaffected by this fix", async () => {
    const { eventId } = await createOrgAndGetEvent("processed-at-zero-applicable");
    await seedHistoricalDelivered(eventId, "stale_consumer_v1"); // even with unrelated noise present.

    const irrelevantConsumer: EventConsumer = {
      name: "test-consumer-irrelevant-for-processed-at",
      eventTypes: ["deal.stage_changed"], // does not match membership.created — applicable.length will be 0 for this event.
      handle: async () => {},
    };
    await dispatchPendingEvents([irrelevantConsumer]);
    expect(await processedAt(eventId)).toBeNull();
  });
});
