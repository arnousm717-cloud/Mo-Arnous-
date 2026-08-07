-- Atomic client-organization creation under an agency (M1.4 backend
-- checkpoint). Mirrors create_organization_with_owner()'s SECURITY DEFINER
-- + auth.uid()-checked pattern (ADR-003), but the authorization check is
-- membership-based rather than identity-based: the caller isn't creating an
-- organization for themselves, they're creating one on behalf of an agency
-- they must actually belong to as agency_owner/agency_admin.

create or replace function public.create_client_organization_for_agency(
  p_org_name text,
  p_org_slug text,
  p_agency_id uuid,
  p_user_id uuid
)
returns table (organization_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_role_key text;
begin
  -- Bypasses RLS entirely (SECURITY DEFINER) — same rule as every other
  -- function in this family: the caller may only act as themselves, never
  -- an arbitrary user id.
  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'p_user_id must match the authenticated caller';
  end if;

  -- The real authorization check: does this user hold an ACTIVE
  -- agency-scoped membership in exactly this agency, with a role that's
  -- permitted to create client orgs? A caller who is agency_owner of a
  -- DIFFERENT agency, or an ordinary org-scoped user with no agency
  -- membership at all, resolves v_role_key to null here and is rejected —
  -- this is what makes cross-agency creation and ordinary-user escalation
  -- both structurally impossible, not just discouraged.
  select r.key into v_role_key
  from public.memberships m
  join public.roles r on r.id = m.role_id
  where m.user_id = p_user_id
    and m.agency_id = p_agency_id
    and m.status = 'active';

  if v_role_key is null or v_role_key not in ('agency_owner', 'agency_admin') then
    raise exception 'caller is not an active agency_owner/agency_admin of the target agency';
  end if;

  -- No membership row is created for the caller in the new organization —
  -- deliberate. Agency access to client orgs flows through agency_id plus
  -- the roll-up view (and, later, an explicit "enter as" mechanism), never
  -- through an implicit per-org membership grant at creation time
  -- (ADR-005's rejection of tying agency identity to organization rows
  -- extends to this: creating an org under an agency must not silently
  -- grant the creator standing org-level access they didn't explicitly
  -- receive).
  insert into public.organizations (name, slug, agency_id)
  values (p_org_name, p_org_slug, p_agency_id)
  returning id into v_org_id;

  return query select v_org_id;
end;
$$;

comment on function public.create_client_organization_for_agency(text, text, uuid, uuid) is
  'Atomically creates a new client organization under an agency, on behalf of a caller who must hold an active agency_owner/agency_admin membership in that exact agency. Rejects cross-agency creation and non-agency callers by construction. organizations.slug''s existing global-uniqueness constraint (M1.2) applies unchanged. See ADR-005.';

grant execute on function public.create_client_organization_for_agency(text, text, uuid, uuid) to authenticated;
