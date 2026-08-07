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

## M1.4 — Agency Hierarchy + Basic White-Label Theming

**Added**
- **Agency-level membership model** (ADR-005): `memberships.organization_id` made nullable, new nullable `memberships.agency_id`, a `memberships_exactly_one_scope` `CHECK` constraint (never both, never neither) — a user may hold an agency-level row and organization-level rows simultaneously, resolved independently by two separate SECURITY DEFINER functions (`get_my_membership_context()`, unchanged; new `get_my_agency_context()`), never one overloaded function. No fake "home organization" is created to represent agency identity.
- Agency-deletion behavior recorded as an explicit decision (ADR-005 addendum): client organizations survive agency deletion (`organizations.agency_id on delete set null`, unchanged since M1.2) and simply fall back to the platform default theme; the agency's own staff memberships are deleted (`memberships.agency_id on delete cascade`).
- `create_agency_with_owner()` and `create_client_organization_for_agency()` — SECURITY DEFINER, `auth.uid()`-gated, mirroring `create_organization_with_owner()`'s atomicity pattern (ADR-003). The latter verifies the caller holds an active `agency_owner`/`agency_admin` membership in the *target* agency specifically, rejecting cross-agency creation and ordinary org-level callers alike; it creates no membership for the creator in the new client org — agency access flows through `agency_id` and the roll-up view, never an implicit per-org grant.
- `agency_rollup_organizations` — the first real implementation of the roll-up-view pattern `03-Database-Architecture.md` §5 only described in prose until now. Runs as its view owner (bypassing `organizations`' single-org RLS policy by design); its own `WHERE` clause (`current_agency()` + role check) is the entire access boundary for this path, never a broadened base-table policy.
- `memberships_agency_self_select` RLS policy — the minimum needed for a user to read their own agency-scoped membership row via ordinary authenticated access, not only via `get_my_agency_context()`'s SECURITY DEFINER bypass.
- `brand_themes` (agency-unique, six paired light/dark color columns for the three overridable tokens, hex-format `CHECK` constraint, platform-default column defaults) and `custom_domains` (schema only — status fields for a future verification workflow, no verification/DNS logic).
- Server-side, three-layer theme resolution (`packages/tenancy/src/theme.ts`): a pure `resolveTheme()` merge function (platform default → agency → dormant org-override), plus DB-backed `resolveThemeForOrganization`/`resolveThemeForAgency`. Wired into `apps/web/app/layout.tsx` — resolved and injected as `<style>` CSS custom properties (light values as `:root` defaults, dark behind `@media (prefers-color-scheme: dark)`) before any HTML is sent, deduplicated per-request via React's `cache()`.
- Real WCAG 2.1 contrast checking and auto-adjustment (`packages/tenancy/src/contrast.ts`): `contrastRatio()`/`meetsWcagAA()` against the actual relative-luminance formula, and `ensureContrast()`, which binary-searches HSL lightness only (hue/saturation frozen) to the smallest change that meets the threshold, leaving already-compliant colors untouched.
- `GET`/`POST /api/v1/organizations` — the first real REST resource beyond the health check (contract documented in `04-API-Architecture.md` §2.1). Agency/organization context resolved entirely server-side; `agency_id` is never read from the request body on `POST`, eliminating client-supplied-agency spoofing structurally, not just by convention.
- Agency Console shell (`apps/web/app/agency/`): identity header, client organization list/grid, empty state, create-client-organization form (Server Action calling the same `packages/tenancy` function the API route calls), loading/error states. No impersonation/client-entry workflow, no roll-up metrics tiles, no CRM UI — explicitly scoped narrower than `07-UI-UX-System.md` §6's full target design (see that doc's own M1.4 scope note).
- 124 tests total across the monorepo as of this milestone (up from 61 at the M1.4 foundation checkpoint): 52 `packages/database`, 28 `packages/tenancy`, 12 `packages/auth`, 32 `packages/web` (`apps/web`'s first test suite).

**Architectural decisions and trade-offs**
- **Testable-core extraction, applied a third time**: `getAuthenticatedUser()` depends on `next/headers`' `cookies()`, which requires an active Next.js request context a test process doesn't have (the same constraint already documented on `exchangeAuthCode`/`refreshSession` since M1.3). Every new piece of request-handling logic this milestone — the API route's `GET`/`POST`, the Agency Console's access decision, its create-org Server Action — splits "who is calling" (thin, resolved once, already covered by real-session tests elsewhere) from "what happens for this caller" (a plain function taking an already-resolved id/context, directly testable with real fixtures). The Server-Action variant (`create-client-org-logic.ts`) has an extra constraint the Route Handler variant doesn't: it must live *outside* any `"use server"` file, since every export of one becomes an independently client-invokable RPC endpoint — a function that trusts an already-resolved `agencyContext` parameter must never be reachable that way.
- **Agency context takes precedence over organization context** when a caller has both (`GET /api/v1/organizations`, the theme resolver does not face this ambiguity since it's always organization-scoped) — an `agency_owner` who also happens to hold an org-level membership somewhere still expects to see their client roster, not one unrelated org.
- **CSRF**: verified (via the installed package, not assumed) that `@supabase/ssr`'s session cookie defaults to `sameSite: "lax"`, which already blocks the cookie from being sent on a cross-site `POST` — the primary defense. Added a same-origin `Origin`-header check on `POST /api/v1/organizations` as cheap additional hardening. The Agency Console's create-form doesn't need the same manual check — Next.js Server Actions get automatic `Origin` verification from the framework itself, a different (and already-sufficient) mechanism.
- **Root-layout theme resolution makes every route dynamically rendered**: resolving the theme per-request in `layout.tsx` (required for genuinely per-tenant branding with no flash) means Next.js can no longer statically prerender any page, including pre-auth ones like `/login`. Accepted trade-off, not a regression to chase — it also has a security upside: dynamic rendering structurally prevents any framework/CDN-level caching of tenant-scoped output, which static rendering could otherwise risk sharing across tenants.

**Fixed**
- A stale-row test-fixture bug in `apps/web/tests/organizations-api.test.ts`: two tests queried `organizations` by a fixed literal `name` (`organizations.name` has no uniqueness constraint) rather than the exact created row's id, so a leftover row from an earlier standalone test run could be matched instead of the row the test just created. Fixed by using randomized names and querying by id where the id was available — caught by running the full suite together, not by any single test file in isolation.
- Two stale drift points in `docs/03-Database-Architecture.md` found while documenting this milestone: the `custom_domains` row said "(Phase 8)" — `docs/09-Development-Roadmap.md` and `docs/12-Implementation-Milestones.md` both say Phase 7; and the `brand_themes` row still showed single-value colors rather than the light/dark pairs `docs/07-UI-UX-System.md` actually requires.

**Known gaps, explicitly deferred (not oversights)**
- RBAC enforcement beyond RLS (the `can()` facade) is still M1.5's scope — the new API route and Server Action both check role membership directly, not yet through a unified permission facade.
- No component-rendering test harness exists in this project (no jsdom/testing-library) — Agency Console and theme-injection tests cover the underlying data/decision/CSS-generation logic thoroughly (real database, real fixtures) but not literal JSX/DOM output. `apps/web/app/layout.tsx` being an async Server Component with no client-side state is what makes "no hydration-dependent flash" true by construction, documented as such rather than runtime-tested.
- No "invite a second agency admin" flow exists yet — tests seed that fixture via the admin bypass. `custom_domains` verification/DNS/SSL automation remains Phase 7, per `docs/12`.
- Org-level theme override (the three-layer model's third layer) is fully supported by the resolver's own precedence logic and tested with a fake value, but has no real data source or UI — deliberately dormant, per `docs/07-UI-UX-System.md` §2's own "optional, later phase" framing.
