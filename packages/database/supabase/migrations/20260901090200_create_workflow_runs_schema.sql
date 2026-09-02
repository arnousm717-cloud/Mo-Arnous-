-- Milestone 3.3A: workflow_runs -- the minimal, Milestone-3.3-scoped
-- observability table Milestone 3.3 Architecture Resolution Report §K
-- specifies. Deliberately narrow: this is not a generic workflow-
-- orchestration platform, only enough to answer "did this org's
-- enrichment run succeed, what did it cost, why did it fail, is it
-- worth retrying" for the one workflow this milestone actually ships.

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Static, code-defined identifier (e.g. 'lead_enrichment') -- never
  -- looked up or constructed from a database column or caller input,
  -- the same discipline event_deliveries.consumer already established
  -- (M1.7 Decision A) for exactly this reason.
  workflow_key text not null,
  -- Informational/traceability only, not a foreign key -- same
  -- reasoning as contact_enrichment.source_event_id.
  source_event_id uuid,
  status text not null check (status in ('pending', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  provider text,
  cost_usd numeric,
  error text,
  -- Small, closed vocabulary -- never free text describing exactly what
  -- went wrong (that's `error`), only which broad category, so
  -- dashboards/alerts can aggregate without parsing prose.
  error_classification text check (
    error_classification is null
    or error_classification in ('timeout', 'provider_4xx', 'provider_5xx', 'malformed_response', 'internal_error')
  ),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  -- The real per-logical-operation idempotency guard this table needs:
  -- a retried delivery attempting to record a second "this same
  -- (organization, workflow, triggering event) succeeded" row must be a
  -- no-op, never a duplicate cost/observability entry (Milestone 3.3
  -- Architecture Resolution Report §I/§K). NULL source_event_id (an
  -- on-demand trigger) is deliberately excluded from this constraint --
  -- Postgres unique constraints treat NULL as distinct from any other
  -- NULL, so on-demand runs are never spuriously deduplicated against
  -- each other.
  constraint workflow_runs_org_workflow_event_key
    unique (organization_id, workflow_key, source_event_id)
);

comment on table public.workflow_runs is
  'Milestone 3.3A. Minimal, Milestone-3.3-scoped observability for the Lead Enrichment workflow only -- not a generic workflow-orchestration platform. UNIQUE (organization_id, workflow_key, source_event_id) is the real per-logical-operation idempotency guard against a retried/duplicated delivery double-counting cost or observability for the same underlying trigger.';

create index workflow_runs_org_started_idx on public.workflow_runs (organization_id, started_at);
