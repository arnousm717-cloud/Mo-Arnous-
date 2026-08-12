-- Milestone 2.1B: RLS + grants for companies/contacts, following the
-- established grant+policy discipline (ADR-003, docs/08-Security.md §2 —
-- "neither layer alone is trusted as sufficient") and the exact M1.2
-- precedent of shipping this as a migration separate from schema.

alter table public.companies enable row level security;
alter table public.contacts enable row level security;

-- No DELETE policy on either table, matching the public.users precedent
-- (not organizations/memberships, which have genuine hard-delete
-- lifecycle needs these tables don't) — ordinary "delete" here is an
-- UPDATE setting deleted_at, never a real DELETE.

create policy companies_select_own on public.companies
  for select
  using (organization_id = current_org());

create policy companies_insert_own on public.companies
  for insert
  with check (organization_id = current_org());

-- WITH CHECK is written explicitly, identical to USING, even though
-- PostgreSQL would already imply this from USING alone when WITH CHECK is
-- omitted on an UPDATE policy (the USING expression is reused as the
-- check on the resulting row). Explicit here so a future reader/editor
-- doesn't need to know that implicit-reuse rule to see that
-- organization_id can never be changed to another tenant's value by this
-- policy.
create policy companies_update_own on public.companies
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

create policy contacts_select_own on public.contacts
  for select
  using (organization_id = current_org());

create policy contacts_insert_own on public.contacts
  for insert
  with check (organization_id = current_org());

create policy contacts_update_own on public.contacts
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

-- SELECT/INSERT/UPDATE only, no DELETE. TRUNCATE/REFERENCES/TRIGGER are
-- already denied to authenticated/anon by the M1.9 default-privilege
-- hardening (20260811100000_revoke_dangerous_default_table_privileges.sql
-- ALTER DEFAULT PRIVILEGES) for every future table, including these two —
-- no explicit revoke needed here. No grant of any kind to anon: no
-- existing or planned flow gives anon access to CRM tables.
grant select, insert, update on public.companies to authenticated;
grant select, insert, update on public.contacts to authenticated;
