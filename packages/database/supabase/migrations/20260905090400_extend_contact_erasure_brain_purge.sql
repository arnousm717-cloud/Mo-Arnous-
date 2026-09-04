-- Milestone 4.1 Phase 1: extends execute_contact_erasure() to delete every
-- Brain embedding artifact linked to the erased contact.
--
-- brain_entity_profiles/brain_entity_profile_history and
-- brain_embedding_entity_refs all carry a real composite tenant-safe FK
-- straight to contacts (organization_id, id) with ON DELETE CASCADE
-- (20260905090100) — those rows are already removed structurally by the
-- `delete from public.contacts` statement below, with no explicit
-- statement needed here, exactly the same as this function already
-- relies on FK cascades for tracking-identification cleanup.
--
-- The ONE thing that cascade does NOT handle: brain_embeddings itself has
-- no direct FK to contacts (a chunk may span multiple entities, so it is
-- linked only via brain_embedding_entity_refs rows).
--
-- Targeted-capture design (Milestone 4.1 Phase 1 acceptance-audit fix
-- round — replaces an earlier, defective "purge whatever is orphaned
-- after the fact" approach that (a) left an erased contact's own PII
-- readable in chunk_text whenever another entity ref on the same
-- embedding survived, and (b) could delete an unrelated, already-orphaned
-- embedding elsewhere in the same organization that had nothing to do
-- with this contact): the exact set of brain_embeddings ids linked to
-- THIS contact is captured into v_target_embedding_ids BEFORE the
-- contacts delete below — while brain_embedding_entity_refs still holds
-- the evidence of which embeddings this contact was linked to, not
-- rediscovered afterward from whatever the cascade happens to leave
-- behind. M4.1 has no deterministic content provenance capable of
-- proving which substring/vector dimensions of a shared chunk_text belong
-- only to which entity, so there is no safe way to redact or keep a
-- shared artifact once it is known to involve the erased contact —
-- privacy safety takes precedence over preserving a shared derived
-- artifact: the ENTIRE embedding is deleted, even if a company or deal
-- ref on it also exists. Deleting the embedding row cascades
-- (ON DELETE CASCADE) to remove any remaining company/deal refs attached
-- to it via brain_embedding_entity_refs_embedding_org_fk — no separate
-- cleanup of those refs is needed. A future ingestion system may
-- regenerate a safe, contact-free company/deal artifact later; this
-- migration does not attempt that (no redaction logic, no regeneration,
-- no AI provider). Because the actual delete is keyed by the captured id
-- set rather than by "currently has zero refs," it can never touch an
-- unrelated pre-existing orphan or a knowledge_document-sourced chunk
-- (which never receives an entity ref in the first place).
--
-- preview_contact_erasure() is deliberately NOT extended — verified by
-- source inspection that neither prior real cascade extension (2.3A
-- activities/notes/taggings, 3.2F tracking anti-relink) ever touched it;
-- it stays a minimal (can_proceed, blocker_reason, target_contact_id)
-- check, never an enumeration of per-artifact cascade counts.
--
-- A forward-only CREATE OR REPLACE on the existing function — the
-- original migration and its two prior extensions (2.3A, 3.2F) are never
-- edited, matching this project's established append-only convention.
-- Per the explicit implementation instruction for this milestone: the
-- CURRENT, EFFECTIVE body of execute_contact_erasure() was re-read
-- directly from 20260821090600_extend_contact_erasure_anti_relink.sql
-- (the latest prior CREATE OR REPLACE) immediately before writing this
-- migration — every line below is that exact body, unchanged, with only
-- the new Brain-purge statement inserted immediately after the existing
-- hard-delete, and the doc comment updated to describe this addition.

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
  v_target_embedding_ids uuid[];
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

  -- Milestone 4.1 Phase 1, new: capture the exact brain_embeddings ids
  -- linked to this contact BEFORE any cascade below removes the
  -- brain_embedding_entity_refs evidence that identifies them. This is
  -- deliberately NOT re-derived after the contacts delete — by then the
  -- only remaining signal would be "which embeddings now have zero
  -- refs," which cannot distinguish an embedding this contact was
  -- linked to from an unrelated embedding that happened to be orphaned
  -- for some other reason.
  select coalesce(array_agg(distinct embedding_id), array[]::uuid[])
    into v_target_embedding_ids
  from public.brain_embedding_entity_refs
  where organization_id = v_dsr.organization_id
    and contact_id = v_contact.id;

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

  -- Milestone 3.2F: erasure anti-relink guard. Every website_visitors row
  -- currently identified to this contact is permanently suppressed from
  -- any future identification — to this contact, to a replacement/
  -- recreated contact, to anyone — before the contact row itself is
  -- deleted below. One audit row per affected visitor records the unlink
  -- (event_type='unlinked_erasure', contact_id = this contact — which the
  -- existing visitor_identifications_contact_org_fk's own ON DELETE SET
  -- NULL then nulls automatically the instant the DELETE below fires,
  -- exactly mirroring how website_visitors_contact_org_fk already
  -- behaves — the audit trail survives, the dangling PII-adjacent
  -- reference does not). Historical visitor_sessions/visitor_events are
  -- deliberately NOT deleted here — see 20260821090600's own top comment
  -- on the TECHNICAL MECHANISM / PRODUCT RETENTION POLICY / LEGAL
  -- DECISION distinction.
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
  -- the tracking-identification ones above and the Brain composite FKs
  -- (brain_entity_profiles_contact_org_fk, ON DELETE CASCADE;
  -- brain_embedding_entity_refs_contact_org_fk, ON DELETE CASCADE, which
  -- also cascades brain_entity_profile_history via its own FK to
  -- brain_entity_profiles), so this DELETE needs no further FK-driven
  -- cascade orchestration beyond what already exists plus the explicit,
  -- already-captured Brain-embedding delete immediately below. Never
  -- deleted_at — that column is the ordinary, recoverable soft-delete
  -- mechanism and is categorically distinct from this irreversible
  -- erasure path.
  delete from public.contacts where id = v_contact.id;

  -- Milestone 4.1 Phase 1, new: delete every brain_embeddings row
  -- captured above as linked to this contact — the ENTIRE artifact, not
  -- merely this contact's own ref on it, even when a company/deal ref on
  -- the same embedding also exists (see this migration's own top comment
  -- for the full reasoning). Deleting the embedding row cascades
  -- (ON DELETE CASCADE, brain_embedding_entity_refs_embedding_org_fk) to
  -- remove any remaining refs pointing at it, so no separate ref cleanup
  -- is needed here. Scoped to this DSR's own organization — never a
  -- cross-tenant scan — and to exactly the captured id set, so it can
  -- never reach an unrelated embedding that merely happens to be
  -- orphaned for some other reason.
  delete from public.brain_embeddings
  where organization_id = v_dsr.organization_id
    and id = any (v_target_embedding_ids);

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
  'Irreversible hard-delete execution for a subject_type=contact data_subject_requests row (Milestone 2.1C, extended in Milestone 2.3A for direct-contact Activities/Notes/Taggings cleanup, extended in Milestone 3.2F for the tracking-identification anti-relink guard, extended in Milestone 4.1 Phase 1 for targeted Brain-embedding deletion). Re-validates caller authorization and the DSR-organization-to-contact-organization binding independently of any prior preview_contact_erasure() call. Captures the exact brain_embeddings ids linked to this contact (via brain_embedding_entity_refs) before any cascade, scrubs related_to_id/subject/body to NULL on directly-related Activities (related_to_type stays ''contact''), scrubs related_to_id/body to NULL on directly-related Notes, physically removes directly-related Taggings, permanently suppresses (identification_suppressed_at) every website_visitors row currently identified to this contact and records one unlinked_erasure audit row per visitor, deletes the contacts row (cascading brain_entity_profiles/brain_entity_profile_history/brain_embedding_entity_refs via their own composite FKs), deletes every captured brain_embeddings row in full (even one a company/deal ref also pointed at — no partial redaction, no shared artifact is ever preserved once linked to the erased contact; deleting it cascades away any remaining refs on it), marks the request completed, and writes one audit_logs entry containing no raw contact PII — all inside this function''s single transaction. Never substitutes deleted_at for this hard delete. consent_records referencing the erased contact are left untouched. preview_contact_erasure() is deliberately not extended for Brain data, matching the established precedent that neither prior cascade extension touched it. Category B (free-text mentions of the contact on rows related to a different entity, including brain_knowledge_documents.content_text) remains a known, documented, unresolved limitation — see 20260817090200''s own top comment.';

-- grant execute ... to authenticated already exists from 20260812130000
-- (CREATE OR REPLACE preserves the function's OID and existing grants,
-- restated explicitly anyway, matching prior extensions' own precedent).
grant execute on function public.execute_contact_erasure(uuid, uuid) to authenticated;
