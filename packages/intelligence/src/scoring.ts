import { withTenantContext, getPool, type RequestContext } from "@ai-revenue-os/database";

/**
 * Deterministic, rules-based lead scoring (Milestone 3.4, Milestone 3.4
 * Implementation Authorization). Contact-level only -- no company-level
 * score exists or is planned; company attributes are an INPUT to the
 * contact score, never a second output.
 *
 * The rule model is deliberately NOT an executable expression language:
 * a rule's `condition` is a strict, allowlisted {field, operator, value}
 * triple. Evaluation (evaluateCondition/computeScore below) is a fixed,
 * hand-written interpreter over a plain, pre-loaded fact object -- there
 * is no eval, no `new Function`, no dynamic SQL construction from rule
 * content, and no LLM/agent involvement anywhere in this module. `field`
 * values are only ever validated, allowlisted strings that already
 * passed both the DB CHECK constraint and the application validation
 * layer (packages/database's own scoring_rules migration,
 * apps/web's scoring-rule-validation.ts) at RULE-WRITE time -- by the
 * time computeScore reads facts[rule.field], that string is safe by
 * construction, not by a runtime check performed here.
 *
 * Weights are bounded [-100, 100] (enforced by the schema's own CHECK
 * constraint, re-validated at the application layer too); the final
 * score is explicitly clamped to [0, 100] regardless of how many rules
 * matched, since a sum of individually-bounded weights can still exceed
 * either edge.
 */

export type ScoringOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "exists";

/** The complete, fixed field allowlist -- mirrors scoring_rules' own DB CHECK exactly. Extending this list requires a migration, not just a code change. */
export type ScoringField =
  | "company.industry"
  | "company.employee_count"
  | "company.annual_revenue"
  | "contact.job_title"
  | "contact.lifecycle_stage"
  | "contact.enrichment_completed"
  | "company.enrichment_completed"
  | "engagement.pageviews_30d"
  | "engagement.form_submits_30d"
  | "engagement.sessions_30d"
  | "engagement.last_seen_days_ago";

export interface ScoringFacts {
  "company.industry": string | null;
  "company.employee_count": number | null;
  "company.annual_revenue": number | null;
  "contact.job_title": string | null;
  "contact.lifecycle_stage": string | null;
  "contact.enrichment_completed": boolean;
  "company.enrichment_completed": boolean;
  "engagement.pageviews_30d": number;
  "engagement.form_submits_30d": number;
  "engagement.sessions_30d": number;
  "engagement.last_seen_days_ago": number | null;
}

export interface ScoringRuleRow {
  id: string;
  field: ScoringField;
  operator: ScoringOperator;
  value: unknown;
  weight: number;
}

export interface BreakdownEntry {
  ruleId: string;
  field: ScoringField;
  operator: ScoringOperator;
  matched: boolean;
  contribution: number;
}

/**
 * Pure, synchronous, never throws. Missing/null data always evaluates to
 * "does not match" (never an error) except for `exists`, which is
 * exactly the operator for testing presence/absence itself. This is what
 * lets a rule safely reference a field that happens to be null for a
 * given contact/company without special-casing every rule author has to
 * remember.
 */
function evaluateCondition(actual: unknown, operator: ScoringOperator, expected: unknown): boolean {
  if (operator === "exists") {
    return actual !== null && actual !== undefined;
  }
  if (actual === null || actual === undefined) {
    return false;
  }
  switch (operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "in":
      return Array.isArray(expected) && expected.some((v) => v === actual);
    case "contains":
      return typeof actual === "string" && typeof expected === "string" && actual.toLowerCase().includes(expected.toLowerCase());
    default:
      return false;
  }
}

/** Deterministic: same facts + same rules always produce the same score and breakdown, every time, with no randomness and no external call. */
export function computeScore(facts: ScoringFacts, rules: ScoringRuleRow[]): { score: number; breakdown: BreakdownEntry[] } {
  let total = 0;
  const breakdown: BreakdownEntry[] = [];
  for (const rule of rules) {
    const actual = facts[rule.field];
    const matched = evaluateCondition(actual, rule.operator, rule.value);
    const contribution = matched ? rule.weight : 0;
    total += contribution;
    breakdown.push({ ruleId: rule.id, field: rule.field, operator: rule.operator, matched, contribution });
  }
  const score = Math.max(0, Math.min(100, Math.round(total)));
  return { score, breakdown };
}

interface FactRow {
  job_title: string | null;
  lifecycle_stage: string | null;
  company_id: string | null;
  industry: string | null;
  employee_count: number | null;
  annual_revenue: number | null;
}

interface EngagementRow {
  pageviews_30d: string;
  form_submits_30d: string;
  sessions_30d: string;
  last_seen_at: string | null;
}

/**
 * Gathers every fact the current rule set can reference, in one pass, for
 * one contact. All queries are parameterized and organization-scoped --
 * no field name is ever interpolated; the mapping from ScoringField to
 * an actual query/column is entirely fixed in this function's own source,
 * never data-driven.
 */
async function gatherScoringFacts(
  ctx: RequestContext & { organizationId: string },
  contactId: string,
): Promise<ScoringFacts | null> {
  return withTenantContext(ctx, async (client) => {
    const contactRow = await client.query<FactRow>(
      `select c.job_title, c.lifecycle_stage, c.company_id,
              co.industry, co.employee_count, co.annual_revenue
       from public.contacts c
       left join public.companies co on co.id = c.company_id and co.organization_id = c.organization_id
       where c.id = $1 and c.organization_id = $2 and c.deleted_at is null`,
      [contactId, ctx.organizationId],
    );
    if (contactRow.rows.length === 0) {
      return null;
    }
    const fact = contactRow.rows[0]!;

    const contactEnrichmentRow = await client.query<{ exists: boolean }>(
      "select exists(select 1 from public.contact_enrichment where organization_id = $1 and contact_id = $2 and status = 'completed') as exists",
      [ctx.organizationId, contactId],
    );
    const contactEnrichmentCompleted = contactEnrichmentRow.rows[0]?.exists ?? false;

    let companyEnrichmentCompleted = false;
    if (fact.company_id) {
      const companyEnrichmentRow = await client.query<{ exists: boolean }>(
        "select exists(select 1 from public.company_enrichment where organization_id = $1 and company_id = $2 and status = 'completed') as exists",
        [ctx.organizationId, fact.company_id],
      );
      companyEnrichmentCompleted = companyEnrichmentRow.rows[0]?.exists ?? false;
    }

    const engagementRow = await client.query<EngagementRow>(
      `select
         count(*) filter (where ve.event_type = 'pageview' and ve.occurred_at > now() - interval '30 days')::text as pageviews_30d,
         count(*) filter (where ve.event_type = 'form_submit' and ve.occurred_at > now() - interval '30 days')::text as form_submits_30d,
         count(distinct vs.id) filter (where vs.started_at > now() - interval '30 days')::text as sessions_30d,
         max(greatest(wv.last_seen_at, coalesce(ve.occurred_at, wv.last_seen_at)))::text as last_seen_at
       from public.website_visitors wv
       left join public.visitor_sessions vs on vs.visitor_id = wv.id and vs.organization_id = wv.organization_id
       left join public.visitor_events ve on ve.session_id = vs.id and ve.organization_id = vs.organization_id
       where wv.organization_id = $1 and wv.identified_contact_id = $2`,
      [ctx.organizationId, contactId],
    );
    const engagement = engagementRow.rows[0];
    const lastSeenAt = engagement?.last_seen_at ? new Date(engagement.last_seen_at) : null;
    const lastSeenDaysAgo = lastSeenAt ? Math.floor((Date.now() - lastSeenAt.getTime()) / (24 * 60 * 60 * 1000)) : null;

    return {
      "company.industry": fact.industry,
      "company.employee_count": fact.employee_count,
      "company.annual_revenue": fact.annual_revenue,
      "contact.job_title": fact.job_title,
      "contact.lifecycle_stage": fact.lifecycle_stage,
      "contact.enrichment_completed": contactEnrichmentCompleted,
      "company.enrichment_completed": companyEnrichmentCompleted,
      "engagement.pageviews_30d": Number(engagement?.pageviews_30d ?? 0),
      "engagement.form_submits_30d": Number(engagement?.form_submits_30d ?? 0),
      "engagement.sessions_30d": Number(engagement?.sessions_30d ?? 0),
      "engagement.last_seen_days_ago": lastSeenDaysAgo,
    };
  });
}

async function loadActiveRules(ctx: RequestContext & { organizationId: string }): Promise<ScoringRuleRow[]> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<{ id: string; field: string; operator: string; value: unknown; weight: number }>(
      "select id, field, operator, value, weight from public.scoring_rules where organization_id = $1 and is_active order by created_at asc",
      [ctx.organizationId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      field: r.field as ScoringField,
      operator: r.operator as ScoringOperator,
      value: r.value,
      weight: r.weight,
    }));
  });
}

export type RecalculateContactScoreOutcome =
  | { accepted: true; score: number; grade: "A" | "B" | "C" | "D" }
  | { accepted: false; reason: "contact_not_found" };

/**
 * The one write path for a contact's lead score. Live re-check (row
 * exists, deleted_at IS NULL) happens inside gatherScoringFacts, in the
 * same transaction as the eventual insert -- mirrors recordEnrichmentResult's
 * own TOCTOU-safe discipline exactly: a stale trigger for a contact that
 * has since been hard-erased or soft-deleted never writes a score for it.
 *
 * Historized: always INSERTs a new row, never updates a prior one. Two
 * genuinely concurrent calls for the same contact simply each insert
 * their own row -- there is no write-write conflict to arbitrate, since
 * neither call ever reads-modifies-writes the same row the other is
 * touching.
 */
export async function recalculateContactScore(
  ctx: RequestContext & { organizationId: string },
  input: { contactId: string; sourceEventId?: string },
): Promise<RecalculateContactScoreOutcome> {
  const facts = await gatherScoringFacts(ctx, input.contactId);
  if (!facts) {
    return { accepted: false, reason: "contact_not_found" };
  }

  const rules = await loadActiveRules(ctx);
  const { score, breakdown } = computeScore(facts, rules);

  const grade = await withTenantContext(ctx, async (client) => {
    const inserted = await client.query<{ grade: "A" | "B" | "C" | "D" }>(
      `insert into public.lead_scores (organization_id, contact_id, score, breakdown, source_event_id)
       values ($1, $2, $3, $4, $5)
       returning grade`,
      [ctx.organizationId, input.contactId, score, JSON.stringify(breakdown), input.sourceEventId ?? null],
    );
    return inserted.rows[0]!.grade;
  });

  return { accepted: true, score, grade };
}

export type RecalculateContactScoreForEventOutcome = RecalculateContactScoreOutcome | { accepted: false; reason: "already_processed" };

/**
 * Milestone 3.4F hostile-concurrency finding: a plain `status <>
 * 'succeeded'` claim predicate is NOT sufficient mutual exclusion -- a
 * still-in-flight 'running' row also satisfies it, so two genuinely
 * concurrent callers could both "claim" the same row and both insert a
 * duplicate lead_scores entry (reproduced directly against real Postgres
 * in scoring-adversarial.test.ts before this fix). A 'running' row is
 * only reclaimable once it is stale -- exactly the time-based lease
 * condition event_deliveries' own claim already enforces (Milestone
 * 3.3), applied here to workflow_runs for the same reason.
 */
const CLAIM_LEASE_SECONDS = 120;

/**
 * Milestone 3.4 Targeted Acceptance Remediation (Finding 3) — the
 * distinct workflow_key recordEnrichmentResult's own post-write scoring
 * hook claims under, kept separate from the dispatcher-triggered
 * 'lead_scoring' key so the two can never collide or be mistaken for one
 * another in workflow_runs, and so a contact can be legitimately
 * recalculated under this key many times over its lifetime (once per
 * distinct enrichment completion) without any prior success permanently
 * blocking a later, genuinely new attempt — each attempt gets its own
 * source_event_id (see recordEnrichmentResult's own call site).
 */
export const POST_ENRICHMENT_SCORING_WORKFLOW_KEY = "lead_scoring_post_enrichment";

/** Bounded per sweep call, same reasoning and same order of magnitude as DISPATCH_BATCH_SIZE (packages/database/src/events.ts) — a cron-driven recovery pass must never attempt to drain an unbounded backlog in one call. */
const RECOVERY_BATCH_SIZE = 10;

/**
 * The dispatcher-triggered path. Milestone 3.4 Implementation
 * Authorization: reuse workflow_runs for event-trigger deduplication
 * rather than inventing a new mechanism. Unlike recordEnrichmentResult
 * (whose own contact_enrichment upsert naturally dedupes a redelivered
 * write-back), lead_scores is deliberately historized/insert-only with
 * no unique constraint to lean on -- so the dedup gate has to be an
 * explicit, atomic CLAIM against workflow_runs, checked BEFORE any score
 * is computed or inserted, not a check-then-act race.
 *
 * The claim is the exact same atomic pattern already proven for
 * event_deliveries' own lease acquire/reclaim (Milestone 3.3): a single
 * INSERT ... ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING, gated on
 * status='succeeded' being excluded AND a still-'running' row being
 * excluded unless its lease has gone stale (CLAIM_LEASE_SECONDS). Zero
 * rows returned means this (workflow_key, source_event_id) pair already
 * has a 'succeeded' row, or a genuinely active 'running' claim -- a
 * redelivered/duplicate/concurrent trigger for the exact same event is a
 * clean no-op, never a duplicate lead_scores insert. This does not
 * replace event_deliveries' own dedup at the dispatcher layer (that still
 * prevents a delivered pair from being re-attempted at all under normal
 * operation) -- it is the second, independent layer that also closes the
 * "handle() partially succeeded, then threw, then got retried" window the
 * dispatcher's own claim-release on failure would otherwise redeliver
 * into, and the "two dispatcher ticks genuinely overlap in time" window a
 * plain status check alone cannot close.
 */
export async function recalculateContactScoreForEvent(
  ctx: RequestContext & { organizationId: string },
  input: { contactId: string; workflowKey: string; sourceEventId: string },
): Promise<RecalculateContactScoreForEventOutcome> {
  const claimed = await withTenantContext(ctx, async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into public.workflow_runs (organization_id, workflow_key, source_event_id, contact_id, status, started_at)
       values ($1, $2, $3, $5, 'running', now())
       on conflict (organization_id, workflow_key, source_event_id) do update set
         status = 'running',
         started_at = now(),
         contact_id = excluded.contact_id,
         attempt_count = public.workflow_runs.attempt_count + 1
       where public.workflow_runs.status = 'failed'
          or (public.workflow_runs.status = 'running' and public.workflow_runs.started_at < now() - make_interval(secs => $4))
       returning id`,
      [ctx.organizationId, input.workflowKey, input.sourceEventId, CLAIM_LEASE_SECONDS, input.contactId],
    );
    return result.rows.length > 0;
  });
  if (!claimed) {
    return { accepted: false, reason: "already_processed" };
  }

  const outcome = await recalculateContactScore(ctx, { contactId: input.contactId, sourceEventId: input.sourceEventId });

  // Completion bookkeeping is best-effort observability, same discipline
  // as recordEnrichmentResult's own workflow_runs step -- the guard below
  // (status <> 'succeeded') means this can never downgrade an
  // already-succeeded run, though under this function's own claim-first
  // design nothing else could have raced past the claim above to mark it
  // succeeded already.
  await withTenantContext(ctx, async (client) => {
    await client.query(
      `update public.workflow_runs
       set status = $4, completed_at = now(), error = $5
       where organization_id = $1 and workflow_key = $2 and source_event_id = $3 and status <> 'succeeded'`,
      [
        ctx.organizationId,
        input.workflowKey,
        input.sourceEventId,
        outcome.accepted ? "succeeded" : "failed",
        outcome.accepted ? null : outcome.reason,
      ],
    );
  });

  return outcome;
}

export interface RecoverPendingPostEnrichmentScoringSummary {
  attempted: number;
  succeeded: number;
}

/**
 * Milestone 3.4 Targeted Acceptance Remediation (Finding 3) — the durable
 * retry/recovery path for a post-enrichment scoring recalculation that
 * failed (a definite, caught failure -- workflow_runs.status='failed') or
 * was interrupted mid-flight by a crash (a stale 'running' claim, exactly
 * the same staleness window recalculateContactScoreForEvent's own claim
 * already uses). Invoked from the same cron tick that already drives
 * dispatchPendingEvents (apps/web/app/api/internal/dispatch-events) --
 * reuses that existing schedule/trigger infrastructure rather than
 * introducing a second one, and reuses recalculateContactScoreForEvent's
 * own already-proven claim/complete mechanism rather than a new retry
 * primitive.
 *
 * Deliberately tenant-agnostic, exactly like dispatchPendingEvents itself:
 * uses the pool's own elevated connection directly (never withTenantContext,
 * which would scope it to a single organization) to discover pending work
 * across every organization in one pass, then hands each row off to
 * recalculateContactScoreForEvent with that row's own organizationId --
 * the SAME two-layer shape (cross-tenant discovery, per-row tenant-scoped
 * work) the dispatcher's own consumer loop already established and this
 * milestone's own audit already verified is safe. No PII flows through
 * this path: only organization_id and two opaque uuids (contact_id,
 * source_event_id) are ever read or logged.
 */
export async function recoverPendingPostEnrichmentScoring(): Promise<RecoverPendingPostEnrichmentScoringSummary> {
  const pool = getPool();
  const summary: RecoverPendingPostEnrichmentScoringSummary = { attempted: 0, succeeded: 0 };

  const pending = await pool.query<{ organization_id: string; contact_id: string; source_event_id: string }>(
    `select organization_id, contact_id, source_event_id
     from public.workflow_runs
     where workflow_key = $1
       and contact_id is not null
       and (
         status = 'failed'
         or (status = 'running' and started_at < now() - make_interval(secs => $2))
       )
     order by started_at asc
     limit $3`,
    [POST_ENRICHMENT_SCORING_WORKFLOW_KEY, CLAIM_LEASE_SECONDS, RECOVERY_BATCH_SIZE],
  );

  for (const row of pending.rows) {
    summary.attempted += 1;
    try {
      const outcome = await recalculateContactScoreForEvent(
        { organizationId: row.organization_id },
        { contactId: row.contact_id, workflowKey: POST_ENRICHMENT_SCORING_WORKFLOW_KEY, sourceEventId: row.source_event_id },
      );
      if (outcome.accepted) {
        summary.succeeded += 1;
      }
    } catch {
      // A genuinely failed retry attempt (e.g. a transient DB error) --
      // the claim it just took is either 'failed' (recalculateContactScoreForEvent's
      // own completion bookkeeping already ran) or left stale-'running'
      // (if the throw happened before that could run), either way
      // findable again by this same sweep on a future tick. Isolated to
      // this one row -- never breaks the batch.
    }
  }

  return summary;
}

export interface LeadScoreRecord {
  id: string;
  score: number;
  grade: "A" | "B" | "C" | "D";
  breakdown: BreakdownEntry[];
  computedAt: string;
}

interface LeadScoreDbRow {
  id: string;
  score: number;
  grade: "A" | "B" | "C" | "D";
  breakdown: BreakdownEntry[];
  computed_at: string;
}

function toLeadScoreRecord(row: LeadScoreDbRow): LeadScoreRecord {
  return { id: row.id, score: row.score, grade: row.grade, breakdown: row.breakdown, computedAt: row.computed_at };
}

/** The single most recent score for a contact, or null if none has ever been computed. Read-only, ordinary RLS-scoped SELECT. */
export async function getLatestLeadScore(
  ctx: RequestContext & { organizationId: string },
  contactId: string,
): Promise<LeadScoreRecord | null> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<LeadScoreDbRow>(
      "select id, score, grade, breakdown, computed_at from public.lead_scores where organization_id = $1 and contact_id = $2 order by computed_at desc, id desc limit 1",
      [ctx.organizationId, contactId],
    );
    return result.rows[0] ? toLeadScoreRecord(result.rows[0]) : null;
  });
}

export interface LeadScoreHistoryCursor {
  computedAt: string;
  id: string;
}
export interface LeadScoreHistoryPage {
  items: LeadScoreRecord[];
  nextCursor: string | null;
}

const DEFAULT_HISTORY_LIMIT = 25;
const MAX_HISTORY_LIMIT = 100;

/**
 * A small, self-contained cursor -- deliberately not a shared package
 * dependency: this is the only consumer of "paginate lead_scores by
 * (computed_at, id) descending" in the whole monorepo, so a dedicated
 * ~15-line helper here is simpler and lower-blast-radius than exporting
 * packages/crm's own internal pagination module (which is not part of
 * its public API today) for a single one-off reuse.
 */
export function encodeLeadScoreHistoryCursor(cursor: LeadScoreHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeLeadScoreHistoryCursor(raw: string): LeadScoreHistoryCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof parsed.computedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.computedAt)) ||
      typeof parsed.id !== "string"
    ) {
      return null;
    }
    return { computedAt: parsed.computedAt, id: parsed.id };
  } catch {
    return null;
  }
}

/** Full historized score list for a contact, newest first, cursor-paginated (never offset — same reasoning as every other list endpoint in this API, docs/04-API-Architecture.md §1). */
export async function listLeadScoreHistory(
  ctx: RequestContext & { organizationId: string },
  contactId: string,
  options: { cursor?: LeadScoreHistoryCursor; limit?: number } = {},
): Promise<LeadScoreHistoryPage> {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT));
  return withTenantContext(ctx, async (client) => {
    const rows = options.cursor
      ? await client.query<LeadScoreDbRow>(
          `select id, score, grade, breakdown, computed_at from public.lead_scores
           where organization_id = $1 and contact_id = $2
             and (computed_at, id) < ($3, $4)
           order by computed_at desc, id desc
           limit $5`,
          [ctx.organizationId, contactId, options.cursor.computedAt, options.cursor.id, limit + 1],
        )
      : await client.query<LeadScoreDbRow>(
          `select id, score, grade, breakdown, computed_at from public.lead_scores
           where organization_id = $1 and contact_id = $2
           order by computed_at desc, id desc
           limit $3`,
          [ctx.organizationId, contactId, limit + 1],
        );

    const hasMore = rows.rows.length > limit;
    const pageRows = hasMore ? rows.rows.slice(0, limit) : rows.rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? encodeLeadScoreHistoryCursor({ computedAt: last.computed_at, id: last.id }) : null;
    return { items: pageRows.map(toLeadScoreRecord), nextCursor };
  });
}

export interface ScoringRuleRecord {
  id: string;
  name: string;
  field: ScoringField;
  operator: ScoringOperator;
  value: unknown;
  weight: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ScoringRuleDbRow {
  id: string;
  name: string;
  field: string;
  operator: string;
  value: unknown;
  weight: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function toScoringRuleRecord(row: ScoringRuleDbRow): ScoringRuleRecord {
  return {
    id: row.id,
    name: row.name,
    field: row.field as ScoringField,
    operator: row.operator as ScoringOperator,
    value: row.value,
    weight: row.weight,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every scoring rule for the organization (active and inactive) — a bounded, typically-small configuration resource; no pagination needed for v1. */
export async function listScoringRules(ctx: RequestContext & { organizationId: string }): Promise<ScoringRuleRecord[]> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<ScoringRuleDbRow>(
      "select id, name, field, operator, value, weight, is_active, created_at, updated_at from public.scoring_rules where organization_id = $1 order by created_at asc",
      [ctx.organizationId],
    );
    return result.rows.map(toScoringRuleRecord);
  });
}

export interface CreateScoringRuleInput {
  name: string;
  field: string;
  operator: string;
  value: unknown;
  weight: number;
  isActive?: boolean;
  createdBy?: string;
}

/** Shape is trusted to have already passed apps/web's own scoring-rule-validation.ts allowlist checks — this function performs the write, not the shape validation, mirroring recordEnrichmentResult's own division of responsibility. */
export async function createScoringRule(
  ctx: RequestContext & { organizationId: string },
  input: CreateScoringRuleInput,
): Promise<ScoringRuleRecord> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<ScoringRuleDbRow>(
      `insert into public.scoring_rules (organization_id, name, field, operator, value, weight, is_active, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, name, field, operator, value, weight, is_active, created_at, updated_at`,
      [
        ctx.organizationId,
        input.name,
        input.field,
        input.operator,
        JSON.stringify(input.value),
        input.weight,
        input.isActive ?? true,
        input.createdBy ?? null,
      ],
    );
    return toScoringRuleRecord(result.rows[0]!);
  });
}

export interface UpdateScoringRuleInput {
  name?: string;
  field?: string;
  operator?: string;
  value?: unknown;
  weight?: number;
  isActive?: boolean;
}

/** Returns null for a nonexistent or cross-tenant rule id — RLS alone would return zero affected rows either way, so this is a structural, not merely a checked, tenant boundary. */
export async function updateScoringRule(
  ctx: RequestContext & { organizationId: string },
  ruleId: string,
  patch: UpdateScoringRuleInput,
): Promise<ScoringRuleRecord | null> {
  return withTenantContext(ctx, async (client) => {
    const result = await client.query<ScoringRuleDbRow>(
      `update public.scoring_rules set
         name = coalesce($3, name),
         field = coalesce($4, field),
         operator = coalesce($5, operator),
         value = coalesce($6, value),
         weight = coalesce($7, weight),
         is_active = coalesce($8, is_active),
         updated_at = now()
       where organization_id = $1 and id = $2
       returning id, name, field, operator, value, weight, is_active, created_at, updated_at`,
      [
        ctx.organizationId,
        ruleId,
        patch.name ?? null,
        patch.field ?? null,
        patch.operator ?? null,
        patch.value !== undefined ? JSON.stringify(patch.value) : null,
        patch.weight ?? null,
        patch.isActive ?? null,
      ],
    );
    return result.rows[0] ? toScoringRuleRecord(result.rows[0]) : null;
  });
}
