-- Milestone 3.2F: extends execute_contact_erasure() to permanently
-- suppress any website_visitors row currently identified to the contact
-- being erased, closing the anti-relink gap the Milestone 3.2 Design
-- Resolution Report's §J identified: without this, a hard-erased
-- contact's own FK (website_visitors_contact_org_fk, ON DELETE SET NULL)
-- already nulls identified_contact_id, but the underlying
-- website_visitors row (and its full historical visitor_sessions/
-- visitor_events trail) survives untouched and could, in principle, be
-- re-identified later to a brand-new/recreated contact simply because the
-- browser still possesses the same anonymous_id -- silently making the
-- erased person's pre-erasure history attributable again.
--
-- A forward-only CREATE OR REPLACE on the existing function — the
-- original migration and its own 2.3A follow-up are never edited,
-- matching this project's established append-only convention (the exact
-- precedent 20260814100200_create_seed_default_pipeline_function.sql and
-- 20260817090200 itself already set). Per the explicit implementation
-- instruction for this milestone: the CURRENT, EFFECTIVE body of
-- execute_contact_erasure() was re-read directly from
-- 20260817090200_extend_contact_erasure_and_retention.sql (the latest
-- prior CREATE OR REPLACE, chronologically after both 20260812130000 and
-- 20260812140000) immediately before writing this migration — every line
-- below is that exact body, unchanged, with only the two new statements
-- inserted immediately before the existing hard-delete, and the doc
-- comment updated to describe this addition.
--
-- TECHNICAL MECHANISM only (Milestone 3.2 Design Resolution Report §J):
-- this migration implements the anti-relink guarantee. It does NOT
-- decide, and is not a claim about, the separate PRODUCT RETENTION
-- POLICY question (whether/when permanently-suppressed, now-orphaned
-- visitor_sessions/visitor_events should eventually be purged by a
-- retention job) or the LEGAL DECISION question (whether retaining
-- anonymized-but-present behavioral history after a GDPR erasure request
-- is itself legally sufficient) -- both remain explicitly unresolved,
-- exactly as flagged in that report.

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
  -- NULL-safe guard (explicit auth.uid() is null check + IS DISTINCT
  -- FROM), matching the already-hardened form this function has carried
  -- since 20260812140000_harden_function_execution_privileges.sql.
  if auth.uid() is null
     or p_caller_user_id is null
     or p_caller_user_id is distinct from auth.uid()
  then
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

  -- Milestone 2.3A: direct-contact relational cleanup, added in this same
  -- transaction, before the hard delete below. Category A only (see
  -- 20260817090200's own top comment) — direct related_to_type/
  -- taggable_type = 'contact' references to THIS contact, tenant-scoped.
  update public.activities
  set related_to_id = null, subject = null, body = null
  where organization_id = v_dsr.organization_id
    and related_to_type = 'contact'
    and related_to_id = v_contact.id;

  -- Notes: identical treatment to activities above.
  update public.notes
  set related_to_id = null, body = null
  where organization_id = v_dsr.organization_id
    and related_to_type = 'contact'
    and related_to_id = v_contact.id;

  -- Taggings: physically removed, not nulled — see 20260817090200's own
  -- comment for the full reasoning (taggable_id is NOT NULL by design).
  delete from public.taggings
  where organization_id = v_dsr.organization_id
    and taggable_type = 'contact'
    and taggable_id = v_contact.id;

  -- Milestone 3.2F, new: erasure anti-relink guard. Every
  -- website_visitors row currently identified to this contact is
  -- permanently suppressed from any future identification — to this
  -- contact, to a replacement/recreated contact, to anyone — before the
  -- contact row itself is deleted below. One audit row per affected
  -- visitor records the unlink (event_type='unlinked_erasure',
  -- contact_id = this contact — which the existing
  -- visitor_identifications_contact_org_fk's own ON DELETE SET NULL then
  -- nulls automatically the instant the DELETE below fires, exactly
  -- mirroring how website_visitors_contact_org_fk already behaves — the
  -- audit trail survives, the dangling PII-adjacent reference does not).
  -- Historical visitor_sessions/visitor_events are deliberately NOT
  -- deleted here — see this migration's own top comment on the
  -- TECHNICAL MECHANISM / PRODUCT RETENTION POLICY / LEGAL DECISION
  -- distinction.
  insert into public.visitor_identifications (organization_id, website_visitor_id, contact_id, event_type, token_jti)
  select v_dsr.organization_id, wv.id, v_contact.id, 'unlinked_erasure', gen_random_uuid()
  from public.website_visitors wv
  where wv.organization_id = v_dsr.organization_id
    and wv.identified_contact_id = v_contact.id;

  update public.website_visitors
  set identification_suppressed_at = now()
  where organization_id = v_dsr.organization_id
    and identified_contact_id = v_contact.id;

  -- The hard delete. No FOREIGN KEY references contacts.id other than
  -- the tracking-identification ones this migration itself just handled
  -- above (verified during the Milestone 2.1C design audit, re-confirmed
  -- in 2.3A and again here in 3.2F), so this DELETE needs no further
  -- FK-driven cascade orchestration beyond what already exists. Never
  -- deleted_at — that column is the ordinary, recoverable soft-delete
  -- mechanism and is categorically distinct from this irreversible
  -- erasure path.
  delete from public.contacts where id = v_contact.id;

  update public.data_subject_requests
  set status = 'completed', completed_at = v_completed_at, handled_by = p_caller_user_id
  where id = p_dsr_id;

  -- Synchronous, same transaction as every mutation above (Unit-of-Work,
  -- docs/02-Software-Architecture.md §7) — if any one step fails, all of
  -- them roll back together. Contains no raw contact PII — deliberately
  -- never first_name/last_name/email/phone/job_title/linkedin_url, only
  -- a boolean summarizing whether the contact had a company link,
  -- matching execute_user_erasure()'s own restraint. consent_records
  -- referencing this contact are deliberately left untouched — preserved
  -- as compliance history, per the same "evidence, not a live reference"
  -- treatment audit_logs already receives. Unchanged from the 2.1C
  -- original.
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
  'Irreversible hard-delete execution for a subject_type=contact data_subject_requests row (Milestone 2.1C, extended in Milestone 2.3A for direct-contact Activities/Notes/Taggings cleanup, extended again in Milestone 3.2F for the tracking-identification anti-relink guard). Re-validates caller authorization and the DSR-organization-to-contact-organization binding independently of any prior preview_contact_erasure() call. Scrubs related_to_id/subject/body to NULL on directly-related Activities (related_to_type stays ''contact''), scrubs related_to_id/body to NULL on directly-related Notes, physically removes directly-related Taggings, permanently suppresses (identification_suppressed_at) every website_visitors row currently identified to this contact and records one unlinked_erasure audit row per visitor, deletes the contacts row, marks the request completed, and writes one audit_logs entry containing no raw contact PII — all inside this function''s single transaction. Never substitutes deleted_at for this hard delete. consent_records referencing the erased contact are left untouched. Category B (free-text mentions of the contact on rows related to a different entity) remains a known, documented, unresolved limitation — see 20260817090200''s own top comment.';

-- grant execute ... to authenticated already exists from 20260812130000
-- (CREATE OR REPLACE preserves the function's OID and existing grants,
-- restated explicitly anyway, matching 20260817090200's own precedent).
grant execute on function public.execute_contact_erasure(uuid, uuid) to authenticated;
