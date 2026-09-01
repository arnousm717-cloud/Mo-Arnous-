-- Milestone 3.2A: RLS for visitor_identifications and
-- tracking_site_public_keys -- companion to the schema migration,
-- matching the established schema-then-RLS precedent.

alter table public.visitor_identifications enable row level security;
alter table public.tracking_site_public_keys enable row level security;

-- visitor_identifications: staff-readable (org-scoped) AND writable via
-- ordinary RLS-scoped INSERT -- NOT a SECURITY DEFINER function.
-- Corrected during 3.2C implementation from this migration's own
-- original design intent (a bypass-RLS function) once the actual
-- identification transaction turned out to be orchestrated the same way
-- ingestTrackingEvent already orchestrates website_visitors/
-- visitor_sessions/visitor_events: application-level TypeScript issuing
-- ordinary INSERT/UPDATE statements against organizationId already
-- resolved via withTenantContext, exactly the same pattern those three
-- tables already use (see their own 20260820090100 grants) -- not a case
-- requiring a bypass-RLS function at all, since the caller by this point
-- in the transaction already has a real, resolved organizationId to
-- satisfy WITH CHECK against. No UPDATE/DELETE grant: identification
-- audit rows are append-only by construction (no code path ever needs to
-- modify or remove one).
create policy visitor_identifications_select_own on public.visitor_identifications
  for select
  using (organization_id = current_org());

create policy visitor_identifications_insert_own on public.visitor_identifications
  for insert
  with check (organization_id = current_org());

grant select, insert on public.visitor_identifications to authenticated;

-- tracking_site_public_keys: staff-managed directly via ordinary RLS,
-- deliberately NOT via a SECURITY DEFINER function -- unlike the public
-- tracking pathways, the caller here is always a real, session-
-- authenticated staff member with a real current_org() context already
-- available, so the ordinary RLS+grant pattern already used for
-- companies/contacts is sufficient and consistent, not a case requiring
-- a bypass-RLS function. Public keys are not secrets, so a staff-scoped
-- SELECT exposes no sensitive material. Revocation is an UPDATE setting
-- revoked_at (tracking_sites.revoked_at precedent) -- no DELETE grant,
-- matching this table family's consistent soft-lifecycle convention.
-- The narrower org_admin-only authorization requirement (Milestone 3.2
-- Design Resolution Report) is enforced at the API layer via can()
-- (Milestone 3.2B), the same two-layer discipline (RLS as defense-in-
-- depth beneath RBAC) already established platform-wide
-- (docs/08-Security.md §2) -- RLS here only proves tenant isolation, not
-- the org_admin-specific authorization on top of it.
create policy tracking_site_public_keys_select_own on public.tracking_site_public_keys
  for select
  using (organization_id = current_org());

create policy tracking_site_public_keys_insert_own on public.tracking_site_public_keys
  for insert
  with check (organization_id = current_org());

create policy tracking_site_public_keys_update_own on public.tracking_site_public_keys
  for update
  using (organization_id = current_org())
  with check (organization_id = current_org());

-- SELECT/INSERT/UPDATE only, no DELETE -- matching companies/contacts'
-- own precedent exactly. TRUNCATE/REFERENCES/TRIGGER are already denied
-- to authenticated/anon by the M1.9 default-privilege hardening for
-- every table created after it, including both of these -- no explicit
-- revoke needed here. No grant of any kind to anon on either table: the
-- public /track/identify pathway (Milestone 3.2C/3.2D,
-- resolveActiveTrackingSitePublicKey in packages/auth) reads
-- tracking_site_public_keys through the SAME ordinary, tenant-scoped
-- RLS SELECT this migration grants to authenticated above -- every
-- request in this monolith connects as authenticated regardless of
-- caller identity, and by the time that pathway queries this table it
-- already has a real, resolved organizationId (from siteKey
-- resolution) to satisfy the tracking_site_public_keys_select_own
-- policy's `organization_id = current_org()` check, exactly like the
-- staff-route pathway does. There is no SECURITY DEFINER function for
-- this table's read path -- it genuinely relies on the grant/policy
-- pair above, not a bypass-RLS mechanism.
grant select, insert, update on public.tracking_site_public_keys to authenticated;
