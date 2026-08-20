-- Milestone 3.1B prerequisite (Decision 2, session semantics): additive
-- follow-up to the 3.1A schema (20260820090000_create_tracking_visitor_
-- intelligence_schema.sql) -- never editing that migration directly.
-- visitor_sessions has zero rows in any environment this milestone has
-- touched (confirmed empirically before writing this migration), so a
-- NOT NULL column can be added directly, with no default/backfill step.
--
-- Session identity is now represented by a client-generated opaque UUID
-- (the future tracking script, 3.1D, generates it) -- NOT an
-- organization identifier, NOT an authorization credential, NOT trusted
-- for tenant selection, NOT a database primary key. It is only an
-- opaque correlation identifier within an already-authorized
-- organization/tracking-site/visitor scope -- visitor_sessions.id
-- remains the real primary key, server-generated, exactly as before.
--
-- Deliberately NOT added in this migration (approved 3.1B decision):
-- timeout columns, last_activity_at, browser cookie fields, IP fields,
-- user-agent fields, identification fields, new tenant-resolution
-- fields. Session-timeout/continuity semantics remain undecided and are
-- not invented here.

alter table public.visitor_sessions
  add column anonymous_session_id uuid not null;

comment on column public.visitor_sessions.anonymous_session_id is
  'Client-generated (crypto.randomUUID(), 3.1D) opaque correlation identifier -- never trusted as an organization identifier or authorization credential, never a database primary key. The domain layer (3.1B) resolves-or-creates a session by this value scoped within an already-resolved organization/tracking-site/visitor -- see visitor_sessions_org_site_visitor_session_key below.';

-- Race-safety: the four-column scope a resolve-or-create upsert
-- (INSERT ... ON CONFLICT, 3.1B's own future domain logic -- not
-- implemented in this migration) will target. Deliberately does NOT
-- unique-scope organization_id alone with anonymous_session_id -- a
-- client-generated UUID has no cross-organization coordination, so the
-- same value may legitimately, independently exist for a different
-- tracking site or a different visitor within the same organization
-- (e.g. one browser tab open against two different embedded properties)
-- without colliding; only the exact (org, site, visitor, session)
-- 4-tuple must ever be unique. This unique constraint's own index also
-- serves as the lookup path a future resolve-or-create query needs --
-- no separate index required.
alter table public.visitor_sessions
  add constraint visitor_sessions_org_site_visitor_session_key
  unique (organization_id, tracking_site_id, visitor_id, anonymous_session_id);
