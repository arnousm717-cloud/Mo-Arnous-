-- Milestone 2.2A: Deals & Pipelines database foundation — schema only
-- (docs/13-Technical-Design-Review.md "Milestone 2.2", frozen decisions
-- 2-6). RLS and grants are the companion migration that follows this one,
-- matching the established M1.2/2.1B precedent of shipping schema and
-- RLS/grants as separate migrations.

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Required so pipeline_stages'/deals' own composite FKs below have a
  -- composite unique target to reference (the companies/contacts
  -- precedent, 20260812120000) — not needed for pipelines' own use
  -- otherwise, since `id` alone is already unique.
  unique (organization_id, id)
);

comment on table public.pipelines is
  'Milestone 2.2A. Ordinary deletion is deleted_at (soft-delete) only — no physical DELETE grant or RLS policy exists for this table. Every organization has exactly one is_default=true pipeline at creation/backfill time (see seed_default_pipeline()); the partial unique index below proves at most one ACTIVE default can ever exist, not that one can never later be removed by an ordinary UPDATE — Milestone 2.2A ships no RBAC/domain layer yet to prevent that (docs/13 Milestone 2.2A "Default-pipeline invariant").';

-- Structural backstop for "at most one active default pipeline per
-- organization" — a partial unique index, not a trigger, so it holds
-- regardless of which code path performs the write (seed_default_pipeline,
-- a future 2.2B domain-layer update, or a direct SQL statement).
create unique index pipelines_org_active_default_idx
  on public.pipelines (organization_id)
  where is_default and deleted_at is null;

create index pipelines_org_active_idx on public.pipelines (organization_id) where deleted_at is null;

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pipeline_id uuid not null,
  name text not null,
  sort_order integer not null,
  probability integer,
  is_won_stage boolean not null default false,
  is_lost_stage boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Required so deals' own composite FKs below have composite unique
  -- targets to reference: one proving tenant ownership, one proving
  -- pipeline membership (docs/13 Milestone 2.2 "two-composite-FK design").
  unique (organization_id, id),
  unique (pipeline_id, id),
  -- The cross-tenant guard: makes `stage.organization_id = Org A,
  -- stage.pipeline_id = a pipeline belonging to Org B` structurally
  -- impossible, independent of RLS or application-layer correctness —
  -- mirrors contacts_company_org_fk exactly. ON DELETE CASCADE (not SET
  -- NULL): pipeline_id is NOT NULL and a stage has no meaningful existence
  -- without its pipeline, unlike contacts.company_id's genuinely optional
  -- relationship. In ordinary operation this never fires — pipelines have
  -- no DELETE grant/policy, only deleted_at soft-delete — this is a
  -- structural safety net for a privileged/administrative hard delete.
  constraint pipeline_stages_pipeline_org_fk
    foreign key (organization_id, pipeline_id)
    references public.pipelines (organization_id, id)
    on delete cascade,
  constraint pipeline_stages_probability_range
    check (probability is null or probability between 0 and 100),
  constraint pipeline_stages_not_won_and_lost
    check (not (is_won_stage and is_lost_stage))
);

comment on table public.pipeline_stages is
  'Milestone 2.2A. Ordinary deletion is deleted_at (soft-delete) only. Whether deals.status is kept consistent with a stage''s is_won_stage/is_lost_stage flags is deliberately NOT enforced at this schema layer — that derivation is the future 2.2B domain layer''s responsibility (docs/13 Milestone 2.2A "Status-derivation boundary"); this table only enforces that a single stage cannot claim to be both won and lost.';

create index pipeline_stages_org_active_idx on public.pipeline_stages (organization_id) where deleted_at is null;
create index pipeline_stages_pipeline_sort_idx on public.pipeline_stages (pipeline_id, sort_order);

-- Prerequisite for deals_contact_org_fk below (must exist before the
-- deals table is created, since that FK references it): contacts had no
-- composite unique(organization_id, id) before this milestone (companies
-- already has one, added in its own original 2.1B schema migration for
-- the identical reason). id is already the primary key (globally
-- unique), so (organization_id, id) is trivially unique already — this
-- cannot fail against any existing data.
alter table public.contacts
  add constraint contacts_organization_id_id_key unique (organization_id, id);

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Plain uuid, deliberately not `references companies/contacts (id)`
  -- here — the real FKs are the composite constraints below, exactly the
  -- contacts.company_id precedent (20260812120000).
  company_id uuid,
  primary_contact_id uuid,
  pipeline_id uuid not null,
  stage_id uuid not null,
  amount numeric,
  currency text not null default 'EUR',
  probability integer,
  expected_close_date date,
  status text not null default 'open',
  owner_id uuid references public.users (id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deals_company_org_fk
    foreign key (organization_id, company_id)
    references public.companies (organization_id, id)
    on delete set null (company_id),
  constraint deals_contact_org_fk
    foreign key (organization_id, primary_contact_id)
    references public.contacts (organization_id, id)
    on delete set null (primary_contact_id),
  -- Tenant-safety half of the two-composite-FK design: proves pipeline_id
  -- belongs to this deal's own organization.
  constraint deals_pipeline_org_fk
    foreign key (organization_id, pipeline_id)
    references public.pipelines (organization_id, id)
    on delete restrict,
  -- Tenant-safety half for stage_id.
  constraint deals_stage_org_fk
    foreign key (organization_id, stage_id)
    references public.pipeline_stages (organization_id, id)
    on delete restrict,
  -- Pipeline-membership-safety half: proves stage_id actually belongs to
  -- THIS deal's own pipeline_id, not merely to the same organization —
  -- without this, a stage from a different pipeline in the same org could
  -- be assigned to a deal, which deals_stage_org_fk alone cannot catch.
  constraint deals_stage_pipeline_fk
    foreign key (pipeline_id, stage_id)
    references public.pipeline_stages (pipeline_id, id)
    on delete restrict,
  -- pipeline_id/stage_id are NOT NULL, so ON DELETE SET NULL is not an
  -- option (unlike company_id/primary_contact_id above) — RESTRICT (the
  -- Postgres default; written explicitly here for legibility, matching
  -- the companies_contacts_rls.sql precedent of writing WITH CHECK
  -- explicitly even where it would otherwise be implied) means a pipeline
  -- or stage still referenced by any deal cannot be hard-deleted at all.
  -- Soft-deleting a pipeline/stage is unaffected — deleted_at is a plain
  -- column update, not a DELETE, so it never touches these FKs.
  constraint deals_currency_format
    check (currency ~ '^[A-Z]{3}$'),
  constraint deals_probability_range
    check (probability is null or probability between 0 and 100),
  constraint deals_status_allowed
    check (status in ('open', 'won', 'lost'))
);

comment on table public.deals is
  'Milestone 2.2A. Ordinary deletion is deleted_at (soft-delete) only. status has no trigger/CHECK tying it to stage_id''s pipeline_stages.is_won_stage/is_lost_stage flags — direct SQL can create a schema-valid status/stage mismatch (e.g. status=''open'' with a won-flagged stage_id); deriving/enforcing status from stage_id is the future 2.2B domain layer''s responsibility, not this schema (docs/13 Milestone 2.2A "Status-derivation boundary").';

create index deals_org_created_idx on public.deals (organization_id, created_at);
create index deals_org_active_idx on public.deals (organization_id) where deleted_at is null;
create index deals_org_owner_idx on public.deals (organization_id, owner_id);
create index deals_org_company_idx on public.deals (organization_id, company_id);
create index deals_org_contact_idx on public.deals (organization_id, primary_contact_id);
create index deals_org_pipeline_idx on public.deals (organization_id, pipeline_id);
create index deals_org_stage_idx on public.deals (organization_id, stage_id);

create trigger pipelines_set_updated_at
  before update on public.pipelines
  for each row
  execute function public.set_updated_at();

create trigger pipeline_stages_set_updated_at
  before update on public.pipeline_stages
  for each row
  execute function public.set_updated_at();

create trigger deals_set_updated_at
  before update on public.deals
  for each row
  execute function public.set_updated_at();
