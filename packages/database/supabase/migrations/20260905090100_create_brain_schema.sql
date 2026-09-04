-- Milestone 4.1 Phase 1: Brain Foundation database schema
-- (docs/11-AI-Revenue-Brain.md, Milestone 4.1 Detailed Design). Six new
-- tables: brain_knowledge_documents, brain_entity_profiles,
-- brain_entity_profile_history, brain_embeddings,
-- brain_embedding_entity_refs, brain_sync_state. RLS/grants are the
-- companion migration that follows, matching the established
-- schema-then-RLS precedent.
--
-- Deviation from the Detailed Design, discovered while re-verifying
-- schema conventions for this migration: public.deals had no
-- unique(organization_id, id) constraint (unlike companies, contacts,
-- pipelines, pipeline_stages), so a composite tenant-safe FK from
-- brain_entity_profiles/brain_embedding_entity_refs into deals could not
-- be created as designed. Fixed here with the exact same prerequisite
-- pattern already used for contacts in 20260814100000 — id is already the
-- primary key (globally unique), so (organization_id, id) is trivially
-- unique already and this cannot fail against any existing data.
alter table public.deals
  add constraint deals_organization_id_id_key unique (organization_id, id);

-- Entity-reference design deliberately deviates from docs/11's own
-- jsonb-array entity_refs proposal: three nullable columns
-- (contact_id/company_id/deal_id) + a CHECK enforcing exactly one is set
-- (matching entity_type) + real composite tenant-safe FKs with
-- ON DELETE CASCADE on each, so a hard-erased contact/company/deal's
-- Brain rows are removed structurally by the database itself, not by an
-- application-level jsonb-array purge convention that could drift or be
-- forgotten on some future write path. This does not scale cleanly past
-- ~4-5 entity types — an accepted, documented limitation for this
-- milestone's two entity kinds actually referenced (contact/company/deal
-- profiles; contact/company/deal embedding refs).

create table public.brain_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title text not null,
  -- Privacy classification (Milestone 4.1 Phase 1, mandatory review):
  -- content_text is org-owned free text with no deterministic entity
  -- linkage in this milestone (no contact_id/company_id/deal_id on this
  -- table) — a staff member could paste text that happens to contain a
  -- named individual's personal data. This is NOT part of the GDPR
  -- erasure cascade (execute_contact_erasure() does not touch this
  -- table): reliable detection of personal-data mentions in arbitrary
  -- free text requires NLP/semantic scanning, out of scope for this
  -- milestone — the same accepted Category B limitation
  -- 20260817090200_extend_contact_erasure_and_retention.sql already
  -- documents for Activities/Notes free text. A documented, deliberate
  -- limitation, not silently resolved and not silently ignored.
  content_text text not null,
  source_type text not null default 'manual_upload',
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, id)
);

comment on table public.brain_knowledge_documents is
  'Milestone 4.1 Phase 1. Org-owned knowledge documents ingested into the Brain. content_text is NOT part of the GDPR contact-erasure cascade — no deterministic entity linkage exists in this milestone, matching the accepted Category B free-text limitation already documented for Activities/Notes (20260817090200). Ordinary deletion is deleted_at (soft-delete) only. SELECT-only for authenticated (see the RLS/grants migration) — no compliant ingestion/DSR design exists yet, so no ordinary RLS-scoped write path is granted; a later milestone introducing real ingestion will need a narrow, validated write path, not this table left open. Deliberately excluded from data_retention_policies for the same reason (see the retention migration''s own comment).';

create index brain_knowledge_documents_org_active_idx on public.brain_knowledge_documents (organization_id) where deleted_at is null;

create table public.brain_entity_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  entity_type text not null check (entity_type in ('contact', 'company', 'deal')),
  contact_id uuid,
  company_id uuid,
  deal_id uuid,
  -- Phase-2 ingestion invariant (documented here, not enforced by this
  -- schema — no JSON-shape constraint is added in Phase 1): a company or
  -- deal profile's jsonb must never copy in a specific contact's personal
  -- data unless that data has its own deterministic contact provenance
  -- allowing it to be found and removed on that contact's own erasure.
  -- Nothing currently writes to this column (no ingestion exists yet), so
  -- this is not a stored-data defect today — it is a constraint the
  -- Phase 2 ingestion design must honor before this column is ever
  -- populated.
  profile jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brain_entity_profiles_entity_match check (
    (entity_type = 'contact' and contact_id is not null and company_id is null and deal_id is null)
    or (entity_type = 'company' and company_id is not null and contact_id is null and deal_id is null)
    or (entity_type = 'deal' and deal_id is not null and contact_id is null and company_id is null)
  ),
  constraint brain_entity_profiles_contact_org_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id)
    on delete cascade,
  constraint brain_entity_profiles_company_org_fk
    foreign key (organization_id, company_id)
    references public.companies (organization_id, id)
    on delete cascade,
  constraint brain_entity_profiles_deal_org_fk
    foreign key (organization_id, deal_id)
    references public.deals (organization_id, id)
    on delete cascade,
  unique (organization_id, id)
);

comment on table public.brain_entity_profiles is
  'Milestone 4.1 Phase 1. One current profile row per CRM entity (contact/company/deal) — exactly one of contact_id/company_id/deal_id is set, matching entity_type, enforced by brain_entity_profiles_entity_match and a real composite tenant-safe FK per entity kind, each ON DELETE CASCADE. A hard-erased contact/company/deal therefore removes its own profile row structurally, with no application-level purge step required. The partial unique indexes below enforce at most one profile per entity.';

create unique index brain_entity_profiles_contact_uidx on public.brain_entity_profiles (organization_id, contact_id) where contact_id is not null;
create unique index brain_entity_profiles_company_uidx on public.brain_entity_profiles (organization_id, company_id) where company_id is not null;
create unique index brain_entity_profiles_deal_uidx on public.brain_entity_profiles (organization_id, deal_id) where deal_id is not null;

create table public.brain_entity_profile_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  entity_profile_id uuid not null,
  profile jsonb not null,
  computed_at timestamptz not null default now(),
  constraint brain_entity_profile_history_profile_org_fk
    foreign key (organization_id, entity_profile_id)
    references public.brain_entity_profiles (organization_id, id)
    on delete cascade
);

comment on table public.brain_entity_profile_history is
  'Milestone 4.1 Phase 1. Historized, insert-only snapshot trail for brain_entity_profiles — one row per recomputation, never updated in place, same discipline as lead_scores. ON DELETE CASCADE to brain_entity_profiles: erasing the owning entity (and therefore its profile row) removes the entire history with it.';

create index brain_entity_profile_history_profile_idx on public.brain_entity_profile_history (entity_profile_id, computed_at desc);

create table public.brain_embeddings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  source_type text not null check (source_type in ('entity_profile', 'knowledge_document')),
  knowledge_document_id uuid,
  chunk_text text not null,
  -- Provisional, schema-only dimension for this milestone: 1536 (a common
  -- embedding width), no model provider selected or called yet, no vector
  -- index created, no row ever populated by this migration — Milestone
  -- 4.1's own charter is schema + pgvector only (docs/12), not generation
  -- or search. Nullable because this milestone never writes a value;
  -- cheaply alterable later once a provider is chosen.
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint brain_embeddings_source_match check (
    (source_type = 'knowledge_document' and knowledge_document_id is not null)
    or (source_type = 'entity_profile' and knowledge_document_id is null)
  ),
  constraint brain_embeddings_knowledge_document_org_fk
    foreign key (organization_id, knowledge_document_id)
    references public.brain_knowledge_documents (organization_id, id)
    on delete cascade,
  unique (organization_id, id)
);

comment on table public.brain_embeddings is
  'Milestone 4.1 Phase 1. Schema-only in this milestone: no embedding is ever generated, no vector index exists, no semantic search reads this table. entity_profile-sourced chunks are linked to their contact/company/deal(s) via brain_embedding_entity_refs, not a direct FK here (a chunk may legitimately span multiple entities). knowledge_document-sourced chunks link directly via knowledge_document_id, ON DELETE CASCADE.';

create table public.brain_embedding_entity_refs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  embedding_id uuid not null,
  entity_type text not null check (entity_type in ('contact', 'company', 'deal')),
  contact_id uuid,
  company_id uuid,
  deal_id uuid,
  created_at timestamptz not null default now(),
  constraint brain_embedding_entity_refs_entity_match check (
    (entity_type = 'contact' and contact_id is not null and company_id is null and deal_id is null)
    or (entity_type = 'company' and company_id is not null and contact_id is null and deal_id is null)
    or (entity_type = 'deal' and deal_id is not null and contact_id is null and company_id is null)
  ),
  constraint brain_embedding_entity_refs_embedding_org_fk
    foreign key (organization_id, embedding_id)
    references public.brain_embeddings (organization_id, id)
    on delete cascade,
  constraint brain_embedding_entity_refs_contact_org_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id)
    on delete cascade,
  constraint brain_embedding_entity_refs_company_org_fk
    foreign key (organization_id, company_id)
    references public.companies (organization_id, id)
    on delete cascade,
  constraint brain_embedding_entity_refs_deal_org_fk
    foreign key (organization_id, deal_id)
    references public.deals (organization_id, id)
    on delete cascade
);

comment on table public.brain_embedding_entity_refs is
  'Milestone 4.1 Phase 1. Junction table: which entities a given brain_embeddings chunk is about (a chunk may reference more than one entity — e.g. a paragraph discussing both a contact and their deal — via more than one row here). Each entity ref is ON DELETE CASCADE to its owning contact/company/deal, so a hard erasure removes that entity''s own refs structurally; execute_contact_erasure() (see 20260905090400) additionally captures every brain_embeddings id linked to the target contact before the cascade fires and deletes those artifacts in full, even when another entity''s ref on the same chunk survives — a shared chunk is never kept just because a company/deal ref remains. Unrelated embeddings orphaned for any other reason are never swept.';

create unique index brain_embedding_entity_refs_contact_uidx on public.brain_embedding_entity_refs (embedding_id, contact_id) where contact_id is not null;
create unique index brain_embedding_entity_refs_company_uidx on public.brain_embedding_entity_refs (embedding_id, company_id) where company_id is not null;
create unique index brain_embedding_entity_refs_deal_uidx on public.brain_embedding_entity_refs (embedding_id, deal_id) where deal_id is not null;
create index brain_embedding_entity_refs_org_idx on public.brain_embedding_entity_refs (organization_id);

create table public.brain_sync_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  sync_key text not null,
  last_synced_at timestamptz,
  last_synced_event_id uuid,
  cursor jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (organization_id, sync_key)
);

comment on table public.brain_sync_state is
  'Milestone 4.1 Phase 1. One row per (organization, ingestion source) tracking how far Brain ingestion has progressed — e.g. sync_key = ''crm_contacts'' or ''visitor_identifications''. Carries no personal data itself (a cursor/watermark only), so it is deliberately excluded from data_retention_policies registration and from the GDPR erasure cascade, same reasoning already applied to tags/taggings (20260817090200).';
