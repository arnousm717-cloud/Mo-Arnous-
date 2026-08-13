-- Milestone 2.1F-A: Idempotency-Key foundation (docs/13-Technical-Design-
-- Review.md "Milestone 2.1F-A"). Backs apps/web/app/api/v1/_shared/idempotency.ts,
-- used by the companies/contacts POST/PATCH routes (2.1F-B). Schema + RLS +
-- grants in one migration, since this table has no companion migration
-- split need the way companies/contacts had (no separate function/trigger
-- work depends on it).

create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- SHA-256 hex digest of the raw Idempotency-Key header value — the raw
  -- header itself is never persisted (2.1F-A approved decision). A hash
  -- collision would only ever cause an unrelated key to be treated as a
  -- conflict (safe failure mode: 409, never an accidental replay), not a
  -- security issue.
  idempotency_key_hash text not null,
  method text not null,
  -- The literal request path (e.g. "/api/v1/companies/<uuid>"), not a
  -- pattern — a POST /companies and a PATCH /companies/:id reusing the
  -- same key string must be treated as genuinely different operations.
  route text not null,
  -- SHA-256 hex digest of the normalized (method, route, sorted-key JSON
  -- body) request identity — the raw request body is never persisted
  -- (2.1F-A approved decision).
  request_fingerprint text not null,
  -- Only two values are ever meaningful: 'in_progress' is set at
  -- reservation time inside the owning transaction and is never observed
  -- by any other transaction as a stable, independently-committed state
  -- (a concurrent reader either blocks until this transaction commits,
  -- seeing 'completed', or blocks until it rolls back, seeing no row at
  -- all — see the helper's retry-on-rollback logic). No 'failed' status
  -- exists: an unexpected error rolls back the whole transaction,
  -- including this row's own insert, rather than persisting a failure
  -- record.
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  response_status integer,
  -- May contain contact PII (email/phone/name) for a successful contact
  -- create/update — a deliberate, TTL-bounded trade-off (2.1F-A approved
  -- decision): exact replay semantics require storing the real response
  -- that was actually returned, not a value re-derived from current state,
  -- which could differ if the underlying record was mutated by an
  -- unrelated request in between.
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- The sole access pattern this table has: "does a reservation already
  -- exist for this exact (org, key)". No other column combination is ever
  -- queried, so this unique constraint's own automatically-created index
  -- is the only index this table needs — no speculative listing/reporting
  -- index is added.
  unique (organization_id, idempotency_key_hash)
);

comment on table public.idempotency_keys is
  'Milestone 2.1F-A. Ephemeral operational plumbing for Idempotency-Key replay on companies/contacts POST/PATCH — not user-facing CRM data, no GDPR/audit significance, no soft-delete convention (unlike companies/contacts, a real DELETE is used for expired-key reclamation). 24-hour retention window (expires_at), no scheduled cleanup job — expired rows are reclaimed inline by the request that next collides with them.';

alter table public.idempotency_keys enable row level security;

create policy idempotency_keys_select_own on public.idempotency_keys
  for select
  using (organization_id = current_org());

create policy idempotency_keys_insert_own on public.idempotency_keys
  for insert
  with check (organization_id = current_org());

create policy idempotency_keys_update_own on public.idempotency_keys
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

-- The one deliberate departure from the companies/contacts "no DELETE"
-- precedent: that convention exists because CRM records are recoverable
-- user data (soft-delete/trash model). This table holds no user-facing
-- data and has no soft-delete concept — a real DELETE is required for
-- inline expired-key reclamation (2.1F-A approved decision).
create policy idempotency_keys_delete_own on public.idempotency_keys
  for delete
  using (organization_id = current_org());

-- SELECT/INSERT/UPDATE/DELETE for authenticated only, matching the
-- approved grant list exactly. No grant of any kind to anon — no existing
-- or planned flow gives anon access to this table. TRUNCATE/REFERENCES/
-- TRIGGER are already denied to authenticated/anon by the M1.9
-- default-privilege hardening for every future table, including this one.
grant select, insert, update, delete on public.idempotency_keys to authenticated;
