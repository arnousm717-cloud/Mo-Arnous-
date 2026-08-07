-- Minimum RLS needed for an authenticated agency member to read their own
-- agency-level membership row (M1.4 backend checkpoint).
--
-- The existing memberships_tenant_isolation_select/_write policies
-- (organization_id = current_org()) already correctly exclude agency-scoped
-- rows by construction (NULL never equals current_org()) — but that means
-- there was previously NO ordinary-authenticated-role path to read an
-- agency-scoped row at all, only via get_my_agency_context()'s SECURITY
-- DEFINER bypass. This adds exactly one narrow SELECT policy: a user may
-- read their own agency-scoped membership row(s), keyed on auth.uid()
-- directly — no session-variable bootstrapping needed (same self-scoping
-- pattern already used for users_select_own).
--
-- Deliberately SELECT-only: writes to agency-scoped memberships still only
-- happen via create_agency_with_owner() or the admin bypass. No policy is
-- added here for reading OTHER agency members' rows, or for agency-scoped
-- INSERT/UPDATE/DELETE via ordinary authenticated access — both stay out of
-- scope until an actual feature needs them, matching the same
-- safe-default-absence precedent already used for the agencies table since
-- M1.2 and reaffirmed for memberships in the previous migration.

create policy "memberships_agency_self_select" on public.memberships
  for select
  using (agency_id is not null and user_id = auth.uid());
