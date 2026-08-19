-- Milestone 2.4A: Agency roll-up read access for Contacts.
-- Follows the exact agency_rollup_organizations/agency_rollup_companies
-- pattern (20260807130200, 20260819100000) — see those migrations for the
-- full architectural rationale, not repeated here.
--
-- Column selection — data minimization is the primary design constraint
-- for this specific view, not merely a style preference (docs/13
-- Milestone 2.4A "Detailed design"): contacts is the one rolled-up table
-- that holds personal data of a natural person.
--   included: id, organization_id (attribution), company_id (explicit
--     requirement: associate the contact with its company),
--     first_name/last_name (explicit requirement: identify the contact),
--     lifecycle_stage (explicit requirement: display lifecycle/status —
--     a bounded, four-value CHECK-constrained enum, never free-form
--     text), created_at (sort).
--   EXCLUDED, never to be added to this view without a separate,
--     explicit, reviewed decision: email, phone (direct personal contact
--     information — the exact fields this milestone's own scope decision
--     names). Also excluded, flagged rather than silently omitted: job_title
--     and linkedin_url are both self-reported FREE-FORM text columns (not
--     bounded enums like lifecycle_stage) with no established roll-up
--     requirement — excluded on the same data-minimization principle,
--     not merely because no one asked for them yet. owner_id excluded
--     for the identical raw-UUID-with-no-resolution reasoning as
--     agency_rollup_companies. updated_at/deleted_at excluded/filtered
--     for the identical reasoning as agency_rollup_companies.
--
-- security_invoker = false — identical rationale to agency_rollup_companies:
-- contacts_select_own is single-organization by design, so it can never
-- satisfy this cross-org read; running as the view owner is what makes it
-- possible, and the WHERE clause below is the entire access boundary.

create view public.agency_rollup_contacts
with (security_invoker = false)
as
  select
    c.id,
    c.organization_id,
    c.company_id,
    c.first_name,
    c.last_name,
    c.lifecycle_stage,
    c.created_at
  from public.contacts c
  join public.organizations o on o.id = c.organization_id
  where o.agency_id = current_agency()
    and current_role_key() in ('agency_owner', 'agency_admin')
    and c.deleted_at is null;

comment on view public.agency_rollup_contacts is
  'Milestone 2.4A. Agency-scoped, read-only roll-up of active client contacts. Runs as the view owner (bypassing contacts'' own single-org RLS policy by design) — access control is entirely the WHERE clause (current_agency() + role check), never contacts'' base policy. Deliberately excludes email/phone (direct PII) and job_title/linkedin_url (free-form text, no established roll-up need) — data minimization is a first-class design constraint for this specific view, not a style choice. See this migration''s own top comment for the full reviewed column set.';

revoke all on public.agency_rollup_contacts from public, anon, authenticated;

grant select on public.agency_rollup_contacts to authenticated;
