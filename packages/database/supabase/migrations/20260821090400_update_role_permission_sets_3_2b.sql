-- Updates roles.permission_set to reflect Milestone 3.2B's 1 new
-- PermissionKey (tracking:manage-identity-keys). Same derived-snapshot
-- discipline as every prior permission-set migration (M1.5 seed
-- 20260807135700, M1.6 20260810100400, 2.1E 20260813100000, 2.2C
-- 20260814110000, 2.3C 20260817090300, 2.4B 20260819100400) --
-- packages/auth/src/permissions.ts's PERMISSION_MATRIX remains the sole
-- source of truth; packages/auth/tests/permission-set-sync.test.ts is
-- what keeps this column from silently drifting out of sync with it.
--
-- Only org_admin gains this key (same reasoning as consent:record's own
-- M1.6 Decision F, applied identically): no agency-scoped role has any
-- access to tracking-identity-key management, so agency_owner/
-- agency_admin/org_member/org_viewer/portal_customer are left untouched.
--
-- A full, deterministic replacement of permission_set, matching the
-- existing repository convention exactly.

update public.roles set permission_set = '{
  "organizations:read": true,
  "organizations:manage-billing": true,
  "organizations:manage-users": true,
  "organizations:manage-settings": true,
  "consent:record": true,
  "tracking:manage-identity-keys": true,
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
  "pipelines:delete": true,
  "activities:read": true,
  "activities:create": true,
  "activities:update": true,
  "activities:delete": true,
  "notes:read": true,
  "notes:create": true,
  "notes:update": true,
  "notes:delete": true,
  "tags:read": true,
  "tags:create": true,
  "tags:update": true,
  "tags:delete": true
}'::jsonb
where key = 'org_admin';
