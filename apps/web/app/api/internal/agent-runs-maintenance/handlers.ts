import { NextResponse } from "next/server";
import { getPool } from "@ai-revenue-os/database";
import { findExhaustedAgentRuns, terminalizeExhaustedAgentRun } from "@ai-revenue-os/ai-agents";
import { apiError } from "../../v1/_shared/api-error";
import { timingSafeEqualStrings } from "../_shared/cron-auth";

/**
 * Milestone 4.2 Step 4 — GET /api/internal/agent-runs-maintenance.
 *
 * MAINTENANCE-ONLY, deliberately not an execution dispatcher. M4.2 has
 * no orchestrator, no model router, no tool layer (`docs/12-
 * Implementation-Milestones.md`'s own M4.3), no persona/agent_definitions
 * registry (M4.4+), and Step 3's own architectural correction found no
 * evidence-backed way to freeze a supported `agent_key`. There is
 * therefore no code anywhere in this repository that could legitimately
 * take ownership of a QUEUED or FAILED-and-retryable `agent_runs` row
 * and do something real with it — claiming such a row here would either
 * strand it `running` forever (nothing would ever complete/fail it) or
 * require fabricating a fake outcome, both explicitly unacceptable. This
 * route therefore deliberately never calls `findClaimableAgentRuns`/
 * `claimAgentRun` — that pairing is a future M4.3 execution worker's own
 * concern, once a real orchestrator exists to hand a claimed row to.
 *
 * What IS legitimate, agent-key-agnostic, and requires no interpretation
 * of "what does this agent do": cleaning up rows already stuck `running`
 * at `MAX_ATTEMPTS` with an expired lease (a crash-recovery edge case
 * `claimAgentRun` itself deliberately excludes, by design — see
 * `packages/ai-agents/src/repository.ts`'s own header comment on
 * `terminalizeExhaustedAgentRun`). This is pure terminal-state hygiene,
 * not agent execution — it recognizes an already-exhausted retry budget
 * and closes the row out, exactly the operational gap Step 2's own Final
 * Implementation Acceptance Audit found (a HIGH defect: such rows had no
 * discovery path and would remain `running` indefinitely in practice).
 *
 * Internal platform infrastructure, identical security model to
 * `dispatch-events`/`brain-embedding-recovery`: CRON_SECRET bearer only,
 * never session or `api_keys` auth, no request body, no organization
 * selector — every organization is enumerated server-side, the same
 * `select id from public.organizations` precedent `brain-embedding-
 * recovery/handlers.ts` already established.
 */

/** Matches `packages/ai-agents/src/repository.ts`'s own already-frozen
 * `DISCOVERY_MAX_LIMIT` comment ("the future dispatcher's own expected
 * BATCH_SIZE = 10 per-tick cadence") — reusing that anticipated value
 * rather than introducing a second batch constant. */
const BATCH_SIZE = 10;

interface MaintenanceSummary {
  organizationsProcessed: number;
  candidatesFound: number;
  terminalized: number;
  errors: number;
}

export async function handleAgentRunsMaintenance(request: Request): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError("INTERNAL_ERROR", "CRON_SECRET is not configured", 500);
  }
  const provided = request.headers.get("authorization");
  if (!provided || !timingSafeEqualStrings(provided, `Bearer ${cronSecret}`)) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }

  const summary: MaintenanceSummary = { organizationsProcessed: 0, candidatesFound: 0, terminalized: 0, errors: 0 };

  let organizationIds: string[];
  try {
    const result = await getPool().query<{ id: string }>("select id from public.organizations order by id asc");
    organizationIds = result.rows.map((row) => row.id);
  } catch {
    return apiError("INTERNAL_ERROR", "Failed to enumerate organizations", 500);
  }

  for (const organizationId of organizationIds) {
    try {
      const exhaustedIds = await findExhaustedAgentRuns({ organizationId }, { limit: BATCH_SIZE });
      summary.candidatesFound += exhaustedIds.length;

      for (const runId of exhaustedIds) {
        try {
          const terminalized = await terminalizeExhaustedAgentRun({ organizationId }, { runId });
          if (terminalized) {
            summary.terminalized += 1;
          }
        } catch {
          // One row's unexpected failure must never block the rest of
          // this organization's batch, let alone later organizations —
          // the exact same isolation discipline brain-embedding-
          // recovery/handlers.ts already established per-candidate.
          summary.errors += 1;
        }
      }
      summary.organizationsProcessed += 1;
    } catch {
      // One organization's failure must never block later organizations.
      summary.errors += 1;
    }
  }

  return NextResponse.json({ summary }, { status: 200 });
}
