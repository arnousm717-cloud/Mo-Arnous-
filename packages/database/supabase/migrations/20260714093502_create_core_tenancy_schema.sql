-- Core tenancy schema (docs/03-Database-Architecture.md §2.1).
-- Tenancy hierarchy: agencies -> organizations -> memberships -> users.

create extension if not exists pgcrypto;

-- roles: seeded lookup table, rarely mutated at runtime.
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (
    key in ('agency_owner', 'agency_admin', 'org_admin', 'org_member', 'org_viewer', 'portal_customer')
  ),
  description text,
  permission_set jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.roles is 'The six platform roles. Seeded once below; not tenant-scoped.';

-- agencies: root of the reseller hierarchy.
create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  subdomain text unique,
  plan text not null default 'free',
  stripe_customer_id text,
  status text not null default 'active' check (status in ('active', 'suspended', 'churned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- organizations: the tenant. agency_id nullable for direct (non-agency) customers.
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references public.agencies (id) on delete set null,
  name text not null,
  slug text not null unique,
  industry text,
  timezone text not null default 'UTC',
  plan text not null default 'free',
  stripe_customer_id text,
  status text not null default 'active' check (status in ('active', 'suspended', 'churned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index organizations_agency_id_idx on public.organizations (agency_id);

-- users: 1:1 with Supabase Auth identity.
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  default_organization_id uuid references public.organizations (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index users_default_organization_id_idx on public.users (default_organization_id);

-- memberships: join table between users and organizations, carrying the role.
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  role_id uuid not null references public.roles (id),
  status text not null default 'invited' check (status in ('invited', 'active', 'removed')),
  invited_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, organization_id)
);

create index memberships_user_id_idx on public.memberships (user_id);
create index memberships_organization_id_idx on public.memberships (organization_id);
create index memberships_role_id_idx on public.memberships (role_id);

-- Seed the six platform roles. Descriptions and permission sets match
-- docs/08-Security.md §3 — the permission matrix itself is enforced by the
-- application-layer RBAC facade (packages/auth), not by this jsonb column
-- alone; it is a readable reference, not the sole enforcement point.
insert into public.roles (key, description, permission_set) values
  ('agency_owner', 'Agency-wide: full control including billing, branding, all client orgs, user management', '{}'::jsonb),
  ('agency_admin', 'Agency-wide: manage client orgs and branding, no billing/plan changes', '{}'::jsonb),
  ('org_admin', 'Single organization: full control within their org (CRM, agents, automations, users)', '{}'::jsonb),
  ('org_member', 'Single organization: CRM read/write per assignment, cannot manage users/billing/settings', '{}'::jsonb),
  ('org_viewer', 'Single organization: read-only across CRM/reports, no write actions', '{}'::jsonb),
  ('portal_customer', 'Own portal scope only: proposal/document/status visibility, scoped chat, no CRM access', '{}'::jsonb);
