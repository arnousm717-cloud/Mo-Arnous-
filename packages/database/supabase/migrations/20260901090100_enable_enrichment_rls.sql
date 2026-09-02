-- Milestone 3.3A: RLS for contact_enrichment / company_enrichment --
-- companion to the schema migration, matching the established
-- schema-then-RLS precedent.

alter table public.contact_enrichment enable row level security;
alter table public.company_enrichment enable row level security;

-- Ordinary RLS-scoped SELECT/INSERT/UPDATE, deliberately NOT a
-- SECURITY DEFINER bypass -- the service-authenticated write-back path
-- (Milestone 3.3E) already has a real, resolved organization_id (derived
-- exclusively from the matched api_keys row, Milestone 3.3B) by the time
-- it writes here, and connects via withTenantContext like every other
-- authenticated-role write in this codebase. This mirrors
-- visitor_identifications' own corrected-during-3.2C precedent exactly:
-- a bypass-RLS function is only needed when the caller does NOT yet have
-- organization_id available, which is never true by the time this table
-- is written to.
--
-- No DELETE grant on either table -- rows are removed only via their own
-- ON DELETE CASCADE FK when the subject contact/company is deleted,
-- never by direct application code.
create policy contact_enrichment_select_own on public.contact_enrichment
  for select
  using (organization_id = current_org());

create policy contact_enrichment_insert_own on public.contact_enrichment
  for insert
  with check (organization_id = current_org());

create policy contact_enrichment_update_own on public.contact_enrichment
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

grant select, insert, update on public.contact_enrichment to authenticated;

create policy company_enrichment_select_own on public.company_enrichment
  for select
  using (organization_id = current_org());

create policy company_enrichment_insert_own on public.company_enrichment
  for insert
  with check (organization_id = current_org());

create policy company_enrichment_update_own on public.company_enrichment
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

grant select, insert, update on public.company_enrichment to authenticated;
