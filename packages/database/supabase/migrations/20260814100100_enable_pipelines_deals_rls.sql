-- Milestone 2.2A: RLS + grants for pipelines/pipeline_stages/deals,
-- following the exact companies/contacts precedent
-- (20260812120100_enable_companies_contacts_rls.sql) — same policy shape,
-- same grant set, same "no DELETE, no anon" posture. No agency roll-up
-- access is added here (out of 2.2A's scope).

alter table public.pipelines enable row level security;
alter table public.pipeline_stages enable row level security;
alter table public.deals enable row level security;

-- No DELETE policy on any of the three tables — ordinary "delete" here is
-- an UPDATE setting deleted_at, never a real DELETE, matching
-- companies/contacts/public.users.

create policy pipelines_select_own on public.pipelines
  for select
  using (organization_id = current_org());

create policy pipelines_insert_own on public.pipelines
  for insert
  with check (organization_id = current_org());

create policy pipelines_update_own on public.pipelines
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

create policy pipeline_stages_select_own on public.pipeline_stages
  for select
  using (organization_id = current_org());

create policy pipeline_stages_insert_own on public.pipeline_stages
  for insert
  with check (organization_id = current_org());

create policy pipeline_stages_update_own on public.pipeline_stages
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

create policy deals_select_own on public.deals
  for select
  using (organization_id = current_org());

create policy deals_insert_own on public.deals
  for insert
  with check (organization_id = current_org());

create policy deals_update_own on public.deals
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

-- SELECT/INSERT/UPDATE only, no DELETE. TRUNCATE/REFERENCES/TRIGGER and
-- every other privilege are already denied to authenticated/anon by the
-- M1.9 default-privilege hardening (20260811100000/20260811110000, both
-- `IN SCHEMA public` — proven to correctly govern future tables, unlike
-- the function-privilege analog) for every table created after those
-- migrations, including these three — no explicit revoke needed here. No
-- grant of any kind to anon: no existing or planned flow gives anon
-- access to CRM/pipeline tables.
grant select, insert, update on public.pipelines to authenticated;
grant select, insert, update on public.pipeline_stages to authenticated;
grant select, insert, update on public.deals to authenticated;
