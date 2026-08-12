-- Security remediation: function EXECUTE privileges + NULL-unsafe caller
-- identity guards. Two independent, systemic root causes, found during the
-- Milestone 2.1C staging verification and confirmed empirically (both
-- locally and live on staging) before this migration was written:
--
-- ROOT CAUSE 1 — PostgreSQL grants EXECUTE on every newly-created function
-- to PUBLIC by default. No migration in this repository's history has ever
-- revoked it (the M1.9 default-privilege hardening
-- (20260811100000/20260811110000) was explicitly scoped to TABLE
-- privileges only). Confirmed live on staging via has_function_privilege():
-- anon and authenticated could both EXECUTE every SECURITY DEFINER
-- function in this schema, including the two private helpers
-- (_validate_user_erasure, _validate_contact_erasure) whose own doc
-- comments claim "not granted to authenticated" — a claim the actual
-- grants never enforced.
--
-- ROOT CAUSE 2 — every caller-identity guard of the shape
-- `p_caller_user_id is null or p_caller_user_id <> auth.uid()` is
-- NULL-unsafe: SQL's `<>` against a NULL operand always evaluates to NULL
-- (never true/false), and PL/pgSQL's IF treats a NULL condition as "do not
-- execute THEN" — so when auth.uid() is NULL (exactly the anon/
-- unauthenticated case), a caller supplying ANY non-null p_caller_user_id
-- sails past the check entirely, impersonating that arbitrary id. Verified
-- empirically with a real PL/pgSQL probe (created, exercised, and dropped
-- against local Postgres) before this fix was written, not assumed from
-- reading the SQL alone.
--
-- The owner/creator role for every function in this schema is `postgres`
-- (verified via pg_proc.proowner — every migration in this project runs
-- as postgres, the same fact 20260811100000's own comment already
-- documents for tables), so both the existing-function REVOKEs below and
-- the future-function default-privilege change target that role
-- explicitly — a schema-only ALTER DEFAULT PRIVILEGES without `FOR ROLE
-- postgres` would not reliably govern what postgres's own future
-- CREATE FUNCTION calls receive by default.

-- ============================================================
-- PART 1: existing-function ACL remediation
-- ============================================================

-- PRIVATE HELPERS — never callable by any app-facing role, only from
-- within another SECURITY DEFINER function owned by the same role.
revoke execute on function public._validate_user_erasure(uuid, uuid) from public;
revoke execute on function public._validate_contact_erasure(uuid, uuid) from public;

-- AUTHENTICATED RPCs — each already has its own explicit
-- `grant execute ... to authenticated` from its original migration, which
-- REVOKE FROM PUBLIC does not touch; only the PUBLIC entry is removed.
revoke execute on function public.create_organization_with_owner(text, text, uuid) from public;
revoke execute on function public.get_my_membership_context() from public;
revoke execute on function public.get_my_agency_context() from public;
revoke execute on function public.create_agency_with_owner(text, text, uuid) from public;
revoke execute on function public.create_client_organization_for_agency(text, text, uuid, uuid) from public;
revoke execute on function public.preview_user_erasure(uuid, uuid) from public;
revoke execute on function public.execute_user_erasure(uuid, uuid) from public;
revoke execute on function public.preview_contact_erasure(uuid, uuid) from public;
revoke execute on function public.execute_contact_erasure(uuid, uuid) from public;

-- RLS-SUPPORT FUNCTIONS — called from inside RLS policy expressions
-- themselves, evaluated as whichever role runs the underlying query
-- (authenticated, in this app's entire real traffic). These never had an
-- explicit grant at all — they relied entirely on the PUBLIC default, so
-- revoking PUBLIC without adding this explicit grant would break every
-- RLS policy in the schema the moment this migration applied.
revoke execute on function public.current_org() from public;
revoke execute on function public.current_agency() from public;
revoke execute on function public.current_role_key() from public;
grant execute on function public.current_org() to authenticated;
grant execute on function public.current_agency() to authenticated;
grant execute on function public.current_role_key() to authenticated;

-- TRIGGER FUNCTIONS — defense-in-depth only. A function declared
-- `returns trigger` cannot be invoked via ordinary SQL/RPC regardless of
-- its EXECUTE grants (PostgreSQL itself rejects a direct call with
-- "trigger functions can only be called as triggers") — confirmed live on
-- staging via pg_proc.prorettype before this migration was written.
-- Revoking PUBLIC here changes no functional behavior; it only removes an
-- ACL that was never actually usable.
revoke execute on function public.handle_new_auth_user() from public;
revoke execute on function public._set_data_subject_request_due_at() from public;
revoke execute on function public.set_updated_at() from public;

-- ============================================================
-- PART 2: future-function default privilege hardening
-- ============================================================

-- Deliberately NOT scoped with `IN SCHEMA public`, unlike the table-level
-- analog in 20260811100000. Empirically proven (against a freshly reset
-- local database, with zero pre-existing default-privilege state, via a
-- disposable probe function created/checked/dropped before this statement
-- was finalized) and independently corroborated by PostgreSQL's own bug
-- tracker: a schema-scoped ALTER DEFAULT PRIVILEGES can only ADD to the
-- compiled-in default for functions, never remove from it — the built-in
-- "PUBLIC gets EXECUTE on every new function" default is cluster-global
-- and can only be revoked by a role-scoped statement with no IN SCHEMA
-- clause at all. (This asymmetry does not apply to tables, which is why
-- 20260811100000's `IN SCHEMA public` form correctly hardens future
-- tables — confirmed still true against the same reset database, same
-- session, immediately before this finding.) This statement still
-- targets the actual, verified function-creator role (postgres) explicitly
-- rather than relying on an ambient current-role assumption; it is simply
-- not schema-scoped, because scoping it would silently no-op.
alter default privileges for role postgres
  revoke execute on functions from public;

-- ============================================================
-- PART 3: NULL-safe caller-identity guards
-- ============================================================
-- CREATE OR REPLACE preserves each function's OID, so its own grants
-- (re-established in Part 1 above) and every dependency on it are
-- unaffected. Every one of the 7 functions below changes in exactly one
-- way: the caller-identity guard. Business logic, transaction behavior,
-- return shape, SECURITY DEFINER, and search_path are otherwise identical
-- to the version already shipped.

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
  -- NULL-safe: explicitly rejects an unauthenticated session (auth.uid()
  -- is null) BEFORE the comparison, and uses IS DISTINCT FROM (never
  -- NULL, always a real true/false) instead of <>. The previous
  -- `p_user_id is null or p_user_id <> auth.uid()` form silently let an
  -- unauthenticated caller supplying any non-null p_user_id through,
  -- because `<>` against a NULL auth.uid() evaluates to NULL, and
  -- PL/pgSQL's IF treats a NULL condition as "do not raise" — verified
  -- empirically before this fix was written.
  if auth.uid() is null
     or p_user_id is null
     or p_user_id is distinct from auth.uid()
  then
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
  'Atomically creates a new organization and its first membership (as org_admin) for the calling user, and emits a membership.created event in the same transaction (M1.7). The only supported way to create an organization — never a direct client INSERT (ADR-003). Caller-identity guard hardened NULL-safe (security remediation, post-2.1C).';

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
  if auth.uid() is null
     or p_user_id is null
     or p_user_id is distinct from auth.uid()
  then
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
  'Atomically creates a new agency and its first membership (as agency_owner) for the calling user. No organization is created (ADR-005). The only supported way to create an agency — never a direct client INSERT. Caller-identity guard hardened NULL-safe (security remediation, post-2.1C).';

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
  if auth.uid() is null
     or p_user_id is null
     or p_user_id is distinct from auth.uid()
  then
    raise exception 'p_user_id must match the authenticated caller';
  end if;

  select r.key into v_role_key
  from public.memberships m
  join public.roles r on r.id = m.role_id
  where m.user_id = p_user_id
    and m.agency_id = p_agency_id
    and m.status = 'active';

  if v_role_key is null or v_role_key not in ('agency_owner', 'agency_admin') then
    raise exception 'caller is not an active agency_owner/agency_admin of the target agency';
  end if;

  insert into public.organizations (name, slug, agency_id)
  values (p_org_name, p_org_slug, p_agency_id)
  returning id into v_org_id;

  return query select v_org_id;
end;
$$;

comment on function public.create_client_organization_for_agency(text, text, uuid, uuid) is
  'Atomically creates a new client organization under an agency, on behalf of a caller who must hold an active agency_owner/agency_admin membership in that exact agency. Rejects cross-agency creation and non-agency callers by construction. See ADR-005. Caller-identity guard hardened NULL-safe (security remediation, post-2.1C).';

create or replace function public.preview_user_erasure(p_dsr_id uuid, p_caller_user_id uuid)
returns table (
  can_proceed boolean,
  blocker_reason text,
  target_user_id uuid,
  membership_count integer,
  affected_organization_ids uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dsr record;
  v_target_user_id uuid;
  v_authorized boolean;
  v_blocking_orgs uuid[];
  v_membership_count integer;
  v_affected_orgs uuid[];
begin
  if auth.uid() is null
     or p_caller_user_id is null
     or p_caller_user_id is distinct from auth.uid()
  then
    raise exception 'p_caller_user_id must match the authenticated caller';
  end if;

  select * into v_dsr from public.data_subject_requests where id = p_dsr_id;
  if v_dsr is null then
    raise exception 'data subject request not found';
  end if;
  if v_dsr.subject_type <> 'user' then
    raise exception 'preview_user_erasure only supports subject_type=user (got %)', v_dsr.subject_type;
  end if;
  if v_dsr.request_type <> 'delete' then
    raise exception 'preview_user_erasure only supports request_type=delete (got %)', v_dsr.request_type;
  end if;

  v_target_user_id := v_dsr.subject_id;

  select authorized, blocking_organization_ids
    into v_authorized, v_blocking_orgs
    from public._validate_user_erasure(p_caller_user_id, v_target_user_id);

  if not v_authorized then
    raise exception 'caller is not an active org_admin of an organization the target user belongs to';
  end if;

  select count(*), array_agg(distinct organization_id)
    into v_membership_count, v_affected_orgs
    from public.memberships
    where user_id = v_target_user_id;

  if v_blocking_orgs is not null and array_length(v_blocking_orgs, 1) > 0 then
    return query select
      false,
      'target user is the sole active org_admin of at least one organization; assign another org_admin before erasure can proceed'::text,
      v_target_user_id,
      v_membership_count,
      v_blocking_orgs;
    return;
  end if;

  return query select true, null::text, v_target_user_id, v_membership_count, v_affected_orgs;
end;
$$;

comment on function public.preview_user_erasure(uuid, uuid) is
  'Dry-run for a subject_type=user data_subject_requests row (M1.6 Decision D). Read-only — never mutates data_subject_requests, users, or memberships. Caller-identity guard hardened NULL-safe (security remediation, post-2.1C).';

create or replace function public.execute_user_erasure(p_dsr_id uuid, p_caller_user_id uuid)
returns table (
  target_user_id uuid,
  memberships_removed integer,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dsr record;
  v_target_user_id uuid;
  v_authorized boolean;
  v_blocking_orgs uuid[];
  v_membership_count integer;
  v_completed_at timestamptz;
begin
  if auth.uid() is null
     or p_caller_user_id is null
     or p_caller_user_id is distinct from auth.uid()
  then
    raise exception 'p_caller_user_id must match the authenticated caller';
  end if;

  select * into v_dsr from public.data_subject_requests where id = p_dsr_id for update;
  if v_dsr is null then
    raise exception 'data subject request not found';
  end if;
  if v_dsr.subject_type <> 'user' then
    raise exception 'execute_user_erasure only supports subject_type=user (got %)', v_dsr.subject_type;
  end if;
  if v_dsr.request_type <> 'delete' then
    raise exception 'execute_user_erasure only supports request_type=delete (got %)', v_dsr.request_type;
  end if;
  if v_dsr.status = 'completed' then
    raise exception 'data subject request % is already completed', p_dsr_id;
  end if;

  v_target_user_id := v_dsr.subject_id;

  select authorized, blocking_organization_ids
    into v_authorized, v_blocking_orgs
    from public._validate_user_erasure(p_caller_user_id, v_target_user_id);

  if not v_authorized then
    raise exception 'caller is not an active org_admin of an organization the target user belongs to';
  end if;

  if v_blocking_orgs is not null and array_length(v_blocking_orgs, 1) > 0 then
    raise exception 'target user is the sole active org_admin of at least one organization; assign another org_admin before erasure can proceed';
  end if;

  select count(*) into v_membership_count from public.memberships where user_id = v_target_user_id;
  v_completed_at := now();

  delete from auth.users where id = v_target_user_id;

  update public.data_subject_requests
  set status = 'completed', completed_at = v_completed_at, handled_by = p_caller_user_id
  where id = p_dsr_id;

  insert into public.audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, before, after)
  values (
    v_dsr.organization_id,
    p_caller_user_id,
    'data_subject_request.executed',
    'user',
    v_target_user_id,
    jsonb_build_object('subject_type', 'user', 'membership_count', v_membership_count),
    jsonb_build_object('deleted', true, 'auth_identity_deleted', true, 'completed_at', v_completed_at)
  );

  return query select v_target_user_id, v_membership_count, v_completed_at;
end;
$$;

comment on function public.execute_user_erasure(uuid, uuid) is
  'Irreversible hard-delete execution for a subject_type=user data_subject_requests row (M1.6). Re-validates caller authorization and the sole-org_admin blocker independently of any prior preview_user_erasure() call. Caller-identity guard hardened NULL-safe (security remediation, post-2.1C).';

create or replace function public.preview_contact_erasure(p_dsr_id uuid, p_caller_user_id uuid)
returns table (
  can_proceed boolean,
  blocker_reason text,
  target_contact_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dsr record;
  v_contact record;
begin
  if auth.uid() is null
     or p_caller_user_id is null
     or p_caller_user_id is distinct from auth.uid()
  then
    raise exception 'p_caller_user_id must match the authenticated caller';
  end if;

  select * into v_dsr from public.data_subject_requests where id = p_dsr_id;
  if v_dsr is null then
    raise exception 'data subject request not found';
  end if;
  if v_dsr.subject_type <> 'contact' then
    raise exception 'preview_contact_erasure only supports subject_type=contact (got %)', v_dsr.subject_type;
  end if;
  if v_dsr.request_type <> 'delete' then
    raise exception 'preview_contact_erasure only supports request_type=delete (got %)', v_dsr.request_type;
  end if;

  select * into v_contact from public.contacts where id = v_dsr.subject_id;

  if v_contact is null or v_contact.organization_id <> v_dsr.organization_id then
    return query select false, 'contact not found in the requesting organization'::text, null::uuid;
    return;
  end if;

  if not public._validate_contact_erasure(p_caller_user_id, v_dsr.organization_id) then
    raise exception 'caller is not an active org_admin of the requesting organization';
  end if;

  return query select true, null::text, v_contact.id;
end;
$$;

comment on function public.preview_contact_erasure(uuid, uuid) is
  'Dry-run for a subject_type=contact data_subject_requests row (Milestone 2.1C). Read-only. Caller-identity guard hardened NULL-safe (security remediation, post-2.1C).';

create or replace function public.execute_contact_erasure(p_dsr_id uuid, p_caller_user_id uuid)
returns table (
  target_contact_id uuid,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dsr record;
  v_contact record;
  v_completed_at timestamptz;
begin
  if auth.uid() is null
     or p_caller_user_id is null
     or p_caller_user_id is distinct from auth.uid()
  then
    raise exception 'p_caller_user_id must match the authenticated caller';
  end if;

  select * into v_dsr from public.data_subject_requests where id = p_dsr_id for update;
  if v_dsr is null then
    raise exception 'data subject request not found';
  end if;
  if v_dsr.subject_type <> 'contact' then
    raise exception 'execute_contact_erasure only supports subject_type=contact (got %)', v_dsr.subject_type;
  end if;
  if v_dsr.request_type <> 'delete' then
    raise exception 'execute_contact_erasure only supports request_type=delete (got %)', v_dsr.request_type;
  end if;
  if v_dsr.status = 'completed' then
    raise exception 'data subject request % is already completed', p_dsr_id;
  end if;

  select * into v_contact from public.contacts where id = v_dsr.subject_id;
  if v_contact is null or v_contact.organization_id <> v_dsr.organization_id then
    raise exception 'contact not found in the requesting organization';
  end if;

  if not public._validate_contact_erasure(p_caller_user_id, v_dsr.organization_id) then
    raise exception 'caller is not an active org_admin of the requesting organization';
  end if;

  v_completed_at := now();

  delete from public.contacts where id = v_contact.id;

  update public.data_subject_requests
  set status = 'completed', completed_at = v_completed_at, handled_by = p_caller_user_id
  where id = p_dsr_id;

  insert into public.audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, before, after)
  values (
    v_dsr.organization_id,
    p_caller_user_id,
    'data_subject_request.executed',
    'contact',
    v_contact.id,
    jsonb_build_object('subject_type', 'contact', 'had_company_link', v_contact.company_id is not null),
    jsonb_build_object('deleted', true, 'completed_at', v_completed_at)
  );

  return query select v_contact.id, v_completed_at;
end;
$$;

comment on function public.execute_contact_erasure(uuid, uuid) is
  'Irreversible hard-delete execution for a subject_type=contact data_subject_requests row (Milestone 2.1C). Re-validates caller authorization and the DSR-organization-to-contact-organization binding independently of any prior preview_contact_erasure() call. Caller-identity guard hardened NULL-safe (security remediation, post-2.1C).';

-- ============================================================
-- PART 4: re-establish grants for the redefined functions
-- ============================================================
-- CREATE OR REPLACE FUNCTION preserves an existing object's ACL, so the
-- explicit `grant execute ... to authenticated` these 7 functions already
-- had (from their original migrations) survives the redefinitions above
-- unchanged. Restated here anyway, explicitly and idempotently, so this
-- migration's own end-state is self-contained and legible without having
-- to cross-reference which prior migration first granted what.
grant execute on function public.create_organization_with_owner(text, text, uuid) to authenticated;
grant execute on function public.create_agency_with_owner(text, text, uuid) to authenticated;
grant execute on function public.create_client_organization_for_agency(text, text, uuid, uuid) to authenticated;
grant execute on function public.preview_user_erasure(uuid, uuid) to authenticated;
grant execute on function public.execute_user_erasure(uuid, uuid) to authenticated;
grant execute on function public.preview_contact_erasure(uuid, uuid) to authenticated;
grant execute on function public.execute_contact_erasure(uuid, uuid) to authenticated;
