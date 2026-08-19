-- Milestone 2.4A: Agency roll-up read access for Deals.
-- Follows the exact agency_rollup_organizations pattern (20260807130200)
-- — this is also the literal worked example already documented in
-- docs/03-Database-Architecture.md §5 ("agency_rollup_deals"), though the
-- column set below is deliberately reviewed and narrower than that
-- illustrative `select d.*`, per this milestone's own "no select * without
-- explicit review" requirement (docs/13 Milestone 2.4A "Detailed design").
--
-- Column selection:
--   included: id, organization_id (attribution), company_id (deal-to-
--     client-company linkage — without it this view has no reportable
--     client-company attribution beyond the organization itself),
--     pipeline_id (resolvable via agency_rollup_pipelines, in scope for
--     this same milestone), amount, currency (the core revenue-visibility
--     data point — this view's entire business justification), status
--     (open/won/lost — human-readable, core reporting dimension, already
--     a trustworthy derived field per Milestone 2.2's own design),
--     expected_close_date (forecast value), created_at (sort).
--   EXCLUDED, flagged rather than silently omitted: stage_id would be an
--     UNRESOLVABLE raw UUID in this milestone's scope — no
--     agency_rollup_pipeline_stages view exists or was approved (stages
--     ride under pipelines' own permission family everywhere else in this
--     codebase, and this milestone's own approval explicitly limits
--     pipelines to "identify and label pipelines," not stages) — exposing
--     stage_id here would violate this project's own "never a raw UUID"
--     UI convention rather than provide a real label, so status (already
--     human-readable) is exposed instead. primary_contact_id excluded —
--     a personal-relationship reference not needed for aggregate revenue
--     reporting. probability, owner_id, updated_at, deleted_at excluded
--     for the same reasoning as agency_rollup_companies/agency_rollup_contacts.

create view public.agency_rollup_deals
with (security_invoker = false)
as
  select
    d.id,
    d.organization_id,
    d.company_id,
    d.pipeline_id,
    d.amount,
    d.currency,
    d.status,
    d.expected_close_date,
    d.created_at
  from public.deals d
  join public.organizations o on o.id = d.organization_id
  where o.agency_id = current_agency()
    and current_role_key() in ('agency_owner', 'agency_admin')
    and d.deleted_at is null;

comment on view public.agency_rollup_deals is
  'Milestone 2.4A. Agency-scoped, read-only roll-up of active client deals. Runs as the view owner (bypassing deals'' own single-org RLS policy by design) — access control is entirely the WHERE clause (current_agency() + role check), never deals'' base policy. Deliberately not select d.* despite docs/03-Database-Architecture.md §5''s illustrative example using that shorthand — stage_id, primary_contact_id, probability, and owner_id are excluded as either unresolvable raw identifiers or unnecessary for aggregate revenue reporting. See this migration''s own top comment for the full reviewed column set.';

revoke all on public.agency_rollup_deals from public, anon, authenticated;

grant select on public.agency_rollup_deals to authenticated;
