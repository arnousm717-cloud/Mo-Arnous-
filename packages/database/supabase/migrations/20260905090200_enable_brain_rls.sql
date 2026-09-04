-- Milestone 4.1 Phase 1: RLS for the six brain_* tables — companion to
-- the schema migration, matching the established schema-then-RLS
-- precedent (lead_scores/scoring_rules, contact_enrichment/
-- company_enrichment, workflow_runs).
--
-- Ordinary RLS-scoped grants throughout, no SECURITY DEFINER bypass —
-- every write path here is either staff session auth (knowledge document
-- authoring) or an in-process domain-layer call already holding a
-- trusted organization_id from resolveOrganizationContextForUser/
-- withTenantContext (profile computation, embedding writes, sync-state
-- updates), never a bootstrap-identity problem the way resolve_api_key
-- or resolve_tracking_site are.

alter table public.brain_knowledge_documents enable row level security;
alter table public.brain_entity_profiles enable row level security;
alter table public.brain_entity_profile_history enable row level security;
alter table public.brain_embeddings enable row level security;
alter table public.brain_embedding_entity_refs enable row level security;
alter table public.brain_sync_state enable row level security;

-- brain_knowledge_documents: SELECT-only for authenticated (Milestone 4.1
-- Phase 1 acceptance-audit fix round). content_text is free text with no
-- deterministic entity linkage and is not part of the GDPR erasure
-- cascade (see the schema migration's own comment) — there is no
-- compliant ingestion/DSR design for this table yet, and no application
-- code anywhere in this repository writes to it (verified by source
-- inspection). Rather than grant an ordinary RLS-scoped INSERT/UPDATE
-- path that any authenticated session could exercise today with zero
-- validation and zero erasure coverage, this table is deliberately
-- SELECT-only until a later milestone introduces a compliant
-- ingestion/DSR design (which will most likely require a narrow
-- SECURITY DEFINER write path with real content validation, not an
-- ordinary RLS-scoped grant). No INSERT/UPDATE policy is created either —
-- a write policy with no corresponding grant would be dead code that
-- could mislead a future reader into thinking a write path exists.
create policy brain_knowledge_documents_select_own on public.brain_knowledge_documents
  for select
  using (organization_id = current_org());

grant select on public.brain_knowledge_documents to authenticated;

-- brain_entity_profiles: SELECT/INSERT/UPDATE — UPDATE backs
-- upsert-in-place recomputation of the CURRENT profile for an entity
-- (mirrors contact_enrichment's own monotonic-upsert convention, not
-- lead_scores' insert-only history convention — the history trail lives
-- in brain_entity_profile_history instead). No DELETE grant — rows are
-- removed only via their own ON DELETE CASCADE FK when the owning
-- contact/company/deal is hard-erased.
create policy brain_entity_profiles_select_own on public.brain_entity_profiles
  for select
  using (organization_id = current_org());

create policy brain_entity_profiles_insert_own on public.brain_entity_profiles
  for insert
  with check (organization_id = current_org());

create policy brain_entity_profiles_update_own on public.brain_entity_profiles
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

grant select, insert, update on public.brain_entity_profiles to authenticated;

-- brain_entity_profile_history: SELECT + INSERT only — historized,
-- insert-only by design, same discipline as lead_scores. No DELETE
-- grant — rows are removed only via their own ON DELETE CASCADE FK.
create policy brain_entity_profile_history_select_own on public.brain_entity_profile_history
  for select
  using (organization_id = current_org());

create policy brain_entity_profile_history_insert_own on public.brain_entity_profile_history
  for insert
  with check (organization_id = current_org());

grant select, insert on public.brain_entity_profile_history to authenticated;

-- brain_embeddings: SELECT + INSERT only — a chunk's embedding/chunk_text
-- is written once and superseded by a new row on recomputation, never
-- edited in place, so no UPDATE grant. No DELETE grant — rows are
-- removed only via their own ON DELETE CASCADE FK (knowledge_document
-- source) or the targeted-capture delete in execute_contact_erasure()
-- (entity_profile source: every embedding linked to a contact being
-- erased is deleted in full, see 20260905090400).
create policy brain_embeddings_select_own on public.brain_embeddings
  for select
  using (organization_id = current_org());

create policy brain_embeddings_insert_own on public.brain_embeddings
  for insert
  with check (organization_id = current_org());

grant select, insert on public.brain_embeddings to authenticated;

-- brain_embedding_entity_refs: SELECT + INSERT only — a junction table,
-- never updated in place. No DELETE grant — rows are removed only via
-- their own ON DELETE CASCADE FK when the referenced entity or embedding
-- is removed.
create policy brain_embedding_entity_refs_select_own on public.brain_embedding_entity_refs
  for select
  using (organization_id = current_org());

create policy brain_embedding_entity_refs_insert_own on public.brain_embedding_entity_refs
  for insert
  with check (organization_id = current_org());

grant select, insert on public.brain_embedding_entity_refs to authenticated;

-- brain_sync_state: SELECT/INSERT/UPDATE — UPDATE backs cursor
-- advancement as ingestion progresses. No DELETE grant — a sync_key's
-- row is superseded in place, never removed.
create policy brain_sync_state_select_own on public.brain_sync_state
  for select
  using (organization_id = current_org());

create policy brain_sync_state_insert_own on public.brain_sync_state
  for insert
  with check (organization_id = current_org());

create policy brain_sync_state_update_own on public.brain_sync_state
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

grant select, insert, update on public.brain_sync_state to authenticated;
