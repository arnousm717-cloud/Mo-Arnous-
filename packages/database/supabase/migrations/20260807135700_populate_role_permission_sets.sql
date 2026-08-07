-- Populates roles.permission_set with a DERIVED SNAPSHOT of the real
-- permission matrix (M1.5, docs/08-Security.md §3). The source of truth is
-- packages/auth/src/permissions.ts's PERMISSION_MATRIX — this column is a
-- readable reference only, never the enforcement mechanism (the seed
-- migration's own comment already said as much back in M1.2, before this
-- column had real values). Nothing in the application ever reads this
-- column to make an authorization decision; can() never queries the
-- database at all (it's pure and synchronous). A test
-- (packages/auth/tests/permission-set-sync.test.ts) asserts this snapshot
-- matches PERMISSION_MATRIX exactly, so the two can never silently drift —
-- that test failing is the signal this migration needs updating, not the
-- other way around.

update public.roles set permission_set = '{
  "organizations:list-clients": true,
  "organizations:create-client": true,
  "agencies:read": true,
  "agencies:manage-branding": true,
  "agencies:manage-billing": true,
  "agencies:manage-domains": true
}'::jsonb
where key = 'agency_owner';

update public.roles set permission_set = '{
  "organizations:list-clients": true,
  "organizations:create-client": true,
  "agencies:read": true,
  "agencies:manage-branding": true,
  "agencies:manage-domains": true
}'::jsonb
where key = 'agency_admin';

update public.roles set permission_set = '{
  "organizations:read": true,
  "organizations:manage-billing": true,
  "organizations:manage-users": true,
  "organizations:manage-settings": true
}'::jsonb
where key = 'org_admin';

update public.roles set permission_set = '{
  "organizations:read": true
}'::jsonb
where key = 'org_member';

update public.roles set permission_set = '{
  "organizations:read": true
}'::jsonb
where key = 'org_viewer';

update public.roles set permission_set = '{}'::jsonb
where key = 'portal_customer';
