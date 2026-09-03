-- Milestone 3.4A: lead_scores / scoring_rules -- deterministic, rules-based
-- lead scoring. Contact-level only (Milestone 3.4 Implementation
-- Authorization) -- no company_scores table exists or is planned; company
-- attributes are an INPUT to the contact score, never a second output.
--
-- Corrects two divergences from docs/03-Database-Architecture.md's own
-- earlier, never-implemented placeholder shape (Milestone 3.4
-- Pre-Implementation Audit §G):
--   1. organization_id is present here -- the placeholder's own column
--      list omitted it, inconsistent with every other real tenant-scoped
--      table in this schema.
--   2. grade is a STRUCTURAL, generated column (never independently
--      writable, never able to drift from score) rather than an
--      app-computed value trusted to stay in sync by convention alone --
--      the same "structural guarantee over convention" discipline this
--      schema already applies via composite FKs and CHECK constraints.

create table public.lead_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  contact_id uuid not null,
  score integer not null check (score >= 0 and score <= 100),
  -- Fixed v1 thresholds (Milestone 3.4 Implementation Authorization --
  -- NOT organization-configurable in this milestone). GENERATED ALWAYS
  -- means grade can never independently drift from score -- there is no
  -- code path, however buggy, that could ever insert a mismatched pair.
  grade text generated always as (
    case
      when score >= 80 then 'A'
      when score >= 60 then 'B'
      when score >= 40 then 'C'
      else 'D'
    end
  ) stored,
  -- Structured rule-evaluation trace only -- {ruleId, field, operator,
  -- matched, contribution} tuples, referencing allowlisted field names.
  -- Deliberately never a container for free-text/raw PII beyond what the
  -- allowlisted field names themselves already expose to the same
  -- RLS-scoped staff reader on the contact/company record directly
  -- (Milestone 3.4 Implementation Authorization -- privacy-by-design
  -- safeguard, application-enforced at write time; see
  -- packages/intelligence/src/scoring.ts).
  breakdown jsonb not null default '[]'::jsonb,
  -- The triggering events.id (visitor.identified / an enrichment
  -- write-back), when event- or write-back-triggered; null for an
  -- on-demand staff recalculation. Deliberately NOT a foreign key to
  -- events.id -- same reasoning as contact_enrichment.source_event_id:
  -- events may be pruned/archived independently later, and a score row
  -- must survive that unaffected. Informational/traceability only.
  source_event_id uuid,
  computed_at timestamptz not null default now(),
  -- Historized: one row per computation, NEVER updated or upserted in
  -- place (unlike contact_enrichment's own upsert-in-place design) --
  -- score DRIFT over time is itself a meaningful signal here, unlike
  -- enrichment, where only the latest provider result has any value.
  -- This also structurally sidesteps the entire class of update-in-place
  -- races contact_enrichment's own monotonic-upsert predicate exists to
  -- resolve: two computations, however they race, each simply insert
  -- their own row: whichever has the latest computed_at is "current" for
  -- read purposes, with no write-write conflict to arbitrate at all.
  constraint lead_scores_contact_org_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id)
    on delete cascade
);

comment on table public.lead_scores is
  'Milestone 3.4A. Historized, insert-only contact-level lead scores (0-100, grade A-D via a fixed, structurally-generated threshold). ON DELETE CASCADE to contacts: a hard-erased contact''s entire score history is deleted with it, same discipline as contact_enrichment. No company-level scores exist or are planned -- company attributes are an input to the contact score, never a second output.';

-- "Latest score for this contact" is the only hot-path read this
-- milestone needs -- no separate mutable "current score" pointer column,
-- avoiding a second value that could ever drift out of sync with the
-- historized rows; this index makes that read cheap directly.
create index lead_scores_org_contact_computed_idx on public.lead_scores (organization_id, contact_id, computed_at desc);
create index lead_scores_source_event_idx on public.lead_scores (source_event_id) where source_event_id is not null;

-- Milestone 3.4A: scoring_rules -- organization-owned, configurable
-- qualification criteria. Deliberately NOT an executable expression
-- language: field/operator/value is a strict, allowlisted, data-driven
-- triple, evaluated by a fixed TypeScript interpreter
-- (packages/intelligence/src/scoring.ts) that never constructs dynamic
-- SQL and never evaluates caller-supplied code (no eval, no
-- `new Function`, no LLM/agent involvement -- Milestone 3.4
-- Implementation Authorization). The CHECK constraints below are a
-- coarse, structural backstop: the real, fine-grained allowlist
-- (which operators are valid for which field, expected value shape per
-- field) lives in the application validation layer, mirroring
-- enrichment-validation.ts's own established discipline of doing rich
-- shape validation in TypeScript with a DB-level constraint as
-- defense-in-depth, not the sole gate.
create table public.scoring_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  field text not null check (field in (
    'company.industry',
    'company.employee_count',
    'company.annual_revenue',
    'contact.job_title',
    'contact.lifecycle_stage',
    'contact.enrichment_completed',
    'company.enrichment_completed',
    'engagement.pageviews_30d',
    'engagement.form_submits_30d',
    'engagement.sessions_30d',
    'engagement.last_seen_days_ago'
  )),
  operator text not null check (operator in ('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists')),
  value jsonb not null,
  -- Bounded so no single rule can dominate a 0-100 total on its own
  -- (Milestone 3.4 Implementation Authorization -- weights must remain
  -- bounded per the accepted design).
  weight integer not null check (weight >= -100 and weight <= 100),
  is_active boolean not null default true,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.scoring_rules is
  'Milestone 3.4A. Organization-owned, configurable scoring criteria -- a strict, allowlisted {field, operator, value} triple, never an executable expression. weight is bounded [-100,100]. is_active is the sole enable/disable mechanism -- no deleted_at (rules carry no personal data, no erasure obligation); no DELETE grant either, matching contact_enrichment/workflow_runs'' own established no-physical-delete convention for this schema.';

create index scoring_rules_org_active_idx on public.scoring_rules (organization_id) where is_active;
