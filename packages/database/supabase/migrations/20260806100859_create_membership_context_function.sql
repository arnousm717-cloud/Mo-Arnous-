-- Resolves "which organization is this logged-in user acting as" — the
-- first thing every authenticated request needs before withTenantContext()
-- can be called (docs/03-Database-Architecture.md §5, ADR-004).
--
-- This has the same bootstrapping problem ADR-003 solved for signup: the
-- memberships RLS policy requires current_org() to already be set, but
-- resolving current_org() in the first place means querying memberships —
-- chicken-and-egg. A SECURITY DEFINER function scoped to auth.uid()
-- internally (never an externally-supplied parameter) sidesteps this the
-- same way, safely, because it only ever returns the calling user's own
-- context, never an arbitrary one.

create or replace function public.get_my_membership_context()
returns table (
  organization_id uuid,
  agency_id uuid,
  role_key text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
begin
  if v_user_id is null then
    return;
  end if;

  select u.default_organization_id into v_org_id
  from public.users u
  where u.id = v_user_id;

  if v_org_id is null then
    return;
  end if;

  return query
    select o.id, o.agency_id, r.key
    from public.organizations o
    join public.memberships m
      on m.organization_id = o.id
     and m.user_id = v_user_id
     and m.status = 'active'
    join public.roles r on r.id = m.role_id
    where o.id = v_org_id;
end;
$$;

comment on function public.get_my_membership_context() is
  'Returns the calling user''s active organization/agency/role, or zero rows if they have no default organization or no active membership there — the caller (application middleware) is expected to handle the empty case, e.g. by routing to an onboarding flow.';

grant execute on function public.get_my_membership_context() to authenticated;
