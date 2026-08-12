-- Milestone 2.1B: Companies + Contacts schema (docs/12-Implementation-
-- Milestones.md, docs/13-Technical-Design-Review.md "Milestone 2.1" and its
-- "Detailed design" subsection). Schema only — RLS and grants are the
-- companion migration that follows this one, matching the M1.2 precedent
-- (20260714093502_create_core_tenancy_schema.sql /
-- 20260714093504_enable_rls_policies.sql).

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  domain text,
  industry text,
  employee_count integer,
  annual_revenue numeric,
  linkedin_url text,
  -- Schema-complete per docs/03-Database-Architecture.md's documented
  -- target shape, functionally inert until Phase 3 Lead Enrichment
  -- consumes it. No approved allowed-value set exists yet, so this is
  -- deliberately left as unconstrained nullable text, not a guessed CHECK.
  enrichment_status text,
  owner_id uuid references public.users (id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Required so contacts_company_org_fk (below) has a composite unique
  -- target to reference — not needed for companies' own use otherwise,
  -- since `id` alone is already unique.
  unique (organization_id, id)
);

comment on table public.companies is
  'Milestone 2.1B. Ordinary deletion is deleted_at (soft-delete) only — no physical DELETE grant or RLS policy exists for this table, matching the public.users precedent. A GDPR erasure path, if ever required for companies, is out of this milestone''s scope (docs/13 Milestone 2.1: companies holds firmographic data, not personal data of a natural person).';

create index companies_org_created_idx on public.companies (organization_id, created_at);
create index companies_org_active_idx on public.companies (organization_id) where deleted_at is null;
create index companies_org_owner_idx on public.companies (organization_id, owner_id);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Plain uuid, deliberately not `references companies (id)` here — the
  -- real FK is the composite constraint below, which is what actually
  -- proves a linked company belongs to the same organization as this
  -- contact. A single-column reference to companies(id) alone would only
  -- prove the company exists somewhere, not that it's the caller's own.
  company_id uuid,
  first_name text,
  last_name text,
  email text,
  phone text,
  job_title text,
  linkedin_url text,
  lifecycle_stage text check (lifecycle_stage in ('lead', 'prospect', 'customer', 'inactive')),
  owner_id uuid references public.users (id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- `!~ '^\s*$'` (not: empty or all-whitespace), not btrim(...) <> '' —
  -- btrim() with a single argument only strips plain space characters by
  -- default, so a tab- or newline-only value would incorrectly satisfy
  -- btrim(...) <> '' while still being empty in any meaningful sense. The
  -- regex form matches \s (space, tab, newline, etc.) precisely.
  constraint contacts_identity_required check (
    (first_name is not null and first_name !~ '^\s*$')
    or (last_name is not null and last_name !~ '^\s*$')
    or (email is not null and email !~ '^\s*$')
  ),
  -- The cross-tenant guard (docs/13 Milestone 2.1 "Detailed design"):
  -- makes `contact.organization_id = Org A, contact.company_id = a company
  -- belonging to Org B` structurally impossible, independent of RLS or
  -- application-layer correctness. ON DELETE SET NULL (company_id) is the
  -- PostgreSQL 15+ column-specific form (this project runs Postgres 17,
  -- confirmed via packages/database/supabase/config.toml's major_version)
  -- — it nulls only company_id on a hard company delete, leaving
  -- organization_id (NOT NULL) untouched. Plain `ON DELETE SET NULL`
  -- without a column list would null every column in this composite FK,
  -- including organization_id, which would violate its NOT NULL
  -- constraint.
  constraint contacts_company_org_fk
    foreign key (organization_id, company_id)
    references public.companies (organization_id, id)
    on delete set null (company_id)
);

comment on table public.contacts is
  'Milestone 2.1B. Ordinary deletion is deleted_at (soft-delete) only. GDPR erasure (subject_type=''contact'') is Milestone 2.1C''s own separate, SECURITY DEFINER-gated path, never conflated with deleted_at — see docs/13 Milestone 2.1 "Detailed design".';

create index contacts_org_created_idx on public.contacts (organization_id, created_at);
create index contacts_org_active_idx on public.contacts (organization_id) where deleted_at is null;
create index contacts_org_company_idx on public.contacts (organization_id, company_id);
create index contacts_org_owner_idx on public.contacts (organization_id, owner_id);

-- Case-insensitive, active-contacts-only email uniqueness (approved
-- decisions: case-insensitive via lower(email); scoped to deleted_at is
-- null so a soft-deleted contact's email is immediately reusable, and a
-- NULL email never participates in uniqueness at all — ordinary Postgres
-- partial-index semantics, nothing bespoke). The stored email value
-- itself is never mutated/lowercased by this constraint.
create unique index contacts_org_active_email_idx
  on public.contacts (organization_id, lower(email))
  where email is not null and deleted_at is null;

-- Shared updated_at trigger (docs/13 Milestone 2.1 "Detailed design") —
-- new to this repository; no prior table has an automatic updated_at
-- mechanism (verified by search before writing this). Plain SQL/plpgsql,
-- no SECURITY DEFINER — it only ever needs to see the row already being
-- updated by the caller's own already-authorized UPDATE, nothing broader.
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Milestone 2.1B. Generic BEFORE UPDATE trigger setting NEW.updated_at = now() — reusable for any future table that adopts the same convention, not specific to companies/contacts.';

create trigger companies_set_updated_at
  before update on public.companies
  for each row
  execute function public.set_updated_at();

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row
  execute function public.set_updated_at();
