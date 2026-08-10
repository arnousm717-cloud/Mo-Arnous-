-- SECURITY FIX, discovered during M1.7's mandated security review, not
-- part of M1.7's own feature scope — a platform-wide gap present on every
-- table since M1.2, not introduced or worsened by M1.7.
--
-- Root cause: the Supabase CLI's local bootstrap configures a default ACL
-- (visible via `select * from pg_default_acl`) that automatically grants
-- TRUNCATE, REFERENCES, and TRIGGER on every new table created by the
-- `postgres` role (which is how every migration in this project runs) to
-- BOTH `anon` and `authenticated`. This is Supabase's own standard
-- convention, not something any migration in this repo ever explicitly
-- requested — every GRANT statement in every prior migration only ever
-- asked for SELECT/INSERT/UPDATE/DELETE as appropriate per table.
--
-- Why this matters: Postgres Row Level Security does NOT filter TRUNCATE
-- — RLS only governs SELECT/INSERT/UPDATE/DELETE. A role with TRUNCATE
-- granted on a table can wipe it entirely regardless of any RLS policy,
-- with no tenant scoping possible at all (TRUNCATE has no WHERE clause).
-- Verified empirically (not assumed) that `authenticated` — the role
-- every ordinary logged-in session runs as — can genuinely execute
-- `TRUNCATE public.consent_records` today, deleting every tenant's rows
-- at once. REFERENCES/TRIGGER are lower-risk in isolation (neither
-- `anon` nor `authenticated` holds CREATE on the public schema, so
-- neither can create a new table/trigger to make use of them), but there
-- is no legitimate reason an ordinary application-facing role should hold
-- them either — removed as defense-in-depth, not because a concrete
-- exploit path for them was found.
--
-- Two-part fix, both required:
-- 1. REVOKE the already-applied grants from every existing table (a
--    default ACL change alone does NOT retroactively affect tables that
--    already exist).
-- 2. ALTER DEFAULT PRIVILEGES so every table created by FUTURE migrations
--    (which also run as postgres) does not silently reacquire these
--    grants the next time `CREATE TABLE` runs — without this second part,
--    the very next migration in this project would reintroduce the exact
--    gap this migration exists to close.
--
-- SELECT/INSERT/UPDATE/DELETE are deliberately untouched — those are the
-- real, intended, per-table grants every prior migration already set up
-- explicitly, each paired with its own RLS policy (docs/08-Security.md
-- §2's two-layer grant+policy discipline). This migration only removes
-- privileges nothing in this codebase ever asked for.

revoke truncate, references, trigger on all tables in schema public from authenticated, anon;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from authenticated, anon;
