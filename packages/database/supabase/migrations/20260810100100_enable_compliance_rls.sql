-- RLS + base grants for the four compliance tables (M1.6). Same two-layer
-- discipline as every table since M1.2 (docs/08-Security.md §2): a table
-- with RLS enabled but no GRANT fails closed on "permission denied" before
-- RLS is ever evaluated, so both are required together, never one alone.
--
-- Decision F (approved M1.6 plan): every policy below is org_admin-only.
-- agency_owner/agency_admin get no access to any of these four tables in
-- M1.6 — agency-facing compliance workflows are explicitly deferred.

grant select, insert on public.consent_records to authenticated;
grant select, insert, update on public.data_subject_requests to authenticated;
-- audit_logs: SELECT + INSERT only — no UPDATE, no DELETE grant at all.
-- This is the actual immutability enforcement (a missing grant is a
-- stronger guarantee than an absent policy, per the same M1.2 lesson that
-- shaped every other table's grants); an RLS policy alone would only be as
-- strong as remembering never to write one for UPDATE/DELETE.
grant select, insert on public.audit_logs to authenticated;
grant select on public.data_retention_policies to authenticated;

alter table public.consent_records enable row level security;

create policy "consent_records_org_admin_select" on public.consent_records
  for select
  using (organization_id = current_org() and current_role_key() = 'org_admin');

create policy "consent_records_org_admin_insert" on public.consent_records
  for insert
  with check (organization_id = current_org() and current_role_key() = 'org_admin');

alter table public.data_subject_requests enable row level security;

create policy "data_subject_requests_org_admin_select" on public.data_subject_requests
  for select
  using (organization_id = current_org() and current_role_key() = 'org_admin');

create policy "data_subject_requests_org_admin_insert" on public.data_subject_requests
  for insert
  with check (organization_id = current_org() and current_role_key() = 'org_admin');

-- UPDATE is intentionally NOT opened to ordinary org_admin writes here —
-- the only supported status transition (pending -> completed) happens
-- exclusively inside execute_user_erasure() (SECURITY DEFINER, next
-- migration), which bypasses RLS entirely and re-validates authorization
-- itself. An org_admin editing a DSR row's status directly (skipping the
-- erasure function's blocker checks and audit write) is exactly the class
-- of bug this milestone exists to make structurally impossible.

alter table public.audit_logs enable row level security;

-- Platform-level entries (organization_id is null) are deliberately not
-- readable through this policy — no platform-operator access path exists
-- yet (docs/08-Security.md §6 names this as a future, separately-audited
-- mechanism). Known, documented gap, not an oversight.
create policy "audit_logs_org_admin_select" on public.audit_logs
  for select
  using (organization_id = current_org() and current_role_key() = 'org_admin');

-- INSERT has no RLS policy at all — by the same safe-default-absence
-- pattern used for agencies/organizations write paths in M1.2/M1.4, this
-- makes ordinary application-layer inserts (organization_id = current_org())
-- impossible for any role by default. The two places this milestone writes
-- audit_logs (consent.ts, data-subject-requests.ts filing) do so via
-- withTenantContext with the acting org_admin's own current_org() already
-- set — but since no INSERT policy exists, THAT path alone would fail.
-- A permissive insert policy scoped to org_admin's own org is what those
-- app-layer writes actually need; execute_user_erasure()'s own INSERT
-- bypasses this entirely as SECURITY DEFINER, same as its UPDATE above.
create policy "audit_logs_org_admin_insert" on public.audit_logs
  for insert
  with check (organization_id = current_org() and current_role_key() = 'org_admin');

alter table public.data_retention_policies enable row level security;

-- Read-only in M1.6 (no editor UI, no purge job) — org_admin can see their
-- own org's policy rows plus platform-default rows (organization_id null),
-- the same "org row or platform default" shape brand_themes' inheritance
-- resolution already established for a different table.
create policy "data_retention_policies_select" on public.data_retention_policies
  for select
  using (
    current_role_key() = 'org_admin'
    and (organization_id = current_org() or organization_id is null)
  );

-- Queryable overdue/breach state (Decision E) — a named, explicit view
-- rather than every call site re-deriving "due_at < now() and status <>
-- completed" independently. Ordinary view (not owner-security-invoker), so
-- it inherits data_subject_requests' own RLS — org_admin sees only their
-- own org's overdue requests, consistent with every other read path in this
-- milestone. No alerting/notification consumer exists yet (explicitly out
-- of scope, Decision E) — this view is the queryable primitive that a
-- future alerting job would read from, not the alerting mechanism itself.
create view public.data_subject_request_breaches as
  select *
  from public.data_subject_requests
  where due_at < now()
    and status <> 'completed';

comment on view public.data_subject_request_breaches is
  'SLA-breach detection primitive (M1.6 Decision E) — rows overdue past their 30-day due_at with no completed status. Inherits data_subject_requests'' own RLS (org_admin, own org only). No notification channel wired to this yet; that is explicitly deferred to the observability/alerting milestone.';

grant select on public.data_subject_request_breaches to authenticated;
