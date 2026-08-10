-- RLS + grants for the four M1.7 platform-infrastructure tables. Same
-- two-layer discipline as every table since M1.2 (docs/08-Security.md §2):
-- a table with RLS enabled but no GRANT fails closed before RLS is ever
-- evaluated, so both are required together.
--
-- M1.7 scope note: no ordinary authenticated route reads or writes any of
-- these four tables yet. api_keys gets a read-only policy now (harmless,
-- and matches the established "safe default, ready for later" pattern
-- already used for data_retention_policies in M1.6) since a future
-- self-service key-management UI (Phase 7) will need exactly this shape.
-- events/event_deliveries/webhook_events_seen get ZERO grants to
-- authenticated at all — there is no legitimate ordinary-user read case
-- for them yet, and an absent grant is a strictly safer default than a
-- present-but-currently-unused one. The domain write that inserts into
-- events (inside create_organization_with_owner(), next migration) and the
-- dispatcher that reads/writes events/event_deliveries both operate via
-- SECURITY DEFINER / the pool's own elevated connection respectively,
-- which bypasses RLS and grants entirely regardless of what authenticated
-- has — see packages/database/src/events.ts's own comment for why this is
-- the documented "service-role bypass" pattern (docs/03-Database-Architecture.md
-- §5), never a blanket unscoped one.

grant select on public.api_keys to authenticated;

alter table public.api_keys enable row level security;

create policy "api_keys_org_select" on public.api_keys
  for select
  using (organization_id = current_org());

-- No insert/update/delete policy — issuance is exclusively the internal
-- script (packages/database/scripts/issue-api-key.mjs), which connects
-- directly via DATABASE_URL as the table-owning role, bypassing RLS by
-- construction, same as every other privileged internal tool in this repo
-- (packages/database/scripts/pooling-spike.mjs).

alter table public.events enable row level security;
-- No policies at all — deny-by-default for every ordinary role, the same
-- safe-default-absence pattern already used for agencies' write paths
-- since M1.2. A future tenant-facing "automation history" read gets its
-- own deliberate policy + grant when it's actually built, not a dormant
-- one added speculatively now.

alter table public.event_deliveries enable row level security;
-- Same: no policies, no grants. Purely internal dispatcher bookkeeping.

alter table public.webhook_events_seen enable row level security;
-- Same: no policies, no grants. Not tenant-scoped at all (no
-- organization_id column) — RLS is enabled anyway as defense-in-depth,
-- consistent with this project's conservative default, even though there
-- is no tenant dimension for it to actually partition.
