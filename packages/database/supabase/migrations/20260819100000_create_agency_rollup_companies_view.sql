-- Milestone 2.4A: Agency roll-up read access for Companies.
-- Follows the exact, proven agency_rollup_organizations pattern
-- (20260807130200_agency_rollup_organizations_view.sql) — see that
-- migration and docs/03-Database-Architecture.md §5 for the full
-- rationale, not repeated here. Never implemented as "agency role
-- bypasses companies' own RLS" — a separate, named, read-only view
-- instead, structurally isolated from companies_select_own so a bug in
-- that base policy can never silently leak cross-client data through
-- this path.
--
-- Column selection is deliberate, not `select c.*` — reviewed explicitly
-- per column (docs/13 Milestone 2.4A "Detailed design"):
--   included: id, organization_id (attribution), name (identify), domain,
--     industry, employee_count, annual_revenue (firmographic — companies'
--     own table comment already establishes this is "not personal data
--     of a natural person", so no PII-minimization concern applies here
--     the way it does for contacts), created_at (sort).
--   excluded: linkedin_url/enrichment_status (no established roll-up
--     need), owner_id (a raw UUID with no cross-org resolution mechanism
--     in this milestone's scope — rendering it would violate this
--     project's own "never a raw UUID" UI convention), updated_at,
--     deleted_at (filtered in the WHERE clause below instead of exposed
--     as a column — a read-only roll-up view has no use for soft-delete
--     state).
--
-- security_invoker = false is required, not incidental: companies_select_own
-- scopes to exactly one organization per request by design, so it can
-- never satisfy a query that needs to see every client company under an
-- agency at once. Running as the view owner is what makes that possible
-- at all — the WHERE clause below is therefore the entire access-control
-- boundary for this path, not a supplement to companies' base policy, and
-- must never be loosened without the same scrutiny as a base RLS policy
-- change.

create view public.agency_rollup_companies
with (security_invoker = false)
as
  select
    c.id,
    c.organization_id,
    c.name,
    c.domain,
    c.industry,
    c.employee_count,
    c.annual_revenue,
    c.created_at
  from public.companies c
  join public.organizations o on o.id = c.organization_id
  where o.agency_id = current_agency()
    and current_role_key() in ('agency_owner', 'agency_admin')
    and c.deleted_at is null;

comment on view public.agency_rollup_companies is
  'Milestone 2.4A. Agency-scoped, read-only roll-up of active (non-soft-deleted) client companies. Runs as the view owner (bypassing companies'' own single-org RLS policy by design) — access control is entirely the WHERE clause (current_agency() + role check), never companies'' base policy. Deliberately not select c.* — see this migration''s own top comment for the reviewed column set. See docs/03-Database-Architecture.md §5 and the agency_rollup_organizations precedent (20260807130200).';

-- Defensive and explicit, not relying solely on the already-safe
-- ALTER DEFAULT PRIVILEGES baseline (20260811110000) — that migration's
-- own incident is exactly why this view's safety must never depend on a
-- later migration alone. Revoking privileges that were never granted is
-- a no-op; this line costs nothing and removes any doubt.
revoke all on public.agency_rollup_companies from public, anon, authenticated;

-- Read-only by design, matching agency_rollup_organizations exactly —
-- SELECT only. No INSERT/UPDATE/DELETE grant exists, has ever existed, or
-- should ever be added: a view's WHERE clause filters SELECT/UPDATE/DELETE
-- but never INSERT (the exact mechanism the 20260811110000 incident
-- exploited on agency_rollup_organizations) — the grant itself, not the
-- WHERE clause, is what makes this view safe against that class of bug.
grant select on public.agency_rollup_companies to authenticated;
