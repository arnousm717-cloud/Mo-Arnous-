-- Platform infrastructure (M1.7, docs/03-Database-Architecture.md §2.1/§2.10):
-- api_keys, events (outbox), event_deliveries, webhook_events_seen.
--
-- Scope note (approved M1.7 plan): none of these tables have any
-- tenant-facing route or UI in M1.7. api_keys exists and can be issued
-- (internally, see the issuance script), but authenticates nothing yet —
-- no request-handling code validates a Bearer token. The events outbox has
-- exactly one real emitter (membership.created, next migration) and a
-- proof-of-mechanism dispatcher, not a production consumer.

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  scopes jsonb not null default '[]'::jsonb,
  created_by uuid references public.users (id) on delete set null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.api_keys is
  'Backs the API key auth model (docs/04-API-Architecture.md §3). key_hash is a fast cryptographic hash (SHA-256) of the raw key, never the plaintext — API keys are high-entropy by construction, unlike passwords, so a deliberately slow hash (bcrypt/argon2) adds latency with no real security benefit here. M1.7: issued only via packages/database/scripts/issue-api-key.mjs (direct DATABASE_URL access, no HTTP route) — never returned or logged in plaintext after creation, per the M1.7 TDR''s named risk.';

create index api_keys_organization_id_idx on public.api_keys (organization_id);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  event_version integer not null default 1,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Observability/state convenience ONLY (M1.7 Decision A) — NOT the
  -- idempotency enforcement mechanism. Set by the dispatcher once every
  -- currently-registered consumer for this event's type has a successful
  -- row in event_deliveries below, never by the emitting write itself.
  processed_at timestamptz
);

comment on table public.events is
  'The outbox table (docs/02-Software-Architecture.md §5, Unit-of-Work pattern, §7). A domain-state write and its corresponding events row commit inside the same Postgres transaction — for M1.7''s one real emitter (membership.created), inside the same SECURITY DEFINER function call, never as two independent application-level round-trips. organization_id is NOT NULL: every event this platform emits is tenant-scoped by design (docs/02 §5''s own representative-events list — contact.created, deal.stage_changed, etc. — has no platform-level example). processed_at is advisory only; see event_deliveries for the real per-consumer guarantee.';

create index events_organization_id_idx on public.events (organization_id, created_at);
create index events_unprocessed_idx on public.events (created_at) where processed_at is null;

create table public.event_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  consumer text not null,
  delivered_at timestamptz not null default now(),
  unique (event_id, consumer)
);

comment on table public.event_deliveries is
  'The REAL per-consumer idempotency mechanism (M1.7 Decision A, docs/02-Software-Architecture.md §5''s explicit "(event_id, consumer)" requirement — events.processed_at alone cannot express this, since it is a single global flag). A row here means exactly one thing: this specific registered consumer successfully processed this specific event. Redelivery is safe by construction — a consumer with an existing row here is skipped, never re-invoked. Consumer identifiers are static, code-defined strings (packages/database''s consumer registry) — this column is never used to dynamically look up or execute a handler, only to record which already-known handler ran.';

create index event_deliveries_event_id_idx on public.event_deliveries (event_id);

create table public.webhook_events_seen (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  processed_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

comment on table public.webhook_events_seen is
  'Dedupe table for INBOUND provider webhooks (docs/03-Database-Architecture.md §2.10, docs/04-API-Architecture.md §7) — distinct from the events outbox above, which is this platform''s own outbound domain-event fan-out. Schema only in M1.7: no /api/v1/webhooks/* receiver route exists yet (that arrives with each real provider integration, Phase 3+), so nothing writes to this table yet. Deliberately has NO organization_id — a provider webhook''s tenant is not always resolvable before the dedup lookup itself runs, so this is a platform-global table, not a tenant-scoped one; adding organization_id later would weaken, not strengthen, the dedup guarantee for webhooks that do not cleanly resolve to one tenant.';
