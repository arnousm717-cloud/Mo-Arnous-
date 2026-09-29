import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import {
  claimAgentRun,
  completeAgentRun,
  failAgentRun,
  terminalizeExhaustedAgentRun,
  findClaimableAgentRuns,
  findExhaustedAgentRuns,
  enqueueAgentRun,
} from "../src/repository";
import { validateAgentRunReferences } from "../src/validation";
import { AgentRunValidationError } from "../src/errors";
import {
  adminPool,
  seedOrg,
  seedUser,
  seedAgentRun,
  rewindStartedAt,
  rewindCompletedAt,
  readAgentRun,
  readAgentRunCountForOrg,
} from "./helpers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 4.2 Step 2 (Correction) — real Postgres, direct repository
 * calls, no mocking of any kind. Proves the claim/lease/retry state
 * machine AND the fencing/exhausted-discovery correction the Final
 * Implementation Acceptance Audit required: claimAgentRun now returns
 * {runId, attemptCount} | null (the fencing token); completeAgentRun/
 * failAgentRun now require that attemptCount and reject a stale
 * caller's generation; findExhaustedAgentRuns closes the orphan
 * lifecycle state a 'running' row stuck at MAX_ATTEMPTS with an expired
 * lease previously had no discovery path out of.
 */

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

const ctx = (organizationId: string) => ({ organizationId });

describe("claimAgentRun: first claim of a brand-new queued row", () => {
  it("queued run claims successfully, returns {runId, attemptCount: 1}, row becomes running with attempt_count unchanged", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);

    const claimed = await claimAgentRun(ctx(organizationId), { runId });
    expect(claimed).toEqual({ runId, attemptCount: 1 });

    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
    expect(row.attempt_count).toBe(1);
    expect(row.started_at).not.toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.error).toBeNull();
  });

  it("a second immediate claim attempt on the same now-running row returns null (active lease)", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    expect(await claimAgentRun(ctx(organizationId), { runId })).not.toBeNull();
    expect(await claimAgentRun(ctx(organizationId), { runId })).toBeNull();
  });
});

describe("claimAgentRun: fencing token (attemptCount) semantics across reclaims", () => {
  it("failed reclaim returns the newly-current attemptCount = 2", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const first = await claimAgentRun(ctx(organizationId), { runId });
    expect(first!.attemptCount).toBe(1);
    await failAgentRun(ctx(organizationId), { runId, attemptCount: first!.attemptCount, error: "x" });
    await rewindCompletedAt(runId, 61);

    const retried = await claimAgentRun(ctx(organizationId), { runId });
    expect(retried).toEqual({ runId, attemptCount: 2 });
  });

  it("lease reclaim returns the newly-current, incremented attemptCount", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const first = await claimAgentRun(ctx(organizationId), { runId });
    await rewindStartedAt(runId, 121);

    const reclaimed = await claimAgentRun(ctx(organizationId), { runId });
    expect(reclaimed!.attemptCount).toBe(first!.attemptCount + 1);
    expect(reclaimed!.attemptCount).toBe(2);
  });
});

describe("failAgentRun: failure does not increment attempt_count, and retry is backoff-gated", () => {
  it("running -> fail leaves attempt_count unchanged and sets a terminal-for-now failed state", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const claimed = await claimAgentRun(ctx(organizationId), { runId });

    const failed = await failAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount, error: "transient provider timeout" });
    expect(failed).toBe(true);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(1);
    expect(row.error).toBe("transient provider timeout");
    expect(row.completed_at).not.toBeNull();
  });

  it("immediate retry claim right after failure returns null (still within the 60s backoff)", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const claimed = await claimAgentRun(ctx(organizationId), { runId });
    await failAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount, error: "x" });

    expect(await claimAgentRun(ctx(organizationId), { runId })).toBeNull();
  });

  it("cooldown boundary: reclaim returns null at 59s and succeeds at 61s", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const claimed = await claimAgentRun(ctx(organizationId), { runId });
    await failAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount, error: "x" });

    await rewindCompletedAt(runId, 59);
    expect(await claimAgentRun(ctx(organizationId), { runId })).toBeNull();

    await rewindCompletedAt(runId, 61);
    expect(await claimAgentRun(ctx(organizationId), { runId })).not.toBeNull();
  });

  it("a retry claim increments attempt_count exactly once (1 -> 2), resets completed_at and clears error", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const claimed = await claimAgentRun(ctx(organizationId), { runId });
    await failAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount, error: "x" });
    await rewindCompletedAt(runId, 61);

    const retried = await claimAgentRun(ctx(organizationId), { runId });
    expect(retried!.attemptCount).toBe(2);
    const row = await readAgentRun(runId);
    expect(row.attempt_count).toBe(2);
    expect(row.status).toBe("running");
    expect(row.completed_at).toBeNull();
    expect(row.error).toBeNull();
  });
});

describe("claimAgentRun: expired running lease (crash recovery)", () => {
  it("a still-active running lease blocks reclaim (returns null)", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    await claimAgentRun(ctx(organizationId), { runId });

    expect(await claimAgentRun(ctx(organizationId), { runId })).toBeNull();
  });

  it("lease boundary: reclaim returns null at 119s and succeeds at 121s", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    await claimAgentRun(ctx(organizationId), { runId });

    await rewindStartedAt(runId, 119);
    expect(await claimAgentRun(ctx(organizationId), { runId })).toBeNull();

    await rewindStartedAt(runId, 121);
    expect(await claimAgentRun(ctx(organizationId), { runId })).not.toBeNull();
  });

  it("a lease reclaim increments attempt_count exactly once and refreshes started_at", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    await claimAgentRun(ctx(organizationId), { runId });
    await rewindStartedAt(runId, 121);
    const before = await readAgentRun(runId);

    const reclaimed = await claimAgentRun(ctx(organizationId), { runId });
    expect(reclaimed).not.toBeNull();
    const after = await readAgentRun(runId);
    expect(after.attempt_count).toBe(before.attempt_count + 1);
    expect(after.status).toBe("running");
    expect(new Date(after.started_at!).getTime()).toBeGreaterThan(new Date(before.started_at!).getTime());
  });
});

describe("multi-reclaim chain: attempt 1 -> 2 -> 3, only the current generation can ever complete", () => {
  it("only the attempt-3 fencing token succeeds; attempt-1 and attempt-2 tokens are both stale and blocked", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);

    const attempt1 = await claimAgentRun(ctx(organizationId), { runId });
    expect(attempt1!.attemptCount).toBe(1);
    await rewindStartedAt(runId, 121);

    const attempt2 = await claimAgentRun(ctx(organizationId), { runId });
    expect(attempt2!.attemptCount).toBe(2);
    await rewindStartedAt(runId, 121);

    const attempt3 = await claimAgentRun(ctx(organizationId), { runId });
    expect(attempt3!.attemptCount).toBe(3);

    expect(await completeAgentRun(ctx(organizationId), { runId, attemptCount: attempt1!.attemptCount })).toBe(false);
    expect(await completeAgentRun(ctx(organizationId), { runId, attemptCount: attempt2!.attemptCount })).toBe(false);
    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");

    expect(await completeAgentRun(ctx(organizationId), { runId, attemptCount: attempt3!.attemptCount })).toBe(true);
    const finalRow = await readAgentRun(runId);
    expect(finalRow.status).toBe("succeeded");
  });
});

describe("max attempts: a failed row at attempt_count = 3 is permanently terminal", () => {
  it("never reclaimed even after the backoff window elapses", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "failed", attemptCount: 3 });
    await rewindCompletedAt(runId, 61);

    expect(await claimAgentRun(ctx(organizationId), { runId })).toBeNull();
  });

  it("remains terminal after an arbitrarily long elapsed time", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "failed", attemptCount: 3 });
    await rewindCompletedAt(runId, 10_000);

    expect(await claimAgentRun(ctx(organizationId), { runId })).toBeNull();
    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(3);
  });
});

describe("max attempts: an expired running lease at attempt_count = 3 is terminalized, never reclaimed as attempt 4", () => {
  it("claimAgentRun does NOT reclaim it, even with an expired lease", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    expect(await claimAgentRun(ctx(organizationId), { runId })).toBeNull();
    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
    expect(row.attempt_count).toBe(3);
  });

  it("terminalizeExhaustedAgentRun transitions it to failed without incrementing attempt_count", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    const terminalized = await terminalizeExhaustedAgentRun(ctx(organizationId), { runId });
    expect(terminalized).toBe(true);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(3);
    expect(row.completed_at).not.toBeNull();
    expect(row.error).toContain("maximum attempt count");
  });

  it("terminalizeExhaustedAgentRun refuses a running row whose lease has NOT yet expired", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });

    expect(await terminalizeExhaustedAgentRun(ctx(organizationId), { runId })).toBe(false);
  });

  it("terminalizeExhaustedAgentRun refuses a running row below MAX_ATTEMPTS even with an expired lease (that is claimAgentRun's own job)", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 2 });
    await rewindStartedAt(runId, 121);

    expect(await terminalizeExhaustedAgentRun(ctx(organizationId), { runId })).toBe(false);
  });

  it("terminalization does not create another execution attempt: the row is not reclaimable afterward", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);
    await terminalizeExhaustedAgentRun(ctx(organizationId), { runId });

    expect(await claimAgentRun(ctx(organizationId), { runId })).toBeNull();
  });
});

describe("completeAgentRun: strict, fenced state transition", () => {
  it("running -> succeeded with the correct attemptCount, attempt_count unchanged", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const claimed = await claimAgentRun(ctx(organizationId), { runId });

    expect(await completeAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount })).toBe(true);
    const after = await readAgentRun(runId);
    expect(after.status).toBe("succeeded");
    expect(after.attempt_count).toBe(claimed!.attemptCount);
    expect(after.completed_at).not.toBeNull();
    expect(after.error).toBeNull();
  });

  it("a succeeded row is never claimable again, even after an arbitrarily long elapsed time", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const claimed = await claimAgentRun(ctx(organizationId), { runId });
    await completeAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount });
    await rewindCompletedAt(runId, 10_000);

    expect(await claimAgentRun(ctx(organizationId), { runId })).toBeNull();
  });

  it("a queued row cannot complete", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    expect(await completeAgentRun(ctx(organizationId), { runId, attemptCount: 1 })).toBe(false);
  });

  it("a failed row cannot complete", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const claimed = await claimAgentRun(ctx(organizationId), { runId });
    await failAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount, error: "x" });
    expect(await completeAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount })).toBe(false);
  });

  it("wrong attemptCount (a correct-looking but stale generation number) is rejected even though status is running", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    await claimAgentRun(ctx(organizationId), { runId });

    expect(await completeAgentRun(ctx(organizationId), { runId, attemptCount: 999 })).toBe(false);
    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
  });
});

describe("completeAgentRun: stale-claimant fencing (the corrected HIGH defect)", () => {
  it("Worker A claims attempt 1; lease expires; Worker B reclaims attempt 2; stale Worker A's complete(attempt=1) is rejected and does not mutate the row", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);

    const workerA = await claimAgentRun(ctx(organizationId), { runId });
    expect(workerA!.attemptCount).toBe(1);
    await rewindStartedAt(runId, 121);

    const workerB = await claimAgentRun(ctx(organizationId), { runId });
    expect(workerB!.attemptCount).toBe(2);

    const staleComplete = await completeAgentRun(ctx(organizationId), { runId, attemptCount: workerA!.attemptCount });
    expect(staleComplete).toBe(false);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
    expect(row.attempt_count).toBe(2);
  });

  it("...and Worker B's own current-generation complete(attempt=2) succeeds normally", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);

    const workerA = await claimAgentRun(ctx(organizationId), { runId });
    await rewindStartedAt(runId, 121);
    const workerB = await claimAgentRun(ctx(organizationId), { runId });

    await completeAgentRun(ctx(organizationId), { runId, attemptCount: workerA!.attemptCount });
    expect(await completeAgentRun(ctx(organizationId), { runId, attemptCount: workerB!.attemptCount })).toBe(true);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("succeeded");
  });
});

describe("failAgentRun: strict, fenced state transition", () => {
  it("a queued row cannot fail", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    expect(await failAgentRun(ctx(organizationId), { runId, attemptCount: 1, error: "x" })).toBe(false);
  });

  it("a succeeded row cannot fail", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const claimed = await claimAgentRun(ctx(organizationId), { runId });
    await completeAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount });
    expect(await failAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount, error: "x" })).toBe(false);
  });

  it("error is persisted verbatim, matching workflow_runs.error's own plain-text convention", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const claimed = await claimAgentRun(ctx(organizationId), { runId });
    await failAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount, error: "provider returned 503" });

    const row = await readAgentRun(runId);
    expect(row.error).toBe("provider returned 503");
  });
});

describe("failAgentRun: stale-claimant fencing (the corrected HIGH defect)", () => {
  it("Worker A claims attempt 1; lease expires; Worker B reclaims attempt 2; stale Worker A's fail(attempt=1) is rejected, does not mutate the row, and its error text is never persisted", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);

    const workerA = await claimAgentRun(ctx(organizationId), { runId });
    await rewindStartedAt(runId, 121);
    const workerB = await claimAgentRun(ctx(organizationId), { runId });
    expect(workerB!.attemptCount).toBe(2);

    const staleFail = await failAgentRun(ctx(organizationId), { runId, attemptCount: workerA!.attemptCount, error: "stale worker A's own old error" });
    expect(staleFail).toBe(false);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
    expect(row.attempt_count).toBe(2);
    expect(row.error).toBeNull();
  });

  it("...and Worker B's own current-generation fail(attempt=2) succeeds normally, persisting its own error", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);

    const workerA = await claimAgentRun(ctx(organizationId), { runId });
    await rewindStartedAt(runId, 121);
    const workerB = await claimAgentRun(ctx(organizationId), { runId });

    await failAgentRun(ctx(organizationId), { runId, attemptCount: workerA!.attemptCount, error: "stale, must not persist" });
    expect(await failAgentRun(ctx(organizationId), { runId, attemptCount: workerB!.attemptCount, error: "current, real error" })).toBe(true);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("current, real error");
  });

  it("a stale FAIL cannot overwrite a row Worker B already legitimately COMPLETED", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);

    const workerA = await claimAgentRun(ctx(organizationId), { runId });
    await rewindStartedAt(runId, 121);
    const workerB = await claimAgentRun(ctx(organizationId), { runId });
    await completeAgentRun(ctx(organizationId), { runId, attemptCount: workerB!.attemptCount });

    const staleFail = await failAgentRun(ctx(organizationId), { runId, attemptCount: workerA!.attemptCount, error: "stale, too late" });
    expect(staleFail).toBe(false);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("succeeded");
    expect(row.error).toBeNull();
  });
});

describe("tenant safety: every mutation is explicitly organization-scoped, not RLS-alone", () => {
  it("wrong org cannot claim a queued row", async () => {
    const orgA = await seedOrg("AI Agents Tenant A Claim");
    const orgB = await seedOrg("AI Agents Tenant B Claim");
    const runId = await seedAgentRun(orgA);

    expect(await claimAgentRun(ctx(orgB), { runId })).toBeNull();
    const row = await readAgentRun(runId);
    expect(row.status).toBe("queued");
  });

  it("wrong org cannot complete a running row even with the correct attemptCount", async () => {
    const orgA = await seedOrg("AI Agents Tenant A Complete");
    const orgB = await seedOrg("AI Agents Tenant B Complete");
    const runId = await seedAgentRun(orgA);
    const claimed = await claimAgentRun(ctx(orgA), { runId });

    expect(await completeAgentRun(ctx(orgB), { runId, attemptCount: claimed!.attemptCount })).toBe(false);
    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
  });

  it("wrong org cannot fail a running row even with the correct attemptCount", async () => {
    const orgA = await seedOrg("AI Agents Tenant A Fail");
    const orgB = await seedOrg("AI Agents Tenant B Fail");
    const runId = await seedAgentRun(orgA);
    const claimed = await claimAgentRun(ctx(orgA), { runId });

    expect(await failAgentRun(ctx(orgB), { runId, attemptCount: claimed!.attemptCount, error: "hostile" })).toBe(false);
    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
    expect(row.error).toBeNull();
  });

  it("wrong org cannot terminalize a max-attempt expired running row", async () => {
    const orgA = await seedOrg("AI Agents Tenant A Terminalize");
    const orgB = await seedOrg("AI Agents Tenant B Terminalize");
    const runId = await seedAgentRun(orgA, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    expect(await terminalizeExhaustedAgentRun(ctx(orgB), { runId })).toBe(false);
    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
  });

  it("findClaimableAgentRuns never returns another organization's row", async () => {
    const orgA = await seedOrg("AI Agents Tenant A Discovery");
    const orgB = await seedOrg("AI Agents Tenant B Discovery");
    await seedAgentRun(orgB);

    const claimable = await findClaimableAgentRuns(ctx(orgA), { limit: 10 });
    expect(claimable).toHaveLength(0);
  });

  it("findExhaustedAgentRuns never returns another organization's row", async () => {
    const orgA = await seedOrg("AI Agents Tenant A ExhaustedDiscovery");
    const orgB = await seedOrg("AI Agents Tenant B ExhaustedDiscovery");
    const runId = await seedAgentRun(orgB, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    const exhausted = await findExhaustedAgentRuns(ctx(orgA), { limit: 10 });
    expect(exhausted).toHaveLength(0);
  });
});

describe("concurrency: two genuinely simultaneous claim attempts yield exactly one winner", () => {
  it("a fresh queued row claimed by two parallel calls only lets one succeed", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);

    const [a, b] = await Promise.all([claimAgentRun(ctx(organizationId), { runId }), claimAgentRun(ctx(organizationId), { runId })]);
    const winners = [a, b].filter((x) => x !== null).length;
    expect(winners).toBe(1);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("running");
    expect(row.attempt_count).toBe(1);
  });

  it("two parallel reclaims of the same expired running lease yield exactly one winner and one increment", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    await claimAgentRun(ctx(organizationId), { runId });
    await rewindStartedAt(runId, 121);

    const [a, b] = await Promise.all([claimAgentRun(ctx(organizationId), { runId }), claimAgentRun(ctx(organizationId), { runId })]);
    const winners = [a, b].filter((x) => x !== null).length;
    expect(winners).toBe(1);

    const row = await readAgentRun(runId);
    expect(row.attempt_count).toBe(2);
  });

  it("a concurrent claim and terminalize attempt on the same max-attempt expired running row never both succeed, and never produce attempt 4", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    const [claimed, terminalized] = await Promise.all([
      claimAgentRun(ctx(organizationId), { runId }),
      terminalizeExhaustedAgentRun(ctx(organizationId), { runId }),
    ]);

    expect(claimed).toBeNull();
    expect(terminalized).toBe(true);

    const row = await readAgentRun(runId);
    expect(row.attempt_count).toBe(3);
    expect(row.status).toBe("failed");
  });

  it("two simultaneous terminalizeExhaustedAgentRun calls on the same row yield exactly one winner", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    const [x, y] = await Promise.all([
      terminalizeExhaustedAgentRun(ctx(organizationId), { runId }),
      terminalizeExhaustedAgentRun(ctx(organizationId), { runId }),
    ]);
    const winners = [x, y].filter(Boolean).length;
    expect(winners).toBe(1);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
  });

  it("a stale-generation complete racing with the current-generation's own complete never lets the stale one win", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const workerA = await claimAgentRun(ctx(organizationId), { runId });
    await rewindStartedAt(runId, 121);
    const workerB = await claimAgentRun(ctx(organizationId), { runId });

    const [staleResult, currentResult] = await Promise.all([
      completeAgentRun(ctx(organizationId), { runId, attemptCount: workerA!.attemptCount }),
      completeAgentRun(ctx(organizationId), { runId, attemptCount: workerB!.attemptCount }),
    ]);

    expect(staleResult).toBe(false);
    expect(currentResult).toBe(true);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("succeeded");
    expect(row.attempt_count).toBe(workerB!.attemptCount);
  });

  it("a stale-generation fail racing with the current-generation's own complete never lets the stale fail overwrite the real outcome", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const workerA = await claimAgentRun(ctx(organizationId), { runId });
    await rewindStartedAt(runId, 121);
    const workerB = await claimAgentRun(ctx(organizationId), { runId });

    const [staleFailResult, currentCompleteResult] = await Promise.all([
      failAgentRun(ctx(organizationId), { runId, attemptCount: workerA!.attemptCount, error: "stale" }),
      completeAgentRun(ctx(organizationId), { runId, attemptCount: workerB!.attemptCount }),
    ]);

    // Both cannot be true (mutually exclusive attempt_count predicates),
    // and whichever the database's own row-lock ordering allowed to win,
    // the stale generation (workerA) must never be the one that did.
    expect(staleFailResult).toBe(false);
    expect(currentCompleteResult).toBe(true);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("succeeded");
    expect(row.error).toBeNull();
  });

  it("a stale-generation complete racing with the current-generation's own fail never lets the stale complete overwrite the real (failed) outcome — closes the Step 2 Final Correction Acceptance Audit's recorded LOW test-coverage gap (race scenario C, the mirror image of the stale-fail-vs-current-complete case above)", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const workerA = await claimAgentRun(ctx(organizationId), { runId });
    await rewindStartedAt(runId, 121);
    const workerB = await claimAgentRun(ctx(organizationId), { runId });

    const [staleCompleteResult, currentFailResult] = await Promise.all([
      completeAgentRun(ctx(organizationId), { runId, attemptCount: workerA!.attemptCount }),
      failAgentRun(ctx(organizationId), { runId, attemptCount: workerB!.attemptCount, error: "current, real error" }),
    ]);

    // Mutually exclusive attempt_count predicates: whichever the
    // database's own row-lock ordering let through, the stale generation
    // (workerA) must never be the one that won.
    expect(staleCompleteResult).toBe(false);
    expect(currentFailResult).toBe(true);

    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(workerB!.attemptCount);
    expect(row.error).toBe("current, real error");
  });
});

describe("findClaimableAgentRuns: scope and ordering", () => {
  it("returns a queued row, excludes a succeeded row, excludes a terminal-failed row, excludes an in-backoff failed row, excludes an actively-leased running row, excludes an exhausted-running row", async () => {
    const organizationId = await seedOrg();
    const queuedId = await seedAgentRun(organizationId);

    const succeededId = await seedAgentRun(organizationId);
    const succeededClaim = await claimAgentRun(ctx(organizationId), { runId: succeededId });
    await completeAgentRun(ctx(organizationId), { runId: succeededId, attemptCount: succeededClaim!.attemptCount });

    const terminalFailedId = await seedAgentRun(organizationId, { status: "failed", attemptCount: 3 });
    await rewindCompletedAt(terminalFailedId, 10_000);

    const inBackoffId = await seedAgentRun(organizationId, { status: "failed", attemptCount: 1 });
    await rewindCompletedAt(inBackoffId, 5);

    const activeLeaseId = await seedAgentRun(organizationId);
    await claimAgentRun(ctx(organizationId), { runId: activeLeaseId });

    const exhaustedId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(exhaustedId, 121);

    const claimable = await findClaimableAgentRuns(ctx(organizationId), { limit: 50 });
    expect(claimable).toContain(queuedId);
    expect(claimable).not.toContain(succeededId);
    expect(claimable).not.toContain(terminalFailedId);
    expect(claimable).not.toContain(inBackoffId);
    expect(claimable).not.toContain(activeLeaseId);
    expect(claimable).not.toContain(exhaustedId);
  });

  it("respects the limit", async () => {
    const organizationId = await seedOrg();
    for (let i = 0; i < 5; i++) {
      await seedAgentRun(organizationId);
    }
    const claimable = await findClaimableAgentRuns(ctx(organizationId), { limit: 3 });
    expect(claimable).toHaveLength(3);
  });
});

describe("findExhaustedAgentRuns: closes the orphan lifecycle state (the corrected HIGH defect)", () => {
  it("a running attempt-3 row with an active lease is NOT returned", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });

    expect(await findExhaustedAgentRuns(ctx(organizationId), { limit: 10 })).not.toContain(runId);
  });

  it("boundary: a running attempt-3 row at 119s is NOT returned", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 119);

    expect(await findExhaustedAgentRuns(ctx(organizationId), { limit: 10 })).not.toContain(runId);
  });

  it("boundary: a running attempt-3 row at 121s IS returned", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    expect(await findExhaustedAgentRuns(ctx(organizationId), { limit: 10 })).toContain(runId);
  });

  it("the returned id can be terminalized", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);

    const found = await findExhaustedAgentRuns(ctx(organizationId), { limit: 10 });
    expect(found).toContain(runId);
    expect(await terminalizeExhaustedAgentRun(ctx(organizationId), { runId })).toBe(true);
  });

  it("terminalization leaves status=failed, attempt_count=3, completed_at set", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);
    await terminalizeExhaustedAgentRun(ctx(organizationId), { runId });

    const row = await readAgentRun(runId);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(3);
    expect(row.completed_at).not.toBeNull();
  });

  it("once terminalized, the row disappears from exhausted discovery", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 3 });
    await rewindStartedAt(runId, 121);
    await terminalizeExhaustedAgentRun(ctx(organizationId), { runId });

    expect(await findExhaustedAgentRuns(ctx(organizationId), { limit: 10 })).not.toContain(runId);
  });

  it("a failed row at attempt_count=3 is NOT returned (already terminal, not a running-lease concern)", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "failed", attemptCount: 3 });
    await rewindCompletedAt(runId, 10_000);

    expect(await findExhaustedAgentRuns(ctx(organizationId), { limit: 10 })).not.toContain(runId);
  });

  it("a succeeded row is NOT returned", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId);
    const claimed = await claimAgentRun(ctx(organizationId), { runId });
    await completeAgentRun(ctx(organizationId), { runId, attemptCount: claimed!.attemptCount });

    expect(await findExhaustedAgentRuns(ctx(organizationId), { limit: 10 })).not.toContain(runId);
  });

  it("a running attempt-2 (below max) expired-lease row belongs only to claimable discovery, never exhausted discovery", async () => {
    const organizationId = await seedOrg();
    const runId = await seedAgentRun(organizationId, { status: "running", attemptCount: 2 });
    await rewindStartedAt(runId, 121);

    expect(await findExhaustedAgentRuns(ctx(organizationId), { limit: 10 })).not.toContain(runId);
    expect(await findClaimableAgentRuns(ctx(organizationId), { limit: 50 })).toContain(runId);
  });
});

describe("discovery limit validation: findClaimableAgentRuns and findExhaustedAgentRuns", () => {
  const cases: Array<[string, number]> = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["one past the maximum", 51],
    ["an absurdly large value", 999_999_999],
  ];

  it.each(cases)("findClaimableAgentRuns rejects %s with a clean AgentRunValidationError, never a raw Postgres error", async (_label, limit) => {
    const organizationId = await seedOrg();
    await expect(findClaimableAgentRuns(ctx(organizationId), { limit })).rejects.toBeInstanceOf(AgentRunValidationError);
  });

  it.each(cases)("findExhaustedAgentRuns rejects %s with a clean AgentRunValidationError, never a raw Postgres error", async (_label, limit) => {
    const organizationId = await seedOrg();
    await expect(findExhaustedAgentRuns(ctx(organizationId), { limit })).rejects.toBeInstanceOf(AgentRunValidationError);
  });

  it("findClaimableAgentRuns accepts 1, 10, and the maximum (50)", async () => {
    const organizationId = await seedOrg();
    await expect(findClaimableAgentRuns(ctx(organizationId), { limit: 1 })).resolves.toBeDefined();
    await expect(findClaimableAgentRuns(ctx(organizationId), { limit: 10 })).resolves.toBeDefined();
    await expect(findClaimableAgentRuns(ctx(organizationId), { limit: 50 })).resolves.toBeDefined();
  });

  it("findExhaustedAgentRuns accepts 1, 10, and the maximum (50)", async () => {
    const organizationId = await seedOrg();
    await expect(findExhaustedAgentRuns(ctx(organizationId), { limit: 1 })).resolves.toBeDefined();
    await expect(findExhaustedAgentRuns(ctx(organizationId), { limit: 10 })).resolves.toBeDefined();
    await expect(findExhaustedAgentRuns(ctx(organizationId), { limit: 50 })).resolves.toBeDefined();
  });
});

describe("schema compatibility: Step 1's own attempt_count cap remains a runtime-only policy, not a migration constraint", () => {
  it("attempt_count = 4 is still directly insertable at the database level", async () => {
    const organizationId = await seedOrg();
    await expect(seedAgentRun(organizationId, { attemptCount: 4 })).resolves.toBeDefined();
  });
});

describe("enqueueAgentRun: Milestone 4.2 Step 3 (Correction) — creates a brand-new row with fully predictable, caller-uncontrollable lifecycle state", () => {
  it("persists organization_id/agent_key/triggered_by/input exactly as given, and every lifecycle field at exactly its schema default", async () => {
    const organizationId = await seedOrg();
    const userId = await seedUser();
    const dealId = randomUUID();

    const enqueued = await enqueueAgentRun(
      { organizationId },
      { agentKey: "lead_enrichment", triggeredBy: userId, references: [{ entityType: "deal", entityId: dealId }] },
    );
    expect(enqueued.agentKey).toBe("lead_enrichment");
    expect(enqueued.status).toBe("queued");
    expect(enqueued.id).toEqual(expect.any(String));

    const row = await readAgentRun(enqueued.id);
    expect(row.organization_id).toBe(organizationId);
    expect(row.agent_key).toBe("lead_enrichment");
    expect(row.triggered_by).toBe(userId);
    expect(row.input).toEqual({ references: [{ entityType: "deal", entityId: dealId }] });
    expect(row.status).toBe("queued");
    expect(row.attempt_count).toBe(1);
    expect(row.started_at).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.error).toBeNull();
    expect(row.created_at).not.toBeNull();
  });

  it("omitting references entirely is accepted and persisted as { references: [] } — a run may legitimately reference nothing", async () => {
    const organizationId = await seedOrg();
    const userId = await seedUser();

    const enqueued = await enqueueAgentRun({ organizationId }, { agentKey: "lead_enrichment", triggeredBy: userId, references: [] });
    const row = await readAgentRun(enqueued.id);
    expect(row.input).toEqual({ references: [] });
  });

  it("has no parameter through which a caller could set status/attempt_count/started_at/completed_at/error/id/created_at directly — the function's own type signature accepts only agentKey/triggeredBy/references", async () => {
    const organizationId = await seedOrg();
    const userId = await seedUser();
    const enqueued = await enqueueAgentRun({ organizationId }, { agentKey: "lead_enrichment", triggeredBy: userId, references: [] });
    // enqueueAgentRun's own input type is `{ agentKey: string; triggeredBy: string; references: AgentRunReference[] }`
    // — there is no lifecycle-field parameter to pass even at the type
    // level; this test documents that structural guarantee by exercising
    // the real call shape and asserting the DB-default outcome once more.
    const row = await readAgentRun(enqueued.id);
    expect(row.status).toBe("queued");
    expect(row.attempt_count).toBe(1);
  });

  it("a freshly enqueued row is immediately claimable via the ordinary queued-row disjunct claimAgentRun already proves", async () => {
    const organizationId = await seedOrg();
    const userId = await seedUser();
    const enqueued = await enqueueAgentRun({ organizationId }, { agentKey: "lead_enrichment", triggeredBy: userId, references: [] });

    const claimed = await claimAgentRun({ organizationId }, { runId: enqueued.id });
    expect(claimed).toEqual({ runId: enqueued.id, attemptCount: 1 });
  });

  it("a freshly enqueued row appears in findClaimableAgentRuns for its own organization", async () => {
    const organizationId = await seedOrg();
    const userId = await seedUser();
    const enqueued = await enqueueAgentRun({ organizationId }, { agentKey: "lead_enrichment", triggeredBy: userId, references: [] });

    expect(await findClaimableAgentRuns({ organizationId }, { limit: 50 })).toContain(enqueued.id);
  });

  it("tenant safety: a row enqueued for org A is never visible to org B's own claim/discovery calls", async () => {
    const orgA = await seedOrg("AI Agents Tenant A Enqueue");
    const orgB = await seedOrg("AI Agents Tenant B Enqueue");
    const userId = await seedUser();
    const enqueued = await enqueueAgentRun({ organizationId: orgA }, { agentKey: "lead_enrichment", triggeredBy: userId, references: [] });

    expect(await claimAgentRun({ organizationId: orgB }, { runId: enqueued.id })).toBeNull();
    expect(await findClaimableAgentRuns({ organizationId: orgB }, { limit: 50 })).not.toContain(enqueued.id);
  });

  it("running an enqueue inside an existing PoolClient transaction (the Idempotency-Key wiring shape) persists identically to the no-client path", async () => {
    const organizationId = await seedOrg();
    const userId = await seedUser();
    const contactId = randomUUID();
    const client = await adminPool.connect();
    let enqueuedId: string;
    try {
      await client.query("begin");
      const enqueued = await enqueueAgentRun(
        { organizationId },
        { agentKey: "lead_enrichment", triggeredBy: userId, references: [{ entityType: "contact", entityId: contactId }] },
        client,
      );
      enqueuedId = enqueued.id;
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    const row = await readAgentRun(enqueuedId!);
    expect(row.status).toBe("queued");
    expect(row.input).toEqual({ references: [{ entityType: "contact", entityId: contactId }] });
  });

  it("DIRECT REPOSITORY BYPASS PROOF: a caller that bypasses TypeScript (as any) and passes a malformed references array directly to enqueueAgentRun is still rejected — the repository re-validates, it does not merely trust its own type signature", async () => {
    const organizationId = await seedOrg();
    const userId = await seedUser();
    const hostileReferences = [{ note: "call tomorrow" }] as unknown as Awaited<ReturnType<typeof validateAgentRunReferences>>;

    await expect(
      enqueueAgentRun({ organizationId }, { agentKey: "lead_enrichment", triggeredBy: userId, references: hostileReferences }),
    ).rejects.toBeInstanceOf(AgentRunValidationError);

    const n = await readAgentRunCountForOrg(organizationId);
    expect(n).toBe(0);
  });

  it("DIRECT REPOSITORY BYPASS PROOF: a non-UUID entityId smuggled past TypeScript is still rejected by the repository itself", async () => {
    const organizationId = await seedOrg();
    const userId = await seedUser();
    const hostileReferences = [{ entityType: "contact", entityId: "not-a-uuid" }] as unknown as Awaited<
      ReturnType<typeof validateAgentRunReferences>
    >;

    await expect(
      enqueueAgentRun({ organizationId }, { agentKey: "lead_enrichment", triggeredBy: userId, references: hostileReferences }),
    ).rejects.toBeInstanceOf(AgentRunValidationError);
  });

  it("ARCHITECTURAL SCOPE PROOF: enqueueAgentRun performs NO agent_key validation of any kind — this is deliberate, not a gap this package owns. An arbitrary, entirely fabricated key is accepted and persisted verbatim, exactly like a well-known one. This is identifier-passthrough, never identifier-shape validation and never supported-persona validation — a future caller (a Staff route or otherwise) is solely responsible for whatever agent-key contract eventually governs which keys are real, once one is designed with real evidence (M4.3/M4.4). Do not read the absence of a check here as this package silently promising key legitimacy.", async () => {
    const organizationId = await seedOrg();
    const userId = await seedUser();

    const fabricated = await enqueueAgentRun({ organizationId }, { agentKey: "totally_fabricated_not_a_real_persona", triggeredBy: userId, references: [] });
    expect(fabricated.agentKey).toBe("totally_fabricated_not_a_real_persona");
    const row = await readAgentRun(fabricated.id);
    expect(row.agent_key).toBe("totally_fabricated_not_a_real_persona");
    expect(row.status).toBe("queued");

    // Even a syntactically nonsensical key (uppercase, spaces, empty-ish)
    // is accepted — proving no shape check exists at this layer either.
    const nonsenseShaped = await enqueueAgentRun({ organizationId }, { agentKey: "NOT even Shaped Like A Key!!", triggeredBy: userId, references: [] });
    expect(nonsenseShaped.agentKey).toBe("NOT even Shaped Like A Key!!");
  });
});

describe("validateAgentRunReferences: Milestone 4.2 Step 3 Correction — positive reference-only allowlist", () => {
  const validUuid1 = randomUUID();
  const validUuid2 = randomUUID();

  it("omitted references defaults to []", () => {
    expect(validateAgentRunReferences(undefined)).toEqual([]);
  });

  it("empty array is accepted and frozen as []", () => {
    expect(validateAgentRunReferences([])).toEqual([]);
  });

  it.each(["contact", "company", "deal"] as const)("accepts a valid %s reference with a real UUID", (entityType) => {
    const id = randomUUID();
    expect(validateAgentRunReferences([{ entityType, entityId: id }])).toEqual([{ entityType, entityId: id }]);
  });

  it("accepts multiple references, including duplicates, persisted verbatim (frozen: duplicates are permitted, never deduplicated)", () => {
    const refs = [
      { entityType: "contact", entityId: validUuid1 },
      { entityType: "contact", entityId: validUuid1 },
      { entityType: "deal", entityId: validUuid2 },
    ];
    expect(validateAgentRunReferences(refs)).toEqual(refs);
  });

  it("accepts exactly the maximum reference count (10)", () => {
    const refs = Array.from({ length: 10 }, () => ({ entityType: "contact" as const, entityId: randomUUID() }));
    expect(validateAgentRunReferences(refs)).toHaveLength(10);
  });

  it("rejects 11 references (one past the maximum)", () => {
    const refs = Array.from({ length: 11 }, () => ({ entityType: "contact" as const, entityId: randomUUID() }));
    expect(() => validateAgentRunReferences(refs)).toThrow(AgentRunValidationError);
  });

  it("rejects a non-array top-level value", () => {
    expect(() => validateAgentRunReferences({ entityType: "contact", entityId: validUuid1 })).toThrow(AgentRunValidationError);
  });

  it.each([
    ["null", null],
    ["a number", 42],
    ["a string", "not-an-array"],
  ])("rejects %s as the top-level references value", (_label, value) => {
    expect(() => validateAgentRunReferences(value)).toThrow(AgentRunValidationError);
  });

  it.each([
    ["missing entityId", { entityType: "contact" }],
    ["missing entityType", { entityId: validUuid1 }],
    ["an unsupported entityType", { entityType: "lead", entityId: validUuid1 }],
    ["a non-UUID entityId (not-a-uuid)", { entityType: "contact", entityId: "not-a-uuid" }],
    ["a numeric-looking entityId (123)", { entityType: "contact", entityId: "123" }],
    ["a name as entityId (John)", { entityType: "contact", entityId: "John" }],
    ["a company-name entityId (Acme)", { entityType: "company", entityId: "Acme" }],
    ["a URL as entityId", { entityType: "contact", entityId: "https://example.com" }],
    ["an email as entityId", { entityType: "contact", entityId: "person@example.com" }],
    ["free text as entityId", { entityType: "contact", entityId: "call tomorrow" }],
  ])("rejects reference with %s", (_label, ref) => {
    expect(() => validateAgentRunReferences([ref])).toThrow(AgentRunValidationError);
  });

  it("rejects an unknown property on an otherwise-valid reference object, even alongside valid entityType/entityId", () => {
    expect(() =>
      validateAgentRunReferences([{ entityType: "contact", entityId: validUuid1, note: "extra" }]),
    ).toThrow(AgentRunValidationError);
  });

  it.each([
    ["note", { note: "call tomorrow" }],
    ["description", { description: "high value prospect" }],
    ["customer", { customer: "Acme" }],
    ["contact (free text, not a reference object)", { contact: "John" }],
    ["transcript", { transcript: "call went well" }],
    ["message", { message: "hey there" }],
    ["prompt", { prompt: "summarize this deal" }],
    ["reference (singular, non-uuid string)", { reference: "not-a-uuid" }],
    ["contactId (bare string, not a reference object)", { contactId: "not-a-uuid" }],
    ["email", { email: "a@example.com" }],
    ["phone", { phone: "+31612345678" }],
    ["metadata (nested object)", { metadata: { foo: "bar" } }],
  ])("rejects a hostile array element shaped as free-form content (%s), structurally impossible to mistake for a reference", (_label, hostileElement) => {
    expect(() => validateAgentRunReferences([hostileElement])).toThrow(AgentRunValidationError);
  });

  it("rejects an array element that is itself an array (no nesting beyond the exact reference structure)", () => {
    expect(() => validateAgentRunReferences([["contact", validUuid1]])).toThrow(AgentRunValidationError);
  });

  it("rejects null as an array element", () => {
    expect(() => validateAgentRunReferences([null])).toThrow(AgentRunValidationError);
  });
});
