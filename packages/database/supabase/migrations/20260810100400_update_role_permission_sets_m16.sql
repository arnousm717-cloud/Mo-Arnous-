-- Updates roles.permission_set to reflect M1.6's three new PermissionKeys
-- (consent:record, data-subject-requests:create/read/execute), all
-- org_admin-only (Decision F). Same derived-snapshot discipline as the
-- M1.5 seed migration (20260807135700) — packages/auth/src/permissions.ts's
-- PERMISSION_MATRIX remains the sole source of truth;
-- packages/auth/tests/permission-set-sync.test.ts is what keeps this column
-- from silently drifting out of sync with it.

update public.roles set permission_set = '{
  "organizations:read": true,
  "organizations:manage-billing": true,
  "organizations:manage-users": true,
  "organizations:manage-settings": true,
  "consent:record": true,
  "data-subject-requests:create": true,
  "data-subject-requests:read": true,
  "data-subject-requests:execute": true
}'::jsonb
where key = 'org_admin';
