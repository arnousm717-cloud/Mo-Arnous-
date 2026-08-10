import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";
import { dispatchPendingEvents, type DomainEvent, type EventConsumer } from "../src/events";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Dispatcher idempotency and failure isolation (M1.7 requirement #4).
 * Registers real EventConsumer callbacks (static, code-defined identifiers
 * — never looked up from the database, per requirement #2) against a real
 * membership.created event, and proves the exact four behaviors the
 * approved plan names: first dispatch invokes both once; second dispatch
 * invokes neither again; partial failure retries only the failed consumer;
 * already-successful consumers are never repeated.
 *
 * dispatchPendingEvents() is deliberately tenant-agnostic (M1.7
 * requirement #1) — it processes EVERY unprocessed event in the table,
 * not just the one this test just created. Other test files (and earlier
 * tests in this same file) also leave unprocessed membership.created
 * events behind, so every consumer here counts invocations PER EVENT ID
 * (a map keyed by event.id), and assertions check the count for this
 * test's own eventId specifically — never a bare top-level call counter,
 * which would be corrupted by however many other pending events happen to
 * exist in the shared database at the moment this test runs.
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

    await dispatchPendingEvents([consumerA, consumerB]);
    expect(callsA.get(eventId)).toBe(1);
    expect(callsB.get(eventId)).toBe(1);

    const deliveries = await deliveryRows(eventId);
    expect(deliveries.map((d) => d.consumer)).toEqual(["test-consumer-a", "test-consumer-b"]);
    expect(await processedAt(eventId)).not.toBeNull();

    // Second dispatch call — redelivery must be a true no-op for THIS event.
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

    await dispatchPendingEvents([failingConsumer, succeedingConsumer]);
    expect(succeedingCalls.get(eventId)).toBe(1);

    const deliveries = await deliveryRows(eventId);
    // Only the succeeding consumer produced a delivery row for THIS event —
    // the failing one produced none, per requirement #3.
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

    // First dispatch: flaky fails, reliable succeeds.
    await dispatchPendingEvents([flakyConsumer, reliableConsumer]);
    expect(flakyCalls.get(eventId)).toBe(1);
    expect(reliableCalls.get(eventId)).toBe(1);
    expect(await processedAt(eventId)).toBeNull();

    // Second dispatch, flaky now succeeds — reliable must NOT be invoked
    // again (it already has a delivery record from the first run).
    shouldFail = false;
    await dispatchPendingEvents([flakyConsumer, reliableConsumer]);
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
  it("a consumer registered for a different event type is never invoked for this event", async () => {
    const { eventId } = await createOrgAndGetEvent("event-type-filter");

    const calls = new Map<string, number>();
    const irrelevantConsumer: EventConsumer = {
      name: "test-consumer-irrelevant",
      eventTypes: ["deal.stage_changed"], // does not match membership.created
      handle: countingHandler(calls),
    };

    await dispatchPendingEvents([irrelevantConsumer]);
    expect(calls.get(eventId)).toBeUndefined();
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

    await dispatchPendingEvents([consumer]);
    expect(received).toBeDefined();
    expect(received?.organizationId).toBe(organizationId);
    expect(received?.eventType).toBe("membership.created");
    expect((received?.payload as { organization_id?: string })?.organization_id).toBe(organizationId);
  });
});
