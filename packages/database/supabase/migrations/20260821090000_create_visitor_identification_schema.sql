-- Milestone 3.2A: Visitor Identification -- database identity foundation
-- (docs/13-Technical-Design-Review.md "Milestone 3.2" design resolution).
-- Schema only -- RLS/grants are the companion migration that follows
-- this one, matching the established schema-then-RLS precedent
-- (20260812120000/20260812120100, 20260820090000/20260820090100, etc.).
--
-- Additive only: website_visitors gains one nullable column via ALTER
-- TABLE; no existing migration is edited in place, matching this
-- repository's own "additive follow-up migration" precedent already set
-- by 3.1B's anonymous_session_id addition (20260820100000).

alter table public.website_visitors
  add column identification_suppressed_at timestamptz;

comment on column public.website_visitors.identification_suppressed_at is
  'Milestone 3.2A. Set once, permanently, by the contact-erasure anti-relink mechanism (Milestone 3.2F) when the contact this visitor was linked to is hard-erased. Non-null makes this specific visitor row permanently ineligible for any future identification, to any contact -- prevents retained anonymous history from becoming re-associated with a replacement/new contact merely because the browser still possesses the same anonymous_id. Never set or cleared by ordinary consent withdrawal (Milestone 3.2F): withdrawal unlinks but does not suppress, since it is reversible in principle -- only erasure is permanent.';

create table public.visitor_identifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_visitor_id uuid not null,
  -- Nullable: an 'unlinked_withdrawal'/'unlinked_erasure'/'rejected_conflict'
  -- row represents "no active contact" or "the contact that was rejected",
  -- not always a successful binding.
  contact_id uuid,
  event_type text not null check (
    event_type in ('identified', 'unlinked_withdrawal', 'unlinked_erasure', 'rejected_conflict')
  ),
  -- Replay protection (Milestone 3.2 Design Resolution Report §D): a
  -- signed assertion's jti is consumed exactly once via the UNIQUE
  -- constraint below, structurally, not by an application-trusted check.
  -- Scoped to (organization_id, token_jti) rather than a bare global
  -- UNIQUE(token_jti) -- threat-modeled deliberately: a jti only ever
  -- needs to be non-replayable within the tenant it was issued for, and
  -- a global constraint would create an (astronomically unlikely, but
  -- structurally unnecessary) cross-tenant availability coupling where
  -- one organization's legitimate identification could fail merely
  -- because an unrelated tenant's customer backend happened to generate
  -- the same random jti first. Tenant-scoping removes that coupling
  -- entirely while providing the identical replay guarantee where it
  -- actually matters.
  token_jti uuid not null,
  occurred_at timestamptz not null default now(),
  -- Tenant-safety half: proves website_visitor_id belongs to this row's
  -- own organization -- same reasoning as every other tracking child
  -- table's composite FK in this repository (visitor_sessions,
  -- visitor_events). ON DELETE CASCADE: an identification audit row has
  -- no meaningful existence without its visitor.
  constraint visitor_identifications_visitor_org_fk
    foreign key (organization_id, website_visitor_id)
    references public.website_visitors (organization_id, id)
    on delete cascade,
  -- Tenant-safety half: proves contact_id (when present) belongs to this
  -- row's own organization. ON DELETE SET NULL, column-list form (same
  -- idiom as website_visitors_contact_org_fk and contacts_company_org_fk):
  -- a hard-erased contact's audit trail survives with contact_id = null,
  -- preserving the fact an identification/rejection once happened
  -- without retaining a dangling reference to the erased row.
  constraint visitor_identifications_contact_org_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id)
    on delete set null (contact_id),
  constraint visitor_identifications_org_jti_key
    unique (organization_id, token_jti)
);

comment on table public.visitor_identifications is
  'Milestone 3.2A. Append-only identification audit/replay-protection log -- one row per identification attempt outcome, never updated or deleted by application code. Doing double duty deliberately (smallest design satisfying two requirements with one object): (1) auditability of every identify/unlink/reject event for a website_visitors row, since identified_contact_id alone loses this history on every UPDATE; (2) structural single-use enforcement of a signed identity assertion''s jti, via the (organization_id, token_jti) UNIQUE constraint -- a replayed jti fails this INSERT, and the whole identification transaction rolls back naturally. No email, no signed-assertion contents, no raw evidence of any kind is ever stored here -- only organization-scoped identifiers and a closed event-type vocabulary.';

create index visitor_identifications_org_visitor_idx on public.visitor_identifications (organization_id, website_visitor_id);
create index visitor_identifications_org_contact_idx on public.visitor_identifications (organization_id, contact_id);
create index visitor_identifications_org_occurred_idx on public.visitor_identifications (organization_id, occurred_at);

create table public.tracking_site_public_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tracking_site_id uuid not null,
  -- Ed25519 public key, SPKI DER, PEM-encoded ("-----BEGIN PUBLIC
  -- KEY-----..."). Never a private key, never a symmetric secret --
  -- public keys are not secrets by definition, so no encryption-at-rest
  -- is required for this column (Milestone 3.2 Design Resolution Report,
  -- post-Phase-0 amendment: the originally accepted HMAC/reversible-
  -- secret-storage design was superseded specifically because this
  -- repository has no shipped encryption-at-rest primitive to reuse for
  -- a reversible secret -- Ed25519 removes that requirement entirely by
  -- construction, since only the customer's own trusted backend ever
  -- holds the private key).
  public_key_pem text not null,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  -- Tenant-safety half: proves tracking_site_id belongs to this row's
  -- own organization -- same composite-FK discipline as every other
  -- tracking table. ON DELETE RESTRICT (not CASCADE): a hard DELETE of a
  -- tracking_sites row (never exercised by any existing code path --
  -- revocation is always revoked_at, matching this table family's own
  -- established convention) must not silently orphan/cascade-destroy a
  -- registered key's own row; this documents that constraint rather than
  -- assuming it.
  constraint tracking_site_public_keys_site_org_fk
    foreign key (organization_id, tracking_site_id)
    references public.tracking_sites (organization_id, id)
    on delete restrict,
  -- Defensive bound on stored key material -- a genuine Ed25519 SPKI PEM
  -- public key is ~110-130 characters; 500 gives ample headroom for
  -- whitespace/line-ending variance across PEM generators without
  -- accepting arbitrarily large garbage. Real format validity (is this
  -- actually a parseable Ed25519 SPKI key, not merely short enough) is
  -- enforced at the application layer (Milestone 3.2B) before this row
  -- is ever inserted -- this CHECK is a cheap defensive floor/ceiling,
  -- not a substitute for that validation.
  constraint tracking_site_public_keys_pem_length check (
    char_length(public_key_pem) > 0 and char_length(public_key_pem) <= 500
  )
);

comment on table public.tracking_site_public_keys is
  'Milestone 3.2A/3.2B. Registered Ed25519 public keys for verifying customer-signed visitor-identification assertions (POST /track/identify). Multiple rows per tracking site are expected and supported -- rotation is a new row plus revoking the old one, never mutating an existing row''s key material in place (api_keys.revoked_at / tracking_sites.revoked_at precedent). id doubles as the assertion''s kid claim: verification always looks up a key by (organization_id, tracking_site_id, id) together, resolved from the request''s own siteKey -- never by id/kid alone -- so a kid value can never select a key belonging to a different tenant or a different tracking site, regardless of what an attacker-controlled token claims. No private key, no symmetric secret is ever stored -- the customer''s own trusted backend generates and retains the private key; this platform never receives, generates, stores, logs, or transmits it.';

create index tracking_site_public_keys_org_site_idx on public.tracking_site_public_keys (organization_id, tracking_site_id);
