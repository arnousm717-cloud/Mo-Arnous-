-- Milestone 2.2-P0: Organization Member Identity Display. Resolves the
-- Companies/Contacts (and, later, Deals) owner-display limitation
-- without broadening public.users' own RLS (M1.2: strictly self-scoped,
-- `id = auth.uid()`, unchanged by this migration) — a narrow,
-- purpose-built SECURITY DEFINER function instead, mirroring the exact
-- _validate_contact_erasure/_validate_user_erasure discipline:
-- organization_id is always an explicit parameter, never trusted as the
-- security boundary by itself — the caller's own active membership in
-- that exact organization is independently re-verified inside the
-- function via auth.uid() on every call, regardless of what
-- p_organization_id claims.
--
-- Exposes only the three fields an owner selector/display actually
-- needs — user_id, email, full_name — never any other public.users
-- column (avatar_url, default_organization_id, created_at/updated_at).
-- Returns only ACTIVE memberships of that exact organization; a removed
-- membership (either the caller's own, checked first, or a target row)
-- is excluded.

create or replace function public.get_organization_member_identities(p_organization_id uuid)
returns table (user_id uuid, email text, full_name text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'caller must be authenticated';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.organization_id = p_organization_id
      and m.status = 'active'
  ) then
    raise exception 'caller does not have an active membership in this organization';
  end if;

  return query
    select u.id, u.email, u.full_name
    from public.memberships m
    join public.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
      and m.status = 'active';
end;
$$;

comment on function public.get_organization_member_identities(uuid) is
  'Milestone 2.2-P0. Resolves active organization members'' id/email/full_name for owner selectors/display, without broadening public.users'' own self-scoped RLS (id = auth.uid(), M1.2). organization_id is never trusted as the security boundary alone — the caller''s own active membership in that exact organization is independently re-verified via auth.uid() on every call, mirroring _validate_contact_erasure''s own discipline. Exposes only id/email/full_name, never any other public.users column.';

-- PUBLIC already receives no EXECUTE on any function newly created by
-- role postgres by default — 20260812140000 PART 2's cluster-scoped
-- `alter default privileges for role postgres revoke execute on
-- functions from public` already governs this function's creation too
-- (verified empirically below, not merely assumed from that comment).
-- This REVOKE is restated explicitly and idempotently anyway, so this
-- migration's own end state is self-contained and legible without
-- requiring a reader to cross-reference the prior migration — the exact
-- precedent 20260812140000 Part 4 already established for its own GRANT
-- restatements, applied here to a REVOKE instead.
revoke execute on function public.get_organization_member_identities(uuid) from public;
grant execute on function public.get_organization_member_identities(uuid) to authenticated;
