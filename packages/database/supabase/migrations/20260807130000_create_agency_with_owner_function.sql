-- Atomic agency + first-membership creation (M1.4 backend checkpoint,
-- ADR-005). Mirrors create_organization_with_owner() (ADR-003, M1.3)
-- exactly: a plain client-issued INSERT ... RETURNING cannot satisfy RLS's
-- SELECT-for-RETURNING requirement for a row that doesn't exist yet, so
-- this runs privileged and returns the new ids directly.
--
-- Deliberately does NOT create any organization — ADR-005 rejected the
-- "home organization" option specifically to avoid a fake org existing
-- solely to hold the owner's membership row. The owner's identity is
-- entirely represented by the new agency-scoped membership row this
-- function creates (memberships.agency_id set, organization_id null).

create or replace function public.create_agency_with_owner(
  p_agency_name text,
  p_agency_slug text,
  p_user_id uuid
)
returns table (agency_id uuid, membership_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agency_id uuid;
  v_membership_id uuid;
  v_agency_owner_role_id uuid;
begin
  -- Bypasses RLS entirely (SECURITY DEFINER), so it must enforce its own
  -- authorization: a caller may only create an agency owned by themselves,
  -- never on behalf of an arbitrary user id (same rule as
  -- create_organization_with_owner()).
  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'p_user_id must match the authenticated caller';
  end if;

  select id into v_agency_owner_role_id from public.roles where key = 'agency_owner';

  insert into public.agencies (name, slug)
  values (p_agency_name, p_agency_slug)
  returning id into v_agency_id;

  insert into public.memberships (user_id, agency_id, role_id, status)
  values (p_user_id, v_agency_id, v_agency_owner_role_id, 'active')
  returning id into v_membership_id;

  return query select v_agency_id, v_membership_id;
end;
$$;

comment on function public.create_agency_with_owner(text, text, uuid) is
  'Atomically creates a new agency and its first membership (as agency_owner) for the calling user. No organization is created — the owner''s identity lives entirely in the agency-scoped membership row (ADR-005). The only supported way to create an agency — never a direct client INSERT, same RETURNING/RLS bootstrapping problem ADR-003 identified.';

grant execute on function public.create_agency_with_owner(text, text, uuid) to authenticated;
