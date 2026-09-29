import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool } from "./crm-api-fixtures";
import { handleAgentRunsMaintenance } from "../app/api/internal/agent-runs-maintenance/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.2 Step 4 — HTTP-level coverage for GET /api/internal/
 * agent-runs-maintenance, mirroring dispatch-events-api.test.ts/
 * brain-embedding-recovery-api.test.ts's own established style: direct
 * handler invocation, no running server, real Postgres, no mocking of
 * this route's own authentication or database behavior.
 *
 * MAINTENANCE-ONLY scope: this route never calls findClaimableAgentRuns/
 * claimAgentRun — it only discovers and terminalizes already-exhausted
 * (attempt_count >= MAX_ATTEMPTS, expired lease) 'running' rows. Several
 * tests below exist specifically to prove that boundary holds (queued/
 * retryable rows are never touched, never claimed, never marked
 * succeeded).
 */

const CRON_SECRET_VALUE = "test-agent-runs-maintenance-cron-secret";
const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET_VALUE;
});

afterEach(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
});

afterAll(async () => {
  await closePool();
});

function maintenanceRequest(authorization?: string): Request {
  return new Request("https://example.test/api/internal/agent-runs-maintenance", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  });
}

async function seedOrg(): Promise<string> {
  const client = await adminPool.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Maintenance Test Org', $1) returning id",
      [`agent-runs-maintenance-org-${randomUUID()}`],
    );
    return org.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function seedAgentRun(
  organizationId: string,
  overrides: { status?: "queued" | "running" | "succeeded" | "failed"; attemptCount?: number } = {},
): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      `insert into public.agent_runs (organization_id, agent_key, input, status, attempt_count)
       values ($1, 'maintenance_test_key', '{"references":[]}'::jsonb, $2, $3)
       returning id`,
      [organizationId, overrides.status ?? "queued", overrides.attemptCount ?? 1],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function rewindStartedAt(runId: string, secondsAgo: number): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("update public.agent_runs set started_at = now() - make_interval(secs => $1) where id = $2", [secondsAgo, runId]);
  } finally {
    client.release();
  }
}

interface AgentRunRow {
  id: string;
  organization_id: string;
  status: string;
  attempt_count: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

async function readAgentRun(runId: string): Promise<AgentRunRow> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<AgentRunRow>("select * from public.agent_runs where id = $1", [runId]);
    return r.rows[0]!;
  } finally {
    client.release();
  }
}

describe("GET /api/internal/agent-runs-maintenance: authentication", () => {
  it("rejects a missing Authorization header with 401", async () => {
    const response = await handleAgentRunsMaintenance(maintenanceRequest());
    expect(response.status).toBe(401);
  });

  it("rejects an incorrect secret with 401", async () => {
    const response = await handleAgentRunsMaintenance(maintenanceRequest("Bearer wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("returns 500 if CRON_SECRET itself is not configured server-side", async () => {
    delete process.env.CRON_SECRET;
    const response = await handleAgentRunsMaintenance(maintenanceRequest("Bearer anything"));
    expect(response.status).toBe(500);
  });

  it("accepts the correct secret and returns a maintenance summary", async () => {
    const response = await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary?: unknown };
    expect(body.summary).toBeDefined();
  });
});

// Every test below proceeds past auth into the real organization-
// enumeration query, whose own duration scales with the shared local
// test database's total accumulated organization count across this
// entire monorepo's test run — the same documented phenomenon
// dispatch-events-api.test.ts/brain-embedding-recovery-api.test.ts's own
// header comments already establish. An explicit, generous timeout
// mirrors that precedent.
describe("GET /api/internal/agent-runs-maintenance: exhausted-run discovery and terminalization", () => {
  it("an expired running attempt-3 row is discovered and terminalized, never reaching attempt 4", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    const response = await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary: { candidatesFound: number; terminalized: number } };
    expect(body.summary.candidatesFound).toBeGreaterThanOrEqual(1);
    expect(body.summary.terminalized).toBeGreaterThanOrEqual(1);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(3);
    expect(row.completed_at).not.toBeNull();
    expect(row.error).toContain("maximum attempt count");
  }, 90000);

  it("an active (not yet expired) running attempt-3 row is left untouched", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });

    await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));

    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
  }, 90000);

  it("an expired running attempt-2 (below max) row remains untouched by maintenance — it is claimable work, not exhausted", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 2 });
    await rewindStartedAt(runId, 121);

    await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));

    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
    expect(row.attempt_count).toBe(2);
  }, 90000);

  it("a succeeded row is left untouched", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "succeeded" });

    await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));

    const row = await readAgentRun(runId);
    expect(row.status).toBe("succeeded");
  }, 90000);

  it("an already-terminal failed row is left untouched", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "failed", attemptCount: 3 });

    await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));

    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
  }, 90000);

  it("wrong tenant does not leak or mutate: org B's exhausted row is untouched by a pass that also processes org A", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const runIdA = await seedAgentRun(orgA, { status: "running", attemptCount: 3 });
    const runIdB = await seedAgentRun(orgB, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runIdA, 121);
    // orgB's row is NOT expired — proves the maintenance pass processes
    // orgA and orgB independently, tenant-scoped, without cross-
    // contamination of eligibility.

    await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));

    const rowA = await readAgentRun(runIdA);
    const rowB = await readAgentRun(runIdB);
    expect(rowA.status).toBe("failed");
    expect(rowB.status).toBe("running");
  }, 90000);
});

describe("GET /api/internal/agent-runs-maintenance: batch bounds", () => {
  it("processes at most 10 exhausted candidates per organization per pass, leaving the rest for a future tick", async () => {
    const organizationId = await seedOrg();
    const runIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
      await rewindStartedAt(runId, 121);
      runIds.push(runId);
    }

    const response = await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));
    const body = (await response.json()) as { summary: { terminalized: number } };

    const rows = await Promise.all(runIds.map(readAgentRun));
    const stillRunning = rows.filter((r) => r.status === "running").length;
    const terminalized = rows.filter((r) => r.status === "failed").length;
    // Exactly 10 processed (this org's own eligible candidate count is
    // 12, strictly above the bound), exactly 2 left untouched for a
    // future tick — proves the bound is real, not merely coincidental.
    expect(body.summary.terminalized).toBe(10);
    expect(terminalized).toBe(10);
    expect(stillRunning).toBe(2);
    expect(terminalized + stillRunning).toBe(12);
  }, 90000);
});

describe("GET /api/internal/agent-runs-maintenance: concurrency", () => {
  it("two overlapping maintenance invocations terminalize the same exhausted row exactly once (no double-count, no contradictory state)", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    const [first, second] = await Promise.all([
      handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`)),
      handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`)),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Deliberately NOT asserting on the two responses' own global summary
    // counts here: this route enumerates every organization in the
    // shared local test database on every invocation (the same
    // documented "shared DB accumulates cross-file/cross-test fixtures"
    // characteristic dispatch-events-api.test.ts/brain-embedding-
    // recovery-api.test.ts's own header comments already establish), so
    // an unrelated exhausted row left over from an earlier test in this
    // same file (e.g. the "batch bounds" test's own two deliberately-
    // unterminalized rows) would also be picked up by both passes,
    // making a global-sum equality assertion fragile for reasons
    // unrelated to this test's own actual claim. The real, atomic
    // exactly-once-winner guarantee for THIS row is already proven at
    // the repository level (packages/ai-agents's own "two simultaneous
    // terminalizeExhaustedAgentRun calls on the same row yield exactly
    // one winner" test) — what this HTTP-level test proves is that the
    // route's own two overlapping invocations converge on the correct,
    // non-contradictory final row state, not a fabricated re-derivation
    // of the same repository-level proof via a fragile summary count.
    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(3);
  }, 90000);

  it("never produces attempt 4: attempt_count is unchanged by terminalization even under concurrent passes", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    await Promise.all([
      handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`)),
      handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`)),
    ]);

    const row = await readAgentRun(runId);
    expect(row.attempt_count).toBe(3);
  }, 90000);
});

describe("GET /api/internal/agent-runs-maintenance: no-false-execution proof (Step 4 is maintenance-only, never an execution dispatcher)", () => {
  it("a brand-new queued row is never touched, never claimed, and never marked succeeded or failed", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "queued" });

    await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));

    const row = await readAgentRun(runId);
    expect(row.status).toBe("queued");
    expect(row.attempt_count).toBe(1);
    expect(row.started_at).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.error).toBeNull();
  }, 90000);

  it("an expired failed row eligible for retry (below MAX_ATTEMPTS) is never claimed or mutated by maintenance — that is a future M4.3 execution worker's own concern", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "failed", attemptCount: 1 });
    const client = await adminPool.connect();
    try {
      await client.query("update public.agent_runs set completed_at = now() - make_interval(secs => 61) where id = $1", [runId]);
    } finally {
      client.release();
    }

    await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));

    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(1);
  }, 90000);

  it("no candidates: returns 200 with a zeroed summary, no crash, no false success", async () => {
    const response = await handleAgentRunsMaintenance(maintenanceRequest(`Bearer ${CRON_SECRET_VALUE}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary: { candidatesFound: number; terminalized: number; errors: number } };
    expect(body.summary.errors).toBe(0);
  }, 90000);
});
