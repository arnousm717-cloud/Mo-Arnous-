-- Milestone 4.3 Step 1: agent_tool_calls database foundation only --
-- durable tool-call/approval-state persistence, no tool registry, no
-- executor, no real tool call, no model/provider code. Target shape per
-- docs/03-Database-Architecture.md §2.4's own "Key Columns" listing:
-- `id`, `agent_run_id`, `tool_name`, `arguments`, `result`, `status`,
-- `called_at`, `cost_usd`, `requires_human_approval`, `approval_status`.
--
-- organization_id is NOT listed in that doc cell, but the doc's own
-- Key-Columns cells are illustrative, not exhaustive -- confirmed
-- directly: `pipeline_stages`' own docs/03 cell also omits
-- organization_id, yet the real, already-accepted
-- 20260814100000_create_pipelines_deals_schema.sql migration gives
-- pipeline_stages its own organization_id column via the established
-- "two-composite-FK design" (docs/13 Milestone 2.2). `taggings`' own
-- docs/03 cell states the underlying principle explicitly: "taggings
-- carries its own organization_id (RLS has no other way to derive
-- tenancy)". That principle applies identically here: agent_tool_calls
-- has no direct FK to public.organizations at all (only to agent_runs),
-- so an ordinary organization_id = current_org() RLS policy -- the one
-- idiom every tenant-scoped table in this repository already uses, no
-- exists(select...)-style join policy exists anywhere in this codebase
-- to imitate instead -- requires a real organization_id column on THIS
-- table. event_deliveries is the one table in this repository that
-- legitimately has neither organization_id nor RLS, but only because it
-- is genuinely internal-only (no tenant-facing route, accessed
-- exclusively via SECURITY DEFINER functions, per its own migration's
-- M1.7 scope note) -- agent_tool_calls does not fit that profile: it is
-- explicitly meant to be Staff-observable (05-AI-Agent-Architecture.md
-- §8's own monitoring requirements), so ordinary RLS-governed reads are
-- expected for it, unlike event_deliveries.
--
-- Adds `unique (organization_id, id)` to the already-accepted
-- agent_runs table -- purely additive (no existing column/constraint/
-- policy/grant touched, the 20260910090000 migration file itself is
-- unmodified), required so the composite FK below has a valid target,
-- mirroring exactly how `pipelines` itself gained the identical
-- constraint "so pipeline_stages'/deals' own composite FKs below have a
-- composite unique target to reference... not needed for pipelines' own
-- use otherwise, since id alone is already unique" (that migration's own
-- comment, verbatim reasoning reused here).

alter table public.agent_runs
  add constraint agent_runs_org_id_unique unique (organization_id, id);

create table public.agent_tool_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_run_id uuid not null,
  -- Static, code-defined identifier -- same discipline as
  -- agent_runs.agent_key/workflow_runs.workflow_key: never looked up or
  -- constructed from a database column or caller input. No DB-level
  -- allowlist here either; the Tool Registry that would define one does
  -- not exist yet (M4.3 Step 2+, explicitly out of scope for this step).
  tool_name text not null,
  -- What the tool was called with. Not null: a row is only ever created
  -- once a call is actually attempted, matching agent_runs.input's own
  -- "always present from insertion" discipline.
  arguments jsonb not null,
  -- What the tool returned. Nullable: a row transitions from "called"
  -- (arguments known, result not yet) to "resolved" (result populated),
  -- the same progressive-population pattern agent_runs.completed_at/
  -- error already establish for that table's own lifecycle.
  result jsonb,
  -- No closed vocabulary is frozen anywhere in this repository for this
  -- column (confirmed by repository-wide search across every doc) --
  -- unlike approval_status below, whose four values ARE explicitly
  -- frozen (docs/03 §2.4's own cell). docs/05-AI-Agent-Architecture.md
  -- §7 only establishes that a tool call can fail ("a tool timeout/error
  -- is surfaced to the model as a tool result"), never a specific string
  -- value for either outcome. Deliberately no CHECK constraint here --
  -- inventing one would be exactly the kind of unevidenced authority
  -- this milestone's own discipline (carried over from M4.2 Step 3)
  -- forbids. Same free-text treatment as agent_runs.agent_key/
  -- workflow_runs.workflow_key for the identical "no frozen vocabulary
  -- yet" reason. A future step that actually builds the Tool Registry/
  -- executor is the correct place to freeze and add this constraint,
  -- once real call outcomes are known.
  status text not null,
  called_at timestamptz not null default now(),
  -- Nullable, unconstrained precision -- exactly matching the existing
  -- company_enrichment.cost_usd/contact_enrichment.cost_usd/
  -- workflow_runs.cost_usd precedent verbatim (not every tool call has a
  -- knowable/applicable cost, e.g. a read-only Brain query).
  cost_usd numeric,
  requires_human_approval boolean not null,
  approval_status text not null default 'n/a' check (approval_status in ('n/a', 'pending', 'confirmed', 'discarded')),
  -- Tenant-safety half of the two-composite-FK design (mirroring
  -- pipeline_stages_pipeline_org_fk/taggings_tag_org_fk exactly):
  -- structurally proves agent_run_id belongs to this row's own
  -- organization, independent of RLS or application-layer correctness.
  -- ON DELETE CASCADE: a tool-call record has no meaningful existence
  -- without its parent run, matching pipeline_stages' own reasoning for
  -- the identical choice. In ordinary operation this never fires --
  -- agent_runs has no DELETE grant/policy (Step 1, unchanged) -- this is
  -- a structural safety net for a privileged/administrative hard delete
  -- only.
  constraint agent_tool_calls_run_org_fk
    foreign key (organization_id, agent_run_id)
    references public.agent_runs (organization_id, id)
    on delete cascade
);

comment on table public.agent_tool_calls is
  'Milestone 4.3 Step 1 -- durable tool-call/approval-state persistence only, no tool registry, executor, model/provider code, or real tool call. organization_id is denormalized (not listed in docs/03 §2.4''s own illustrative Key-Columns cell, but required for ordinary RLS -- see this migration''s own header comment) and structurally tied to agent_run_id via a composite FK, the same "two-composite-FK design" pipeline_stages/taggings already established. arguments/result MAY eventually carry real, non-reference CRM content once a real tool executor exists (M4.3 Step 2+) -- deliberately NOT assumed reference-only the way agent_runs.input is; GDPR retention-policy/erasure-cascade registration is deliberately deferred to whichever step first writes real content through this table, since freezing a cascade now, before any real tool wires a specific entity-reference shape into arguments/result, would be guessing at an undefined data shape rather than deriving it from evidence. This table currently has no code path capable of writing anything but test-fixture data.';

comment on column public.agent_tool_calls.organization_id is
  'Denormalized from agent_runs.organization_id, structurally enforced via the agent_tool_calls_run_org_fk composite FK -- required because RLS has no other way to derive tenancy for this table (same principle taggings.organization_id''s own docs/03 note states verbatim).';

comment on column public.agent_tool_calls.status is
  'Free text, deliberately no CHECK constraint -- no closed vocabulary for tool-call status is frozen anywhere in this repository''s documentation (confirmed by repository-wide search). A future step that builds the real Tool Registry/executor is the correct place to freeze and enforce one, once real call outcomes are known.';

comment on column public.agent_tool_calls.approval_status is
  'Closed vocabulary frozen by docs/03-Database-Architecture.md §2.4''s own Key-Columns cell verbatim: n/a (the tool does not require approval), pending (a requires_human_approval call awaiting a human confirm/discard), confirmed, discarded. Defaults to n/a -- correct for the common case (a non-approval-gated tool call), never requiring the caller to know its own tool''s approval-gating status just to insert a row.';

-- High-volume append-only table (docs/03-Database-Architecture.md §4
-- explicitly names agent_tool_calls in this category, alongside
-- visitor_events/audit_logs/events) -- indexes on (organization_id,
-- called_at), matching that section's own stated convention exactly,
-- plus a lookup index on the parent run for the obvious "show me this
-- run's own tool calls" access pattern.
create index agent_tool_calls_org_called_at_idx on public.agent_tool_calls (organization_id, called_at);
create index agent_tool_calls_agent_run_id_idx on public.agent_tool_calls (agent_run_id);

alter table public.agent_tool_calls enable row level security;

-- Ordinary RLS-scoped SELECT/INSERT/UPDATE -- identical shape to
-- agent_runs' own policies (20260910090000). No DELETE grant: tool-call
-- records are never removed by application code, same discipline as
-- every other append-only/history table in this codebase.
create policy agent_tool_calls_select_own on public.agent_tool_calls
  for select
  using (organization_id = current_org());

create policy agent_tool_calls_insert_own on public.agent_tool_calls
  for insert
  with check (organization_id = current_org());

create policy agent_tool_calls_update_own on public.agent_tool_calls
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

grant select, insert, update on public.agent_tool_calls to authenticated;
