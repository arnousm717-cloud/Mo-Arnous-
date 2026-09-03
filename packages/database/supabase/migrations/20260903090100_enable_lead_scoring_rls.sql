-- Milestone 3.4A: RLS for lead_scores / scoring_rules -- companion to the
-- schema migration, matching the established schema-then-RLS precedent
-- (contact_enrichment/company_enrichment, workflow_runs).
--
-- Ordinary RLS-scoped grants, deliberately NOT a SECURITY DEFINER bypass
-- -- by the time anything writes to either table, organization_id is
-- already known from a trusted source: session auth (staff rule
-- management, resolveOrganizationContextForUser) or the triggering
-- event's own already-verified payload (the dispatcher's lead_scoring
-- consumer, or a direct post-enrichment recalculation call). Neither
-- write path is ever a bootstrap-identity problem the way resolve_api_key
-- or resolve_tracking_site are -- so no bypass function is introduced for
-- lead scoring, honoring the Milestone 3.4 Implementation Authorization's
-- own explicit stop condition on this exact point.

alter table public.lead_scores enable row level security;
alter table public.scoring_rules enable row level security;

-- lead_scores: SELECT + INSERT only -- historized, insert-only by design
-- (see the schema migration's own comment); there is no legitimate
-- UPDATE path at all, so none is granted. No DELETE grant -- rows are
-- removed only via their own ON DELETE CASCADE FK when the contact is
-- hard-erased, never by direct application code.
create policy lead_scores_select_own on public.lead_scores
  for select
  using (organization_id = current_org());

create policy lead_scores_insert_own on public.lead_scores
  for insert
  with check (organization_id = current_org());

grant select, insert on public.lead_scores to authenticated;

-- scoring_rules: ordinary SELECT/INSERT/UPDATE (UPDATE backs both
-- PATCH-style edits and the is_active disable/enable toggle). No DELETE
-- grant -- is_active is the sole retirement mechanism.
create policy scoring_rules_select_own on public.scoring_rules
  for select
  using (organization_id = current_org());

create policy scoring_rules_insert_own on public.scoring_rules
  for insert
  with check (organization_id = current_org());

create policy scoring_rules_update_own on public.scoring_rules
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

grant select, insert, update on public.scoring_rules to authenticated;
