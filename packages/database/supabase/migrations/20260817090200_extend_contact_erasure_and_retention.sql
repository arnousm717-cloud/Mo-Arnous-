-- Milestone 2.3A: extends execute_contact_erasure() (2.1C,
-- 20260812130000) to handle direct-contact Activities/Notes/Taggings, and
-- adds the retention-policy rows docs/10-CLAUDE.md §8's standing rule
-- requires ("any new table holding personal data must be added to the
-- relevant data_retention_policies entry and included in the
-- data_subject_requests cascade... as part of the same PR that
-- introduces the table"). A forward-only CREATE OR REPLACE on the
-- existing function — the original migration is never edited, matching
-- this project's own append-only convention (the exact precedent
-- 20260814100200_create_seed_default_pipeline_function.sql already set
-- when it extended create_organization_with_owner()).
--
-- Category A vs Category B (docs/13 Milestone 2.3, frozen GDPR
-- correction): this migration closes Category A only — a direct
-- relational reference (related_to_type/taggable_type = 'contact' and
-- the erased contact's own id) is fully and correctly erased. Category B
-- (an Activity/Note related to a Company or Deal whose free-text
-- subject/body happens to mention the erased contact by name) is NOT
-- addressed here and is not claimed to be — reliable detection of
-- personal-data mentions in free text requires NLP/semantic scanning,
-- explicitly out of scope for Milestone 2.3 (frozen decision). This
-- remains a documented, known compliance limitation, not silently
-- resolved and not silently ignored.

insert into public.data_retention_policies (organization_id, data_type, retention_days) values
  (null, 'activities', 2555), -- current configurable platform default, mirrors the 'contacts' precedent (2.1C) — not a claim that GDPR universally requires seven years.
  (null, 'notes', 2555);
-- Deliberately NOT added: 'tags' (organization-defined labels, never
-- personal data about an individual) and 'taggings' (a direct
-- contact-targeting tagging is physically removed at erasure time below,
-- not governed by a time-based retention window — the two mechanisms are
-- categorically different, docs/13 Milestone 2.3 §13).

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
  -- Self-caught correction: this migration originally based its CREATE OR
  -- REPLACE on the superseded 20260812130000 source — the guard's
  -- pre-hardening, NULL-unsafe `p_caller_user_id is null or
  -- p_caller_user_id <> auth.uid()` form — instead of the function's
  -- actual latest-applied body, silently regressing the NULL-auth-
  -- impersonation fix for this one function. `<>` against a NULL
  -- auth.uid() evaluates to NULL, and PL/pgSQL treats a NULL IF condition
  -- as false, so an authenticated-but-unidentified session supplying any
  -- real org_admin's p_caller_user_id would have sailed past this guard
  -- and irreversibly erased that org's contact. Caught by the pre-existing
  -- regression test in function-execution-privilege-hardening.test.ts
  -- during this milestone's own verification suite, before commit — see
  -- docs/13 Milestone 2.3A.
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
  -- transaction, before the hard delete below. Category A only (see this
  -- migration's own top comment) — direct related_to_type/taggable_type
  -- = 'contact' references to THIS contact, tenant-scoped.
  --
  -- Activities: the row survives (docs/03-Database-Architecture.md's own
  -- deletion-model example: "an activities row tied to a deal stays, but
  -- its subject/body text referencing the erased contact is
  -- overwritten"). related_to_type stays 'contact' — a category, not a
  -- personal identifier, deliberately preserved as non-identifying
  -- historical metadata ("this was an activity associated with a
  -- Contact") — while related_to_id, subject, and body are set to NULL,
  -- never a placeholder string (NULL is this project's consistent
  -- marker for "removed", matching deals.company_id/primary_contact_id's
  -- own ON DELETE SET NULL semantics; a fabricated placeholder would be
  -- stored, fabricated content). created_by is never touched — it
  -- identifies the staff member who logged the activity, not the erased
  -- contact.
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

  -- Taggings: physically removed, not nulled — a tagging carries no free
  -- text and no historical narrative worth preserving, and (unlike
  -- activities/notes) taggable_id is NOT NULL by design (2.3A schema),
  -- so nulling it is not an available option regardless. Leaving it
  -- pointing at a physically-deleted contact would be exactly the
  -- dangling identifier this milestone's GDPR correction was written to
  -- eliminate.
  delete from public.taggings
  where organization_id = v_dsr.organization_id
    and taggable_type = 'contact'
    and taggable_id = v_contact.id;

  -- The hard delete. No FOREIGN KEY references contacts.id (verified
  -- during the Milestone 2.1C design audit, re-confirmed in 2.3A: the
  -- polymorphic activities.related_to_id/notes.related_to_id/
  -- taggings.taggable_id columns are deliberately NOT real foreign keys,
  -- per docs/03-Database-Architecture.md §3 — Postgres cannot express a
  -- type-conditional FK — so this DELETE needs no FK-driven cascade
  -- orchestration; the application-level cleanup above is what makes
  -- this safe), so a plain delete remains structurally sufficient. Never
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
  'Irreversible hard-delete execution for a subject_type=contact data_subject_requests row (Milestone 2.1C, extended in Milestone 2.3A for direct-contact Activities/Notes/Taggings cleanup). Re-validates caller authorization and the DSR-organization-to-contact-organization binding independently of any prior preview_contact_erasure() call. Scrubs related_to_id/subject/body to NULL on directly-related Activities (related_to_type stays ''contact''), scrubs related_to_id/body to NULL on directly-related Notes, physically removes directly-related Taggings, deletes the contacts row, marks the request completed, and writes one audit_logs entry containing no raw contact PII — all inside this function''s single transaction. Never substitutes deleted_at for this hard delete. consent_records referencing the erased contact are left untouched. Category B (free-text mentions of the contact on rows related to a different entity) is a known, documented, unresolved limitation — see this migration''s own top comment.';

-- grant execute ... to authenticated already exists from 20260812130000
-- (CREATE OR REPLACE preserves the function's OID and existing grants,
-- restated explicitly anyway for the same "this migration's own end
-- state is self-contained" reason 20260814100200 Part 2 already
-- established as this project's precedent for CREATE OR REPLACE
-- extensions).
grant execute on function public.execute_contact_erasure(uuid, uuid) to authenticated;
