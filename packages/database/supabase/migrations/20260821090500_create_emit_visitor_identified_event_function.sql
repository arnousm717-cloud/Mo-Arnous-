-- Milestone 3.2C: emit_visitor_identified_event() -- the one narrow,
-- purpose-built write path for the visitor.identified outbox event.
--
-- `public.events` deliberately has ZERO grants to authenticated/anon
-- (20260811090100_enable_platform_infrastructure_rls.sql, M1.7) -- every
-- existing event emission happens exclusively via a SECURITY DEFINER SQL
-- function (create_organization_with_owner()'s own membership.created
-- insert is the only prior example), never a direct authenticated-role
-- INSERT. identifyVisitor (packages/intelligence/src/identify.ts) is
-- orchestrated in TypeScript across multiple statements inside one
-- withTenantContext transaction -- exactly like ingestTrackingEvent
-- already does for website_visitors/visitor_sessions/visitor_events --
-- so its own outbox write needed the identical narrow-function treatment
-- rather than either (a) a blanket INSERT grant on `events` to
-- authenticated (rejected: would let any authenticated-role connection,
-- which is every request in this monolith, forge an arbitrary event_type
-- for any organization_id it can resolve -- a real widening of the M1.7
-- security boundary for zero benefit to this one narrow use case), or
-- (b) folding the entire identification transaction into one giant
-- plpgsql function (rejected: identifyVisitor already composes real,
-- independently-tested TypeScript functions from two different packages
-- -- checkCookieTrackingConsent, resolveOrCreateVisitor,
-- getContactByEmail -- which cannot be called from inside a SQL
-- function body).
--
-- Takes only the two bare identifiers a caller could not otherwise
-- derive authority from on its own -- no event_type parameter (fixed to
-- 'visitor.identified'), no arbitrary payload shape, so this function
-- cannot be used to forge any other event type or an arbitrary payload
-- the way a general-purpose emit_event() primitive would. No PII of any
-- kind (no email) is accepted or stored.
--
-- Hardened (Milestone 3.2 Final Implementation Acceptance Audit,
-- remediation pass): the original version of this function accepted
-- p_organization_id/p_website_visitor_id/p_contact_id as three
-- independent, entirely-caller-trusted parameters and inserted the
-- event without ever re-checking them against real database state.
-- Since every request in this monolith connects as the same fixed
-- `authenticated` role, that meant ANY authenticated-role caller --
-- not just identifyVisitor's own correct call site -- could invoke this
-- function directly with arbitrary/fabricated/cross-tenant UUIDs and
-- forge a visitor.identified event for any organization. RLS is not a
-- defense here (SECURITY DEFINER bypasses it by design), so the
-- function itself must be the security boundary, exactly like every
-- other SECURITY DEFINER function in this codebase already is
-- (resolve_tracking_site, check_tracking_rate_limit,
-- record_visitor_cookie_tracking_consent -- none of which trust
-- organization_id as a raw parameter either).
--
-- p_organization_id is removed entirely, not merely re-validated --
-- organization_id is now ALWAYS derived from the website_visitors row
-- itself, the one piece of authoritative state a legitimate caller
-- cannot fabricate a plausible-looking value for. Before inserting, the
-- function independently re-proves from the database that the visitor
-- exists, that its CURRENT identified_contact_id equals the supplied
-- contact (i.e. this is really that visitor's authoritative binding
-- right now, not a stale/mismatched/fabricated pair), and that the
-- contact itself belongs to the same organization the visitor does.
-- Any hostile or malformed invocation -- nonexistent visitor,
-- nonexistent contact, mismatched org, or a visitor not currently bound
-- to the supplied contact -- fails closed as a silent no-op: no event
-- row, no exception, no PII in any error, consistent with this
-- milestone's own non-oracle design used everywhere else
-- (identifyVisitor's IdentifyResult, /track/identify's uniform 204).
-- identifyVisitor's own call (Step 9, after Step 8's
-- identified_contact_id UPDATE in the same transaction) always
-- satisfies these checks by construction, so this is a pure hardening
-- with no behavioral change to the legitimate path.

create function public.emit_visitor_identified_event(
  p_website_visitor_id uuid,
  p_contact_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visitor record;
begin
  select id, organization_id, identified_contact_id
    into v_visitor
    from public.website_visitors
    where id = p_website_visitor_id;

  -- Nonexistent visitor: nothing to authoritatively bind against.
  if v_visitor is null then
    return;
  end if;

  -- The supplied contact must be the visitor's CURRENT authoritative
  -- binding -- never merely "some contact that once was linked" or a
  -- caller-asserted value with no real relationship to this visitor.
  if v_visitor.identified_contact_id is null or v_visitor.identified_contact_id is distinct from p_contact_id then
    return;
  end if;

  -- Defense in depth: the contact must belong to the same organization
  -- as the visitor. website_visitors.identified_contact_id's own
  -- composite FK already guarantees this can never be false in
  -- practice, but re-proving it here costs nothing and means this
  -- function's safety never silently depends on that FK continuing to
  -- exist unchanged.
  if not exists (
    select 1 from public.contacts
    where id = p_contact_id and organization_id = v_visitor.organization_id
  ) then
    return;
  end if;

  insert into public.events (event_type, event_version, organization_id, payload)
  values (
    'visitor.identified',
    1,
    v_visitor.organization_id,
    jsonb_build_object(
      'organization_id', v_visitor.organization_id,
      'website_visitor_id', v_visitor.id,
      'contact_id', p_contact_id
    )
  );
end;
$$;

comment on function public.emit_visitor_identified_event(uuid, uuid) is
  'Milestone 3.2C, hardened in the Milestone 3.2 Final Implementation Acceptance Audit remediation pass. The one narrow SECURITY DEFINER write path for the visitor.identified outbox event, called from identifyVisitor''s own atomic transaction. organization_id is never a caller-supplied parameter -- it is always derived from the website_visitors row itself, and the event is only ever inserted after independently re-proving from authoritative database state that the visitor exists, that its CURRENT identified_contact_id equals the supplied contact, and that the contact belongs to the same organization. Any mismatch fails closed as a silent no-op (no event, no exception, no PII). Fixed event_type/event_version, no arbitrary payload shape -- cannot be used to forge any other event type. EXECUTE granted to authenticated only, matching every other tracking function''s privilege model -- the function body itself, not the grant, is the security boundary.';

grant execute on function public.emit_visitor_identified_event(uuid, uuid) to authenticated;
