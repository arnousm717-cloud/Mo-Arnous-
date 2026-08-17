-- Milestone 2.3A: RLS + grants for activities/notes/tags/taggings,
-- following the exact companies/contacts/pipelines/deals precedent
-- (20260812120100/20260814100100) — same policy shape, same "no anon"
-- posture. No agency roll-up access is added here (out of 2.3A's scope,
-- matching every other CRM resource so far — no
-- agency_rollup_activities/notes/tags view exists).

alter table public.activities enable row level security;
alter table public.notes enable row level security;
alter table public.tags enable row level security;
alter table public.taggings enable row level security;

-- No DELETE policy on activities/notes/tags — ordinary "delete" here is
-- an UPDATE setting deleted_at, never a real DELETE, matching
-- companies/contacts/pipelines/pipeline_stages/deals.

create policy activities_select_own on public.activities
  for select
  using (organization_id = current_org());

create policy activities_insert_own on public.activities
  for insert
  with check (organization_id = current_org());

create policy activities_update_own on public.activities
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

create policy notes_select_own on public.notes
  for select
  using (organization_id = current_org());

create policy notes_insert_own on public.notes
  for insert
  with check (organization_id = current_org());

create policy notes_update_own on public.notes
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

create policy tags_select_own on public.tags
  for select
  using (organization_id = current_org());

create policy tags_insert_own on public.tags
  for insert
  with check (organization_id = current_org());

create policy tags_update_own on public.tags
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

-- Taggings: the one deliberate departure from the "no DELETE" precedent
-- in this table family, mirroring idempotency_keys_delete_own
-- (20260813110000) exactly — same reasoning: a tagging is a relationship
-- row with no soft-delete concept, not a standalone historical CRM
-- record (2.3 frozen design decision, docs/13 Milestone 2.3). No UPDATE
-- policy — a tagging is created or removed, never modified in place.
--
-- Accepted, documented defense-in-depth exception (docs/13 Milestone
-- 2.3, security analysis): this RLS policy, like every other policy in
-- this project, enforces the tenant boundary only (organization_id =
-- current_org()) — it does not and cannot distinguish caller role
-- (current_role() is never referenced by any RLS policy anywhere in this
-- codebase, by design; RBAC role differentiation is exclusively an
-- application-layer concern, packages/auth's can()). An authenticated
-- user with direct database/PostgREST access (bypassing the application
-- API entirely) could therefore physically delete a same-organization
-- tagging even without tags:delete RBAC. This is a LOW-severity, ACCEPTED
-- risk: no cross-tenant exposure, no PII disclosure, and fully
-- reversible (re-applying a tag costs one write) — categorically
-- different from the risk a similar gap would pose on companies/
-- contacts/deals. Not redesigned in 2.3A per the frozen decision.

create policy taggings_select_own on public.taggings
  for select
  using (organization_id = current_org());

create policy taggings_insert_own on public.taggings
  for insert
  with check (organization_id = current_org());

create policy taggings_delete_own on public.taggings
  for delete
  using (organization_id = current_org());

-- SELECT/INSERT/UPDATE only for activities/notes/tags, no DELETE.
-- Taggings additionally gets DELETE (see above) but never UPDATE.
-- TRUNCATE/REFERENCES/TRIGGER and every other privilege are already
-- denied to authenticated/anon by the M1.9 default-privilege hardening
-- (20260811100000/20260811110000, `IN SCHEMA public`) for every table
-- created after those migrations, including these four — no explicit
-- revoke needed here. No grant of any kind to anon: no existing or
-- planned flow gives anon access to CRM tables.
grant select, insert, update on public.activities to authenticated;
grant select, insert, update on public.notes to authenticated;
grant select, insert, update on public.tags to authenticated;
grant select, insert, delete on public.taggings to authenticated;
