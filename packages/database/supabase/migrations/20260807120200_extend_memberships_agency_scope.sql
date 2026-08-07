-- Agency-level membership model (M1.4 foundation, ADR-005).
--
-- memberships previously required organization_id on every row, making it
-- impossible to represent a pure agency_owner/agency_admin without inventing
-- a fake organization for them to belong to — which would contradict
-- roles.description's own "agency-wide, not scoped to one org" framing of
-- those two roles. This migration makes organization_id nullable, adds a
-- nullable agency_id, and enforces via CHECK that every row is scoped to
-- exactly one of the two — never both, never neither. See ADR-005 for the
-- full rationale and the alternatives considered.

alter table public.memberships
  alter column organization_id drop not null;

alter table public.memberships
  add column agency_id uuid references public.agencies (id) on delete cascade;

alter table public.memberships
  add constraint memberships_exactly_one_scope
  check (
    (organization_id is not null and agency_id is null)
    or
    (organization_id is null and agency_id is not null)
  );

-- Mirrors the existing unique (user_id, organization_id): Postgres treats
-- NULL as distinct from NULL in unique constraints, so an org-scoped row
-- (agency_id null) never collides with this, and an agency-scoped row
-- (organization_id null) never collides with the existing one either —
-- the two constraints only ever apply within their own scope.
alter table public.memberships
  add constraint memberships_user_agency_unique unique (user_id, agency_id);

create index memberships_agency_id_idx on public.memberships (agency_id);

comment on column public.memberships.organization_id is
  'Set for organization-scoped roles (org_admin/org_member/org_viewer/portal_customer). NULL for agency-scoped rows — see memberships_exactly_one_scope (ADR-005).';

comment on column public.memberships.agency_id is
  'Set for agency-scoped roles (agency_owner/agency_admin). NULL for organization-scoped rows — see memberships_exactly_one_scope (ADR-005).';

-- Deliberately NOT adding a new RLS policy for agency-scoped rows here.
-- The existing memberships_tenant_isolation_select/_write policies
-- (organization_id = current_org()) already correctly exclude agency-scoped
-- rows by construction — NULL never equals current_org() — so ordinary
-- authenticated access to agency-scoped membership rows remains
-- structurally impossible until a deliberate policy is added alongside the
-- agency-creation function (a later M1.4 step), the same safe-default-
-- absence pattern already used for the agencies table itself since M1.2.
