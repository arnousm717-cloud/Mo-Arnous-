-- Milestone 2.1C: Contacts GDPR/DSR integration (docs/13-Technical-Design-
-- Review.md "Milestone 2.1" — Detailed design; docs/03-Database-
-- Architecture.md §2.8's own "cascade extends into CRM tables in later
-- milestones" — this is that milestone for contacts). Mirrors M1.6's
-- preview_user_erasure/execute_user_erasure pair
-- (20260810100300_create_user_erasure_functions.sql) exactly — no new
-- architecture invented.
--
-- Critical difference from the user-erasure authorization check, by
-- design: a contact has no memberships/roles of its own, so authorization
-- here is not "is the caller an org_admin sharing some organization with
-- the target" — it is "is the caller an active org_admin of the EXACT
-- organization the data_subject_requests row and the target contact both
-- belong to." _validate_contact_erasure takes that organization_id as an
-- explicit parameter (resolved server-side from the DSR row, never from
-- the caller) so a caller who is org_admin in Org A can never use that
-- authority against Org B's contact, even if they also happen to hold a
-- membership in Org A.

insert into public.data_retention_policies (organization_id, data_type, retention_days) values
  (null, 'contacts', 2555); -- current configurable platform default, not a claim that GDPR universally requires seven years (Milestone 2.1C decision).

create or replace function public._validate_contact_erasure(p_caller_user_id uuid, p_organization_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.user_id = p_caller_user_id
      and m.organization_id = p_organization_id
      and m.status = 'active'
      and r.key = 'org_admin'
  );
end;
$$;

comment on function public._validate_contact_erasure(uuid, uuid) is
  'Internal helper shared by preview_contact_erasure/execute_contact_erasure — not granted to authenticated, callable only from within another SECURITY DEFINER function owned by the same role. Takes an explicit organization_id (always resolved server-side from the data_subject_requests row, never accepted as a caller-controlled parameter) and proves the caller holds an ACTIVE org_admin membership in exactly that organization — never merely "org_admin somewhere." This is what makes an admin of Org A structurally unable to use that authority against Org B''s contact.';

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
  if p_caller_user_id is null or p_caller_user_id <> auth.uid() then
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

  -- Soft-deleted contacts remain a valid erasure target — deleted_at is
  -- never a substitute for GDPR erasure, so it is deliberately not
  -- filtered here.
  select * into v_contact from public.contacts where id = v_dsr.subject_id;

  -- A missing contact and a contact belonging to a DIFFERENT organization
  -- than this DSR are made externally indistinguishable on purpose — both
  -- return the exact same generic blocker, never a different message that
  -- would let a caller infer that another organization's contact exists.
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
  'Dry-run for a subject_type=contact data_subject_requests row (Milestone 2.1C, mirroring M1.6''s preview_user_erasure). Read-only — never mutates contacts, data_subject_requests, or audit_logs. Binds the DSR''s own organization_id to the target contact''s organization_id explicitly, never trusting a caller-supplied value. A missing contact and a cross-organization contact produce an identical result, so this can never be used to probe whether another organization''s contact exists. A true can_proceed here is advisory only; execute_contact_erasure re-validates from scratch and does not trust this result.';

grant execute on function public.preview_contact_erasure(uuid, uuid) to authenticated;

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
  if p_caller_user_id is null or p_caller_user_id <> auth.uid() then
    raise exception 'p_caller_user_id must match the authenticated caller';
  end if;

  -- Row-locked for the duration of this transaction — two concurrent
  -- execute calls against the same request must not both proceed.
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

  -- Re-read and re-validate from scratch — never trusts any prior
  -- preview_contact_erasure() result (mirrors execute_user_erasure()'s
  -- own discipline exactly). The DSR-organization-to-contact-organization
  -- binding is re-proven here independently, not carried over from a
  -- preview call.
  select * into v_contact from public.contacts where id = v_dsr.subject_id;
  if v_contact is null or v_contact.organization_id <> v_dsr.organization_id then
    raise exception 'contact not found in the requesting organization';
  end if;

  if not public._validate_contact_erasure(p_caller_user_id, v_dsr.organization_id) then
    raise exception 'caller is not an active org_admin of the requesting organization';
  end if;

  v_completed_at := now();

  -- The hard delete. No table currently references contacts.id (verified
  -- during the Milestone 2.1C design audit), so a plain delete is
  -- structurally sufficient — no cascade orchestration needed, unlike
  -- execute_user_erasure()'s auth.users delete. Never deleted_at — that
  -- column is the ordinary, recoverable soft-delete mechanism and is
  -- categorically distinct from this irreversible erasure path.
  delete from public.contacts where id = v_contact.id;

  update public.data_subject_requests
  set status = 'completed', completed_at = v_completed_at, handled_by = p_caller_user_id
  where id = p_dsr_id;

  -- Synchronous, same transaction as the delete and the status update
  -- above (Unit-of-Work, docs/02-Software-Architecture.md §7) — if any one
  -- of the three fails, all three roll back together. Contains no raw
  -- contact PII — deliberately never first_name/last_name/email/phone/
  -- job_title/linkedin_url, only a boolean summarizing whether the
  -- contact had a company link, matching execute_user_erasure()'s own
  -- restraint (it logs only a membership count, never user data).
  -- consent_records referencing this contact are deliberately left
  -- untouched — preserved as compliance history, per the same "evidence,
  -- not a live reference" treatment audit_logs already receives.
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
  'Irreversible hard-delete execution for a subject_type=contact data_subject_requests row (Milestone 2.1C). Re-validates caller authorization and the DSR-organization-to-contact-organization binding independently of any prior preview_contact_erasure() call. Deletes the contacts row, marks the request completed, and writes one audit_logs entry containing no raw contact PII — all inside this function''s single transaction. Never substitutes deleted_at for this hard delete. consent_records referencing the erased contact are left untouched.';

grant execute on function public.execute_contact_erasure(uuid, uuid) to authenticated;
