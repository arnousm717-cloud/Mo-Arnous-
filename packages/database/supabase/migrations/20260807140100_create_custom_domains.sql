-- custom_domains: schema only (M1.4 product/data checkpoint,
-- docs/12-Implementation-Milestones.md M1.4 — "schema only, verification
-- flow is a Phase 7 feature"). No verification logic, no DNS automation,
-- no SSL provisioning — just the additive table, status fields for a
-- future workflow to drive, and agency-scoped RLS.
--
-- Unlike agencies/organizations, no SECURITY DEFINER creation function is
-- needed here: an insert's WITH CHECK (agency_id = current_agency()) can be
-- satisfied directly, because agency_id references an agency that already
-- exists by the time a domain is added to it — this isn't the same
-- RETURNING-requires-SELECT-for-a-not-yet-existing-row bootstrapping
-- problem ADR-003 solved for agencies/organizations themselves.

create table public.custom_domains (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies (id) on delete cascade,
  domain text not null unique,
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'failed')),
  verified_at timestamptz,
  ssl_status text not null default 'pending'
    check (ssl_status in ('pending', 'active', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index custom_domains_agency_id_idx on public.custom_domains (agency_id);

comment on table public.custom_domains is
  'Agency vanity/white-label domains — schema only in M1.4. verification_status/ssl_status/verified_at exist for a future Phase 7 verification workflow to drive; nothing in this codebase transitions them yet beyond their pending default.';

alter table public.custom_domains enable row level security;

grant select, insert, update, delete on public.custom_domains to authenticated;

create policy "custom_domains_agency_select" on public.custom_domains
  for select
  using (agency_id = current_agency() and current_role_key() in ('agency_owner', 'agency_admin'));

create policy "custom_domains_agency_write" on public.custom_domains
  for all
  using (agency_id = current_agency() and current_role_key() in ('agency_owner', 'agency_admin'))
  with check (agency_id = current_agency() and current_role_key() in ('agency_owner', 'agency_admin'));
