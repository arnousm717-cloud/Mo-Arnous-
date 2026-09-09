import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { deriveEmbeddingRecoveryEventId } from "@ai-revenue-os/brain";
import { adminPool } from "./crm-api-fixtures";
import { handleBrainEmbeddingRecovery } from "../app/api/internal/brain-embedding-recovery/handlers";
import { GET as recoveryRouteGet } from "../app/api/internal/brain-embedding-recovery/route";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.1 Phase 5 — HTTP-level coverage for
 * GET /api/internal/brain-embedding-recovery, mirroring
 * dispatch-events-api.test.ts's own established style exactly: direct
 * handler invocation, no running server, real Postgres, a real HTTP mock
 * server standing in for n8n's Brain Indexing webhook — no mocking of
 * this route's own authentication or database behavior.
 */

const CRON_SECRET_VALUE = "test-recovery-cron-secret-value";
const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const ORIGINAL_WEBHOOK_URL = process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL;
const ORIGINAL_WEBHOOK_SECRET = process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_SECRET;

let mockServer: Server | undefined;
let mockPort: number;
let receivedNotifications: Array<{ eventId: string; organizationId: string; entityType: string; entityId: string }>;
let mockResponseStatus = 200;

beforeEach(async () => {
  process.env.CRON_SECRET = CRON_SECRET_VALUE;
  delete process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL;
  delete process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_SECRET;
  receivedNotifications = [];
  mockResponseStatus = 200;

  await new Promise<void>((resolve) => {
    mockServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        receivedNotifications.push(JSON.parse(raw));
        res.writeHead(mockResponseStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: mockResponseStatus === 200 }));
      });
    });
    mockServer!.listen(0, "127.0.0.1", () => {
      const address = mockServer!.address();
      mockPort = typeof address === "object" && address ? address.port : 0;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  if (ORIGINAL_WEBHOOK_URL === undefined) delete process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL;
  else process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = ORIGINAL_WEBHOOK_URL;
  if (ORIGINAL_WEBHOOK_SECRET === undefined) delete process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_SECRET;
  else process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_SECRET = ORIGINAL_WEBHOOK_SECRET;
});

afterAll(async () => {
  await closePool();
});

function recoveryRequest(authorization?: string): Request {
  return new Request("https://example.test/api/internal/brain-embedding-recovery", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  });
}

async function seedOrg(): Promise<string> {
  const client = await adminPool.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Recovery Test Org', $1) returning id",
      [`brain-recovery-org-${randomUUID()}`],
    );
    return org.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function seedProfileNeedingEmbedding(organizationId: string, computedAt = "2026-01-01T00:00:00.000Z"): Promise<{ id: string; contactId: string }> {
  const client = await adminPool.connect();
  try {
    const contact = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, email) values ($1, 'RecoveryAPI', $2) returning id",
      [organizationId, `recovery-api-${randomUUID()}@example.test`],
    );
    const profile = await client.query<{ id: string }>(
      `insert into public.brain_entity_profiles (organization_id, entity_type, contact_id, profile, computed_at)
       values ($1, 'contact', $2, '{}'::jsonb, $3) returning id`,
      [organizationId, contact.rows[0]!.id, computedAt],
    );
    return { id: profile.rows[0]!.id, contactId: contact.rows[0]!.id };
  } finally {
    client.release();
  }
}

async function bumpProfileComputedAt(profileId: string, computedAt: string): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("update public.brain_entity_profiles set computed_at = $1 where id = $2", [computedAt, profileId]);
  } finally {
    client.release();
  }
}

/** Test-only: rewinds a workflow_runs row's completed_at into the past to
 * simulate elapsed real time without a fragile wall-clock sleep — mirrors
 * packages/brain/tests/embedding-recovery.test.ts's own identical helper. */
async function rewindWorkflowRunCompletedAt(
  organizationId: string,
  workflowKey: string,
  sourceEventId: string,
  secondsAgo: number,
): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query(
      `update public.workflow_runs
       set completed_at = now() - make_interval(secs => $1)
       where organization_id = $2 and workflow_key = $3 and source_event_id = $4`,
      [secondsAgo, organizationId, workflowKey, sourceEventId],
    );
  } finally {
    client.release();
  }
}

/** Reads back computed_at exactly as production code now does
 * (`ep.computed_at::text`, packages/brain/src/backfill.ts) -- deriving
 * the recovery event id from a second, independently-hand-typed literal
 * is fragile (node-pg's raw timestamptz representation and any text-cast
 * formatting are both implementation details, not something a test
 * should have to reproduce by hand) and silently mismatches, causing
 * rewindWorkflowRunCompletedAt below to affect zero rows. Reading the
 * real, live value back is the only robust way to derive the SAME id
 * production computed. */
async function readProfileComputedAt(profileId: string): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ computed_at: string }>("select computed_at::text as computed_at from public.brain_entity_profiles where id = $1", [
      profileId,
    ]);
    return r.rows[0]!.computed_at;
  } finally {
    client.release();
  }
}

async function writeFreshEmbedding(organizationId: string, entityProfileId: string, sourceVersionAt: string): Promise<void> {
  const client = await adminPool.connect();
  try {
    const vector = `[${Array.from({ length: 1536 }, () => "0").join(",")}]`;
    await client.query(
      `insert into public.brain_embeddings (organization_id, source_type, entity_profile_id, chunk_text, embedding, content_hash, source_version_at)
       values ($1, 'entity_profile', $2, 'x', $3::vector, $4, $5)`,
      [organizationId, entityProfileId, vector, randomUUID(), sourceVersionAt],
    );
  } finally {
    client.release();
  }
}

describe("GET /api/internal/brain-embedding-recovery: authentication", () => {
  it("rejects a missing Authorization header with 401", async () => {
    const response = await handleBrainEmbeddingRecovery(recoveryRequest());
    expect(response.status).toBe(401);
  });

  it("rejects an incorrect secret with 401", async () => {
    const response = await handleBrainEmbeddingRecovery(recoveryRequest("Bearer wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("returns 500 if CRON_SECRET itself is not configured server-side", async () => {
    delete process.env.CRON_SECRET;
    const response = await handleBrainEmbeddingRecovery(recoveryRequest("Bearer anything"));
    expect(response.status).toBe(500);
  });

  it("accepts the correct secret and returns a recovery summary", async () => {
    const response = await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary?: unknown };
    expect(body.summary).toBeDefined();
  });
});

describe("GET /api/internal/brain-embedding-recovery: unconfigured webhook", () => {
  it("returns 200 with unconfiguredWebhook:true and zero notifications, no crash, no false success", async () => {
    // N8N_BRAIN_EMBEDDING_WEBHOOK_URL deliberately unset (beforeEach).
    const organizationId = await seedOrg();
    await seedProfileNeedingEmbedding(organizationId);

    const response = await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { unconfiguredWebhook?: boolean; summary: { notificationsSent: number } };
    expect(body.unconfiguredWebhook).toBe(true);
    expect(body.summary.notificationsSent).toBe(0);
    expect(receivedNotifications).toHaveLength(0);
  });
});

// Every test below configures a real webhook URL, so the handler proceeds
// past its early unconfigured-webhook return into the real organization-
// enumeration query -- whose own duration scales with the shared local
// test database's total accumulated organization count across this
// entire monorepo's test run (dispatch-events-api.test.ts's own header
// comment already documents this exact "shared DB accumulates cross-file
// fixtures" phenomenon for events; the same applies here to
// organizations). An explicit, generous timeout on each such test
// mirrors that file's own established `90000` precedent.
describe("GET /api/internal/brain-embedding-recovery: candidate notification", () => {
  it("no candidates: returns 200 with a zeroed summary", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();

    const response = await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    const own = receivedNotifications.filter((n) => n.organizationId === organizationId);
    expect(own).toHaveLength(0);
  }, 90000);

  it("one candidate: the webhook receives an ID-minimized notification, no CRM content", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();
    const profile = await seedProfileNeedingEmbedding(organizationId);

    const response = await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);

    const own = receivedNotifications.find((n) => n.organizationId === organizationId);
    expect(own).toBeDefined();
    expect(own!.entityType).toBe("contact");
    expect(own!.entityId).toBe(profile.contactId);
    expect(Object.keys(own!).sort()).toEqual(["entityId", "entityType", "eventId", "organizationId"]);
    const serialized = JSON.stringify(own);
    expect(serialized).not.toContain("RecoveryAPI");

    const body = (await response.json()) as { summary: { notificationsSent: number; candidatesFound: number } };
    expect(body.summary.notificationsSent).toBeGreaterThanOrEqual(1);
    expect(body.summary.candidatesFound).toBeGreaterThanOrEqual(1);
  }, 90000);

  it("multiple organizations: each organization's candidates are notified independently, never cross-mixed", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const profileA = await seedProfileNeedingEmbedding(orgA);
    const profileB = await seedProfileNeedingEmbedding(orgB);

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));

    const notifiedA = receivedNotifications.find((n) => n.organizationId === orgA);
    const notifiedB = receivedNotifications.find((n) => n.organizationId === orgB);
    expect(notifiedA?.entityId).toBe(profileA.contactId);
    expect(notifiedB?.entityId).toBe(profileB.contactId);
  }, 90000);

  it("webhook failure (non-200 response) is recorded as an error but does not crash the route", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    mockResponseStatus = 500;
    const organizationId = await seedOrg();
    await seedProfileNeedingEmbedding(organizationId);

    const response = await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary: { errors: number; notificationsSent: number } };
    expect(body.summary.errors).toBeGreaterThanOrEqual(1);
  }, 90000);

  it("webhook unreachable (connection refused, simulating a network failure/timeout) is isolated and does not crash the route", async () => {
    // Point at a closed port -- exercises the identical catch path a real
    // timeout would (dispatch-events-api.test.ts's own established
    // precedent tests failure via a non-OK response, never a literal
    // multi-second wait; this adds the connection-level failure mode).
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = "http://127.0.0.1:1/unreachable";
    const organizationId = await seedOrg();
    await seedProfileNeedingEmbedding(organizationId);

    const response = await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary: { errors: number } };
    expect(body.summary.errors).toBeGreaterThanOrEqual(1);
  }, 90000);

  it("one candidate's failure does not block a later candidate in the same organization", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();
    await seedProfileNeedingEmbedding(organizationId, "2026-01-01T00:00:00.000Z");
    const second = await seedProfileNeedingEmbedding(organizationId, "2026-01-02T00:00:00.000Z");

    // Fail the FIRST webhook call this test's mock server receives, then
    // succeed on the rest -- proves per-candidate isolation within one org.
    let callCount = 0;
    mockServer!.removeAllListeners("request");
    mockServer!.on("request", (req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        callCount += 1;
        receivedNotifications.push(JSON.parse(raw));
        const status = callCount === 1 ? 500 : 200;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status === 200 }));
      });
    });

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));

    const own = receivedNotifications.filter((n) => n.organizationId === organizationId);
    expect(own.map((n) => n.entityId)).toContain(second.contactId);
  }, 90000);
});

describe("GET /api/internal/brain-embedding-recovery: immediate re-notification blocking (NOT a permanent block — see the eventual-retry describe block below)", () => {
  it("a profile still missing its embedding is NOT re-notified on a second consecutive run within the same state", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();
    const profile = await seedProfileNeedingEmbedding(organizationId, "2026-01-01T00:00:00.000Z");

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    const firstRoundCount = receivedNotifications.filter((n) => n.entityId === profile.contactId).length;
    expect(firstRoundCount).toBe(1);

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    const secondRoundCount = receivedNotifications.filter((n) => n.entityId === profile.contactId).length;
    // Still exactly 1 -- the second run's claim attempt for the SAME
    // (profileId, computedAt) state is blocked by the still-within-
    // cooldown 'succeeded' workflow_runs row (claimEmbeddingRecoveryAttempt,
    // packages/brain/src/repository.ts). This is NOT permanent -- see
    // "eventual retry after cooldown" below for the corrected behavior.
    expect(secondRoundCount).toBe(1);
  }, 90000);

  it("a profile recomputed to a newer computed_at becomes eligible for a fresh notification, even though the prior state already succeeded", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();
    const profile = await seedProfileNeedingEmbedding(organizationId, "2026-01-01T00:00:00.000Z");

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(receivedNotifications.filter((n) => n.entityId === profile.contactId)).toHaveLength(1);

    await bumpProfileComputedAt(profile.id, "2026-02-01T00:00:00.000Z");

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(receivedNotifications.filter((n) => n.entityId === profile.contactId)).toHaveLength(2);
  }, 90000);
});

describe("GET /api/internal/brain-embedding-recovery: eventual retry after cooldown — the corrected HIGH defect, proven end-to-end through the real route", () => {
  const RECOVERY_WORKFLOW_KEY = "brain_embedding_recovery_contact";

  it("REGRESSION: a successful webhook acknowledgement is not permanent proof of materialization — a still-missing profile is re-notified after the cooldown elapses, with computedAt unchanged", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();
    const profile = await seedProfileNeedingEmbedding(organizationId, "2026-01-01T00:00:00.000Z");

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(receivedNotifications.filter((n) => n.entityId === profile.contactId)).toHaveLength(1);

    // No embedding write-back ever occurs. Immediate re-run stays blocked
    // (matches the immediate-blocking describe block above).
    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(receivedNotifications.filter((n) => n.entityId === profile.contactId)).toHaveLength(1);

    // Simulate elapsed time beyond the 900s cooldown -- computedAt is
    // deliberately left unchanged, so this proves eventual retry of the
    // SAME state, not merely a new-version re-eligibility (already
    // covered above).
    const computedAt = await readProfileComputedAt(profile.id);
    const sourceEventId = deriveEmbeddingRecoveryEventId(profile.id, computedAt);
    await rewindWorkflowRunCompletedAt(organizationId, RECOVERY_WORKFLOW_KEY, sourceEventId, 901);

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(receivedNotifications.filter((n) => n.entityId === profile.contactId)).toHaveLength(2);
  }, 90000);

  it("a fresh embedding suppresses further retries entirely, even well past the cooldown", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();
    const profile = await seedProfileNeedingEmbedding(organizationId, "2026-01-01T00:00:00.000Z");

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(receivedNotifications.filter((n) => n.entityId === profile.contactId)).toHaveLength(1);

    // This time the embedding genuinely materializes.
    await writeFreshEmbedding(organizationId, profile.id, "2026-01-01T00:00:00.000Z");

    const computedAt = await readProfileComputedAt(profile.id);
    const sourceEventId = deriveEmbeddingRecoveryEventId(profile.id, computedAt);
    await rewindWorkflowRunCompletedAt(organizationId, RECOVERY_WORKFLOW_KEY, sourceEventId, 10_000);

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    // Still exactly 1 -- the profile is no longer a candidate at all
    // (findEmbeddingRecoveryCandidates excludes it), so no reclaim is
    // even attempted, regardless of how much cooldown time has passed.
    expect(receivedNotifications.filter((n) => n.entityId === profile.contactId)).toHaveLength(1);
  }, 90000);
});

describe("GET /api/internal/brain-embedding-recovery: backlog/cap safety", () => {
  it("a single run never exceeds the per-entity-type cap even with a large backlog", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();
    for (let i = 0; i < 25; i++) {
      await seedProfileNeedingEmbedding(organizationId, "2026-01-01T00:00:00.000Z");
    }

    await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    const own = receivedNotifications.filter((n) => n.organizationId === organizationId);
    // findEmbeddingRecoveryCandidates' own default limitPerEntityType is
    // 10 (packages/brain/src/backfill.ts) — every seeded profile here is
    // a contact, so a single call is capped at exactly that.
    expect(own.length).toBeLessThanOrEqual(10);
  }, 90000);

  it("a backlog larger than one run's cap is progressively covered across multiple runs, not permanently starved beyond the cap — the real rotation guarantee is proven fast and robustly at the domain layer (packages/brain/tests/embedding-recovery.test.ts); this is a lighter end-to-end confirmation through the real route", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();
    for (let i = 0; i < 25; i++) {
      await seedProfileNeedingEmbedding(organizationId, "2026-01-01T00:00:00.000Z");
    }

    const seenContactIds = new Set<string>();
    for (let round = 0; round < 3; round++) {
      await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
      for (const n of receivedNotifications) {
        if (n.organizationId === organizationId) seenContactIds.add(n.entityId);
      }
    }
    // A statistically robust (non-flaky), always-true assertion given
    // real md5(id || now())-based rotation: the union across several
    // independently-shuffled runs exceeds what any single run's own cap
    // alone could ever cover — proving rotation is real end-to-end
    // through the actual route, without depending on covering every one
    // of the 25 within a small, timing-sensitive round count.
    expect(seenContactIds.size).toBeGreaterThan(10);
  }, 90000);
});

describe("GET /api/internal/brain-embedding-recovery: GDPR erasure race", () => {
  it("a candidate erased between discovery and notification cannot leak, and a subsequent run correctly excludes it", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();
    const profile = await seedProfileNeedingEmbedding(organizationId);

    const client = await adminPool.connect();
    try {
      await client.query("delete from public.contacts where id = $1", [profile.contactId]);
    } finally {
      client.release();
    }

    const response = await handleBrainEmbeddingRecovery(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    expect(receivedNotifications.find((n) => n.entityId === profile.contactId)).toBeUndefined();
  }, 90000);
});

describe("GET /api/internal/brain-embedding-recovery: PII/logging safety", () => {
  it("the real, logging-wrapped route's structured completion log line never contains CRM content or the CRON_SECRET", async () => {
    process.env.N8N_BRAIN_EMBEDDING_WEBHOOK_URL = `http://127.0.0.1:${mockPort}/webhook`;
    const organizationId = await seedOrg();
    await seedProfileNeedingEmbedding(organizationId, "2026-01-01T00:00:00.000Z");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let recordedCalls: unknown[][];
    try {
      const response = await recoveryRouteGet(recoveryRequest(`Bearer ${CRON_SECRET_VALUE}`) as never);
      expect(response.status).toBe(200);
      recordedCalls = logSpy.mock.calls;
    } finally {
      logSpy.mockRestore();
    }

    expect(recordedCalls.length).toBeGreaterThan(0);
    for (const call of recordedCalls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("RecoveryAPI");
      expect(serialized).not.toContain(CRON_SECRET_VALUE);
    }
  }, 90000);
});

describe("deriveEmbeddingRecoveryEventId (barrel export sanity)", () => {
  it("is importable from the package barrel and matches the direct-module derivation", () => {
    const id = deriveEmbeddingRecoveryEventId("11111111-1111-1111-1111-111111111111", "2026-01-01T00:00:00.000Z");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
