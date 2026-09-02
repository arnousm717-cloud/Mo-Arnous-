-- Milestone 3.3A: contact_enrichment / company_enrichment -- the real
-- schema behind docs/03-Database-Architecture.md's own previously-
-- documented (but never built) enrichment-cache tables, per the
-- Milestone 3.3 Architecture Resolution Report §J.
--
-- Deliberately a SEPARATE table from `contacts`/`companies`, never a
-- column on either -- this is the structural mechanism that makes
-- provider-enriched data categorically incapable of overwriting a
-- customer-entered CRM field: there is no code path that writes a
-- provider result into contacts.job_title/companies.industry/etc.,
-- because those columns are never touched by anything in this table's
-- own write path at all.
--
-- One row per (organization, subject, provider) -- upserted on every
-- fresh lookup, never accumulated as history. This is deliberately
-- unlike visitor_identifications' append-only audit design: enrichment
-- is working data with a freshness/TTL concept (fetched_at/expires_at),
-- not a compliance/audit trail: a stale row has no evidentiary value
-- once superseded, so overwriting it in place is correct, not a loss.

create table public.contact_enrichment (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  contact_id uuid not null,
  provider text not null,
  status text not null check (status in ('pending', 'completed', 'failed')),
  -- Structured, product-displayed fields only -- deliberately never
  -- merged into contacts.* directly (see this migration's own top
  -- comment). Null while status='pending' or 'failed'.
  normalized_result jsonb,
  -- Full provider response, retained for debugging/reprocessing without
  -- a second paid lookup -- RLS-protected like every other column here,
  -- never logged wholesale (apps/web's own structured-logging discipline,
  -- docs/08-Security.md §7, is unaffected by this table's existence).
  -- Size-bounded at the application layer before insert (Milestone 3.3E).
  raw_payload jsonb,
  error text,
  cost_usd numeric,
  -- The public.events.id (visitor.identified/contact.created) that
  -- triggered this lookup, when event-triggered -- an on-demand/manual
  -- trigger has none. Deliberately NOT a foreign key to events.id:
  -- events may be pruned/archived independently later, and an
  -- enrichment row must survive that unaffected. Informational/
  -- traceability only.
  source_event_id uuid,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz,
  -- Tenant-safety half, and ALSO the erasure-cascade mechanism: a
  -- hard-erased contact's enrichment data has no independent existence
  -- or evidentiary value once its subject is gone -- CASCADE, never SET
  -- NULL, deliberately unlike visitor_identifications' own audit-trail
  -- FK (which must survive its subject's erasure). This is one of two
  -- layers closing the "delayed enrichment write-back after erasure"
  -- race (Milestone 3.3 Architecture Resolution Report §G) -- the
  -- other, live-recheck layer lives in the application-level write-back
  -- transaction (packages/intelligence, Milestone 3.3D), since a
  -- provider response can still arrive and attempt a write in the
  -- window between erasure and this FK's own enforcement being
  -- relevant (i.e., before any row here would even exist to cascade).
  constraint contact_enrichment_contact_org_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id)
    on delete cascade,
  constraint contact_enrichment_org_contact_provider_key
    unique (organization_id, contact_id, provider)
);

comment on table public.contact_enrichment is
  'Milestone 3.3A. Provider-enriched contact data, upserted per (organization_id, contact_id, provider) -- never merged into contacts.* directly, so provider data can never overwrite a customer-entered CRM field. ON DELETE CASCADE to contacts: enrichment data does not survive its subject''s hard erasure (unlike visitor_identifications'' own audit-trail design). No raw email/PII beyond what the provider itself returns is accepted here from any caller -- see Milestone 3.3D''s own write-back validation.';

create index contact_enrichment_org_contact_idx on public.contact_enrichment (organization_id, contact_id);
create index contact_enrichment_source_event_idx on public.contact_enrichment (source_event_id) where source_event_id is not null;

create table public.company_enrichment (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  provider text not null,
  status text not null check (status in ('pending', 'completed', 'failed')),
  normalized_result jsonb,
  raw_payload jsonb,
  error text,
  cost_usd numeric,
  source_event_id uuid,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz,
  -- Unlike contacts, companies are NEVER hard-erased anywhere in this
  -- codebase as of this migration (companies hold firmographic, not
  -- natural-person, data -- docs/13 Milestone 2.1's own scope note) --
  -- ON DELETE CASCADE is still the correct FK action for referential
  -- cleanliness if that ever changes, but the write-back live-recheck
  -- for companies (Milestone 3.3D) checks deleted_at IS NULL, the
  -- actually-exercised lifecycle event for this table, not row
  -- existence.
  constraint company_enrichment_company_org_fk
    foreign key (organization_id, company_id)
    references public.companies (organization_id, id)
    on delete cascade,
  constraint company_enrichment_org_company_provider_key
    unique (organization_id, company_id, provider)
);

comment on table public.company_enrichment is
  'Milestone 3.3A. Provider-enriched company data, upserted per (organization_id, company_id, provider) -- never merged into companies.* directly. Companies are never hard-erased in this codebase (firmographic, not personal, data) -- the write-back path (Milestone 3.3D) instead re-checks companies.deleted_at IS NULL before writing, the actually-exercised lifecycle event for this table.';

create index company_enrichment_org_company_idx on public.company_enrichment (organization_id, company_id);
create index company_enrichment_source_event_idx on public.company_enrichment (source_event_id) where source_event_id is not null;
