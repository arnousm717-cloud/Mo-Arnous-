-- Milestone 3.1A: Tracking Sites + Website Visitor Intelligence -- schema
-- only (docs/13-Technical-Design-Review.md "Milestone 3.1A" architecture
-- decision report). RLS/grants are the companion migration that follows
-- this one, matching the established schema-then-RLS precedent
-- (20260812120000/20260812120100, 20260814100000/20260814100100,
-- 20260817090000/20260817090100).
--
-- Scope: schema only. No ingestion endpoint, no tracking script, no
-- consent-record endpoint, no rate limiting, no n8n, no visitor
-- identification logic exist yet -- see the 3.1A architecture decision
-- report for the full design and the 3.1B/C/D boundary. Every table
-- below has zero rows until a later sub-phase's write path ships.
--
-- Deviation from docs/03-Database-Architecture.md Section 2.3's one-line
-- schema table, reported per the 3.1A brief's own instruction not to
-- blindly implement docs/03 where analysis proves an adjustment
-- necessary: docs/03 lists visitor_sessions/visitor_events WITHOUT an
-- organization_id column. Every other high-volume child table in this
-- repository needing a tenant-safety composite FK to its parent
-- (activities, notes, taggings, pipeline_stages, deals --
-- 20260812120000 through 20260817090000) denormalizes organization_id
-- onto the child row specifically to make that composite FK possible --
-- a plain session_id/tracking_site_id/visitor_id FK alone provides zero
-- structural tenant-safety guarantee (a row belonging to org A could
-- otherwise reference a parent row belonging to org B, independent of
-- RLS -- docs/03 Section 5's own "RLS is defense-in-depth, not the only
-- check" principle). Both tables gain their own organization_id column
-- here, following that identical, already-established pattern -- not a
-- new decision, an application of an existing one. docs/03 is corrected
-- to match in this same milestone's documentation update.

create table public.tracking_sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  label text,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  -- Required so website_visitors'/visitor_sessions' own composite FKs
  -- below (tenant-safety half) have a composite unique target to
  -- reference -- id alone is already unique (PK); the pair is what a
  -- composite FK needs (pipelines/pipeline_stages/tags precedent).
  unique (organization_id, id)
);

comment on table public.tracking_sites is
  'Milestone 3.1A. id is the public tracking-site identifier itself -- intentionally public, non-secret, meant to be embedded in a customer''s browser-served JavaScript once the tracking script ships (3.1D). Deliberately NOT hashed at rest (3.1 architecture decision report''s public-identifier-vs-secret analysis): unlike api_keys.key_hash, this value has no confidentiality to protect -- it is published in every installing customer''s page source by design, so hashing it would defend against a threat (database-read exposure) that provides no actual protection, since the same value is already readable from the public page. Its security properties are unguessability (gen_random_uuid()''s ~122 bits) and narrow scope (grants nothing beyond what resolve_tracking_site() -- the companion function migration -- returns: an organization_id, nothing else), not secrecy. Multiple rows per organization are expected and supported (one per tenant property/site). Rotation is a new row plus revoking the old one, never mutating id in place (api_keys.revoked_at precedent) -- the public identifier itself is never reused. No last_seen_at/allowed_origins in 3.1A -- deliberately deferred (no current writer for the former; origin policy is unenforced and undesigned for 3.1, see the architecture decision report Section 13/15).';

create index tracking_sites_org_idx on public.tracking_sites (organization_id);

create table public.website_visitors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  anonymous_id uuid not null,
  -- Tenant-safety composite FK, nullable, ON DELETE SET NULL (column
  -- list form) -- identical shape/reasoning to deals.primary_contact_id
  -- (20260814100000): an identified visitor must survive contact
  -- erasure/soft-delete rather than retaining a dangling reference.
  -- Never populated by any 3.1A code path -- schema-ready for Milestone
  -- 3.2's identification logic only (3.1A architecture decision report,
  -- Decision B exclusions).
  identified_contact_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint website_visitors_contact_org_fk
    foreign key (organization_id, identified_contact_id)
    references public.contacts (organization_id, id)
    on delete set null (identified_contact_id),
  -- Race-safe resolve-or-create target for the future ingestion write
  -- path (3.1C) -- the same anonymous_id must map to at most one visitor
  -- row per organization; two different organizations may independently
  -- reuse the same anonymous_id value with no collision (it is a
  -- client-generated UUID, not globally coordinated).
  unique (organization_id, anonymous_id),
  -- Required so visitor_sessions' own composite FK below (tenant-safety
  -- half) has a composite unique target to reference.
  unique (organization_id, id)
);

comment on table public.website_visitors is
  'Milestone 3.1A: schema only. anonymous_id is a client-generated (crypto.randomUUID()) opaque identifier -- never itself a secret or credential. It is also the value consent_records.subject_id will hold for subject_type=''visitor'' once the consent-record endpoint ships (3.1C) -- consent_records.subject_id has no FK (verified against 20260810100000''s DDL), so a consent grant can exist for an anonymous_id before any row here does (3.1 architecture decision report Sections 5-7). identified_contact_id is schema-ready and deliberately unpopulated in 3.1A -- see column comment.';

create index website_visitors_org_last_seen_idx on public.website_visitors (organization_id, last_seen_at);
create index website_visitors_org_contact_idx on public.website_visitors (organization_id, identified_contact_id);

create table public.visitor_sessions (
  id uuid primary key default gen_random_uuid(),
  -- Added beyond docs/03's literal one-line spec -- see this migration's
  -- header comment for why (established repository pattern for
  -- tenant-safe composite FKs, applied identically here).
  organization_id uuid not null references public.organizations (id) on delete cascade,
  visitor_id uuid not null,
  -- NOT NULL -- every session created by 3.1's actual future write path
  -- always originates from exactly one resolved tracking_sites row;
  -- there is no code path that creates a session without first
  -- resolving a tracking credential (3.1 architecture decision report
  -- Sections 3/7). Confirmed safe against the pre-implementation
  -- invariant audit: this is a brand-new table with zero existing rows,
  -- so NOT NULL creates no backfill incompatibility.
  tracking_site_id uuid not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  landing_page text,
  device_type text,
  -- Tenant-safety half: proves visitor_id belongs to this session's own
  -- organization (pipeline_stages_pipeline_org_fk/deals_*_org_fk
  -- precedent). ON DELETE CASCADE: a session has no meaningful existence
  -- without its visitor, mirroring pipeline_stages_pipeline_org_fk's own
  -- reasoning -- a visitor is never hard-deleted by ordinary application
  -- code (no DELETE grant/policy, see companion RLS migration), so this
  -- never fires in ordinary operation; it is a structural safety net.
  constraint visitor_sessions_visitor_org_fk
    foreign key (organization_id, visitor_id)
    references public.website_visitors (organization_id, id)
    on delete cascade,
  -- Tenant-safety half: proves tracking_site_id belongs to this
  -- session's own organization. ON DELETE RESTRICT (not CASCADE): a
  -- revoked tracking site must not silently destroy historical session
  -- data -- revocation is revoked_at, never a DELETE, matching this
  -- table family's consistent soft-lifecycle convention; RESTRICT simply
  -- documents that a hard DELETE of a tracking_sites row (never
  -- exercised by any 3.1A code path) cannot orphan/cascade-destroy
  -- session history.
  constraint visitor_sessions_tracking_site_org_fk
    foreign key (organization_id, tracking_site_id)
    references public.tracking_sites (organization_id, id)
    on delete restrict,
  -- Required so visitor_events' own composite FK below (tenant-safety
  -- half) has a composite unique target to reference.
  unique (organization_id, id)
);

comment on table public.visitor_sessions is
  'Milestone 3.1A: schema only. organization_id denormalized beyond docs/03''s literal spec -- see this migration''s header comment. tracking_site_id is NOT NULL: every session this platform ever creates originates from a resolved tracking credential (3.1 architecture decision report). No ingestion write path exists yet in 3.1A -- this table has zero rows until 3.1C ships.';

create index visitor_sessions_org_visitor_idx on public.visitor_sessions (organization_id, visitor_id);
create index visitor_sessions_org_tracking_site_idx on public.visitor_sessions (organization_id, tracking_site_id);
create index visitor_sessions_org_started_idx on public.visitor_sessions (organization_id, started_at);

create table public.visitor_events (
  id uuid primary key default gen_random_uuid(),
  -- Added beyond docs/03's literal one-line spec -- see this migration's
  -- header comment.
  organization_id uuid not null references public.organizations (id) on delete cascade,
  session_id uuid not null,
  event_type text not null check (event_type in ('pageview', 'form_submit', 'click')),
  url text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  -- Tenant-safety half: proves session_id belongs to this event's own
  -- organization -- without this, a plain FK alone would let an event
  -- attach to any organization's session regardless of this row's own
  -- organization_id, independent of RLS. ON DELETE CASCADE: an event has
  -- no meaningful existence without its session, same reasoning as
  -- visitor_sessions_visitor_org_fk above.
  constraint visitor_events_session_org_fk
    foreign key (organization_id, session_id)
    references public.visitor_sessions (organization_id, id)
    on delete cascade
);

comment on table public.visitor_events is
  'Milestone 3.1A: schema only. organization_id denormalized beyond docs/03''s literal spec -- see this migration''s header comment. High-volume, append-only -- monthly partitioning explicitly deferred (docs/03 Section 4, Phase 8 per 10-CLAUDE.md''s "no speculative scaling work" doctrine) until real ingestion volume justifies it; not implemented in 3.1A. No GIN index on metadata -- added only once a specific query pattern justifies it (docs/03 Section 4), not speculatively. No ingestion write path exists yet -- this table has zero rows until 3.1C ships.';

create index visitor_events_org_occurred_idx on public.visitor_events (organization_id, occurred_at);
create index visitor_events_org_session_idx on public.visitor_events (organization_id, session_id);
