-- Milestone 3.1A: RLS + grants for tracking_sites/website_visitors/
-- visitor_sessions/visitor_events -- companion to the schema migration,
-- following the established schema-then-RLS precedent
-- (20260812120000/20260812120100, 20260814100000/20260814100100,
-- 20260817090000/20260817090100).
--
-- Standard ADR-003 tenant-isolation policy shape throughout -- no broad
-- cross-tenant policy, no anonymous INSERT policy, no RLS bypass of any
-- kind for these four tables. The only pre-tenant, cross-organization
-- read in this milestone is the narrow SECURITY DEFINER resolver
-- function (companion migration, 20260820090200) -- it does not touch
-- these tables' own RLS policies at all; it reads tracking_sites via its
-- own elevated, narrowly-scoped execution context, entirely separately
-- from the ordinary policies below.
--
-- No ingestion/consent-record/rate-limiting code exists yet (3.1B/C) --
-- these grants only enable the ordinary authenticated, tenant-scoped
-- access pattern every other CRM-family table already has. TRUNCATE/
-- REFERENCES/TRIGGER and every other privilege beyond what is granted
-- explicitly below are already denied to authenticated/anon by the M1.9
-- default-privilege hardening (20260811100000/20260811110000, IN SCHEMA
-- public) for every table created after those migrations, including
-- these four -- no explicit revoke needed here.

alter table public.tracking_sites enable row level security;
alter table public.website_visitors enable row level security;
alter table public.visitor_sessions enable row level security;
alter table public.visitor_events enable row level security;

-- tracking_sites: no soft-delete column (revoked_at is a distinct
-- lifecycle concept, not deleted_at) -- ordinary "remove" is revoking,
-- an UPDATE, never a real DELETE. No DELETE policy/grant, matching the
-- companies/contacts/pipelines/deals/activities/notes/tags precedent for
-- every other entity governed by a lifecycle flag rather than physical
-- deletion.

create policy tracking_sites_select_own on public.tracking_sites
  for select
  using (organization_id = current_org());

create policy tracking_sites_insert_own on public.tracking_sites
  for insert
  with check (organization_id = current_org());

create policy tracking_sites_update_own on public.tracking_sites
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

create policy website_visitors_select_own on public.website_visitors
  for select
  using (organization_id = current_org());

create policy website_visitors_insert_own on public.website_visitors
  for insert
  with check (organization_id = current_org());

create policy website_visitors_update_own on public.website_visitors
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

create policy visitor_sessions_select_own on public.visitor_sessions
  for select
  using (organization_id = current_org());

create policy visitor_sessions_insert_own on public.visitor_sessions
  for insert
  with check (organization_id = current_org());

create policy visitor_sessions_update_own on public.visitor_sessions
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

create policy visitor_events_select_own on public.visitor_events
  for select
  using (organization_id = current_org());

create policy visitor_events_insert_own on public.visitor_events
  for insert
  with check (organization_id = current_org());

-- No UPDATE policy on visitor_events -- an event is an immutable,
-- append-only fact once recorded (matching audit_logs'/events' own
-- append-only discipline), never edited in place.

grant select, insert, update on public.tracking_sites to authenticated;
grant select, insert, update on public.website_visitors to authenticated;
grant select, insert, update on public.visitor_sessions to authenticated;
grant select, insert on public.visitor_events to authenticated;

-- No grant of any kind to anon on any of these four tables -- the future
-- ingestion/consent-record write path (3.1B/C) always runs through the
-- application's own backend connection under the authenticated role
-- (identical to every other tenant-scoped write in this codebase --
-- verified directly against packages/database/src/tenant-context.ts's
-- withTenantContext, which sets `set local role authenticated`
-- unconditionally for every caller type, never a distinct anon-role
-- connection -- 3.1 architecture decision report Section 3). anon never
-- touches these tables directly, at any point.
