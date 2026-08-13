-- Updates roles.permission_set to reflect Milestone 2.1E's 8 new
-- PermissionKeys (companies:read/create/update/delete,
-- contacts:read/create/update/delete). Same derived-snapshot discipline as
-- the M1.5 seed migration (20260807135700) and the M1.6 update
-- (20260810100400) — packages/auth/src/permissions.ts's PERMISSION_MATRIX
-- remains the sole source of truth; packages/auth/tests/permission-set-sync.test.ts
-- is what keeps this column from silently drifting out of sync with it.
--
-- Only the three roles whose PERMISSION_MATRIX entry actually changes are
-- touched here (org_admin, org_member, org_viewer) — agency_owner,
-- agency_admin, and portal_customer gain none of the 8 new keys
-- (docs/13 "Milestone 2.1" Detailed design: no agency_rollup_companies/
-- agency_rollup_contacts view exists yet, so agency-scoped roles get zero
-- direct CRM CRUD), so their existing rows are left untouched and remain
-- correct exactly as seeded.
--
-- Each UPDATE is a full, deterministic replacement of permission_set —
-- matching the existing repository convention (both prior permission-set
-- migrations replace the whole object rather than jsonb-merging), and
-- explicitly preserves every pre-existing key for that role alongside the
-- new CRM ones, rather than only appending.

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
  "contacts:delete": true
}'::jsonb
where key = 'org_admin';

update public.roles set permission_set = '{
  "organizations:read": true,
  "companies:read": true,
  "companies:create": true,
  "companies:update": true,
  "contacts:read": true,
  "contacts:create": true,
  "contacts:update": true
}'::jsonb
where key = 'org_member';

update public.roles set permission_set = '{
  "organizations:read": true,
  "companies:read": true,
  "contacts:read": true
}'::jsonb
where key = 'org_viewer';
