-- brand_themes: one white-label theme per agency (M1.4 product/data
-- checkpoint, docs/07-UI-UX-System.md §2/§3).
--
-- Only --primary/--secondary/--accent and the logo are overridable per
-- docs/07 §2 — --destructive/--success/--warning/--ai-surface/--context-band
-- stay platform-fixed everywhere, so this table intentionally has no
-- columns for them. Every overridable color needs both a light and dark
-- variant (docs/07 §2: "every tenant theme must define both a light and
-- dark variant of its palette") — stored as explicit paired columns rather
-- than a jsonb blob, matching this schema's existing preference for typed
-- columns wherever the shape is fixed and known (jsonb here is reserved for
-- genuinely open-ended data like roles.permission_set).
--
-- Column defaults are the platform default palette itself
-- (docs/07 §3's exact hex values) — a freshly created agency theme starts
-- identical to the platform default and is then customized, rather than
-- starting blank.

create table public.brand_themes (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null unique references public.agencies (id) on delete cascade,
  logo_url text,
  favicon_url text,
  primary_color_light text not null default '#3B5BFD',
  primary_color_dark text not null default '#5B7BFF',
  secondary_color_light text not null default '#0F1420',
  secondary_color_dark text not null default '#1E2433',
  accent_color_light text not null default '#0EA5A0',
  accent_color_dark text not null default '#14C8C2',
  font_family text not null default 'Inter, sans-serif',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brand_themes_hex_colors check (
    primary_color_light ~ '^#[0-9a-fA-F]{6}$'
    and primary_color_dark ~ '^#[0-9a-fA-F]{6}$'
    and secondary_color_light ~ '^#[0-9a-fA-F]{6}$'
    and secondary_color_dark ~ '^#[0-9a-fA-F]{6}$'
    and accent_color_light ~ '^#[0-9a-fA-F]{6}$'
    and accent_color_dark ~ '^#[0-9a-fA-F]{6}$'
  )
);

comment on table public.brand_themes is
  'One white-label theme per agency (agency_id unique). Platform default -> agency -> dormant org-override is the three-layer resolution model (docs/07-UI-UX-System.md §2); this table is layer 2. Layer 3 (per-organization override) is intentionally not built yet.';

alter table public.brand_themes enable row level security;

-- Base grants — tables created via SQL migrations don't auto-grant to
-- authenticated/anon (M1.2 finding, docs/08-Security.md §2); every table
-- since has carried this explicitly rather than rediscovering it.
grant select, insert, update, delete on public.brand_themes to authenticated;

-- Agency staff manage their own agency's theme directly. Write access is
-- role-restricted (agency_owner/agency_admin) even though every currently
-- seeded agency-scoped role already is one of those two — stated
-- explicitly so a future lower-privilege agency role doesn't silently
-- inherit write access it was never meant to have.
create policy "brand_themes_agency_select" on public.brand_themes
  for select
  using (agency_id = current_agency());

create policy "brand_themes_agency_write" on public.brand_themes
  for all
  using (agency_id = current_agency() and current_role_key() in ('agency_owner', 'agency_admin'))
  with check (agency_id = current_agency() and current_role_key() in ('agency_owner', 'agency_admin'));

-- Separate policy for the OTHER real reader of this table: an ordinary
-- organization-level user, rendering their own org's pages, needs to read
-- the theme of the agency that owns their org — a completely different
-- access pattern from "I am agency staff reading my own agency's row",
-- and one current_agency() alone can't express, since an org-level user
-- has no agency context at all. The subquery is itself constrained by
-- organizations' own RLS (id = current_org()), so this can only ever
-- resolve the caller's own currently-active organization's agency, never
-- an arbitrary one.
create policy "brand_themes_via_own_organization_select" on public.brand_themes
  for select
  using (
    agency_id = (select o.agency_id from public.organizations o where o.id = current_org())
  );
