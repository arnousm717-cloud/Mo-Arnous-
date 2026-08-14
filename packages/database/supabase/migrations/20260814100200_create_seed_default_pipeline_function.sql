-- Milestone 2.2A: default-pipeline seeding. Every organization gets
-- exactly one active default "Sales Pipeline" with 5 deterministic
-- stages (Lead/Qualified/Proposal/Won/Lost) — at creation time (via
-- create_organization_with_owner()) and, for organizations that already
-- existed before this migration, via the one-time backfill loop at the
-- bottom of this file.

-- ============================================================
-- PART 1: seed_default_pipeline() — internal privileged helper
-- ============================================================
--
-- Deliberately NOT a general authenticated RPC, unlike
-- get_organization_member_identities() (2.2-P0). That function performs
-- its own independent caller-identity/active-membership check before
-- returning anything; this one does not — it takes a bare
-- p_organization_id with no authorization check at all, because its only
-- two legitimate callers (create_organization_with_owner(), part 2 below,
-- and this migration's own backfill loop, part 3 below) already run as
-- role `postgres`, which owns this function and therefore always retains
-- full implicit rights on it regardless of any GRANT/REVOKE state — this
-- is ordinary PostgreSQL owner-privilege semantics, not a bypass this
-- migration introduces. If this function were ever granted to
-- `authenticated`, any caller could re-seed or probe pipeline existence
-- for an arbitrary organization_id with no membership check whatsoever —
-- so it must never be reachable from an ordinary session. Do not copy
-- 2.2-P0's authenticated-EXECUTE grant here; these two functions have
-- different security purposes (docs/13 Milestone 2.2A "seed_default_
-- pipeline implementation/security model").
--
-- Concurrency: uses a per-organization Postgres advisory transaction lock
-- (pg_advisory_xact_lock, released automatically at the end of the
-- calling transaction) to serialize concurrent callers targeting the SAME
-- organization, rather than a check-then-insert pattern that relies on
-- catching a unique-violation — catching that exception would require a
-- SAVEPOINT/nested-block workaround to avoid leaving the caller's whole
-- transaction in Postgres's aborted state, which this design avoids
-- entirely. A second concurrent caller blocks until the first commits,
-- then re-checks and finds an active default already exists, and no-ops.
-- Different organizations use different lock keys (hashtext() of the
-- org id) and never block each other. The partial unique index on
-- pipelines(organization_id) WHERE is_default AND deleted_at IS NULL
-- (previous migration) remains the structural backstop proving "at most
-- one" even if this function's own logic were ever bypassed — see docs/13
-- Milestone 2.2A "Default-pipeline invariant actually guaranteed" for the
-- honest distinction between "at most one" (DB-guaranteed, always) and
-- "exactly one" (true only immediately after creation/backfill/seed — an
-- ordinary authenticated UPDATE can still remove the only active default
-- afterward; 2.2A ships no RBAC/domain layer to prevent that).
--
-- Idempotent: a second call for an organization that already has an
-- active default pipeline returns without inserting anything.

create or replace function public.seed_default_pipeline(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pipeline_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text));

  select id into v_pipeline_id
  from public.pipelines
  where organization_id = p_organization_id
    and is_default
    and deleted_at is null;

  if v_pipeline_id is not null then
    return;
  end if;

  insert into public.pipelines (organization_id, name, is_default)
  values (p_organization_id, 'Sales Pipeline', true)
  returning id into v_pipeline_id;

  insert into public.pipeline_stages
    (organization_id, pipeline_id, name, sort_order, is_won_stage, is_lost_stage)
  values
    (p_organization_id, v_pipeline_id, 'Lead', 10, false, false),
    (p_organization_id, v_pipeline_id, 'Qualified', 20, false, false),
    (p_organization_id, v_pipeline_id, 'Proposal', 30, false, false),
    (p_organization_id, v_pipeline_id, 'Won', 40, true, false),
    (p_organization_id, v_pipeline_id, 'Lost', 50, false, true);
end;
$$;

comment on function public.seed_default_pipeline(uuid) is
  'Milestone 2.2A. Internal privileged helper — ensures p_organization_id has exactly one ACTIVE default "Sales Pipeline" (5 deterministic stages: Lead/Qualified/Proposal/Won/Lost, only Won has is_won_stage, only Lost has is_lost_stage). Idempotent (no-ops if an active default already exists) and concurrency-safe (pg_advisory_xact_lock per organization_id, no check-then-insert/exception-catching). Deliberately NOT granted to authenticated — no caller-identity check of its own, reachable only from other SECURITY DEFINER functions/migrations running as its owning role. Never grant this to authenticated or anon.';

revoke execute on function public.seed_default_pipeline(uuid) from public;

-- ============================================================
-- PART 2: create_organization_with_owner() integration
-- ============================================================
--
-- CREATE OR REPLACE preserves this function's OID and its existing
-- `authenticated`-only grant (no PUBLIC — 20260812140000), so no grant
-- restatement is functionally required; restated anyway immediately
-- below, mirroring 20260812140000 Part 4's own explicit precedent for the
-- identical reason: this migration's own end state stays self-contained
-- and legible without requiring a reader to cross-reference an earlier
-- migration. Every prior behavior (NULL-safe caller-identity guard,
-- organization/membership/default_organization_id/membership.created
-- event) is unchanged; the only addition is the seed_default_pipeline()
-- call immediately before the final RETURN.

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

  -- Milestone 2.2A: atomically seeds the default Sales Pipeline + 5
  -- stages in the SAME transaction as the rows above. If this raises, the
  -- organization/membership/event inserts and the default_organization_id
  -- update all roll back with it — never a partially-initialized
  -- organization. reachable here via the owner-implicit-privilege rule
  -- (this function and seed_default_pipeline are both owned by postgres),
  -- not via any grant.
  perform public.seed_default_pipeline(v_org_id);

  return query select v_org_id, v_membership_id;
end;
$$;

comment on function public.create_organization_with_owner(text, text, uuid) is
  'Atomically creates a new organization, its first membership (org_admin), a membership.created event, and a default Sales Pipeline with 5 stages, all in one transaction (M1.3, M1.7, Milestone 2.2A). The only supported way to create an organization — never a direct client INSERT (ADR-003). Caller-identity guard NULL-safe (security remediation, post-2.1C).';

grant execute on function public.create_organization_with_owner(text, text, uuid) to authenticated;

-- ============================================================
-- PART 3: existing-organization backfill
-- ============================================================
--
-- Runs once, at migration-apply time, as the migration role (postgres) —
-- reaches seed_default_pipeline() via the same owner-implicit-privilege
-- rule as Part 2, not a grant. Calls the SAME canonical function used at
-- organization-creation time (never a second, duplicated definition of
-- "Sales Pipeline" + 5 stages) — idempotent by construction, so this loop
-- is safe even if re-examined; an organization that already has an active
-- default pipeline (none do yet, since this table is brand new in this
-- migration, but the idempotency still matters for the general contract)
-- is left untouched.
do $$
declare
  v_org record;
begin
  for v_org in select id from public.organizations loop
    perform public.seed_default_pipeline(v_org.id);
  end loop;
end;
$$;
