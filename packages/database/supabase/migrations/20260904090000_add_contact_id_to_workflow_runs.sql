-- Milestone 3.4 Targeted Acceptance Remediation (Finding 3): workflow_runs
-- gains a nullable, informational contact_id column so a durable
-- post-enrichment scoring recalculation attempt can be found again by a
-- periodic recovery sweep (recoverPendingPostEnrichmentScoring,
-- packages/intelligence/src/scoring.ts) without depending on a new event
-- type, a new SECURITY DEFINER function, or any RLS change.
--
-- Deliberately NOT a foreign key -- same reasoning as this table's own
-- pre-existing source_event_id column ("informational/traceability only,
-- not a foreign key"): a row must remain findable/observable even for a
-- contact that is later hard-erased (the recovery sweep's own live
-- re-check inside recalculateContactScore already handles that case
-- correctly, returning contact_not_found rather than acting on stale
-- data -- see that function's own header comment). No RLS/grant change is
-- needed: the existing workflow_runs policies apply at the row level and
-- already cover every column, including this new one.

alter table public.workflow_runs add column contact_id uuid;

comment on column public.workflow_runs.contact_id is
  'Informational/traceability only, not a foreign key -- same reasoning as source_event_id above. Lets recoverPendingPostEnrichmentScoring() recover which contact a pending/failed lead_scoring_post_enrichment run belongs to, without a new table or event type.';

-- Partial index: only rows the recovery sweep actually queries (a pending
-- post-enrichment scoring attempt) are indexed -- cheap, and irrelevant to
-- every other workflow_key this table already holds.
create index workflow_runs_pending_recovery_idx on public.workflow_runs (workflow_key, status, started_at)
  where contact_id is not null;
