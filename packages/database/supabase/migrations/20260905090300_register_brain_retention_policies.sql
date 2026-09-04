-- Milestone 4.1 Phase 1: registers the new personal-data-bearing Brain
-- tables in data_retention_policies, per docs/10-CLAUDE.md §8's standing
-- rule ("any new table holding personal data must be added to the
-- relevant data_retention_policies entry... as part of the same PR that
-- introduces the table") — same discipline already applied in
-- 20260817090200 (activities/notes) and 20260903090000-adjacent work.

insert into public.data_retention_policies (organization_id, data_type, retention_days) values
  (null, 'brain_entity_profiles', 2555),
  (null, 'brain_entity_profile_history', 2555),
  (null, 'brain_embeddings', 2555),
  (null, 'brain_embedding_entity_refs', 2555);
-- Deliberately NOT added: 'brain_knowledge_documents' (org-owned content
-- with no deterministic personal-data linkage in this milestone, and no
-- write path at all today — authenticated is SELECT-only on this table,
-- see 20260905090200 — nothing can populate content_text yet; see that
-- table's own comment in 20260905090100 for the full Category-B-style
-- reasoning) and 'brain_sync_state' (an ingestion cursor/watermark,
-- carries no personal data at all — the same 'tags'/'taggings'-style
-- exclusion precedent from 20260817090200).
