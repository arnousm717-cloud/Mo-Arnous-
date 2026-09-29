-- Milestone 4.2 Step 1: agent_runs database foundation only -- durable
-- queue mechanics, no execution semantics. Mirrors workflow_runs' own
-- shape and precedent (20260901090200/20260901090300) wherever this
-- table's own concept genuinely matches it; deviates only where the
-- accepted M4.2 design freeze explicitly requires a difference (this
-- table's own 'queued' initial status, its dedicated agent_key
-- identifier instead of a not-yet-existing agent_definition_id FK, and
-- its own attempt_count/backoff-ready shape built in from day one
-- instead of retrofitted under audit pressure the way both
-- event_deliveries and workflow_runs' own lease columns were).
--
-- No claim/lease/retry SQL, no RBAC permission, no route, no cron --
-- those are later M4.2 steps. This migration only proves the table
-- exists, is tenant-safe, and is GDPR-correct by construction.

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Static, code-defined identifier, same discipline as
  -- workflow_runs.workflow_key/event_deliveries.consumer -- never looked
  -- up or constructed from a database column or caller input. The
  -- future persona/agent-definition allowlist deliberately lives in
  -- application code, not a DB CHECK, for the identical reason
  -- workflow_key has none: new agent keys will ship without a migration,
  -- exactly like new workflow_key values already do.
  agent_key text not null,
  -- Who/what caused this run to be enqueued. References the acting
  -- STAFF user, not a data subject -- same concept and same GDPR
  -- handling as audit_logs.actor_user_id (20260810100000): ON DELETE SET
  -- NULL, because this row is itself a legitimate historical/operational
  -- record that must survive the erasure of the person who triggered it,
  -- never a live pointer that erasure needs to cascade through.
  triggered_by uuid references public.users (id) on delete set null,
  -- References/IDs only, never copied CRM content -- the same
  -- ID-minimized-payload discipline already established for every Brain
  -- webhook payload and workflow_runs.contact_id. No structured entity
  -- FK exists on this table (deliberately -- that is M4.3/agent_tool_
  -- calls' own concern once real tool execution exists), so this jsonb
  -- column carries no deterministic, database-enforceable personal-data
  -- linkage, mirroring the exact reasoning brain_knowledge_documents.
  -- content_text already established for why a column can hold
  -- unstructured content yet still correctly sit outside the erasure
  -- cascade (03-Database-Architecture.md §2.9's own Category-B-style
  -- note).
  input jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  -- Represents the reserved first worker attempt from the moment a row
  -- is enqueued -- default 1, not 0, exactly matching workflow_runs'
  -- own attempt_count column (20260901090200) verbatim. A later
  -- reclaim (crash recovery or a retried failure) is what increments
  -- this; the claim SQL that does so is explicitly out of scope for
  -- this migration and this step.
  attempt_count integer not null default 1 check (attempt_count > 0),
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

comment on table public.agent_runs is
  'Milestone 4.2 Step 1 -- durable agent-run queue mechanics only, no execution semantics. agent_key is a static, code-defined identifier (no DB-level allowlist, matching workflow_runs.workflow_key). triggered_by is ON DELETE SET NULL (matches audit_logs.actor_user_id) -- this row survives the erasure of the staff user who triggered it. input carries references/IDs only, never copied CRM content, and has no deterministic entity FK on this table, so it is not part of the data_subject_requests erasure cascade, the same reasoning already established for brain_knowledge_documents.content_text. Not registered in data_retention_policies for the identical reason workflow_runs itself never was: no direct, structured personal-data column exists on this table.';

comment on column public.agent_runs.agent_key is
  'Static, code-defined identifier (e.g. a future persona key) -- never looked up or constructed from a database column or caller input. Deliberately no DB CHECK/enum: new agent keys ship without a migration, matching workflow_runs.workflow_key''s own precedent exactly.';

comment on column public.agent_runs.triggered_by is
  'The staff user who caused this run to be enqueued. ON DELETE SET NULL, not CASCADE -- this row is itself a legitimate historical record, matching audit_logs.actor_user_id (20260810100000) verbatim: an entry must survive the erasure of the person who acted.';

comment on column public.agent_runs.input is
  'References/IDs only, never copied CRM content -- same ID-minimized-payload discipline as every Brain webhook payload and workflow_runs.contact_id. No structured entity FK exists on this table, so this column carries no deterministic, database-enforceable personal-data linkage.';

comment on column public.agent_runs.attempt_count is
  'Represents the reserved first worker attempt from enqueue time -- default 1, exactly matching workflow_runs.attempt_count (20260901090200). Claim/reclaim logic that increments this is out of scope for Milestone 4.2 Step 1.';

-- Tenant-scoped queue lookup + status filtering (the two access patterns
-- this step's own schema/RLS tests actually exercise). A future claim
-- query's own started_at/completed_at-based eligibility predicates are
-- covered by this same composite prefix without a second, narrower
-- index -- matching workflow_runs' own single general index
-- (organization_id, started_at) rather than speculatively adding a
-- specialized partial index ahead of real access-pattern evidence.
create index agent_runs_org_status_idx on public.agent_runs (organization_id, status);

alter table public.agent_runs enable row level security;

-- Ordinary RLS-scoped SELECT/INSERT/UPDATE -- identical shape to
-- workflow_runs' own policies (20260901090300). No DELETE grant: runs
-- are never removed by application code, same discipline as every other
-- table in this codebase that models an append/update-in-place history.
create policy agent_runs_select_own on public.agent_runs
  for select
  using (organization_id = current_org());

create policy agent_runs_insert_own on public.agent_runs
  for insert
  with check (organization_id = current_org());

create policy agent_runs_update_own on public.agent_runs
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

grant select, insert, update on public.agent_runs to authenticated;
