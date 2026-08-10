-- Retrofits membership.created event emission into
-- create_organization_with_owner() (M1.3, ADR-003) — the first real
-- domain event this platform emits (M1.7 Decision C).
--
-- Why THIS function and not create_client_organization_for_agency() or
-- create_agency_with_owner(), despite the approved plan naming
-- "organization/client-organization membership creation flows" generally:
-- create_client_organization_for_agency() deliberately creates NO
-- membership row at all (see its own migration comment — agency access to
-- a client org flows through agency_id + the roll-up view, never an
-- implicit per-org membership grant), so there is no real membership row
-- to emit an event about there. create_agency_with_owner() DOES create a
-- real membership row (agency-scoped) and would be a natural, symmetric
-- follow-up, but is deliberately left out of THIS migration to keep a
-- single, minimal, already-most-tested write path for M1.7's
-- infrastructure-proving purpose — not a signal that agency membership
-- creation is somehow less "real."
--
-- The event insert lives INSIDE this SECURITY DEFINER function body,
-- not as a second application-level round-trip, per
-- docs/02-Software-Architecture.md §5's explicit requirement: "a single
-- database function/RPC call, not two separate round-trips from
-- application code." This is what makes the atomicity guarantee
-- structural rather than a convention someone has to remember to honor at
-- every call site.

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

  update public.users set default_organization_id = v_org_id where id = p_user_id;

  -- organization_id is v_org_id (just created above, in this same
  -- transaction) — never a client-supplied value, and structurally cannot
  -- be one, since this entire function takes no organization_id parameter
  -- at all. If this insert fails, the two inserts and the update above
  -- roll back with it (proven by the chaos-injection atomicity test).
  insert into public.events (event_type, event_version, organization_id, payload)
  values (
    'membership.created',
    1,
    v_org_id,
    jsonb_build_object(
      'membership_id', v_membership_id,
      'user_id', p_user_id,
      'organization_id', v_org_id,
      'role_key', 'org_admin'
    )
  );

  return query select v_org_id, v_membership_id;
end;
$$;

comment on function public.create_organization_with_owner(text, text, uuid) is
  'Atomically creates a new organization and its first membership (as org_admin) for the calling user, and emits a membership.created event in the same transaction (M1.7). The only supported way to create an organization — never a direct client INSERT (ADR-003).';
