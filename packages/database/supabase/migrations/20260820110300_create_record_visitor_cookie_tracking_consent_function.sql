-- Milestone 3.1C-A: record_visitor_cookie_tracking_consent() -- the
-- SECURITY DEFINER write path a future public consent endpoint (3.1C-C,
-- not yet built) will call to record a visitor's own cookie-tracking
-- consent decision, without any staff session, JWT, or role context.
--
-- Deliberately unlike packages/compliance's existing recordConsent(),
-- which requires {userId, organizationId, roleKey} and is gated by the
-- staff-only consent_records_org_admin_insert RLS policy -- that path is
-- for staff recording consent on a contact's behalf, and is completely
-- unusable here (design review confirmed no unauthenticated caller can
-- satisfy it). This function is the visitor's own, narrow write path.
--
-- Takes p_site_key (the public tracking-site credential), never
-- p_organization_id directly -- organization_id is resolved internally
-- from tracking_sites, mirroring resolve_tracking_site()'s own precedent
-- exactly. A design accepting organization_id as a parameter was
-- evaluated and rejected during design review: it would let any
-- authenticated-role caller anywhere in the monorepo -- not just the
-- intended anonymous tracking pathway -- forge a consent_records row for
-- an arbitrary tenant simply by passing its organization_id. Removing
-- the parameter closes that structurally, not by convention: there is
-- nothing here to misuse.
--
-- Takes no IP parameter. recordConsent()'s own ip_address column has
-- never been populated by any real caller since M1.6 (confirmed by
-- repository grep during design review), and this new anonymous pathway
-- has no more legitimate a use for capturing it -- consent_records
-- carries a 7-year compliance-evidence retention (docs/03), and adding a
-- new, populated PII field to a 7-year-retained table was rejected as an
-- unjustified privacy/data-minimization cost with no offsetting benefit.
--
-- Returns boolean only -- true if a row was written, false if the site
-- key could not be resolved to a live (non-revoked) tracking site. No
-- other metadata (organization_id, consent_record id, timestamps) is
-- ever returned to the caller: the anonymous pathway has no legitimate
-- use for any of it, and returning it would be a gratuitous new leak
-- surface for zero functional benefit. On an unresolved site key,
-- nothing is written at all -- no placeholder row, no error, no partial
-- state -- only false.
--
-- Append-only, matching every other consent_records write path in this
-- repository: no update, no delete, no upsert. The subject's current
-- consent status is always "most recent row", per
-- check_visitor_cookie_tracking_consent()'s own
-- order by recorded_at desc, id desc limit 1 read precedent.

create function public.record_visitor_cookie_tracking_consent(
  p_site_key uuid,
  p_anonymous_id uuid,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
begin
  if p_status not in ('granted', 'withdrawn') then
    raise exception 'p_status must be granted or withdrawn';
  end if;

  select organization_id into v_organization_id
  from public.tracking_sites
  where id = p_site_key
    and revoked_at is null;

  if v_organization_id is null then
    return false;
  end if;

  insert into public.consent_records (
    organization_id,
    subject_type,
    subject_id,
    consent_type,
    status,
    source,
    ip_address,
    recorded_at
  ) values (
    v_organization_id,
    'visitor',
    p_anonymous_id,
    'cookie_tracking',
    p_status,
    'tracking_script',
    null,
    now()
  );

  return true;
end;
$$;

comment on function public.record_visitor_cookie_tracking_consent(uuid, uuid, text) is
  'Milestone 3.1C-A. SECURITY DEFINER write path for a visitor''s own cookie-tracking consent decision, for the future public consent endpoint (3.1C-C). Takes p_site_key, never organization_id directly -- organization_id is resolved internally from tracking_sites, mirroring resolve_tracking_site()''s own precedent, making cross-tenant forgery structurally impossible rather than merely checked. No IP parameter (recordConsent()''s own ip_address has never been populated by any real caller; consent_records carries a 7-year compliance retention, so no new PII field is added without justification). Returns boolean only -- true if written, false if the site key did not resolve to a live tracking site, in which case nothing is written. Append-only. EXECUTE granted to authenticated only.';

grant execute on function public.record_visitor_cookie_tracking_consent(uuid, uuid, text) to authenticated;
