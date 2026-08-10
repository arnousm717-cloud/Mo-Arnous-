-- Default ACL hardening (M1.7 follow-up, release-blocking security fix).
-- Discovered during the default-ACL review that followed the Cloud
-- migration recovery: the Supabase Cloud bootstrap's default ACL grants
-- full SELECT/INSERT/UPDATE/DELETE to BOTH anon and authenticated on every
-- table, on Cloud specifically (broader than the local CLI environment's
-- own default, which is why no prior local-only rehearsal caught it).
--
-- Two compounding problems this migration closes:
--
-- 1. anon (fully unauthenticated) held CRUD-level grants on every table.
--    No current or planned flow in this codebase gives anon any table
--    access at all — the future public tracking-ingestion endpoint
--    (Phase 3+) uses its own separate, service-role-backed write path
--    (docs/04-API-Architecture.md §2), never a direct anon table grant.
--
-- 2. A actively exploitable consequence of (1): agency_rollup_organizations
--    is security_invoker = false by design (docs/03-Database-Architecture.md
--    §5) so its own WHERE clause can bypass organizations' single-org
--    SELECT policy for the legitimate agency roll-up read. A view's WHERE
--    clause filters SELECT/UPDATE/DELETE, but never INSERT — so ANY role
--    holding an INSERT grant on this view (which the default ACL gave to
--    both anon and authenticated) could insert an arbitrary row directly
--    into organizations, completely bypassing that table's own INSERT
--    policy, because the view executes as its owner, not the caller.
--    Proven exploitable by both anon and an authenticated caller with zero
--    legitimate agency context — verified empirically (committed a real
--    proof-of-concept row, confirmed it existed, deleted it) during the
--    review that preceded this migration.
--
-- Design: strip everything, then re-grant EXACTLY what each table's own
-- original migration already declared — copied verbatim from every prior
-- migration's own `grant` statement, not from memory. A first draft using
-- surgical per-table REVOKEs was proven incomplete by the full regression
-- suite (it silently missed audit_logs and roles); the strip-and-regrant
-- shape is what's actually in this migration because it cannot silently
-- omit a table the way a manually-curated revoke list can.
--
-- Deliberately NOT touched: no RLS policy is created, altered, or dropped
-- here. No application code changes. This is a grants-only migration.

revoke all on all tables in schema public from anon, authenticated;

grant select on public.roles to authenticated;
grant select on public.agencies to authenticated;
grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update on public.users to authenticated;
grant select, insert, update, delete on public.memberships to authenticated;
-- Read-only by design (docs/03 §5: "a separate, named, READ-ONLY view") —
-- this is the specific grant that closes the INSERT bypass above.
grant select on public.agency_rollup_organizations to authenticated;
grant select, insert, update, delete on public.custom_domains to authenticated;
grant select, insert, update, delete on public.brand_themes to authenticated;
grant select, insert on public.consent_records to authenticated;
grant select, insert, update on public.data_subject_requests to authenticated;
grant select, insert on public.audit_logs to authenticated;
grant select on public.data_retention_policies to authenticated;
grant select on public.data_subject_request_breaches to authenticated;
grant select on public.api_keys to authenticated;
-- events, event_deliveries, webhook_events_seen: intentionally nothing
-- granted to authenticated at all, matching their original M1.7 design —
-- dispatcher/internal-only, accessed exclusively via an elevated
-- connection that bypasses grants entirely, never an ordinary session.

-- Safe default for every future table, both roles — every migration in
-- this project already writes its own explicit grant statement (as this
-- migration's own re-grants above demonstrate), so this changes no
-- future migration's required content; it only removes the silent
-- over-grant footgun that let events/event_deliveries/webhook_events_seen
-- end up over-granted in M1.7 despite that migration's own stated intent
-- to grant them nothing.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
