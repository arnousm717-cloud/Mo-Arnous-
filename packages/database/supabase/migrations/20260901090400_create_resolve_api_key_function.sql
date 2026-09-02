-- Milestone 3.3B: resolve_api_key() -- the bootstrapping-identity read
-- path for service-to-service authentication (Milestone 3.3 Architecture
-- Resolution Report §C), mirroring resolve_tracking_site()'s own
-- precedent exactly: api_keys' existing RLS policy
-- (api_keys_org_select, 20260811090100) requires organization_id =
-- current_org() to already be set -- which is circular for resolving an
-- incoming Bearer token, since organization_id is exactly what this
-- lookup is trying to determine. No auth.uid() guard, by design, same
-- reasoning as resolve_tracking_site(): a machine credential has no
-- session identity to check against; its authorization primitive is
-- possession of the plaintext key itself, which this function's caller
-- has already hashed before calling (the raw plaintext key is never
-- passed to this or any other SQL function -- packages/auth hashes it
-- client-side first, matching every other credential-verification
-- function in this schema).
--
-- Single UPDATE ... RETURNING does the lookup, the revocation check,
-- and the last_used_at bump atomically in one round trip. Returns zero
-- rows for a nonexistent, revoked, or hash-mismatched key -- callers
-- cannot distinguish which, matching this schema's established
-- non-oracle discipline for credential resolution (resolveActiveTrackingSitePublicKey
-- follows the identical shape).

create function public.resolve_api_key(p_key_hash text)
returns table (
  api_key_id uuid,
  organization_id uuid,
  scopes jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    update public.api_keys
    set last_used_at = now()
    where key_hash = p_key_hash and revoked_at is null
    returning id, api_keys.organization_id, api_keys.scopes;
end;
$$;

comment on function public.resolve_api_key(text) is
  'Milestone 3.3B. SECURITY DEFINER bootstrapping lookup for service-to-service authentication -- resolves a pre-hashed API key to its organization_id/scopes and bumps last_used_at, atomically. No auth.uid() guard, by design (mirrors resolve_tracking_site()): possession of the correctly-hashed key is the authorization primitive, since there is no session identity to check for a machine credential. Returns zero rows, never a distinguishable error, for any invalid key (nonexistent, revoked, or hash mismatch). EXECUTE granted to authenticated only -- PUBLIC/anon receive zero EXECUTE by construction (M1.9 default-privilege hardening).';

grant execute on function public.resolve_api_key(text) to authenticated;
