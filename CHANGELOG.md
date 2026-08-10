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

## M1.5 — RBAC Enforcement

**Added**
- `can(actor, action, resource)` — the RBAC facade (`packages/auth/src/permissions.ts`, `docs/02-Software-Architecture.md` §7 Facade pattern): pure, synchronous, code-defined, deny-by-default, never queries the database. `PERMISSION_MATRIX` covers every role × the ten permission keys built so far (`organizations:*`, `agencies:*`); absence of a key is the deny, with no explicit `false` anywhere.
- The approved billing decision, enforced: `agency_owner` gets `agencies:manage-billing`, `agency_admin` explicitly does not; `org_admin` gets `organizations:manage-billing` for its own standalone organization; the two billing keys are never granted to the same role.
- `POST /api/v1/organizations` and the Agency Console's create-org Server Action migrated from inline `AGENCY_WRITE_ROLES.has(...)` role-string checks to `can()`.
- `roles.permission_set` populated as a derived snapshot of `PERMISSION_MATRIX` (schema existed since M1.2) — never an independent source of truth; `permission-set-sync.test.ts` asserts the two can never silently drift.
- `role-check-coverage.test.ts` — an automated, grep-based check that no application source file outside `permissions.ts` contains a raw role-key string literal, catching a direct role comparison that bypasses `can()`.
- `rls-defense-in-depth.test.ts` — explicit proof that RLS/SECURITY DEFINER checks independently block unauthorized access even when `can()` is deliberately bypassed, per `docs/08-Security.md` §2's "neither layer alone is trusted as sufficient."
- `docs/08-Security.md` §3.1 — the full agency-scoped vs. organization-scoped permission matrix, including the billing disambiguation.
- CI hardening: `.github/workflows/ci.yml` now runs the full test suite (not just lint/typecheck/build) against a local Supabase stack, service-excluded down to `db`/`auth`/`kong`/`mailpit` after verifying no test depends on the rest.
- 258 permission-matrix tests, 144 defense-in-depth tests, plus coverage/sync checks — the monorepo's first milestone where CI runs the complete suite.

**Architectural decisions and trade-offs**
- **`can()` never resolves context itself** — it only judges an already-resolved `Actor`. Context resolution (`resolveOrganizationContextForUser`/`resolveAgencyContextForUser`) stays entirely separate, so the facade is reusable from a future agent tool-execution worker exactly as-is.
- **`!agencyContext ||` guards retained alongside `can()` calls**: redundant with `can(null, ...)`'s own denial at runtime, but necessary for TypeScript's flow analysis under `exactOptionalPropertyTypes`, since a boolean-returning function doesn't narrow its argument's type.

**Fixed**
- (Diagnosed and fixed as a follow-up, not in this commit) A Node/WebSocket CI failure: `.nvmrc`/`engines.node` bumped 20→22 after this milestone's CI-hardening step exposed that `@supabase/supabase-js`'s eager `RealtimeClient` construction requires a native `WebSocket`, stable only from Node 22 — see the dedicated fix commit.

**Known gaps, explicitly deferred (not oversights)**
- GDPR primitives (`can()` keys for consent/DSR management) are M1.6's scope, added there.
- No UI-level conditional hiding of write actions by role yet (`docs/12`'s "org_viewer sees no write buttons") — server-side enforcement is complete and tested; the client-side affordance is a smaller, separable follow-up not blocking this milestone's own stated exit criteria.

## M1.6 — GDPR Primitives

**Added**
- `packages/compliance` (new package, `docs/02-Software-Architecture.md` §4): `consent.ts` (staff-recorded consent), `data-subject-requests.ts` (filing, read, dry-run preview, and irreversible execution of user erasure).
- Four tables (`docs/03-Database-Architecture.md` §2.8): `consent_records`, `data_subject_requests` (with a `subject_type='user'` value added beyond the three originally documented — the only subject a real erasure cascade can be built against today, since no `contacts`/`visitors`/`portal_users` tables exist yet), `audit_logs`, `data_retention_policies` (seeded with platform-default retention rows).
- `due_at` (30-day SLA) set by a `BEFORE INSERT` trigger, not a `GENERATED` column — `now()` is `STABLE`, not `IMMUTABLE`, which Postgres requires for generated-column expressions; found and fixed during the first local `db reset`, not assumed correct from the design.
- `data_subject_request_breaches` — a view (`due_at < now() and status <> 'completed'`) backing the approved reduced SLA-breach scope (Decision E): queryable and tested, no notification channel wired to it yet (deferred to the observability/alerting milestone).
- `preview_user_erasure(dsr_id, caller_user_id)` / `execute_user_erasure(dsr_id, caller_user_id)` — SECURITY DEFINER functions (ADR-003 pattern) sharing a private `_validate_user_erasure()` helper, each independently re-validating (a) the caller holds an active `org_admin` membership sharing an organization with the target, and (b) the target isn't the sole active `org_admin` of any organization (Decision C) — execute never trusts a prior preview result (Decision D). `execute_user_erasure()` deletes `auth.users`, verified empirically to cascade through `public.users`/`public.memberships` and every GoTrue-internal table, and writes its audit entry inside the same transaction as the delete.
- A real cascade-blocking bug found and fixed before it could matter: `memberships.invited_by` had no `ON DELETE` clause (defaulting to `NO ACTION`), which would have thrown a foreign-key violation erasing anyone who had ever invited a still-active colleague. Fixed to `ON DELETE SET NULL`.
- Three new `PermissionKey`s (`consent:record`, `data-subject-requests:create/read/execute`), `org_admin`-only per Decision F — no agency-scoped role gets any of them. `roles.permission_set` updated to match (`permission-set-sync.test.ts`); `role-check-coverage.test.ts`'s scan roots extended to `packages/compliance/src`.
- `POST /api/v1/consent`, `POST /api/v1/data-subject-requests`, `GET /api/v1/data-subject-requests/{id}`, `POST .../{id}/preview`, `POST .../{id}/execute` (`docs/04-API-Architecture.md` §2.2) — the preview/execute pair replaces the originally-drafted `DELETE`-based contract (Decision D), a correction made to the docs alongside the implementation rather than left to drift.
- A minimal internal admin UI (`apps/web/app/data-subject-requests/`) to file an erasure request and track its status/preview/execute — explicitly not the full self-service experience (Phase 6).
- `apps/web/app/api/v1/_shared/same-origin.ts` — the `Origin`-header CSRF check, extracted from `organizations/handlers.ts` (which now re-exports it) so four new mutating routes share one implementation instead of four copies.
- Test coverage: `packages/database/tests/compliance-schema.test.ts` (16, RLS isolation + grant-level `audit_logs` immutability + breach-view detection), `packages/compliance/tests/user-erasure.test.ts` (6 — happy path with direct-database-inspection verification and a real post-erasure login-attempt failure, the sole-`org_admin` blocker, authorization-boundary and impersonation-guard tests) and `audit-completeness.test.ts` (3), `apps/web/tests/compliance-api.test.ts` (12, including the sole-`org_admin` blocker surfacing as `409` at the API layer). 272 tests total across the monorepo as of this milestone.

**Architectural decisions and trade-offs**
- **`data_subject_requests.subject_type='user'` is a deliberate, approved scope decision (Decision A)**, not implied by the original schema draft — `docs/03-Database-Architecture.md`'s pre-M1.6 enum (`contact`/`visitor`/`portal_user`) had no value for the only entity this milestone could realistically cascade against; extending it, rather than building an untestable mechanism, was the explicit choice.
- **Auth identity removal via a single `DELETE FROM auth.users`, not per-table orchestration**: `public.users.id references auth.users(id) on delete cascade` (M1.2) already made this correct by construction once verified — deleting the GoTrue-managed row is what a real, complete erasure requires (Decision B), and letting Postgres's own FK graph do the cascading work means a future table added with a FK to `users` is automatically covered, not silently missed by a hand-maintained delete sequence.
- **Preview/execute as dedicated endpoints, not a `DELETE` verb** (Decision D): deviates from `docs/04-API-Architecture.md` §1's own stated verb convention, deliberately — a single `DELETE` reads as symmetric with every other resource's recoverable soft-delete, which an irreversible cross-cascade hard-delete structurally is not.
- **Audit logging for login events is not wired in M1.6**, despite `docs/08-Security.md` §6 naming it as an eventual target: doing so from `packages/auth` would require `auth` to depend on `compliance`, contradicting the package boundary `compliance` (which depends on `auth`) already establishes (`docs/02` §4) — deferred rather than solved with an architecturally awkward reverse dependency.
- **`packages/compliance` depends only on `database`**, not `auth`, matching `packages/tenancy`'s existing precedent (its own package.json has no `auth` dependency despite `docs/02`'s table listing one) — permission checks (`can()`) happen at the Route Handler/Server Action layer that calls into `compliance`, not inside the package itself.

**Fixed**
- The `memberships.invited_by` cascade gap and the `due_at` generated-column error, both above — caught by actually running the migration against a real database, not by SQL review alone.
- `CHANGELOG.md` was missing its M1.5 entry (the M1.5 commit updated `docs/08-Security.md` but not this file) — added retroactively, reconstructed from the actual commit diff rather than from memory.
- `docs/02-Software-Architecture.md`'s "Related ADRs" list mislabeled ADR-005 as "queued/async agent execution"; corrected to match the actual, already-implemented `docs/adr/ADR-005-agency-level-membership-model.md`.

**Known gaps, explicitly deferred (not oversights)**
- CRM/visitor/portal-user erasure, and the Brain's extended erasure cascade (`brain_entity_profiles`, `brain_embeddings`, etc.) — none of those tables exist yet; building against them now would be the exact "fully generic cascade framework for tables that don't exist" the TDR (`docs/13-Technical-Design-Review.md`) explicitly warned against.
- `access`/`export` `data_subject_requests` — schema-valid, explicitly rejected by `fileDataSubjectRequest()` with a clear error, no fulfillment logic.
- SLA-breach detection is a queryable view only (Decision E) — no email/Slack/Sentry notification channel consumes it; that is the observability/alerting milestone's scope.
- No platform-operator (cross-organization) audit log read path exists — `audit_logs` rows with a null `organization_id` are not readable through any RLS policy in M1.6, matching `docs/08-Security.md` §6's own framing of that as a separate, not-yet-built access path.
- Agency-scoped roles (`agency_owner`/`agency_admin`) have zero access to any compliance data or actions (Decision F) — agency-facing compliance workflows are real future scope, not designed here.
- A newly-noticed (not part of this milestone's approved cleanup list, so left as-is): `docs/02-Software-Architecture.md`'s "Related ADRs" list also mislabels ADR-004 ("outbox + polling" — the actual `docs/adr/ADR-004-direct-postgres-data-access.md` is about direct Postgres access over PostgREST). Flagged for a future doc-cleanup pass, not fixed here since it wasn't part of the two drift items explicitly approved for this milestone's closeout.

## Security Fix — Platform-Wide Default Table Privileges (found during M1.7)

**Not M1.7 feature work** — a gap present on every table since M1.2, discovered during M1.7's mandated security review and fixed immediately given its severity, before M1.7 itself was completed.

**The gap**: the Supabase CLI's local bootstrap applies a default ACL granting `TRUNCATE`, `REFERENCES`, and `TRIGGER` on every new table to both `authenticated` and `anon` — a Supabase platform convention, not anything any migration in this repo ever explicitly requested (every `GRANT` statement in every migration to date only ever asked for `SELECT`/`INSERT`/`UPDATE`/`DELETE` as appropriate). Postgres Row Level Security does not filter `TRUNCATE` at all — RLS only governs `SELECT`/`INSERT`/`UPDATE`/`DELETE`. Verified empirically, not assumed: an ordinary `authenticated` session could genuinely execute `TRUNCATE public.consent_records` and wipe every tenant's rows at once, with zero RLS protection possible (`TRUNCATE` has no `WHERE` clause to scope). This affected all 17 tables/views that existed at the time, across every milestone from M1.2 onward.

**Fixed**: `packages/database/supabase/migrations/20260811100000_revoke_dangerous_default_table_privileges.sql` — a two-part fix: (1) `REVOKE TRUNCATE, REFERENCES, TRIGGER ... FROM authenticated, anon` on every existing table (a default-ACL change alone does not retroactively affect tables that already exist), and (2) `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ...` so tables created by every future migration don't silently reacquire these grants the next time `CREATE TABLE` runs. `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants — the real, intended, per-table permissions every migration already set up explicitly, each paired with its own RLS policy — are completely untouched.

**Verified**: the exploit attempt (`TRUNCATE consent_records` as `authenticated`) now fails with `permission denied`; a simulated future-migration table gets zero such grants; every pre-existing `SELECT`/`INSERT`/`UPDATE`/`DELETE` grant remains intact; the full monorepo test suite (306 tests at the time of this fix) re-ran green after applying it. A permanent regression test (`packages/database/tests/table-privilege-hardening.test.ts`) now guards against this specific gap ever silently reopening — including against a future Supabase CLI version change altering its own defaults again.

**Documented**: `docs/08-Security.md` §2 gets a new bullet extending the existing "RLS requires base grants" lesson from M1.2 with the inverse case this surfaces — a table can have RLS enabled AND correct grants for the privileges that matter, and still be fully exposed via a privilege nobody thought to check because RLS was never going to catch it.

## M1.7 — Platform Infrastructure (api_keys, events outbox)

**Added**
- `api_keys` table (`docs/03-Database-Architecture.md` §2.1) — hashed at rest (SHA-256, not a deliberately slow password hash), scoped per organization, individually revocable. Issued only via `packages/database/scripts/issue-api-key.mjs` (M1.7 Decision B) — a local, human-run script using `DATABASE_URL` directly, no HTTP route at all; plaintext shown exactly once at generation, never logged or persisted. An automated coverage test (`api-key-issuance-isolation.test.ts`) proves no file under `apps/web/app` references it.
- `events` (the outbox table) + `event_deliveries` (M1.7 Decision A — the real per-`(event_id, consumer)` idempotency mechanism `docs/02-Software-Architecture.md` §5 always specified; `events.processed_at` is an observability convenience only, set once every registered consumer has a successful delivery record) + `webhook_events_seen` (schema only, no receiver route yet).
- `membership.created` — the platform's first real domain event (M1.7 Decision C), emitted from `create_organization_with_owner()` inside the same SECURITY DEFINER function call as the organization/membership writes themselves (not a second application-level round-trip), matching the Unit-of-Work requirement precisely. Deliberately not retrofitted into the GDPR/DSR execution path, per the approved plan.
- `packages/database/src/events.ts` — `dispatchPendingEvents()`, an in-process, tenant-agnostic dispatcher (M1.7 Decision D): reads all pending events across every organization in one pass (the same documented "service-role bypass" pattern already named for scheduled/system jobs, `docs/03-Database-Architecture.md` §5), invokes each applicable **statically-registered** consumer, records per-consumer delivery, and sets `events.processed_at` once every registered consumer has succeeded. Failure in one consumer never blocks another consumer for the same event; a failed delivery produces no `event_deliveries` row and remains eligible for retry.
- `packages/auth/src/api-keys.ts` — `generateApiKey()`, `hashApiKey()`, `verifyApiKey()` (pure, timing-safe hash comparison), `isApiKeyValid()` (composes hash verification with revocation state).
- Test coverage: `platform-infrastructure.test.ts` (9 — emission correctness, outbox atomicity under injected mid-transaction failure via the same chaos-trigger pattern `signup-flow.test.ts` established in M1.3, cross-tenant correctness, RLS/grant isolation for all four tables), `dispatcher.test.ts` (5 — two-consumer idempotency, redelivery no-ops, partial-failure retry that never re-invokes an already-successful consumer, event-type filtering, payload shape), `api-keys.test.ts` (15 — entropy, hash-not-reversible, verify success/failure, tampered-key rejection, revocation), `api-key-issuance-isolation.test.ts` (2). 306 tests total across the monorepo as of this milestone (including the privilege-hardening fix above).

**Architectural decisions and trade-offs**
- **`event_deliveries` exists because `docs/03`'s originally-documented 3-table list couldn't satisfy `docs/02` §5's own idempotency requirement** — a single `events.processed_at` column is a global flag, not a per-consumer one; the schema addition (Decision A) resolves a real, pre-existing tension between two architecture documents, not a speculative addition.
- **The one real event (`membership.created`) is emitted from `create_organization_with_owner()`, not `create_client_organization_for_agency()`** — despite the approved plan naming "organization/client-organization membership creation flows" generally, `create_client_organization_for_agency()` was found, on inspection, to create no membership row at all (agency access to a client org flows through `agency_id` + the roll-up view, per ADR-005) — there is no real membership-creation event to emit there. `create_agency_with_owner()` also creates a real (agency-scoped) membership row and would be a natural, symmetric follow-up, but was deliberately left out to keep a single, minimal, already-most-tested write path for this milestone's infrastructure-proving purpose.
- **At-least-once delivery, not exactly-once, documented explicitly rather than implied**: a crash between a consumer's side effect succeeding and its `event_deliveries` row committing causes redelivery on the next dispatch call. `event_deliveries` prevents double-counting once a delivery is recorded; it cannot make an arbitrary external side effect (an API call, an email send) exactly-once across that specific crash window. Any consumer with a non-transactional external effect must be idempotent on its own terms — stated plainly in `packages/database/src/events.ts`'s own doc comment and `docs/02-Software-Architecture.md` §5, per the approved plan's explicit instruction not to overstate the guarantee.
- **No package boundary changes** — outbox/dispatcher code lives in `packages/database` (matching `withTenantContext`'s existing home), API-key utilities in `packages/auth` (matching its existing identity/credential bounded context), per Decision D. No new package created for this milestone.

**Fixed**
- See the dedicated Security Fix section above (platform-wide `TRUNCATE`/`REFERENCES`/`TRIGGER` default-privilege gap) — found during this milestone's mandated review, not part of its feature scope, but closed before this milestone's own closeout.
- `docs/04-API-Architecture.md`'s §2.1/§2.2 subsections were out of numeric order (an artifact from M1.6's own editing) — corrected.

**Known gaps, explicitly deferred (not oversights)**
- API-key-based request **authentication** — nothing validates a `Bearer` token yet; that's Phase 3, when n8n is the first real caller.
- `/api/v1/api-keys` as a tenant-facing self-service route — Phase 7; `docs/04-API-Architecture.md` §2.3 now states this explicitly rather than leaving the general resource-map row to be discovered as inaccurate later.
- `webhook_subscriptions` (tenant-configurable outbound webhooks) and any inbound `/api/v1/webhooks/*` receiver — Phase 7 and Phase 3+ respectively; `webhook_events_seen` is schema only.
- n8n fan-out from the dispatcher — Phase 3, per `docs/12-Implementation-Milestones.md`'s own M1.7 scope.
- No scheduled/cron-triggered dispatch (a Supabase Edge Function polling the outbox) — M1.7's dispatcher is called directly (proven via tests), not yet wired to run on a schedule.
- Generic `Idempotency-Key` HTTP header support (`docs/04-API-Architecture.md` §1's own stated design principle) — a pre-existing gap across the whole API since M1.1, not this milestone's job to close.
