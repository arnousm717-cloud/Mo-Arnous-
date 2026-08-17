-- Milestone 2.3A: Activities, Notes, Tags & Taggings — schema only
-- (docs/13-Technical-Design-Review.md "Milestone 2.3", frozen design +
-- GDPR correction). RLS/grants are the companion migration that follows
-- this one, matching the established M1.2/2.1B/2.2A precedent of shipping
-- schema and RLS/grants as separate migrations.
--
-- Polymorphic associations (activities.related_to_type/related_to_id,
-- notes.related_to_type/related_to_id, taggings.taggable_type/
-- taggable_id) are deliberately NOT backed by a real foreign key —
-- Postgres cannot express "id references company/contact/deal depending
-- on a sibling column's value" (docs/03-Database-Architecture.md §3).
-- Tenant-safety and target-existence for these columns is a
-- packages/crm domain-layer responsibility (2.3B) — this migration only
-- proves the allowed-type CHECK and the row's own organization
-- ownership, never a false claim that the DB validates the polymorphic
-- target itself.

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  type text not null check (type in ('call', 'email', 'meeting', 'note', 'task')),
  related_to_type text not null check (related_to_type in ('company', 'contact', 'deal')),
  -- Deliberately NULLABLE — NOT a general design looseness. NULL is
  -- reserved exclusively for the irreversible GDPR contact-erasure path
  -- (execute_contact_erasure(), extended in this milestone's companion
  -- migration): an Activity directly related to an erased Contact
  -- survives with related_to_id set to NULL rather than retaining a
  -- dangling identifier for a physically-deleted row. Ordinary
  -- create/update application code (packages/crm, 2.3B) must always
  -- supply a non-null value — enforced at the domain/API layer, never by
  -- a DB CHECK here, because a CHECK cannot distinguish an ordinary
  -- application write from the compliance function's own write (a
  -- `CHECK (related_to_id is not null)` would block the erasure UPDATE
  -- itself, a self-contradictory constraint).
  related_to_id uuid,
  subject text,
  body text,
  due_at timestamptz,
  completed_at timestamptz,
  created_by uuid references public.users (id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.activities is
  'Milestone 2.3A. Ordinary deletion is deleted_at (soft-delete) only — matches every other CRM entity''s precedent. type=''note'' activities are chronological timeline events distinct from the standalone notes table (2.3 frozen design decision 1) — the latter is a persistent, freely-editable annotation with no due_at/completed_at semantics. related_to_id is nullable solely for GDPR contact erasure (see column comment) — never nulled by ordinary application code.';

create index activities_org_active_idx on public.activities (organization_id) where deleted_at is null;
create index activities_org_related_idx on public.activities (organization_id, related_to_type, related_to_id);
create index activities_org_created_by_idx on public.activities (organization_id, created_by);

create trigger activities_set_updated_at
  before update on public.activities
  for each row
  execute function public.set_updated_at();

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  related_to_type text not null check (related_to_type in ('company', 'contact', 'deal')),
  -- Nullable for the identical GDPR-erasure reason as activities.related_to_id
  -- above — see that column's own comment for the full rationale, not
  -- repeated here.
  related_to_id uuid,
  -- Nullable — NOT the original frozen shape (which specified NOT NULL).
  -- Corrected during 2.3A implementation: GDPR contact erasure must be
  -- able to scrub this column to NULL for a note directly related to the
  -- erased contact (docs/13 Milestone 2.3 GDPR correction), and a DB
  -- NOT NULL constraint would make that UPDATE fail outright — the exact
  -- same self-contradiction already identified for related_to_id, simply
  -- not caught for this column until 2.3A's own pre-implementation
  -- audit. Ordinary createNote (2.3B) still requires a non-empty body at
  -- the domain layer; this is a DB-level relaxation for the compliance
  -- path only, mirroring related_to_id's own discipline exactly.
  body text,
  created_by uuid references public.users (id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.notes is
  'Milestone 2.3A. Ordinary deletion is deleted_at (soft-delete) only. body is nullable solely for GDPR contact erasure (corrected during 2.3A from an originally-frozen NOT NULL — see column comment) — packages/crm''s createNote (2.3B) enforces non-empty body at the domain layer regardless.';

create index notes_org_active_idx on public.notes (organization_id) where deleted_at is null;
create index notes_org_related_idx on public.notes (organization_id, related_to_type, related_to_id);

create trigger notes_set_updated_at
  before update on public.notes
  for each row
  execute function public.set_updated_at();

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  color text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Required so taggings' own composite tenant-safety FK below has a
  -- composite unique target to reference — the same
  -- companies/pipelines/pipeline_stages precedent (2.1B/2.2A).
  unique (organization_id, id)
);

comment on table public.tags is
  'Milestone 2.3A. Ordinary deletion is deleted_at (soft-delete) only. Active tag-name uniqueness is case-insensitive per organization (see tags_org_active_name_idx) — reusing a name after the prior tag with that name is soft-deleted is allowed by design. color is a free-form nullable text column — no design-token/palette system introduced in this milestone.';

create unique index tags_org_active_name_idx
  on public.tags (organization_id, lower(name))
  where deleted_at is null;

create trigger tags_set_updated_at
  before update on public.tags
  for each row
  execute function public.set_updated_at();

create table public.taggings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tag_id uuid not null,
  taggable_type text not null check (taggable_type in ('company', 'contact', 'deal')),
  -- Polymorphic, same discipline and same limitation as
  -- activities/notes.related_to_id above (no real FK possible) — but
  -- deliberately NEVER nullable: a tagging with no target has no
  -- purpose. Unlike activities/notes, a tagging carries no free text and
  -- has no "historical record" worth preserving once its target is
  -- gone — the 2.3 frozen design's resolution is to physically delete
  -- the tagging row itself during contact erasure (this milestone's
  -- companion migration), never to null this column.
  taggable_id uuid not null,
  created_at timestamptz not null default now(),
  -- Tenant-safety half of a two-composite-FK-style design, mirroring
  -- deals_pipeline_org_fk/pipeline_stages_pipeline_org_fk (2.2A):
  -- structurally proves tag_id belongs to this row''s own organization,
  -- independent of RLS or application-layer correctness. ON DELETE
  -- CASCADE (not RESTRICT): a tagging has no existence without its tag,
  -- mirroring pipeline_stages_pipeline_org_fk''s own reasoning exactly —
  -- this never fires via the ordinary application path (tags are
  -- soft-delete only), it is a structural safety net for a privileged/
  -- administrative hard delete.
  constraint taggings_tag_org_fk
    foreign key (organization_id, tag_id)
    references public.tags (organization_id, id)
    on delete cascade,
  -- Duplicate-tagging prevention — the same (tag, target) pair can never
  -- be recorded twice.
  unique (tag_id, taggable_type, taggable_id)
);

comment on table public.taggings is
  'Milestone 2.3A. Deliberate exception to this project''s soft-delete convention (2.3 frozen design decision, docs/13 Milestone 2.3): no deleted_at, no update trigger — a tagging is a relationship row, not a standalone historical CRM record. Removing a tagging is always a physical DELETE, tenant-scoped, never a broader capability. Physically deleted (not merely orphaned) during direct-contact GDPR erasure — see execute_contact_erasure()''s companion migration.';

create index taggings_org_taggable_idx on public.taggings (organization_id, taggable_type, taggable_id);
create index taggings_org_tag_idx on public.taggings (organization_id, tag_id);
