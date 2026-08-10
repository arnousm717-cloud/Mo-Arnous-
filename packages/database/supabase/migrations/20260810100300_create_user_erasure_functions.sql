-- User erasure orchestration (M1.6). Three functions, mirroring the
-- SECURITY DEFINER + auth.uid()-checked pattern established in M1.3/M1.4
-- (ADR-003): the caller may only ever act as themselves, and all real
-- authorization/blocker logic lives in the database function, not trusted
-- from the application layer alone (docs/08-Security.md §2).
--
-- _validate_user_erasure is a private helper (no EXECUTE grant to
-- authenticated) shared by preview and execute, so the authorization check
-- and the sole-org_admin blocker check are defined exactly once — but each
-- of preview/execute calls it independently, live, against current data.
-- execute_user_erasure never accepts or trusts a prior preview result
-- (M1.6 Decision D) — this shared-but-re-invoked-per-call shape is what
-- makes that true structurally, not just by convention.

create or replace function public._validate_user_erasure(p_caller_user_id uuid, p_target_user_id uuid)
returns table (authorized boolean, blocking_organization_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_authorized boolean;
  v_blocking_orgs uuid[];
begin
  -- Caller must hold an ACTIVE org_admin membership in some organization
  -- the target user is also an ACTIVE member of. A user can hold
  -- memberships in multiple organizations; this only requires ONE shared
  -- org where the caller has admin authority over the target, not that the
  -- caller admins every org the target belongs to.
  select exists (
    select 1
    from public.memberships caller_m
    join public.roles caller_r on caller_r.id = caller_m.role_id
    join public.memberships target_m
      on target_m.organization_id = caller_m.organization_id
     and target_m.user_id = p_target_user_id
     and target_m.status = 'active'
    where caller_m.user_id = p_caller_user_id
      and caller_m.status = 'active'
      and caller_r.key = 'org_admin'
  ) into v_authorized;

  -- Sole-org_admin blocker (M1.6 Decision C): for every organization where
  -- the target user IS an active org_admin, is there at least one OTHER
  -- active org_admin? Collects every organization that would be left
  -- admin-less, not just the first one found, so the blocker message/preview
  -- can report the complete picture in one pass.
  select array_agg(m.organization_id) into v_blocking_orgs
  from public.memberships m
  join public.roles r on r.id = m.role_id
  where m.user_id = p_target_user_id
    and m.status = 'active'
    and r.key = 'org_admin'
    and not exists (
      select 1
      from public.memberships other_m
      join public.roles other_r on other_r.id = other_m.role_id
      where other_m.organization_id = m.organization_id
        and other_r.key = 'org_admin'
        and other_m.user_id <> p_target_user_id
        and other_m.status = 'active'
    );

  return query select v_authorized, v_blocking_orgs;
end;
$$;

comment on function public._validate_user_erasure(uuid, uuid) is
  'Internal helper shared by preview_user_erasure/execute_user_erasure — not granted to authenticated, callable only from within another SECURITY DEFINER function owned by the same role. Returns whether the caller is authorized (active org_admin sharing an org with the target) and which organizations, if any, would be left without an active org_admin if the target were removed.';

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
  if p_caller_user_id is null or p_caller_user_id <> auth.uid() then
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
    -- Blocked: affected_organization_ids reports which orgs need another
    -- org_admin assigned before erasure can proceed — the actionable list,
    -- not the full membership list.
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
  'Dry-run for a subject_type=user data_subject_requests row (M1.6 Decision D). Read-only — never mutates data_subject_requests, users, or memberships. Runs the exact same authorization and sole-org_admin blocker checks execute_user_erasure() independently re-runs; a true here is advisory only, never trusted by execute_user_erasure() in place of its own check.';

grant execute on function public.preview_user_erasure(uuid, uuid) to authenticated;

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
  if p_caller_user_id is null or p_caller_user_id <> auth.uid() then
    raise exception 'p_caller_user_id must match the authenticated caller';
  end if;

  -- Row-locked for the duration of this transaction — two concurrent
  -- execute calls against the same request must not both proceed.
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

  -- Re-validated from scratch against live data — does not accept or trust
  -- any result a prior preview_user_erasure() call may have returned
  -- (M1.6 Decision D: "execute must not trust a prior preview result").
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

  -- The hard delete. A single statement against auth.users — every
  -- downstream row (public.users, public.memberships, and every
  -- GoTrue-internal table: auth.identities/sessions/refresh_tokens/
  -- mfa_factors/one_time_tokens/webauthn_*/oauth_*) is removed by
  -- Postgres's own FK cascade graph, empirically verified against the
  -- local Supabase Auth schema (every one of those is ON DELETE CASCADE
  -- from auth.users; public.users already had "on delete cascade" from
  -- auth.users since M1.2) rather than orchestrated table-by-table here.
  -- This is what makes "a user must not remain able to authenticate after
  -- a completed erasure" (Decision B) true by construction.
  delete from auth.users where id = v_target_user_id;

  update public.data_subject_requests
  set status = 'completed', completed_at = v_completed_at, handled_by = p_caller_user_id
  where id = p_dsr_id;

  -- Synchronous, same transaction as the delete above (M1.6 constraint #9)
  -- — if the delete fails, this insert never runs either; if this insert
  -- fails, the delete rolls back too. organization_id is the request's own
  -- filing organization (the caller's org), not null, so the org_admin who
  -- filed it can read this entry under audit_logs' own RLS afterward.
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
  'Irreversible hard-delete execution for a subject_type=user data_subject_requests row (M1.6). Re-validates caller authorization and the sole-org_admin blocker independently of any prior preview_user_erasure() call. Deletes auth.users (cascading through public.users/memberships and every GoTrue-internal table), marks the request completed, and writes one audit_logs entry — all inside this function''s single transaction (docs/02-Software-Architecture.md §7 Unit-of-Work pattern).';

grant execute on function public.execute_user_erasure(uuid, uuid) to authenticated;
