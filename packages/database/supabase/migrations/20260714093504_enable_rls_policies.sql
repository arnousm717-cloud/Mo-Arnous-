-- Row Level Security baseline policies (docs/03-Database-Architecture.md §5).
-- RLS is enabled in the same migration as the tables it protects would be
-- ideal, but since schema and policies are reviewed as a single M1.2 unit
-- and applied atomically in one migration run, there is no window where a
-- table exists without RLS in any environment this ever gets deployed to.

-- Base table-level grants. Tables created via SQL migrations (as opposed to
-- Supabase Studio's Table Editor) do NOT automatically receive grants for
-- the anon/authenticated Postgres roles PostgREST uses — without these,
-- every request would fail with "permission denied for table ..." before
-- RLS is ever evaluated, regardless of how correct the policies below are.
-- RLS remains the actual row-level enforcement; these grants only open the
-- table up to being subject to that enforcement in the first place.
grant usage on schema public to authenticated;
grant select on public.roles to authenticated;
grant select on public.agencies to authenticated;
grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update on public.users to authenticated;
grant select, insert, update, delete on public.memberships to authenticated;

-- roles: global lookup, not tenant-scoped. Readable by anyone signed in;
-- writable only via migrations (which run as the table owner, bypassing RLS).
alter table public.roles enable row level security;

create policy "roles_select_authenticated" on public.roles
  for select
  using (auth.role() = 'authenticated');

-- agencies: scoped by current_agency(). No insert/update/delete policy yet —
-- agency creation is built in M1.4; until then, writes only happen via
-- migrations or a service-role path, which is the safe default absence of
-- a policy already gives us for every non-owner role.
alter table public.agencies enable row level security;

create policy "agencies_select_own" on public.agencies
  for select
  using (id = current_agency());

-- organizations: the core tenant. Insert is deliberately open to any
-- authenticated user — creating your own first organization is exactly
-- the bootstrapping case where current_org() cannot already equal the
-- not-yet-created row's id. M1.3's signup transaction is expected to set
-- app.current_org to the new row's id immediately after this insert,
-- within the same transaction, before the first membership is created.
alter table public.organizations enable row level security;

create policy "organizations_select_own" on public.organizations
  for select
  using (id = current_org());

create policy "organizations_insert_authenticated" on public.organizations
  for insert
  with check (auth.role() = 'authenticated');

create policy "organizations_update_own" on public.organizations
  for update
  using (id = current_org())
  with check (id = current_org());

create policy "organizations_delete_own" on public.organizations
  for delete
  using (id = current_org());

-- users: self-scoped, not organization-scoped. A user reads/writes only
-- their own row. No delete policy — account removal is a GDPR/DSR cascade
-- concern (docs/08-Security.md §5), never an ordinary client-permitted delete.
alter table public.users enable row level security;

create policy "users_select_own" on public.users
  for select
  using (id = auth.uid());

create policy "users_insert_own" on public.users
  for insert
  with check (id = auth.uid());

create policy "users_update_own" on public.users
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- memberships: scoped by organization_id = current_org() for every operation.
-- The first membership row for a brand-new organization relies on the same
-- same-transaction sequencing as the organizations insert policy above.
alter table public.memberships enable row level security;

create policy "memberships_tenant_isolation_select" on public.memberships
  for select
  using (organization_id = current_org());

create policy "memberships_tenant_isolation_write" on public.memberships
  for all
  using (organization_id = current_org())
  with check (organization_id = current_org());
