-- Milestone 3.1C-A: rate-limit counter storage for the future public
-- collect/consent HTTP endpoints (3.1C-C, not yet built). Schema only --
-- no HTTP route, no TS wrapper, no application code anywhere in this
-- milestone touches this table yet.
--
-- Stores ONLY an opaque, application-computed SHA-256 hex digest as
-- bucket_hash -- never a raw IP address, raw tracking-site key, raw
-- anonymous_id, raw anonymous_session_id, or organization_id. Hashing
-- happens application-side (TypeScript, mirroring
-- apps/web/app/api/v1/_shared/idempotency.ts's own sha256Hex precedent
-- exactly), before any value ever reaches this table or a SQL parameter
-- -- the strongest available property against a raw identifier ever
-- surfacing here or in any query log. This table has no legitimate
-- staff-facing use case at all (unlike tracking_sites), so it carries no
-- ordinary RLS policy shape -- see the companion RLS migration.
--
-- window_start is computed exclusively inside check_tracking_rate_limit()
-- (companion function migration) from the database's own now() -- never
-- accepted as a parameter from any caller, closing the "caller supplies
-- a fresh timestamp on every call to escape accumulation" flaw identified
-- and rejected during the 3.1C-A design review.

create table public.rate_limit_counters (
  bucket_hash text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket_hash, window_start)
);

comment on table public.rate_limit_counters is
  'Milestone 3.1C-A. Opaque SHA-256 hex digest bucket keys only -- never a raw IP/site-key/anonymous_id/anonymous_session_id/organization_id. Fixed-window counters for the future public tracking collect/consent endpoints (3.1C-C). No RLS policy exists (see companion migration) -- the sole access path is check_tracking_rate_limit(), never a direct table grant to any role.';

-- Required for check_tracking_rate_limit()'s own opportunistic global
-- age-based cleanup (window_start < now() - interval '24 hours'), which
-- filters purely on window_start with no bucket_hash constraint -- the
-- primary key's own (bucket_hash, window_start) ordering cannot serve
-- that predicate efficiently, since bucket_hash is the leading column.
create index rate_limit_counters_window_start_idx on public.rate_limit_counters (window_start);
