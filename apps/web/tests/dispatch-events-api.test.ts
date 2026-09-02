import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, getPool } from "@ai-revenue-os/database";
import { generateApiKey } from "@ai-revenue-os/auth";
import { identifyVisitor } from "@ai-revenue-os/intelligence";
import { adminPool } from "./crm-api-fixtures";
import { handleDispatchEvents } from "../app/api/internal/dispatch-events/handlers";
import { handleRecordContactEnrichment } from "../app/api/v1/contacts/[id]/enrichment/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.3F — HTTP-level coverage for the cron-driven dispatch
 * route: CRON_SECRET authentication, consumer failure isolation, and (in
 * the final describe block) the full end-to-end visitor.identified ->
 * dispatch -> n8n webhook (stand-in) -> write-back -> workflow_runs loop.
 *
 * Milestone 3.3 Reliability Remediation — the route no longer holds a
 * database transaction or advisory lock across the dispatch pass (see
 * packages/database/src/events.ts's own header comment for the full
 * redesign). The "advisory-lock concurrency" tests that used to live here
 * (proving a session/transaction-scoped lock serializes overlapping
 * invocations) are gone because that lock is gone; concurrency safety is
 * now proven at the dispatcher level (packages/database/tests/
 * dispatcher.test.ts, real Postgres, no lock) and, here, at the route
 * level via a "two simultaneous real invocations never double-deliver"
 * test using the actual leadEnrichmentConsumer and a real webhook
 * stand-in.
 *
 * Still deliberately ONE file, not split: multiple tests here create real
 * visitor.identified events in the SAME shared database other test files
 * also write to, and dispatchPendingEvents is tenant-agnostic — every
 * assertion that depends on "my own event was delivered" retries a
 * bounded number of times and/or filters by this test's own
 * organizationId, for the same reasons packages/database/tests/
 * dispatcher.test.ts's own header comment documents in detail.
 */

const CRON_SECRET_VALUE = "test-cron-secret-value";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const ORIGINAL_WEBHOOK_URL = process.env.N8N_LEAD_ENRICHMENT_WEBHOOK_URL;

let mockN8nServer: Server | undefined;
let mockN8nPort: number;
let mockN8nApiKey: string;
let receivedTriggerPayloads: Array<{ eventId: string; organizationId: string; entityType: string; entityId: string }>;

beforeEach(async () => {
  process.env.CRON_SECRET = CRON_SECRET_VALUE;
  delete process.env.N8N_LEAD_ENRICHMENT_WEBHOOK_URL;
  receivedTriggerPayloads = [];

  await new Promise<void>((resolve) => {
    mockN8nServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        void (async () => {
          const trigger = JSON.parse(raw) as { eventId: string; organizationId: string; entityType: string; entityId: string };
          receivedTriggerPayloads.push(trigger);

          // Plays n8n's own role: calls back into the real write-back
          // endpoint with a normalized result, using a real API key.
          await handleRecordContactEnrichment(
            new Request(`http://localhost/api/v1/contacts/${trigger.entityId}/enrichment`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${mockN8nApiKey}` },
              body: JSON.stringify({
                provider: "e2e-test-provider",
                status: "completed",
                normalizedResult: { companyDomain: "example.test" },
                costUsd: 0.01,
                sourceEventId: trigger.eventId,
              }),
            }),
            trigger.entityId,
          );

          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        })();
      });
    });
    mockN8nServer!.listen(0, "127.0.0.1", () => {
      const address = mockN8nServer!.address();
      mockN8nPort = typeof address === "object" && address ? address.port : 0;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => mockN8nServer!.close(() => resolve()));
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  if (ORIGINAL_WEBHOOK_URL === undefined) delete process.env.N8N_LEAD_ENRICHMENT_WEBHOOK_URL;
  else process.env.N8N_LEAD_ENRICHMENT_WEBHOOK_URL = ORIGINAL_WEBHOOK_URL;
});

afterAll(async () => {
  await closePool();
});

function dispatchRequest(authorization?: string): Request {
  return new Request("https://example.test/api/internal/dispatch-events", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  });
}

describe("GET /api/internal/dispatch-events: authentication", () => {
  it("rejects a missing Authorization header with 401", async () => {
    const response = await handleDispatchEvents(dispatchRequest());
    expect(response.status).toBe(401);
  });

  it("rejects an incorrect secret with 401", async () => {
    const response = await handleDispatchEvents(dispatchRequest("Bearer wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("returns 500 if CRON_SECRET itself is not configured server-side, never silently accepting", async () => {
    delete process.env.CRON_SECRET;
    const response = await handleDispatchEvents(dispatchRequest("Bearer anything"));
    expect(response.status).toBe(500);
  });

  it("accepts the correct secret and returns a dispatch summary", async () => {
    const response = await handleDispatchEvents(dispatchRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary?: unknown };
    expect(body.summary).toBeDefined();
  });
});

describe("GET /api/internal/dispatch-events: consumer failure isolation", () => {
  it("an unconfigured N8N_LEAD_ENRICHMENT_WEBHOOK_URL causes the lead_enrichment consumer to fail cleanly for any applicable event, without crashing the dispatch route itself", async () => {
    // N8N_LEAD_ENRICHMENT_WEBHOOK_URL is deliberately unset (beforeEach).
    const response = await handleDispatchEvents(dispatchRequest(`Bearer ${CRON_SECRET_VALUE}`));
    // The route itself must always return 200 — a consumer's own failure
    // is isolated by dispatchPendingEvents' own per-delivery catch and
    // must never surface as a route-level 500.
    expect(response.status).toBe(200);
  });
});

async function seedOrgAndKey(): Promise<{ organizationId: string }> {
  const client = await adminPool.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('E2E Enrichment Org', $1) returning id",
      [`e2e-enrichment-org-${randomUUID()}`],
    );
    const organizationId = org.rows[0]!.id;
    const { plaintext, keyHash, keyPrefix } = generateApiKey("test");
    await client.query(
      "insert into public.api_keys (organization_id, name, key_hash, key_prefix, scopes) values ($1, $2, $3, $4, $5)",
      [organizationId, "E2E n8n Key", keyHash, keyPrefix, JSON.stringify(["enrichment:write"])],
    );
    mockN8nApiKey = plaintext;
    return { organizationId };
  } finally {
    client.release();
  }
}

async function createTrackingSiteAndContact(organizationId: string, anonymousId: string, email: string) {
  const client = await adminPool.connect();
  try {
    const site = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, 'E2E Site') returning id",
      [organizationId],
    );
    await client.query(
      `insert into public.consent_records (organization_id, subject_type, subject_id, consent_type, status)
       values ($1, 'visitor', $2, 'cookie_tracking', 'granted')`,
      [organizationId, anonymousId],
    );
    await client.query("insert into public.contacts (organization_id, first_name, email) values ($1, $2, $3)", [
      organizationId,
      "E2E",
      email,
    ]);
    return site.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function identifyOne(organizationId: string, trackingSiteId: string): Promise<{ contactId: string }> {
  const anonymousId = randomUUID();
  const email = `e2e-${randomUUID()}@example.test`;
  await adminPool.query(
    `insert into public.consent_records (organization_id, subject_type, subject_id, consent_type, status)
     values ($1, 'visitor', $2, 'cookie_tracking', 'granted')`,
    [organizationId, anonymousId],
  );
  await adminPool.query("insert into public.contacts (organization_id, first_name, email) values ($1, $2, $3)", [
    organizationId,
    "E2E",
    email,
  ]);
  const identifyResult = await identifyVisitor(
    { organizationId },
    { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
  );
  expect(identifyResult.accepted).toBe(true);
  if (!identifyResult.accepted) throw new Error("identify failed");
  return { contactId: identifyResult.contactId };
}

/**
 * Retries handleDispatchEvents until at least `count` of this test's own
 * triggers (filtered by organizationId) have been received, or a bounded
 * number of attempts is exhausted — the same bounded-batch-aware pattern
 * packages/database/tests/dispatcher.test.ts's own dispatchUntil()
 * establishes, applied here at the route/HTTP level.
 */
async function dispatchUntilOwnTriggersReceived(organizationId: string, count: number, maxAttempts = 20): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const own = receivedTriggerPayloads.filter((t) => t.organizationId === organizationId);
    if (own.length >= count) return;
    const response = await handleDispatchEvents(dispatchRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    if (receivedTriggerPayloads.filter((t) => t.organizationId === organizationId).length < count) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe("GET /api/internal/dispatch-events: lock-free concurrency (Milestone 3.3 Reliability Remediation)", () => {
  it("two genuinely simultaneous real invocations never both deliver the same visitor.identified event to the webhook", async () => {
    const { organizationId } = await seedOrgAndKey();
    const trackingSiteId = await createTrackingSiteAndContact(organizationId, randomUUID(), `e2e-seed-${randomUUID()}@example.test`);
    process.env.N8N_LEAD_ENRICHMENT_WEBHOOK_URL = `http://127.0.0.1:${mockN8nPort}/webhook`;

    const first = await identifyOne(organizationId, trackingSiteId);
    const second = await identifyOne(organizationId, trackingSiteId);

    // No lock protects this — event_deliveries' own unique constraint,
    // claimed via INSERT ... ON CONFLICT DO NOTHING, is the entire
    // concurrency-safety mechanism now. Fire two real, concurrent
    // invocations of the actual route handler.
    const [r1, r2] = await Promise.all([
      handleDispatchEvents(dispatchRequest(`Bearer ${CRON_SECRET_VALUE}`)),
      handleDispatchEvents(dispatchRequest(`Bearer ${CRON_SECRET_VALUE}`)),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Retry a little further in case a large ambient backlog meant
    // neither concurrent call reached both of our own events yet.
    await dispatchUntilOwnTriggersReceived(organizationId, 2);

    const ownTriggers = receivedTriggerPayloads.filter((t) => t.organizationId === organizationId);
    const entityIds = ownTriggers.map((t) => t.entityId);
    // No duplicates: each contact triggered at most once, even though two
    // invocations ran concurrently with no lock between them.
    expect(new Set(entityIds).size).toBe(entityIds.length);
    expect(entityIds).toContain(first.contactId);
    expect(entityIds).toContain(second.contactId);
  }, 20000);
});

describe("End-to-end: visitor.identified -> dispatch -> n8n webhook (stand-in) -> write-back -> workflow_runs", () => {
  it("completes the full loop with no mocking of any AI Revenue OS code", async () => {
    const { organizationId } = await seedOrgAndKey();
    const anonymousId = randomUUID();
    const email = `e2e-${randomUUID()}@example.test`;
    const trackingSiteId = await createTrackingSiteAndContact(organizationId, anonymousId, email);

    const identifyResult = await identifyVisitor(
      { organizationId },
      { trackingSiteId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(identifyResult.accepted).toBe(true);
    if (!identifyResult.accepted) return;
    const contactId = identifyResult.contactId;

    process.env.N8N_LEAD_ENRICHMENT_WEBHOOK_URL = `http://127.0.0.1:${mockN8nPort}/webhook`;

    // dispatchPendingEvents is deliberately tenant-agnostic (M1.7) and now
    // (Milestone 3.3 Reliability Remediation) bounded to
    // DISPATCH_BATCH_SIZE events per call — it may take several ticks to
    // reach this test's own event under real ambient backlog, exactly as
    // a real cron schedule would. This models that same recovery rather
    // than assuming perfect first-attempt synchronization.
    await dispatchUntilOwnTriggersReceived(organizationId, 1);
    const ownTrigger = receivedTriggerPayloads.find((t) => t.organizationId === organizationId);
    expect(ownTrigger).toBeDefined();
    expect(ownTrigger!.entityType).toBe("contact");
    expect(ownTrigger!.entityId).toBe(contactId);

    const eventRow = await getPool().query<{ id: string }>(
      "select id from public.events where organization_id = $1 and event_type = 'visitor.identified'",
      [organizationId],
    );
    const eventId = eventRow.rows[0]!.id;

    const enrichmentRows = await getPool().query(
      "select status, normalized_result from public.contact_enrichment where organization_id = $1 and contact_id = $2",
      [organizationId, contactId],
    );
    expect(enrichmentRows.rows).toHaveLength(1);
    expect(enrichmentRows.rows[0]!.status).toBe("completed");
    expect(enrichmentRows.rows[0]!.normalized_result).toEqual({ companyDomain: "example.test" });

    const workflowRunRows = await getPool().query(
      "select status, cost_usd from public.workflow_runs where organization_id = $1 and workflow_key = 'lead_enrichment' and source_event_id = $2",
      [organizationId, eventId],
    );
    expect(workflowRunRows.rows).toHaveLength(1);
    expect(workflowRunRows.rows[0]!.status).toBe("succeeded");
    expect(Number(workflowRunRows.rows[0]!.cost_usd)).toBe(0.01);

    // A second dispatch call must not re-deliver the same event to the
    // webhook — event_deliveries' own real idempotency guarantee (the
    // event is fully processed and no longer selected at all). Checked
    // for this test's own organizationId specifically.
    receivedTriggerPayloads = [];
    await handleDispatchEvents(dispatchRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(receivedTriggerPayloads.find((t) => t.organizationId === organizationId)).toBeUndefined();
  }, 30000);
});
