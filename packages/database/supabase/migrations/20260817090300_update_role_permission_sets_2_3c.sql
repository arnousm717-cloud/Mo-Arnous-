-- Updates roles.permission_set to reflect Milestone 2.3C's 12 new
-- PermissionKeys (activities:read/create/update/delete,
-- notes:read/create/update/delete, tags:read/create/update/delete). Same
-- derived-snapshot discipline as every prior permission-set migration
-- (M1.5 seed 20260807135700, M1.6 20260810100400, 2.1E 20260813100000,
-- 2.2C 20260814110000) — packages/auth/src/permissions.ts's
-- PERMISSION_MATRIX remains the sole source of truth;
-- packages/auth/tests/permission-set-sync.test.ts is what keeps this
-- column from silently drifting out of sync with it.
--
-- Only the three roles whose PERMISSION_MATRIX entry actually changes are
-- touched here (org_admin, org_member, org_viewer) — agency_owner,
-- agency_admin, and portal_customer gain none of the 12 new keys (docs/13
-- Milestone 2.3C, same structural reason as every CRM resource added so
-- far: no agency_rollup_activities/agency_rollup_notes/agency_rollup_tags
-- view exists, and an agency-scoped Actor carries agencyId, not
-- organizationId), so their existing rows are left untouched and remain
-- byte-identical to their previously-committed state.
--
-- No taggings:* keys exist and none are added here (frozen 2.3 design) —
-- a future Taggings API route (2.3D) authorizes under tags:* instead,
-- mirroring pipeline_stages' own precedent of a child/relationship
-- resource authorizing under its owning resource's keys, never its own
-- family.
--
-- Each UPDATE is a full, deterministic replacement of permission_set —
-- matching the existing repository convention (every prior permission-set
-- migration replaces the whole object rather than jsonb-merging), and
-- explicitly preserves every pre-existing key for that role alongside the
-- new activities:*/notes:*/tags:* ones, rather than only appending.

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
  "pipelines:read": true,
  "activities:read": true,
  "activities:create": true,
  "activities:update": true,
  "notes:read": true,
  "notes:create": true,
  "notes:update": true,
  "tags:read": true,
  "tags:create": true,
  "tags:update": true
}'::jsonb
where key = 'org_member';

update public.roles set permission_set = '{
  "organizations:read": true,
  "companies:read": true,
  "contacts:read": true,
  "deals:read": true,
  "pipelines:read": true,
  "activities:read": true,
  "notes:read": true,
  "tags:read": true
}'::jsonb
where key = 'org_viewer';
