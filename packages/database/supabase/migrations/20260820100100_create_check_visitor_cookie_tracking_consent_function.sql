-- Milestone 3.1B prerequisite (Decision 1, consent access): a narrow
-- SECURITY DEFINER function answering exactly one question -- for this
-- organization + anonymous visitor, is the latest cookie_tracking
-- consent state granted -- closing the empirically-proven gap where
-- consent_records' own RLS (org_admin-only SELECT,
-- 20260810100100_enable_compliance_rls.sql) makes the table completely
-- unreadable to the role-less ingestion pathway (Milestone 3.1B
-- pre-implementation audit, docs/13-Technical-Design-Review.md
-- "Milestone 3.1B" -- empirically proven there, not just reasoned about:
-- a real granted consent_records row was invisible to a read using
-- organization_id alone, no role, before this function existed).
--
-- Deliberate, documented exception to this schema's own
-- caller-identity-guard convention -- the SAME class of exception
-- resolve_tracking_site() (20260820090200) already established: there
-- is no authenticated identity for the ingestion pathway to check (no
-- staff user, no membership, no role), so this function does not, and
-- must not, guard on auth.uid(). Its authorization primitive is an
-- already-resolved organization_id (never accepted from the browser --
-- 3.1 architecture decision report) plus the visitor's own opaque
-- anonymous_id, exactly mirroring resolve_tracking_site()'s own
-- possession-based model.
--
-- Existing consent_records RLS/grants are entirely untouched by this
-- migration -- this function does not loosen the org_admin-only
-- SELECT/INSERT policies in any way; it is a narrow, separate, minimal
-- read path that returns a single boolean, never a row, never any other
-- consent_type/subject_type's data, and never a distinguishable
-- "no row" vs "withdrawn" signal (both correctly resolve to false).

create or replace function public.check_visitor_cookie_tracking_consent(
  p_organization_id uuid,
  p_anonymous_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select status = 'granted'
      from public.consent_records
      where organization_id = p_organization_id
        and subject_type = 'visitor'
        and subject_id = p_anonymous_id
        and consent_type = 'cookie_tracking'
      order by recorded_at desc, id desc
      limit 1
    ),
    false
  );
$$;

comment on function public.check_visitor_cookie_tracking_consent(uuid, uuid) is
  'Milestone 3.1B prerequisite. Returns whether the latest cookie_tracking consent state for (organization_id, subject_type=visitor, subject_id=anonymous_id) is granted -- false for no matching row, false for a withdrawn latest row, deliberately indistinguishable (mirrors this platform''s established cross-org/nonexistent-indistinguishable doctrine, applied here to consent absence vs. withdrawal). Deterministic ordering: recorded_at desc, id desc -- id is a secondary tie-breaker guaranteeing a repeatable query result under a same-instant recorded_at collision, not a claim that it identifies the true chronological winner in that vanishingly rare case (3.1B pre-implementation audit, approved as-is -- no additional schema column). Does not modify or bypass consent_records'' own RLS for any other caller -- this is an additional, narrow, boolean-only read path, not a replacement for the existing org_admin-gated SELECT policy. EXECUTE granted to authenticated only, mirroring resolve_tracking_site()''s own privilege model exactly -- PUBLIC/anon receive zero EXECUTE by construction (the M1.7-era default-privilege hardening, 20260812140000, already revokes PUBLIC execute on every function created after it -- no explicit revoke needed here).';

grant execute on function public.check_visitor_cookie_tracking_consent(uuid, uuid) to authenticated;
