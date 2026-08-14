-- Updates roles.permission_set to reflect Milestone 2.2C's 8 new
-- PermissionKeys (deals:read/create/update/delete,
-- pipelines:read/create/update/delete). Same derived-snapshot discipline
-- as the M1.5 seed migration (20260807135700), the M1.6 update
-- (20260810100400), and the 2.1E update (20260813100000) —
-- packages/auth/src/permissions.ts's PERMISSION_MATRIX remains the sole
-- source of truth; packages/auth/tests/permission-set-sync.test.ts is
-- what keeps this column from silently drifting out of sync with it.
--
-- Only the three roles whose PERMISSION_MATRIX entry actually changes are
-- touched here (org_admin, org_member, org_viewer) — agency_owner,
-- agency_admin, and portal_customer gain none of the 8 new keys (docs/13
-- Milestone 2.2C, same structural reason as the 2.1E CRM keys: no
-- agency_rollup_deals/agency_rollup_pipelines view exists yet, and an
-- agency-scoped Actor carries agencyId, not organizationId), so their
-- existing rows are left untouched and remain correct exactly as seeded.
--
-- Each UPDATE is a full, deterministic replacement of permission_set —
-- matching the existing repository convention (every prior permission-set
-- migration replaces the whole object rather than jsonb-merging), and
-- explicitly preserves every pre-existing key for that role alongside the
-- new deals:*/pipelines:* ones, rather than only appending. No
-- pipeline_stages:* keys exist by design — stage operations authorize
-- under pipelines:* (packages/auth/src/permissions.ts's own comment).

update public.roles set permission_set = '{
  "organizations:read": true,
  "organizations:manage-billing": true,
  "organizations:manage-users": true,
  "organizations:manage-settings": true,
  "consent:record": true,
  "data-subject-requests:create": true,
  "data-subject-requests:read": true,
  "data-subject-requests:execute": true,
  "companies:read": true,
  "companies:create": true,
  "companies:update": true,
  "companies:delete": true,
  "contacts:read": true,
  "contacts:create": true,
  "contacts:update": true,
  "contacts:delete": true,
  "deals:read": true,
  "deals:create": true,
  "deals:update": true,
  "deals:delete": true,
  "pipelines:read": true,
  "pipelines:create": true,
  "pipelines:update": true,
  "pipelines:delete": true
}'::jsonb
where key = 'org_admin';

update public.roles set permission_set = '{
  "organizations:read": true,
  "companies:read": true,
  "companies:create": true,
  "companies:update": true,
  "contacts:read": true,
  "contacts:create": true,
  "contacts:update": true,
  "deals:read": true,
  "deals:create": true,
  "deals:update": true,
  "pipelines:read": true
}'::jsonb
where key = 'org_member';

update public.roles set permission_set = '{
  "organizations:read": true,
  "companies:read": true,
  "contacts:read": true,
  "deals:read": true,
  "pipelines:read": true
}'::jsonb
where key = 'org_viewer';
