-- Agency roll-up access for organizations (M1.4 backend checkpoint,
-- docs/03-Database-Architecture.md §5's documented pattern, first real
-- implementation of it).
--
-- Never implemented as "agency role bypasses organizations' own RLS" — a
-- separate, named, read-only view instead, exactly as docs/03 §5 specifies
-- for agency_rollup_deals. This keeps the blanket cross-org read path
-- explicit, named, and auditable: a bug in organizations_select_own can
-- never silently leak cross-client data, because this roll-up path is
-- structurally separate from it.
--
-- Security-relevant: views run with the privileges of their OWNER by
-- default (not the querying role) unless declared security_invoker — this
-- is deliberate here, not an oversight. organizations_select_own
-- (id = current_org()) is scoped to exactly one organization per request by
-- design, so it can never satisfy a roll-up query that needs to see every
-- client org under an agency at once; running as the view owner is what
-- lets this view read across organizations at all. The view's own WHERE
-- clause — current_agency() plus the explicit role check — is therefore
-- the entire access-control boundary for this path, not a supplement to
-- organizations' base policy. That WHERE clause must never be loosened
-- without equal scrutiny to a base RLS policy change.

create view public.agency_rollup_organizations
with (security_invoker = false)
as
  select o.*
  from public.organizations o
  where o.agency_id = current_agency()
    and current_role_key() in ('agency_owner', 'agency_admin');

comment on view public.agency_rollup_organizations is
  'Agency-scoped read-only roll-up of client organizations. Runs as the view owner (bypassing organizations'' own single-org RLS policy by design) — access control is entirely the WHERE clause (current_agency() + role check), never organizations'' base policy. See docs/03-Database-Architecture.md §5 and ADR-005.';

grant select on public.agency_rollup_organizations to authenticated;
