-- Milestone 4.1 Phase 2: emit_contact_event / emit_company_event /
-- emit_deal_event -- the three narrow, hardened SECURITY DEFINER write
-- paths for the nine CRM domain-event outbox rows Phase 2 needs (contact/
-- company/deal x created/updated/deleted). Directly follows the
-- emit_visitor_identified_event() precedent (20260821090500): public.events
-- has zero grants to authenticated (20260811090100, M1.7), so every event
-- emission is a SECURITY DEFINER function, never a direct authenticated-role
-- INSERT -- a blanket INSERT grant on `events` would let any
-- authenticated-role connection (every request in this monolith) forge an
-- arbitrary event_type for any organization_id it can resolve.
--
-- organization_id is never a caller-supplied parameter -- always re-derived
-- from the mutated row itself, the one piece of authoritative state a
-- caller cannot fabricate a plausible cross-tenant value for (same
-- discipline as emit_visitor_identified_event's own hardening).
--
-- Caller-tenant-context check (hardening found and fixed during this
-- migration's own implementation-turn testing, before commit): unlike
-- emit_visitor_identified_event -- whose own re-validation requires a
-- SPECIFIC, already-true {visitor, contact} linkage that a caller cannot
-- fabricate merely by knowing two existing ids -- an emit_<entity>_event
-- call only needs a single existing row of the right kind. Without an
-- additional check, ANY authenticated-role caller (any logged-in user of
-- any organization, since every request in this monolith shares that one
-- role) could invoke e.g. emit_contact_event() directly with some OTHER
-- organization's real, guessed/enumerated contact id and successfully
-- insert a legitimate-looking event into that victim organization's own
-- outbox -- a real cross-tenant abuse path (spurious Brain projection
-- churn at minimum), not merely a redundant replay of already-true state.
-- Each function therefore also requires the row's own organization_id to
-- match current_org() -- the same request-scoped tenant-context function
-- every RLS policy in this codebase already reads (public.current_org(),
-- 20260714093501) -- before inserting. Every legitimate call site
-- (packages/crm's create/update/soft-delete functions) always runs inside
-- withTenantContext(ctx, ...) with ctx.organizationId equal to the row's
-- own organization_id by construction (every query is itself scoped
-- `where organization_id = ctx.organizationId`), so this adds no
-- legitimate-path behavior change -- it only closes the cross-tenant gap.
--
-- event_type is a fixed, allowlisted set per function (never an arbitrary
-- string), and is cross-checked against the row's own deleted_at state:
-- '.created'/'.updated' require the row to currently be active (matches
-- createX/updateX's own `WHERE deleted_at is null` invariant in
-- packages/crm -- re-verified here so this function's safety never
-- silently depends on that TypeScript-side invariant alone), and
-- '.deleted' requires deleted_at to already be set (softDeleteX sets
-- deleted_at = now() and calls this function inside the SAME transaction,
-- after the UPDATE has already returned the row with deleted_at populated).
-- Any mismatch -- nonexistent entity, wrong tenant, invalid event_type, or
-- a state that doesn't match the requested event_type -- fails closed as a
-- silent no-op: no event row, no exception, matching this codebase's
-- established non-oracle design for every other SECURITY DEFINER tracking
-- function.
--
-- Payload carries only organization_id + the entity id -- no name/email/
-- phone/any other content field (Milestone 4.1 Phase 2 Detailed Design
-- §N) -- an identity reference for a reconciliation-model consumer to
-- re-read current state by, never a snapshot to project.
--
-- No hard-delete/GDPR-erasure event exists or is needed here: Phase 1's
-- own composite ON DELETE CASCADE FKs (brain_entity_profiles_contact_org_fk
-- et al., 20260905090100) already remove a hard-erased entity's Brain rows
-- structurally, the instant execute_contact_erasure() runs -- there is no
-- Brain-side code path for Phase 2 to trigger in response to an erasure.

create function public.emit_contact_event(
  p_contact_id uuid,
  p_event_type text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact record;
begin
  if p_event_type not in ('contact.created', 'contact.updated', 'contact.deleted') then
    return;
  end if;

  select id, organization_id, deleted_at
    into v_contact
    from public.contacts
    where id = p_contact_id;

  if v_contact is null then
    return;
  end if;

  if v_contact.organization_id is distinct from current_org() then
    return;
  end if;

  if p_event_type in ('contact.created', 'contact.updated') and v_contact.deleted_at is not null then
    return;
  end if;
  if p_event_type = 'contact.deleted' and v_contact.deleted_at is null then
    return;
  end if;

  insert into public.events (event_type, event_version, organization_id, payload)
  values (
    p_event_type,
    1,
    v_contact.organization_id,
    jsonb_build_object(
      'organization_id', v_contact.organization_id,
      'contact_id', v_contact.id
    )
  );
end;
$$;

comment on function public.emit_contact_event(uuid, text) is
  'Milestone 4.1 Phase 2. SECURITY DEFINER write path for the contact.created/contact.updated/contact.deleted outbox events, mirroring emit_visitor_identified_event()''s hardening. organization_id is always re-derived from the contacts row itself, never a caller parameter, and must match the caller''s own current_org() tenant context -- closes a cross-tenant abuse path where any authenticated caller could otherwise emit an event into another organization''s outbox merely by knowing/guessing a real contact id there. event_type is validated against a fixed allowlist and cross-checked against the row''s own deleted_at state (created/updated require an active row; deleted requires deleted_at already set), so this function cannot be used to forge an event inconsistent with the row''s real state. Payload carries only organization_id/contact_id -- no PII. Fails closed (silent no-op, no exception) for a nonexistent contact, wrong tenant, an invalid event_type, or a state mismatch. EXECUTE granted to authenticated only.';

grant execute on function public.emit_contact_event(uuid, text) to authenticated;

create function public.emit_company_event(
  p_company_id uuid,
  p_event_type text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company record;
begin
  if p_event_type not in ('company.created', 'company.updated', 'company.deleted') then
    return;
  end if;

  select id, organization_id, deleted_at
    into v_company
    from public.companies
    where id = p_company_id;

  if v_company is null then
    return;
  end if;

  if v_company.organization_id is distinct from current_org() then
    return;
  end if;

  if p_event_type in ('company.created', 'company.updated') and v_company.deleted_at is not null then
    return;
  end if;
  if p_event_type = 'company.deleted' and v_company.deleted_at is null then
    return;
  end if;

  insert into public.events (event_type, event_version, organization_id, payload)
  values (
    p_event_type,
    1,
    v_company.organization_id,
    jsonb_build_object(
      'organization_id', v_company.organization_id,
      'company_id', v_company.id
    )
  );
end;
$$;

comment on function public.emit_company_event(uuid, text) is
  'Milestone 4.1 Phase 2. SECURITY DEFINER write path for the company.created/company.updated/company.deleted outbox events -- structurally identical hardening to emit_contact_event (see that function''s own comment), including the current_org() cross-tenant-caller check. organization_id always re-derived from the companies row itself. Fails closed for a nonexistent company, wrong tenant, an invalid event_type, or a deleted_at state mismatch. EXECUTE granted to authenticated only.';

grant execute on function public.emit_company_event(uuid, text) to authenticated;

create function public.emit_deal_event(
  p_deal_id uuid,
  p_event_type text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deal record;
begin
  if p_event_type not in ('deal.created', 'deal.updated', 'deal.deleted') then
    return;
  end if;

  select id, organization_id, deleted_at
    into v_deal
    from public.deals
    where id = p_deal_id;

  if v_deal is null then
    return;
  end if;

  if v_deal.organization_id is distinct from current_org() then
    return;
  end if;

  if p_event_type in ('deal.created', 'deal.updated') and v_deal.deleted_at is not null then
    return;
  end if;
  if p_event_type = 'deal.deleted' and v_deal.deleted_at is null then
    return;
  end if;

  insert into public.events (event_type, event_version, organization_id, payload)
  values (
    p_event_type,
    1,
    v_deal.organization_id,
    jsonb_build_object(
      'organization_id', v_deal.organization_id,
      'deal_id', v_deal.id
    )
  );
end;
$$;

comment on function public.emit_deal_event(uuid, text) is
  'Milestone 4.1 Phase 2. SECURITY DEFINER write path for the deal.created/deal.updated/deal.deleted outbox events -- structurally identical hardening to emit_contact_event (see that function''s own comment), including the current_org() cross-tenant-caller check. organization_id always re-derived from the deals row itself. Fails closed for a nonexistent deal, wrong tenant, an invalid event_type, or a deleted_at state mismatch. EXECUTE granted to authenticated only.';

grant execute on function public.emit_deal_event(uuid, text) to authenticated;
