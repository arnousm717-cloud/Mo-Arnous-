-- Resolves "which agency is this logged-in user acting as" — the
-- agency-scoped counterpart to get_my_membership_context() (M1.3), kept as
-- a dedicated function rather than overloading that one, per ADR-005: the
-- two contexts answer different questions (what org am I in right now vs.
-- what agency do I belong to) and should never be conflated into one
-- ambiguous return shape.
--
-- Same bootstrapping problem ADR-003 solved for signup and M1.3 solved
-- again for get_my_membership_context(): resolving current_agency() means
-- querying memberships, but memberships' own RLS would need current_agency()
-- already set. A SECURITY DEFINER function scoped to auth.uid() internally
-- (never an externally-supplied parameter) sidesteps this safely, because
-- it only ever returns the calling user's own agency membership rows, never
-- an arbitrary one — this is also what makes it impossible to spoof: there
-- is no parameter to pass a different agency_id into.

create or replace function public.get_my_agency_context()
returns table (
  agency_id uuid,
  role_key text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    return;
  end if;

  return query
    select m.agency_id, r.key
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.user_id = v_user_id
      and m.agency_id is not null
      and m.status = 'active';
end;
$$;

comment on function public.get_my_agency_context() is
  'Returns the calling user''s active agency membership(s) (agency_id, role_key), or zero rows if they have none. Deliberately separate from get_my_membership_context() (ADR-005) — a user with both an agency-level and organization-level membership gets both resolved independently, not merged into one ambiguous row.';

grant execute on function public.get_my_agency_context() to authenticated;
