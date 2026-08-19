-- Updates roles.permission_set to reflect Milestone 2.4B's 4 new
-- PermissionKeys (companies:agency-rollup-read, contacts:agency-rollup-read,
-- deals:agency-rollup-read, pipelines:agency-rollup-read). Same
-- derived-snapshot discipline as every prior permission-set migration
-- (M1.5 seed 20260807135700, M1.6 20260810100400, 2.1E 20260813100000,
-- 2.2C 20260814110000, 2.3C 20260817090300) — packages/auth/src/permissions.ts's
-- PERMISSION_MATRIX remains the sole source of truth;
-- packages/auth/tests/permission-set-sync.test.ts is what keeps this
-- column from silently drifting out of sync with it.
--
-- Only the two roles whose PERMISSION_MATRIX entry actually changes are
-- touched here (agency_owner, agency_admin) — org_admin, org_member,
-- org_viewer, and portal_customer gain none of the 4 new keys (docs/13
-- Milestone 2.4B, frozen decision: these keys are the application-layer
-- defense-in-depth counterpart to the Milestone 2.4A agency_rollup_*
-- database views, which only agency_owner/agency_admin can ever satisfy
-- the WHERE clause of in the first place), so their existing rows are
-- left untouched and remain byte-identical to their previously-committed
-- state.
--
-- No write-shaped variant (agency-rollup-create/-update/-delete) exists
-- for any of the four resources — the underlying roll-up views are
-- structurally read-only (2.4A: SELECT-only grant, no INSERT/UPDATE/DELETE
-- privilege on any of them), so a write permission key would authorize an
-- operation with no corresponding code path.
--
-- Each UPDATE is a full, deterministic replacement of permission_set —
-- matching the existing repository convention (every prior permission-set
-- migration replaces the whole object rather than jsonb-merging), and
-- explicitly preserves every pre-existing key for the role alongside the
-- new companies:agency-rollup-read/contacts:agency-rollup-read/
-- deals:agency-rollup-read/pipelines:agency-rollup-read ones, rather than
-- only appending.

update public.roles set permission_set = '{
  "organizations:list-clients": true,
  "organizations:create-client": true,
  "agencies:read": true,
  "agencies:manage-branding": true,
  "agencies:manage-billing": true,
  "agencies:manage-domains": true,
  "companies:agency-rollup-read": true,
  "contacts:agency-rollup-read": true,
  "deals:agency-rollup-read": true,
  "pipelines:agency-rollup-read": true
}'::jsonb
where key = 'agency_owner';

update public.roles set permission_set = '{
  "organizations:list-clients": true,
  "organizations:create-client": true,
  "agencies:read": true,
  "agencies:manage-branding": true,
  "agencies:manage-domains": true,
  "companies:agency-rollup-read": true,
  "contacts:agency-rollup-read": true,
  "deals:agency-rollup-read": true,
  "pipelines:agency-rollup-read": true
}'::jsonb
where key = 'agency_admin';
