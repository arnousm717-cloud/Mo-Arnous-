-- Milestone 4.1 Phase 3: additive schema readiness for real, retry-safe
-- embedding write-back for a SINGLE entity profile's own current chunk —
-- the narrow, common case this phase's write-back path (packages/brain/
-- src/embeddings.ts) actually needs. Phase 1's own, more general design
-- (an entity_profile-sourced chunk that references zero, one, or several
-- entities purely via the brain_embedding_entity_refs junction table,
-- e.g. "a paragraph discussing both a contact and their deal") is left
-- completely intact and untouched — every new column below is nullable,
-- and every existing accepted test (brain-schema.test.ts,
-- brain-rls.test.ts, brain-gdpr-erasure.test.ts) that inserts a
-- brain_embeddings row with no entity_profile_id/content_hash/
-- source_version_at continues to work unmodified, verified live against
-- this exact migration.
--
-- Two deficiencies closed for the entity_profile_id-linked case only:
--
-- 1. No stable identity linking an entity-profile-sourced chunk back to
--    the SPECIFIC brain_entity_profiles row it was generated from, so
--    staleness (a redelivered/late write-back computed from an
--    already-superseded profile snapshot) could not be detected from the
--    schema alone. Fixed with a nullable entity_profile_id column,
--    populated only by upsertEntityEmbedding's own single-profile write-
--    back path — never required, never inferred from source_type alone
--    (unlike knowledge_document_id, which genuinely is mandatory
--    whenever source_type = 'knowledge_document' — that Phase 1
--    invariant, and its own CHECK constraint, are unchanged) — plus a
--    composite tenant-safe FK, ON DELETE CASCADE: a hard-erased entity's
--    profile row disappearing structurally removes any embedding
--    attached to it, the same discipline brain_entity_profiles itself
--    already established for the contact/company/deal row one level up.
--
-- 2. No uniqueness guarantee suitable for an ON CONFLICT arbiter, so a
--    retried or redelivered write-back had no conflict target to upsert
--    against and would have inserted a duplicate row. Fixed with a
--    partial unique index on (organization_id, entity_profile_id) WHERE
--    entity_profile_id IS NOT NULL — one current embedding row per entity
--    profile (only among the rows that opt into this identity at all),
--    exactly mirroring brain_entity_profiles_contact_uidx et al.'s own
--    "one current row per X" pattern in the migration this one extends
--    (20260905090100).
--
-- content_hash and source_version_at are the two other new columns:
-- content_hash is the deterministic content-identity the write-back path
-- uses to make a truly-duplicate delivery a real no-op (see
-- packages/brain/src/embeddings.ts's own header comment for the exact
-- hash contract); source_version_at captures the source profile's own
-- computed_at at generation time, the freshness token compared against
-- the CURRENT profile's computed_at to reject a stale result — the same
-- "source's own freshness marker, not wall-clock write-completion time"
-- design upsertEntityProfile already proved correct for
-- brain_entity_profiles itself (packages/brain/src/repository.ts). Both
-- are nullable at the schema level (an unrelated, entity_profile_id-less
-- row has no use for either), but a CHECK constraint below guarantees
-- they are ALWAYS present together whenever entity_profile_id is set —
-- upsertEntityEmbedding's own invariant, enforced by the database too,
-- not only by that function's own TypeScript.
--
-- No vector index, no HNSW/IVFFlat, no semantic-search SQL of any kind —
-- out of this phase's scope by design (Milestone 4.1 Phase 3 Detailed
-- Design), deferred to the later search sub-phase where an index type
-- can be benchmarked against real data volume. No historical migration
-- edited; no destructive statement anywhere in this file.

alter table public.brain_embeddings
  add column entity_profile_id uuid,
  add column content_hash text,
  add column source_version_at timestamptz;

alter table public.brain_embeddings
  add constraint brain_embeddings_entity_profile_identity_complete check (
    entity_profile_id is null
    or (content_hash is not null and source_version_at is not null)
  );

alter table public.brain_embeddings
  add constraint brain_embeddings_entity_profile_org_fk
    foreign key (organization_id, entity_profile_id)
    references public.brain_entity_profiles (organization_id, id)
    on delete cascade;

create unique index brain_embeddings_entity_profile_uidx
  on public.brain_embeddings (organization_id, entity_profile_id)
  where entity_profile_id is not null;

-- Grant model extension (does not edit 20260905090200, which stays
-- forward-only/append-only per this project's established convention):
-- that migration's own comment assumed "a chunk's embedding/chunk_text is
-- written once and superseded by a new row on recomputation, never
-- edited in place, so no UPDATE grant" — written before this phase
-- actually designed the write-back mechanism. A genuinely idempotent,
-- "one current artifact per entity" design (the explicit Phase 3
-- requirement, scoped to the entity_profile_id-linked rows this
-- migration adds) needs the SAME update-in-place pattern
-- brain_entity_profiles itself already uses (compare
-- brain_entity_profiles_update_own, same migration) — an INSERT-only
-- "supersede with a new row" alternative cannot coexist with the partial
-- unique index above (a second insert for the same entity_profile_id
-- would violate it outright) without either resurrecting the exact
-- ordering-precision class of problem Phase 2 already fixed once
-- (`created_at`-ordered "latest wins") or duplicating
-- brain_entity_profile_history's own already-solved job a second time.
-- Update-in-place, mirroring the already-audited brain_entity_profiles
-- pattern exactly, is deliberately chosen instead. No DELETE grant is
-- added — rows are still removed only via ON DELETE CASCADE or
-- execute_contact_erasure()'s targeted-capture delete, unchanged from
-- Phase 1.
create policy brain_embeddings_update_own on public.brain_embeddings
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

grant update on public.brain_embeddings to authenticated;

comment on column public.brain_embeddings.entity_profile_id is
  'Milestone 4.1 Phase 3. Set only by upsertEntityEmbedding''s own single-entity write-back path — never required by source_type alone (unlike knowledge_document_id). The one brain_entity_profiles row this chunk/embedding was generated from, when set. Composite tenant-safe FK, ON DELETE CASCADE: erasing the owning contact/company/deal removes its profile row (existing Phase 1 cascade), which removes this embedding row structurally in turn — no second erasure mechanism needed. The partial unique index below enforces at most one CURRENT embedding row per entity profile among rows that set it; a general, entity_profile_id-less chunk (Phase 1''s own original multi-entity-via-brain_embedding_entity_refs design) is entirely unaffected.';

comment on column public.brain_embeddings.content_hash is
  'Milestone 4.1 Phase 3. Deterministic sha256 hex digest binding this row to its exact chunk_text AND source identity (entityType/entityId) — see packages/brain/src/embeddings.ts''s own header comment for the precise hash contract. Required (via brain_embeddings_entity_profile_identity_complete) whenever entity_profile_id is set; null otherwise. Used to make a truly-duplicate write-back (identical content, redelivered) a real no-op rather than a wasted UPDATE.';

comment on column public.brain_embeddings.source_version_at is
  'Milestone 4.1 Phase 3. The source brain_entity_profiles row''s own computed_at, captured at the moment this embedding was generated (by the external n8n workflow) — never wall-clock write-completion time, same freshness-token discipline brain_entity_profiles.computed_at itself already uses relative to the CRM source row''s updated_at. Required (via brain_embeddings_entity_profile_identity_complete) whenever entity_profile_id is set; null otherwise. A write-back whose source_version_at is older than the CURRENT profile''s computed_at is rejected as stale.';
