-- Atomic organization + first-membership creation (docs/12-Implementation-Milestones.md M1.3, ADR-003).
--
-- ADR-003 found that a plain client-issued INSERT ... RETURNING cannot
-- satisfy this: Postgres requires the SELECT policy to also pass for
-- RETURNING, and a brand-new organization's id can never match
-- id = current_org() yet. A SECURITY DEFINER function sidesteps this by
-- performing the creation in a privileged context and returning the new
-- ids directly, not via a client-facing RLS-constrained INSERT.

create or replace function public.create_organization_with_owner(
  p_org_name text,
  p_org_slug text,
  p_user_id uuid
)
returns table (organization_id uuid, membership_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_membership_id uuid;
  v_org_admin_role_id uuid;
begin
  -- This function bypasses RLS entirely (that's what SECURITY DEFINER means),
  -- so it must enforce its own authorization rather than relying on RLS to
  -- have done it: a caller may only create an organization owned by
  -- themselves, never on behalf of an arbitrary user id.
  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'p_user_id must match the authenticated caller';
  end if;

  select id into v_org_admin_role_id from public.roles where key = 'org_admin';

  insert into public.organizations (name, slug)
  values (p_org_name, p_org_slug)
  returning id into v_org_id;

  insert into public.memberships (user_id, organization_id, role_id, status)
  values (p_user_id, v_org_id, v_org_admin_role_id, 'active')
  returning id into v_membership_id;

  -- Without this, get_my_membership_context() (next migration) has nothing
  -- to resolve for a user who just signed up — default_organization_id is
  -- what makes "the org this user is acting as" resolvable at all for the
  -- very first request after signup.
  update public.users set default_organization_id = v_org_id where id = p_user_id;

  return query select v_org_id, v_membership_id;
end;
$$;

comment on function public.create_organization_with_owner(text, text, uuid) is
  'Atomically creates a new organization and its first membership (as org_admin) for the calling user. The only supported way to create an organization — never a direct client INSERT, which cannot satisfy RLS''s RETURNING requirement for a not-yet-existing row (ADR-003).';

grant execute on function public.create_organization_with_owner(text, text, uuid) to authenticated;
