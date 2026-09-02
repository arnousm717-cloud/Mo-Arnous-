-- Milestone 3.3A: RLS for workflow_runs -- companion to the schema
-- migration, matching the established schema-then-RLS precedent.

alter table public.workflow_runs enable row level security;

-- Ordinary RLS-scoped SELECT/INSERT/UPDATE -- same reasoning as
-- contact_enrichment/company_enrichment's own RLS migration: the
-- writer already has a real, resolved organization_id by the time it
-- writes here, no SECURITY DEFINER bypass needed. SELECT lets staff see
-- their own organization's automation history (docs/06-n8n-Workflow-
-- Architecture.md §1's own stated purpose for this table). No DELETE
-- grant -- runs are never removed by application code.
create policy workflow_runs_select_own on public.workflow_runs
  for select
  using (organization_id = current_org());

create policy workflow_runs_insert_own on public.workflow_runs
  for insert
  with check (organization_id = current_org());

create policy workflow_runs_update_own on public.workflow_runs
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

grant select, insert, update on public.workflow_runs to authenticated;
