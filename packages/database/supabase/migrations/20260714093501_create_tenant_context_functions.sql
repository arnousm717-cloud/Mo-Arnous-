-- Tenant-context resolution (docs/03-Database-Architecture.md §5).
--
-- These functions read from a request-scoped Postgres session setting
-- (set via set_config(..., true) — transaction-local), populated by API
-- middleware at the start of every request. This is the single mechanism
-- every caller type resolves through — JWT session, API key, or n8n's
-- service-role credential (docs/02-Software-Architecture.md §1,
-- docs/04-API-Architecture.md §3) — never a static JWT claim, never a
-- client-supplied parameter.
--
-- Deviation from docs/03: the third function is named current_role_key(),
-- not current_role(), to avoid any ambiguity with PostgreSQL's own
-- SQL-standard CURRENT_ROLE construct. Naming-only correctness fix — see
-- ADR-003 and CHANGELOG.md for the M1.2 entry.

create or replace function public.current_org()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select nullif(current_setting('app.current_org', true), '')::uuid;
$$;

comment on function public.current_org() is
  'Resolves the active organization_id for the current request from a request-scoped session setting. Never a static JWT claim.';

create or replace function public.current_agency()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select nullif(current_setting('app.current_agency', true), '')::uuid;
$$;

comment on function public.current_agency() is
  'Resolves the active agency_id for agency-level (roll-up) requests. Resolution logic for which agency a request acts on behalf of is an API-middleware concern, built in M1.4 — this function only reads the already-resolved value.';

create or replace function public.current_role_key()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(current_setting('app.current_role', true), '');
$$;

comment on function public.current_role_key() is
  'Resolves the active role key (e.g. org_admin) for the current request. Named current_role_key(), not current_role(), to avoid colliding with PostgreSQL''s built-in CURRENT_ROLE.';
