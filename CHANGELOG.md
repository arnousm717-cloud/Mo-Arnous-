# Changelog

Milestone-scoped, per `docs/12-Implementation-Milestones.md`. Each entry lists what shipped, not a commit-by-commit history.

## M1.1 — Repository & Environment Bootstrap

**Added**
- Turborepo monorepo scaffold: `apps/web` (Next.js 15, App Router), `apps/marketing` (placeholder, intentionally not built out — see rationale below), `packages/config` (shared eslint/TypeScript config), `packages/database` (Supabase CLI wrapper).
- `GET /api/v1/health` — first real endpoint, returns `{"status":"ok","service":"ai-revenue-os-web"}`.
- CI pipeline (`.github/workflows/ci.yml`): lint → typecheck → build on every PR and push to `main`.
- Local Supabase dev stack via `packages/database` (wraps the Supabase CLI directly; no hand-rolled `docker-compose.yml` — the CLI already runs Postgres/Auth/Storage in Docker).
- ADR-001 (modular monolith over microservices), logged in `docs/adr/`.

**Architectural decisions and trade-offs**
- **No `docker-compose.yml`**: the Supabase CLI's `supabase start` already provides local Docker-based Postgres/Auth/Storage. Writing a parallel compose file would duplicate what the CLI maintains and risk drifting out of sync with it. Trade-off: local dev is coupled to the Supabase CLI's own tooling rather than a fully custom stack — acceptable since Supabase is already the chosen managed database provider (`02-Software-Architecture.md`).
- **`apps/marketing` is a placeholder, not a scaffolded app**: there is no marketing site to build until well into the roadmap (`09-Development-Roadmap.md`), so a second full Next.js app now would be unused boilerplate carried forward for no functional benefit. Trade-off: when marketing content is actually needed, someone has to scaffold it from scratch rather than filling in an existing shell — an intentional deferral, not an oversight.
- **`packages/config` has no `tailwind` export yet**: an earlier draft of this package referenced a Tailwind config file that was never created. Removed rather than stubbed, since no UI component work happens until the design system milestones (`07-UI-UX-System.md`) — an unused export pointing at a nonexistent file is a defect, not a placeholder worth keeping.
- **`next-env.d.ts` is excluded from lint, not from the repo**: it's Next.js-regenerated on every build and always carries a triple-slash reference our own lint rule would otherwise flag. Excluding the generated file (rather than weakening the rule everywhere) keeps the rule meaningful for hand-written code.

**Fixed**
- `packages/config`'s `.js` config files (`eslint/base.js`, `eslint/next.js`) use Node globals (`__dirname`, `require`) with no type information available to an editor/TS server, surfacing as a false "Cannot find name `__dirname`" error. Fixed with a `jsconfig.json` (`types: ["node"]`) and an explicit `@types/node` devDependency, rather than suppressing the diagnostic.
- Lint failure on `next-env.d.ts`'s required triple-slash reference (see trade-offs above).

**Known gaps, explicitly deferred (not oversights)**
- No real Supabase/Vercel/GitHub cloud projects exist yet — provisioning them requires account access this session doesn't have. Documented as manual steps in `README.md`.
- No database schema, no authentication, no RLS — all scoped to M1.2 onward per `docs/12-Implementation-Milestones.md`.

## Cloud Bootstrap (between M1.1 and M1.2)

**Added**
- GitHub repository connected, first commit pushed.
- Vercel project connected (Production + Preview deployments verified via real health checks, not just dashboard status).
- Supabase Cloud project created (`eu-west-1`, matching the EU-first data residency decision).
- Three environment variables configured in Vercel (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
- `.env.example` added, landed via a real PR (#1) that also served as the first genuine Preview Deployment verification.

**Fixed**
- Removed dead root-level `supabase:start`/`supabase:stop` scripts — confirmed broken (`supabase` binary not resolvable at root workspace scope) by actually running them, not just by inspection.

## M1.2 — Core Tenancy Schema + RLS + Tenant-Context Mechanism

**Added**
- Three migrations: tenant-context functions (`current_org()`, `current_agency()`, `current_role_key()`), core tenancy schema (`agencies`, `organizations`, `users`, `memberships`, `roles`, seeded with the 6 platform roles), and RLS policies + base grants on all five tables.
- RLS isolation test suite (`packages/database/tests/rls-isolation.test.ts`), 14 tests, run against a real local Postgres instance — never mocked.
- Supavisor pooling-behavior spike (`packages/database/scripts/pooling-spike.mjs`), run against the real Supabase Cloud dev project: 100/100 simulated requests correct, 0 tenant-context leaks.
- ADR-003 (shared-schema RLS, plus three implementation findings — see below), logged in `docs/adr/`.

**Architectural decisions and trade-offs**
- **`current_role()` renamed to `current_role_key()`**: avoids colliding with PostgreSQL's own SQL-standard `CURRENT_ROLE` construct. Naming-only correctness fix; `docs/03-Database-Architecture.md` updated to match. See ADR-003.
- **Base table grants added alongside RLS policies**: tables created via SQL migrations don't automatically receive `authenticated`/`anon` grants — without them, every request fails with "permission denied" before RLS is even evaluated. Caught by the isolation test suite's very first real query against a real database, not by inspection. Now a documented rule in `10-CLAUDE.md` and `08-Security.md`.
- **Organization-creation bootstrapping cannot use plain `INSERT ... RETURNING`**: Postgres requires the `SELECT` policy to also pass for `RETURNING`, which a brand-new org's row can never satisfy under `id = current_org()`. M1.3's atomic signup transaction will need a `SECURITY DEFINER` function instead — flagged now in `docs/12-Implementation-Milestones.md`'s M1.3 entry so it isn't rediscovered mid-milestone.

**Fixed (test infrastructure, found while building the isolation suite itself)**
- A test-helper bug where a thrown assertion inside a transaction released a still-broken connection back to the pool, cascading failures into every subsequent test — fixed with a proper try/catch/rollback/force-release pattern.
- The test harness only set `request.jwt.claims` (which `auth.role()`/`auth.uid()` actually read) when a specific user was being simulated, not whenever the Postgres session role was set to `authenticated` — causing false permission denials for tests using an authenticated-but-anonymous context. Fixed to always pair the two, matching how PostgREST behaves for every real request.

**Known gaps, explicitly deferred (not oversights)**
- Agency-level RLS roll-up views (`agency_rollup_*`) are not built yet — `agencies` currently has only a `SELECT` policy; roll-up mechanics are M1.4's scope.
- No API layer yet resolves `current_org()` for real requests — M1.2 proves the database mechanism works; wiring it to actual HTTP requests is M1.3.

## M1.3 — Auth & Signup Flow

**Added**
- `packages/auth` (new package): Supabase Auth wired into a `createSupabaseServerClient`, `getAuthenticatedUser()` (uses `auth.getUser()`, server-revalidated, never the spoofable `getSession()`), `resolveRequestContext()` (per-request `organization_id`/`agency_id`/`role_key` resolution — never client-supplied), `signUpWithPassword`/`signInWithPassword`/`signOut`, `refreshSession` (Edge-runtime session-cookie refresh for `middleware.ts`), `exchangeAuthCode` (PKCE code exchange for the email-confirmation callback).
- `packages/tenancy` (new package): `createOrganizationForNewUser` (slug generation + collision retry, calls the SECURITY DEFINER signup function), `getOrganizationById`.
- Three new migrations: `handle_new_auth_user()` trigger (atomically syncs `auth.users` → `public.users` in the same transaction as GoTrue's own insert), `create_organization_with_owner()` SECURITY DEFINER function (atomic org + first-membership creation, ADR-003), `get_my_membership_context()` SECURITY DEFINER function (resolves the calling user's own org/agency/role from `auth.uid()`, no client-supplied parameter).
- `apps/web`: `/signup`, `/login`, `/dashboard` (bare authenticated shell — "Welcome, {org}", role, logout), `/signup/check-email`, `/auth/callback` (PKCE email-confirmation handler), `middleware.ts` (session refresh on every request).
- Deliberate Auth policy decisions, as config-as-code in `packages/database/supabase/config.toml` (not left at CLI defaults, not manual-dashboard-only): email confirmation required before a session is usable (`create_organization_with_owner()` grants `org_admin` at signup — an unconfirmed address must never be enough for that), minimum 8-character passwords with letters+digits complexity.
- ADR-004 (direct Postgres connection layer over PostgREST for internal app queries — PostgREST can't see the custom session variables `current_org()` etc. depend on).
- `docs/runbooks/auth-users-reconciliation.md` — detection/remediation if `auth.users`/`public.users` ever diverge (structurally unlikely given the trigger's atomicity and the FK's `on delete cascade`, but documented per the TDR's disaster-recovery requirement).
- Test suite, all against real services (local Postgres, local Supabase Auth/GoTrue, local Mailpit inbox) — nothing mocked: 21 tests in `packages/database` (RLS isolation, atomic-transaction success/failure paths including a chaos-style mid-transaction failure test), 12 in `packages/auth` (session-expiry/refresh, email-confirmation policy, real signup→email→confirmation-link→session round trip via Mailpit, cross-user tenant-context isolation with two real logged-in sessions, logout/session-invalidation), 4 in `packages/tenancy` (RLS cross-tenant isolation — read/write blocked — under a real, correctly-resolved session context, not a manufactured one). 37 total.

**Architectural decisions and trade-offs**
- **`emailRedirectTo` required, and must be in the redirect-URL allow-list**: `@supabase/ssr`'s `createServerClient` defaults to `flowType: "pkce"`, so `signUpWithPassword` must pass `emailRedirectTo` pointing at `/auth/callback` — but GoTrue silently ignores any `emailRedirectTo` not present in `additional_redirect_urls` and falls back to `site_url` instead, meaning the confirmation link would never reach the callback route at all. Discovered by testing against the real local Auth service, not assumed from documentation.
- **`exchangeAuthCode`/`refreshSession` are request/response-cookie-based, not `next/headers`-based**: `next/headers`'s `cookies()` requires an active Next.js request context that a test process doesn't have. Keeping these two Edge-safe, no-`pg` functions in `packages/auth/src/middleware.ts` (exported only via the `@ai-revenue-os/auth/middleware` path, never the main barrel) means they stay directly testable standalone, same reasoning as the barrel-splitting decision below.
- **Edge Runtime / Node.js import-path separation**: `apps/web/middleware.ts` originally imported `refreshSession` from the package's main barrel, which transitively pulled in `resolveRequestContext` → `@ai-revenue-os/database` → `pg` (Node-only APIs) into the Edge bundle `middleware.ts` compiles to. Build succeeded but printed explicit "Node.js API used... not supported in the Edge Runtime" warnings — treated as unacceptable, not a warning to suppress. Fixed with a dedicated `"./middleware"` export path so the mistake is structurally impossible, not just documented.
- **Business logic for the callback route lives in `packages/auth`, not inline in the Route Handler**: `apps/web/app/auth/callback/route.ts` is a ~15-line delegator; the actual PKCE exchange is `exchangeAuthCode` in `packages/auth` — per `docs/10-CLAUDE.md`'s standing rule that business logic never lives inline in route handlers/Server Actions.
- **Cross-package test execution ordering**: running the full monorepo `pnpm test` (as opposed to a single `--filter`) runs `database`/`auth`/`tenancy`'s test tasks via Turborepo, which by default has no reason to serialize them. `rls-isolation.test.ts`'s cleanup does an unscoped `DELETE ... WHERE true` across `users`/`memberships`/`organizations`/`agencies` — safe when it's the only suite touching those tables, unsafe once `packages/auth`/`packages/tenancy` also gained tests against the same live database. Fixed via `turbo.json`'s `test` task depending on `^test` (mirroring the existing `^build` dependency) — Turborepo's own package-dependency graph now guarantees `database`'s tests finish before its dependents' tests start, with no change to any test itself. Verified stable across repeated forced, uncached full runs.

**Fixed**
- The above Edge Runtime bundling bug and the cross-package test race — both caught by actually running the full verification suite, not by code review alone.
- `rls-isolation.test.ts`'s fixture setup manually inserted into `public.users` after `handle_new_auth_user()` was added, causing a duplicate-key conflict since the trigger now does this automatically — removed the now-redundant manual insert.

**Known gaps, explicitly deferred (not oversights)**
- RBAC enforcement beyond RLS (the `can(actor, action, resource)` facade) is M1.5's scope — M1.3 proves tenant isolation and role *resolution*, not yet a full permission matrix per action.
- Agency-level roll-up access is still M1.4's scope, unchanged from M1.2.
- No password-reset flow yet (only signup confirmation) — not part of M1.3's stated deliverables; a real, non-stubbed provider is wired and this can follow the same pattern.
- Signup funnel drop-off tracking (verification-not-completed) is an M1.8 (Observability) concern, not built here, per the TDR's own sequencing note.
