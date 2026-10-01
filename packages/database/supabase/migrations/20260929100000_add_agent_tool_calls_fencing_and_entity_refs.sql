-- Milestone 4.3 Step 2B: agent_tool_calls attempt-fencing schema support
-- plus agent_tool_call_entity_refs -- schema/RLS/retention only, no
-- executor, no repository persistence primitive, no application writer.
-- The Step-2 design audit's own §3/§4 live-proved (real, reproducible
-- concurrent-transaction test against local Postgres) that a future
-- INSERT ... SELECT ... WHERE attempt_count = $N AND status = 'running'
-- persistence primitive is NOT sufficient on its own to close a reclaim
-- race -- a stale worker's naive INSERT...SELECT can still succeed while a
-- concurrent reclaim is in-flight (uncommitted). The closing primitive
-- (SELECT ... FOR SHARE on the joined agent_runs row) is documented here
-- as the frozen future contract; implementing it is explicitly Step 2D's
-- concern, not this one's. This migration adds only the column that
-- primitive will read, never the primitive itself.
--
-- FUTURE STEP-2D PERSISTENCE PRIMITIVE (frozen design, not implemented
-- here):
--
--   insert into public.agent_tool_calls
--     (organization_id, agent_run_id, tool_name, arguments, status,
--      requires_human_approval, attempt_count)
--   select ar.organization_id, ar.id, $toolName, $arguments, $status,
--          $requiresHumanApproval, ar.attempt_count
--   from public.agent_runs ar
--   where ar.id = $agentRunId
--     and ar.organization_id = $organizationId
--     and ar.attempt_count = $expectedAttemptCount
--     and ar.status = 'running'
--   for share;
--
-- `status = 'running'` is required, not optional: completeAgentRun/
-- failAgentRun never change attempt_count on success/failure, only status
-- -- without this predicate a straggling tool-call write from an already-
-- finalized attempt could still attach itself to a completed run, since
-- its attempt_count number would still match. `for share` is required,
-- not optional: without it, this exact statement raced against a
-- concurrent claimAgentRun reclaim (real test, see the Step-2B design
-- audit) inserted a tool-call row for an already-superseded generation --
-- `for share` forces the statement to wait for any concurrent reclaim on
-- that row to commit first, then correctly re-evaluates against the new
-- attempt_count. The inserted attempt_count is read directly from the
-- joined agent_runs row (ar.attempt_count), never re-passed as a separate
-- trusted literal, so it can never drift from what the WHERE clause just
-- proved.
--
-- If PostgreSQL syntax requires a different placement of the locking
-- clause once this is actually implemented against a real multi-table
-- INSERT ... SELECT ... FROM ... JOIN shape (Step 2D will have more than
-- one source table once tool-call arguments reference entities), that is
-- Step 2D's own concern to resolve and re-verify live -- this comment
-- documents the requirement (an explicit row lock on the read side of the
-- gate, not predicates alone), not a syntax guarantee for every future
-- query shape.

-- Represents the agent_runs.attempt_count value that was CURRENT at the
-- moment this tool call was persisted -- a write-time snapshot of the
-- run's own generation number, not an independently meaningful counter.
-- default 1: required by Postgres for any existing row (this table has no
-- production writer -- Step 1/2A ship none -- so the only rows any real
-- environment could have are committed test fixtures, which this default
-- backfills harmlessly as "assume first attempt"); matches
-- agent_runs.attempt_count's own default verbatim. No index: this column
-- only ever participates in the future write-time gate above, never an
-- independent read filter -- the two existing indexes already cover this
-- table's real, docs/03 §4-specified access patterns. No uniqueness: many
-- tool calls legitimately share one attempt. No FK to
-- agent_runs.attempt_count: Postgres FKs enforce existence in a
-- referenced table, never equality with another row's currently-mutable
-- column -- the future INSERT...SELECT...FOR SHARE primitive above is the
-- real enforcement mechanism, not a schema constraint.
alter table public.agent_tool_calls
  add column attempt_count integer not null default 1 check (attempt_count > 0);

comment on column public.agent_tool_calls.attempt_count is
  'Snapshot of agent_runs.attempt_count at the moment this row was persisted -- the fencing/generation token proving which run attempt this tool call belongs to. Populated by reading agent_runs.attempt_count directly inside the same atomic INSERT...SELECT...FOR SHARE gate a future Step 2D persistence primitive uses (see this migration''s own header comment for the frozen design), never independently incremented or trusted from a separate caller-supplied literal.';

-- Required so agent_tool_call_entity_refs' own composite tenant-safety FK
-- below has a composite unique target to reference -- the same prerequisite
-- Step 1 itself already needed and added to agent_runs
-- (agent_runs_org_id_unique), for the identical reason: `id` alone is
-- already globally unique via the primary key, so this can never fail
-- against any existing data, and is not needed for agent_tool_calls' own
-- use otherwise.
alter table public.agent_tool_calls
  add constraint agent_tool_calls_org_id_unique unique (organization_id, id);

-- agent_tool_call_entity_refs: junction table recording which CRM
-- entities a given agent_tool_calls row's arguments/result actually
-- concern -- the structural GDPR prerequisite the Step-1 acceptance audit
-- required before any real tool-call writer ships (docs/10-CLAUDE.md's
-- own standing rule: "any new table holding personal data must be added
-- to the relevant data_retention_policies entry... as part of the same PR
-- that introduces the table"). Mirrors brain_embedding_entity_refs
-- (20260905090100) exactly -- the established, already-accepted, already-
-- adversarially-tested precedent for "a shared artifact may contain more
-- than one entity's data" -- rather than inventing a new shape. Reuses
-- the full, existing {contact, company, deal} EntityType vocabulary
-- (packages/brain's own canonical type, already reused by
-- packages/ai-agents' validateAgentRunReferences) verbatim, even though
-- Step 2C/D initially wires only crm.get_contact/crm.get_deal -- every
-- existing entity-ref table in this repository always carries the full
-- three-way vocabulary as one indivisible unit; a partial vocabulary
-- would itself be a more speculative, unprecedented design than reusing
-- the established whole. The absent company-tool today is a future
-- executor scope boundary, not a schema boundary.
create table public.agent_tool_call_entity_refs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tool_call_id uuid not null,
  entity_type text not null check (entity_type in ('contact', 'company', 'deal')),
  contact_id uuid,
  company_id uuid,
  deal_id uuid,
  created_at timestamptz not null default now(),
  constraint agent_tool_call_entity_refs_entity_match check (
    (entity_type = 'contact' and contact_id is not null and company_id is null and deal_id is null)
    or (entity_type = 'company' and company_id is not null and contact_id is null and deal_id is null)
    or (entity_type = 'deal' and deal_id is not null and contact_id is null and company_id is null)
  ),
  -- Tenant-safety half of the two-composite-FK design, mirroring
  -- brain_embedding_entity_refs_embedding_org_fk exactly: structurally
  -- proves tool_call_id belongs to this row's own organization,
  -- independent of RLS or application-layer correctness. ON DELETE
  -- CASCADE: a ref has no meaningful existence without its parent tool
  -- call -- deleting the tool call (e.g. the future contact-erasure
  -- extension below) removes its own refs for free, no separate cleanup
  -- statement needed.
  constraint agent_tool_call_entity_refs_tool_call_org_fk
    foreign key (organization_id, tool_call_id)
    references public.agent_tool_calls (organization_id, id)
    on delete cascade,
  -- One composite tenant-safe FK per entity kind, each ON DELETE CASCADE
  -- -- identical shape to brain_embedding_entity_refs_contact_org_fk/
  -- _company_org_fk/_deal_org_fk. A hard-erased contact/company/deal
  -- removes its own refs structurally; for contacts specifically, the
  -- companion erasure-function migration additionally captures and
  -- deletes the entire linked agent_tool_calls row before this FK's own
  -- cascade would otherwise merely remove the ref and leave the
  -- PII-bearing parent row behind.
  constraint agent_tool_call_entity_refs_contact_org_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id)
    on delete cascade,
  constraint agent_tool_call_entity_refs_company_org_fk
    foreign key (organization_id, company_id)
    references public.companies (organization_id, id)
    on delete cascade,
  constraint agent_tool_call_entity_refs_deal_org_fk
    foreign key (organization_id, deal_id)
    references public.deals (organization_id, id)
    on delete cascade
);

comment on table public.agent_tool_call_entity_refs is
  'Milestone 4.3 Step 2B. Junction table: which CRM entities a given agent_tool_calls row''s arguments/result concern (a tool call may reference more than one entity via more than one row here). Mirrors brain_embedding_entity_refs exactly. No application writer exists yet -- this migration is schema/RLS/retention only; a future Step 2C/D executor is the first real writer. Each ref is ON DELETE CASCADE to its owning contact/company/deal; execute_contact_erasure() (see the companion migration) additionally captures every agent_tool_calls id linked to the target contact before that cascade fires and deletes those rows in full -- a shared tool call is never kept just because a company/deal ref on it also survives, matching the Brain precedent''s own privacy-over-preservation reasoning exactly. Append-only: no UPDATE grant/policy, no ordinary DELETE grant/policy -- rows are removed only via ON DELETE CASCADE (from either the parent tool call or the referenced entity) or the trusted SECURITY DEFINER erasure path.';

-- Deduplication -- the same (tool call, entity) pair can never be recorded
-- twice, one partial unique index per entity kind, mirroring
-- brain_embedding_entity_refs_contact_uidx/_company_uidx/_deal_uidx
-- exactly.
create unique index agent_tool_call_entity_refs_contact_uidx on public.agent_tool_call_entity_refs (tool_call_id, contact_id) where contact_id is not null;
create unique index agent_tool_call_entity_refs_company_uidx on public.agent_tool_call_entity_refs (tool_call_id, company_id) where company_id is not null;
create unique index agent_tool_call_entity_refs_deal_uidx on public.agent_tool_call_entity_refs (tool_call_id, deal_id) where deal_id is not null;

-- Tenant-scoped access index -- matches
-- brain_embedding_entity_refs_org_idx's own convention. No speculative
-- indexes beyond this and the three dedup indexes above: this table has
-- no real access pattern evidence yet beyond "look up this tool call's
-- own refs" (already served by the dedup indexes' own leading
-- tool_call_id column) and ordinary tenant-scoped RLS filtering.
create index agent_tool_call_entity_refs_org_idx on public.agent_tool_call_entity_refs (organization_id);

alter table public.agent_tool_call_entity_refs enable row level security;

-- Append-only junction table -- SELECT + INSERT only, no UPDATE, no
-- DELETE, matching brain_embedding_entity_refs_select_own/_insert_own
-- exactly. Rows disappear only through FK CASCADE or the trusted erasure
-- function, never an ordinary authenticated DELETE.
create policy agent_tool_call_entity_refs_select_own on public.agent_tool_call_entity_refs
  for select
  using (organization_id = current_org());

create policy agent_tool_call_entity_refs_insert_own on public.agent_tool_call_entity_refs
  for insert
  with check (organization_id = current_org());

grant select, insert on public.agent_tool_call_entity_refs to authenticated;

-- Retention registration (docs/10-CLAUDE.md's own standing rule, quoted in
-- this migration's own header comment) -- platform-default, 2555 days,
-- reusing the exact figure every other personal-data-bearing table in
-- this repository already uses (contacts, activities/notes, all four
-- Brain tables) since data_retention_policies' own schema comment
-- discloses this value as a repository-wide directional placeholder, not
-- a legally reviewed duration -- reusing it is the evidence-based,
-- non-invented choice; inventing a different number here would not be.
-- agent_tool_calls itself is registered for the first time here too: it
-- did not need registration at Step 1 (no entity-reference path existed
-- yet, so nothing on that table was deterministically personal-data-
-- linked), but does now that agent_tool_call_entity_refs gives it one.
insert into public.data_retention_policies (organization_id, data_type, retention_days) values
  (null, 'agent_tool_calls', 2555),
  (null, 'agent_tool_call_entity_refs', 2555);
