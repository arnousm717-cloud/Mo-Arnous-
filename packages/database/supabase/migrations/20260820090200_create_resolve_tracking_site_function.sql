-- Milestone 3.1A: resolve_tracking_site() -- the one function in this
-- milestone that crosses the pre-tenant bootstrap boundary (3.1
-- architecture decision report Sections 3/13). Ordinary tenant-context
-- resolution (withTenantContext) requires organization_id to already be
-- known; this function exists specifically to produce that value from a
-- public tracking-site identifier before it is known, mirroring the
-- identical bootstrapping problem get_my_membership_context()
-- (20260806100859) already solved for JWT-session signup, applied here
-- to a structurally different (identity-less, credential-only) caller.
--
-- Deliberate, documented exception to this schema's own
-- caller-identity-guard convention: every other SECURITY DEFINER
-- function in this repository (create_organization_with_owner,
-- preview_user_erasure, etc.) begins with `if auth.uid() is null then
-- raise exception` -- this function must NOT have that guard. There is
-- no authenticated identity for a public tracking beacon to check -- its
-- authorization primitive is possession of the public tracking-site
-- identifier itself, not who is calling. This is the ONLY function in
-- this schema with that property, and it is why its returned surface is
-- kept to the absolute minimum (organization_id alone -- no label, no
-- created_by, no timestamps, no distinguishable signal for "revoked" vs
-- "never existed") and why it accepts nothing but the opaque identifier
-- itself as input -- never an organization_id parameter, which would
-- make it a lookup-in-reverse tool instead of a one-way resolver.
--
-- Malformed-input note (adversarially tested, not just documented): the
-- p_site_key uuid parameter type means Postgres itself rejects a
-- non-UUID-shaped string at the call boundary with a raw
-- "invalid input syntax for type uuid" error, before this function body
-- ever runs -- the same behavior every other uuid-typed function
-- parameter in this schema already has. This function does not, and
-- structurally cannot, catch that at the database layer. Validating a
-- caller-supplied identifier's shape before it ever reaches this
-- function is the future public ingestion endpoint's own responsibility
-- (3.1C), mirroring the exact isValidUuid discipline already established
-- at the application layer for path parameters (Milestone 2.3D/2.5C,
-- apps/web/app/api/v1/_shared/uuid.ts) -- not invented or duplicated
-- here.

create or replace function public.resolve_tracking_site(p_site_key uuid)
returns table (organization_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select t.organization_id
  from public.tracking_sites t
  where t.id = p_site_key
    and t.revoked_at is null;
$$;

comment on function public.resolve_tracking_site(uuid) is
  'Milestone 3.1A. Resolves a public tracking-site identifier to its owning organization_id, or zero rows if the identifier does not exist or has been revoked -- deliberately indistinguishable, matching this platform''s established cross-org/nonexistent-indistinguishable doctrine (docs/04-API-Architecture.md Section 2.6) applied here to credential resolution. The only function in this schema with no auth.uid() caller-identity guard, by design (see this migration''s header comment). Returns organization_id only -- no tracking-site or organization metadata of any kind. Callers must feed the returned organization_id into the ordinary withTenantContext mechanism for any subsequent write -- this function performs no writes itself and must never be used for anything beyond this one resolution (3.1 architecture decision report Sections 3/13). The caller''s Postgres role for this call is always `authenticated` (the application backend''s own uniform connection role for every request, per tenant-context.ts -- there is no direct anon-to-Postgres path in this architecture), so EXECUTE is granted to authenticated only. PUBLIC/anon have zero EXECUTE by construction (the M1.7-era default-privilege hardening, 20260812140000, already revokes PUBLIC execute on every function created after it -- no explicit revoke needed here).';

grant execute on function public.resolve_tracking_site(uuid) to authenticated;
