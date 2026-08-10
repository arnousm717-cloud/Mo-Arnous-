-- GDPR primitives (M1.6, docs/03-Database-Architecture.md §2.8,
-- docs/08-Security.md §5/§6). Four tables: consent_records,
-- data_subject_requests, audit_logs, data_retention_policies.
--
-- Scope note (M1.6 approved plan, Decision A): data_subject_requests.
-- subject_type gains a 'user' value beyond the three originally documented
-- (contact/visitor/portal_user) — none of those three exist as tables yet
-- (Phase 2/6), so 'user' (a staff public.users row) is the only subject this
-- milestone can build a real, testable erasure cascade against. The other
-- three values are kept in the CHECK constraint for forward-schema-
-- compatibility with Phase 2+, even though no code path produces them yet.
-- consent_records.subject_type is NOT extended with 'user' — consent
-- (marketing/tracking) is not a concept that applies to a staff account,
-- so extending it there would be scope creep beyond what was approved.

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  subject_type text not null check (subject_type in ('contact', 'visitor', 'portal_user')),
  subject_id uuid not null,
  consent_type text not null check (consent_type in ('marketing_email', 'cookie_tracking', 'data_processing')),
  status text not null check (status in ('granted', 'withdrawn')),
  source text,
  ip_address inet,
  recorded_at timestamptz not null default now()
);

comment on table public.consent_records is
  'Append-only (docs/08-Security.md §5) — a withdrawal is recorded as a new row, never an update to a prior grant. subject_id/subject_type is a polymorphic reference (application-enforced, no physical FK), matching this schema''s existing pattern for activities/notes/taggings (docs/03 §3) since no single subject table exists yet to point a real FK at.';

create index consent_records_org_subject_idx on public.consent_records (organization_id, subject_type, subject_id);

create table public.data_subject_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  subject_type text not null check (subject_type in ('contact', 'visitor', 'portal_user', 'user')),
  subject_id uuid not null,
  request_type text not null check (request_type in ('access', 'export', 'delete')),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed')),
  requested_at timestamptz not null default now(),
  -- Set by the trigger below, not a GENERATED column — now() (used to
  -- default requested_at) is STABLE, not IMMUTABLE, which Postgres
  -- requires for a generated column's expression; a BEFORE INSERT trigger
  -- gets the same "database fact, not an application call site's job to
  -- remember" property without that restriction.
  due_at timestamptz not null,
  completed_at timestamptz,
  handled_by uuid references public.users (id) on delete set null
);

create or replace function public._set_data_subject_request_due_at()
returns trigger
language plpgsql
as $$
begin
  new.due_at := new.requested_at + interval '30 days';
  return new;
end;
$$;

create trigger data_subject_requests_set_due_at
  before insert on public.data_subject_requests
  for each row
  execute function public._set_data_subject_request_due_at();

comment on table public.data_subject_requests is
  'Drives the erasure orchestration (docs/08-Security.md §5). M1.6 scope: only request_type=''delete'' against subject_type=''user'' is actually executable (see preview_user_erasure/execute_user_erasure) — access/export and the other three subject types are schema-ready but have no fulfillment logic yet, deliberately (approved M1.6 plan constraint: do not over-generalize beyond users/memberships). handled_by is nullable and ON DELETE SET NULL, not CASCADE — a completed request row must outlive the staff member who handled it, including the case where that same handler is erased in a later, separate request.';

create index data_subject_requests_org_status_idx on public.data_subject_requests (organization_id, status);
-- Backs the overdue/breach query (Decision E: due_at < now() and status <>
-- completed) without a full table scan as request volume grows.
create index data_subject_requests_due_at_idx on public.data_subject_requests (due_at) where status <> 'completed';

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  actor_user_id uuid references public.users (id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  before jsonb,
  after jsonb,
  ip_address inet,
  occurred_at timestamptz not null default now()
);

comment on table public.audit_logs is
  'Append-only (docs/08-Security.md §6) — no updated_at/deleted_at, and deliberately no UPDATE/DELETE grant at all (see the RLS/grants migration), not just an absent policy. actor_user_id is ON DELETE SET NULL: an audit entry must survive the erasure of the person who acted, since the entry itself is the historical record of what they did, not a live reference to their still-existing account. resource_id is a polymorphic reference (no physical FK), same reasoning as consent_records.subject_id — an erased resource (e.g. an erased user) must not block deletion, and the entry remains meaningful via before/after alone.';

create index audit_logs_org_occurred_idx on public.audit_logs (organization_id, occurred_at);

create table public.data_retention_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  data_type text not null,
  retention_days integer not null check (retention_days > 0),
  last_purge_run_at timestamptz,
  unique (organization_id, data_type)
);

comment on table public.data_retention_policies is
  'organization_id null = platform default for that data_type (docs/03 §2.8). Schema + platform-default seed rows only in M1.6 — no scheduled purge job exists yet (that is a later Edge Function milestone, not part of the M1.6 approved plan). Postgres treats NULL as distinct in unique constraints, so multiple platform-default rows (organization_id null) coexist correctly as long as each has a distinct data_type.';

-- Platform-default retention rows for the data types this milestone
-- actually creates. Values are directional placeholders (documented as such
-- — not derived from any legal review), reviewable later without a schema
-- change, per this table's own stated purpose.
insert into public.data_retention_policies (organization_id, data_type, retention_days) values
  (null, 'audit_logs', 2555),      -- ~7 years, standard audit-trail retention baseline
  (null, 'consent_records', 2555), -- kept as long as audit_logs — consent history is itself compliance evidence
  (null, 'data_subject_requests', 2555);
