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

**Closeout — live end-to-end verification**

M1.3 was intentionally left open after implementation, pending a real signup/email-confirmation test through a running application with a real (non-stubbed) transactional email provider — the TDR's own conditional-GO requirement ("GO, conditional... not complete until a real transactional email provider... is wired and verified end-to-end"). That verification is now complete:

- Resend Custom SMTP configured and live-verified: a real confirmation email was sent and received (previously blocked by Supabase's default test-SMTP "email rate limit exceeded" — resolved by switching to Custom SMTP, not by any code change).
- Full flow live-verified in Production: `/signup` → `/signup/check-email` → confirmation email received and clicked → `/auth/callback` → session established → `/dashboard`.
- Database provisioning confirmed directly in Supabase: `public.users`, `public.organizations`, and `public.memberships` rows created correctly, membership `status = active`, `organization_id` matches, and the dashboard correctly resolves and displays the new user as `org_admin`.
- A dedicated closeout audit re-ran the full verification suite against this same commit, with zero code changes required: lint, typecheck, and build all clean; **357/357 tests passing (0 failed, 0 skipped)** across all 5 packages; targeted secret/security scan clean (no committed credentials; the server-only secrets `DATABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are unreachable from any client-bundled code path).
- **M1.3 status: PASS — CLOSED.**

**Known open item, explicitly not addressed here**: Preview-environment `DATABASE_URL` scoping (confirming Vercel's Preview deployments use the dedicated staging Supabase project for the direct-Postgres connection, not just for Supabase Auth) is an open M1.9 (CI/CD Hardening & Environment Separation) action item — not an M1.3 blocker, and deliberately left unchanged during this closeout.

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

## Security Fix — Default `SELECT`/`INSERT`/`UPDATE`/`DELETE` Grants and a View-INSERT RLS Bypass (release-blocking)

**Not M1.8 work** — a dedicated follow-up to the `TRUNCATE`/`REFERENCES`/`TRIGGER` fix above, found during the default-ACL hardening review that fix's own closeout explicitly called for.

**The gap**: Cloud's default ACL — beyond the `TRUNCATE`/`REFERENCES`/`TRIGGER` already closed — also grants full `SELECT`/`INSERT`/`UPDATE`/`DELETE` to **both** `authenticated` and `anon` on every table, broader than any migration in this repo ever declared (ground-truthed against every migration's own explicit `grant` statement — several tables were meant to be far narrower, e.g. `api_keys`/`roles`/`agencies` select-only, `events`/`event_deliveries`/`webhook_events_seen` nothing at all). `anon` in particular was never meant to hold any table access anywhere in this codebase.

**A materially more severe, actively exploitable consequence of the same gap**: `agency_rollup_organizations` is deliberately `security_invoker = false` (`03-Database-Architecture.md` §5) so its own `WHERE` clause can bypass `organizations`' single-org `SELECT` policy for the legitimate agency roll-up read. A view's `WHERE` clause only ever filters `SELECT`/`UPDATE`/`DELETE` — **never `INSERT`** — and the view runs as its *owner* for permission purposes, not the caller. Any role holding `INSERT` on the view (which the default ACL gave both `anon` and `authenticated`) could insert an arbitrary row straight into `organizations`, completely bypassing that table's own `INSERT` policy. **Proven exploitable, not theoretical**: a real proof-of-concept row was committed as an unauthenticated `anon` session, confirmed to exist in the base table, then deleted; independently reproduced for an `authenticated` caller with zero agency membership at all. `UPDATE`/`DELETE` through the same view were confirmed *not* exploitable — those respect the view's `WHERE` clause as an implicit row filter (session-state-dependent, not caller-identity-dependent).

**Fixed**: `packages/database/supabase/migrations/20260811110000_harden_default_table_privileges.sql` — strips every privilege from `anon`/`authenticated` on every table, then re-grants exactly what each table's own original migration already declared (copied verbatim from every prior migration's own `grant` statement, not from memory — a first draft using surgical per-table `REVOKE`s was proven incomplete by the full regression suite, which caught two silently-missed tables, `audit_logs` and `roles`, before this design was finalized). `agency_rollup_organizations` gets `SELECT` only, closing the `INSERT` bypass. `events`/`event_deliveries`/`webhook_events_seen` keep zero grants, matching their original M1.7 design. Default privileges for future tables corrected for both roles. No RLS policy touched; no application behavior changed — this is a grants-only migration.

**Verified**: rehearsed twice against a locally-reproduced copy of Cloud's actual current (pre-fix) grant state — first attempt caught the two missing tables above via the full regression suite; second attempt, corrected design, 316/316 passing. The view exploit is closed for both `anon` and `authenticated`; legitimate roll-up `SELECT` for a real `agency_owner` still works; `organizations`' `UPDATE`-affects-0-rows behavior (which `rls-isolation.test.ts` depends on to prove RLS itself, not the grant, is the enforcement layer) is unchanged; a simulated future table inherits zero privileges for both roles. Ten new regression tests (`packages/database/tests/default-acl-hardening.test.ts`) guard against every one of these regressing silently, including an exhaustive table-by-table exact-match assertion against the full intended privilege matrix.

**Documented**: `docs/08-Security.md` §2 gets a second new bullet, distinct from the `TRUNCATE` lesson — a `security_invoker = false` view bypasses RLS for *every* operation its grants permit, not just the read it was designed to bypass RLS for; any future view of this kind must be granted only the exact operations it's meant to support, never a blanket default.

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

## M1.8 — Observability & Dependency Hygiene

**Added**
- `apps/web/app/api/v1/_shared/redaction.ts` — one shared redaction implementation (`docs/08-Security.md` §7.1), used identically by the structured logger and Sentry's `beforeSend`/`beforeSendTransaction` hooks. Two complementary mechanisms: pattern-based (`arev_live_`/`arev_test_` keys, `Bearer` tokens, JWT-shaped values, `sk_`/`pk_` provider keys, DB connection-string credentials, email addresses, `name=value`-shaped cookie/session strings) and key-name-based (`cookie`/`cookies`/`authorization`/`password`/`secret`/`session` keys redacted outright regardless of value shape) — the latter added after empirical testing (Decision D) found Sentry's own `RequestData` integration auto-parses a raw `Cookie` header into a structured `request.cookies` object whose values have no string pattern for the former to catch.
- `apps/web/app/api/v1/_shared/logger.ts` — `logRequest()` (structured JSON per request: `timestamp`/`level`/`method`/`route`/`status`/`durationMs`/`actorId`/`organizationId`/`message`/`errorType`, redacted, emitted to stdout — no new log-aggregation vendor) and `withRequestLogging()`, wrapping all 7 existing API route handlers so every route now logs structured request/response metadata without duplicating timing/logging boilerplate per route.
- Sentry (`@sentry/nextjs`) wired server-side and into Next.js Edge middleware only (`instrumentation.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `sentry.shared-config.ts`, `next.config.js` wrapped with `withSentryConfig`) — `sendDefaultPii: false` explicit, no `tracesSampleRate` (tracing/APM off), no browser/client-side capture, no session replay. Every event passes through the shared redaction function before it would leave the process.
- `.github/dependabot.yml` — scheduled `npm`/pnpm and GitHub Actions update PRs, no auto-merge.
- `pnpm audit --audit-level=high` added as a CI step in `.github/workflows/ci.yml` — a genuine merge-blocking gate (`docs/10-CLAUDE.md` §8), proven via the TDR-required pin-and-revert exercise.
- `SECURITY.md` — published vulnerability disclosure policy (reporting channel, scope, safe-harbor language, response-time commitments).
- Test coverage: `apps/web/tests/redaction.test.ts` (23), `logger.test.ts` (10), `sentry-integration.test.ts` (4 — a real Sentry client with a custom transport capturing outgoing envelopes instead of sending them over the network, the mechanism that found the `request.cookies` gap above), `instrumentation.test.ts` (1, fail-open for `onRequestError`). 354 tests total across the monorepo as of this milestone.

**Architectural decisions and trade-offs**
- **Redaction/logger utilities live in `apps/web/app/api/v1/_shared/`, not a new `packages/observability`** (Decision A) — treated as request/response glue per `docs/02-Software-Architecture.md` §4's own framing of what `apps/web` may contain directly, matching the existing `_shared/same-origin.ts` precedent; `docs/10-CLAUDE.md`'s "don't create a package for a handful of utilities" rule argued directly against a new package.
- **Automatic Sentry instrumentation relied on, not manually wrapped per route** (Decision D), but only after empirical verification, not assumption: confirmed via (a) build evidence — the Edge middleware bundle grew 92.4 kB → 156 kB once `withSentryConfig` was applied, and Next.js's own Edge-runtime build validation (which hard-fails on incompatible Node APIs) passed; (b) a real local server run — a deliberately-thrown route error produced a Sentry-wrapped stack trace and an explicit SDK debug-log "Captured error event" entry with the correct message, with no manual `captureException` call anywhere in the route; (c) the transport-capture integration tests above, which is what actually found and drove the fix for the `request.cookies` redaction gap. No per-route manual wrapping was added, since no evidence emerged that automatic instrumentation was insufficient for these server/middleware surfaces.
- **No Supabase Edge Function exists in this codebase as of M1.8** (verified by direct search) — the milestone's original deliverable text ("wired into apps/web and Edge Functions") presupposed one that doesn't exist; the only candidate, a scheduled outbox-dispatcher Edge Function, is itself an explicitly deferred M1.7 gap. Flagged as documentation drift rather than silently resolved either way; Edge Function instrumentation is deferred until one exists (`docs/08-Security.md` §7.1).
- **Dependency vulnerability remediation was a prerequisite, not a side effect**: the CI audit gate was not enabled against an unverified baseline. The actual baseline had 24 known vulnerabilities (1 critical — `vitest`'s UI-server arbitrary-file-read, no fix in the 2.x line — plus 13 high, 10 moderate), all in devDependencies. Fixed via in-major-line bumps (`next` 15.1→15.5.23, `vitest` 2.1→3.2.7) and targeted `pnpm.overrides` for deep transitive packages (`postcss`, `sharp`, `js-yaml`, `esbuild`, `vite`, two independent `brace-expansion` lines) — the full test suite re-verified green after each change, including the vitest major-version bump.
- **No tracing/APM, no session replay, no browser capture** (Decisions F and the data-minimization requirements) — `tracesSampleRate` is deliberately omitted rather than set to 0, since the milestone's stated deliverable is error capture, not performance monitoring; introducing it would be new scope beyond what M1.8 was scoped to cover.

**Fixed**
- A duplicate `next` package resolution across the workspace, caused by `@sentry/nextjs` bringing `@opentelemetry/api` into `apps/web`'s dependency graph while `packages/auth`'s own `next` devDependency (used for `NextRequest`/`NextResponse` types in `middleware.ts` and `app/auth/callback/route.ts`) resolved without it — pnpm's peer-dependency-based resolution created two structurally-incompatible `next` instances, breaking typecheck on files this milestone never touched. Fixed by adding `@opentelemetry/api` as an explicit devDependency to `packages/auth`, unifying peer resolution to a single `next` instance workspace-wide — root-caused via `pnpm why`, not guessed at.
- The Sentry-gap in redaction (`request.cookies`) described above.

**Known gaps, explicitly deferred (not oversights)**
- Edge Function instrumentation — no Edge Function exists yet to instrument (see above).
- Client/browser-side Sentry capture and session replay — deliberately out of scope (Decision F); revisit once there's meaningful product UI and the server-side redaction discipline has more real-world mileage.
- Source-map upload to Sentry (readable production stack traces) — disabled (`sourcemaps: { disable: true }` in `next.config.js`), since it requires a `SENTRY_AUTH_TOKEN` this environment doesn't have configured; a later, separate concern once a real Sentry project/org exists.
- Log aggregation/search platform (Datadog, Logtail, etc.) — not required by this milestone; Vercel's own Runtime Logs plus Sentry satisfies the stated deliverables without an additional vendor.

## M1.9 — CI/CD Hardening & Environment Separation

**Added**
- Dedicated staging Supabase project (`damunjcpwxthdjaonatb`) provisioned and migrated, confirmed (not assumed) separate from Production.
- `packages/database/src/environment-target.ts` (`verifyEnvironmentTarget`) — pure, no-network invariant: given a deployment context and the resolved Supabase Auth/`DATABASE_URL` targets, fails closed unless both equal the expected staging project for `preview` context; `production`/`development` are never forced against it. `packages/database/tests/environment-target.test.ts` (21 tests), including the exact adversarial scenario (Preview's Auth and DB targets both silently resolving to Production).
- `apps/web/scripts/verify-preview-environment.mjs` — the real, fail-closed Vercel Preview build gate, wired into `apps/web`'s own `build` script (`node ./scripts/verify-preview-environment.mjs && next build`), reusing `verifyEnvironmentTarget()` unchanged against the genuine `VERCEL_ENV`/`NEXT_PUBLIC_SUPABASE_URL`/`DATABASE_URL` a real Vercel build sees. `apps/web/tests/verify-preview-environment.test.ts` (18 tests), including a real subprocess-level adversarial test that spawns the script and asserts on its actual exit code.
- `turbo.json`'s `build` task now declares `"env": ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]` — required because Turborepo's default strict env-var mode was silently stripping `DATABASE_URL` from the build gate's process even when Vercel's real Preview environment had it set correctly, a genuine bug caught live in a real Preview build, not found synthetically.
- `packages/database/src/migration-safety.ts` (`classifyMigrationSql`) — a pure, offline classifier that tokenizes a migration file (excluding comments, string literals, and dollar-quoted function bodies from analysis) and blocks destructive top-level statements (`DROP TABLE`/`COLUMN`/`TYPE`/`SCHEMA`, `TRUNCATE`, `DROP ... CASCADE`, unscoped `DELETE`, unsafe `ALTER`/`RENAME`) unless a committed, auditable override (`-- migration-safety: destructive-override` + a non-empty `-- migration-safety-reason: ...`) is present — the finding is still reported even when overridden. `packages/database/tests/migration-safety.test.ts` (66 tests), including a regression suite that runs the classifier against every real migration file in the repository. `packages/database/scripts/check-migration-safety.mjs` is the CI-invoked wrapper, requiring no database connection, environment variable, or credential of any kind — wired into `.github/workflows/ci.yml` as the very first step (after Node setup, before `pnpm install`).
- `docs/adr/ADR-001` through `ADR-004` now exist as real files (`ADR-002-n8n-provider-boundary.md` newly written: n8n has no direct Postgres access and must never receive `DATABASE_URL`, reading/writing tenant data exclusively through the app's own `/api/v1/*` API via the same `api_keys`/`service`-scope credential primitive as any external integrator — precise that the credential foundation is implemented (M1.7) while actual n8n consumption is Phase 3 work).
- `docs/runbooks/bad-migration-to-production.md` — detection, containment (including mandatory re-verification of the linked Supabase project before any `--linked` command), severity-based assessment, a forward-fix-only recovery strategy consistent with this repo's append-only migration convention, and post-recovery tenant/RLS validation.

**Architectural decisions and trade-offs**
- **Migration-safety classifier calibrated against real history, not synthetic fixtures alone**: `DROP CONSTRAINT`, `ALTER COLUMN ... DROP NOT NULL`, and `REFERENCES ... ON DELETE/UPDATE CASCADE` (used throughout the schema) are correctly left unflagged, and the GDPR erasure function's `DELETE FROM auth.users` is correctly recognized as reviewed source inside a function body, not a migration-time statement. One real classifier bug was found and fixed during calibration: `REVOKE TRUNCATE, REFERENCES, TRIGGER ON ...` was initially misflagged because `TRUNCATE` also names a Postgres privilege, not only the destructive command — fixed by anchoring the rule to statement-start, with a dedicated regression test.
- **The override mechanism is a committed, in-file comment pair, never a CI setting or environment variable** — per the milestone's own "no destructive migration without an explicit flag" wording, an override must be auditable in permanent git history, not a bypassable dashboard toggle.
- **`ADR-004` corrected, not redesigned**: it previously stated an external integrator or n8n workflow uses Supabase's PostgREST, contradicting `04-API-Architecture.md` §8 (which it itself cited). Corrected to state both use the app's own `/api/v1/*` API instead (ADR-002) — its own architectural decision (direct Postgres for the app's internal queries) is unchanged.
- **A real self-invocation bug was found and fixed empirically, not assumed correct**: the Preview build gate's `import.meta.url === file://${process.argv[1]}` guard never matched in this repository's own path (which contains a space), so the very first version of the gate silently never ran at all. Fixed via `pathToFileURL`, and re-verified by direct subprocess execution before any test was written.

**Known gaps, explicitly deferred (not oversights)**
- **Backup/PITR remains UNVERIFIED — MUST CONFIRM IN SUPABASE DASHBOARD BEFORE USE.** `docs/08-Security.md` §8 describes automated backups/point-in-time recovery as a target ("once on a plan that supports it"), not a confirmed-active capability on either Supabase project. The DR runbook states this explicitly rather than assuming recoverability; this is a real operational gap, not an M1.9 exit blocker (the exit criterion is that the runbook exists, "even if never yet exercised for real," per `docs/13` risk row 15).
- The Manual QA checklist's literal exercise of opening a real GitHub PR containing a destructive migration was not performed. The underlying blocking behavior was verified directly and adversarially instead (a temporary, uncommitted fixture run through the real CLI, both with and without a valid override, exit codes confirmed both ways) and GitHub Actions was independently confirmed green on the real migration-safety commit — judged sufficient; not a literal PR drill.
- The static classifier has known, documented limits: semantically destructive SQL outside its keyword grammar (e.g. a mass `UPDATE` with an incorrect `WHERE`), and dynamically constructed SQL (`EXECUTE format(...)`) would not be caught. Not present anywhere in this repository's actual migration style; stated as a limitation, not hidden.

**Closeout — final validation**

- **462/462 tests passing** across all 5 packages (`database` 184, `auth` 138, `tenancy` 28, `compliance` 9, `web` 103), lint/typecheck/build all green, forced/uncached, local/ephemeral infrastructure only.
- Migration-safety gate adversarially re-verified: a temporary, never-committed destructive fixture correctly failed the CLI (non-zero exit, file and category identified) without an override, correctly passed (with the finding still visibly reported) with a valid override, and the fixture was fully removed with the working tree confirmed clean afterward.
- Environment-separation guard adversarially re-verified through the real build-gate script with synthetic values only: Preview+staging → pass; Preview+non-staging Auth → fail; Preview+non-staging DB → fail; Preview+missing `DATABASE_URL` → fail; Production+production-shaped targets → pass; local/no-Vercel-vars → pass.
- Preview → staging separation was live-verified end-to-end in a prior session (real Preview deployment, real signup, real staging Auth + staging Postgres, matching rows found directly in staging's `public.users`/`organizations`/`memberships`) — user-verified, not independently re-executed this session. Production health endpoint user-verified: `{"status":"ok","service":"ai-revenue-os-web"}`. GitHub Actions user-verified green on the migration-safety commit.
- **M1.9 status: PASS — CLOSED.**

## Milestone 2.1 — Companies & Contacts

**Added**
- `companies`/`contacts` tables (`docs/03-Database-Architecture.md` §2.2) — `organization_id`-scoped RLS + base grants, no `DELETE` grant/policy on either (ordinary "delete" is `deleted_at`, matching the `public.users` precedent). `contacts.email` unique per organization; `contacts.lifecycle_stage` a narrow `lead`/`prospect`/`customer`/`inactive` enum.
- `packages/crm` (new package) — `createCompany`/`getCompanyById`/`listCompanies`/`updateCompany`/`softDeleteCompany` and the same five for contacts, plus shared cursor pagination (`packages/crm/src/pagination.ts`) and typed domain errors (`ValidationError`, `DuplicateContactEmailError`, `InvalidCompanyRelationshipError`, `InvalidOwnerError`, `InvalidContactRelationshipError`).
- 8 new RBAC permission keys (`companies:read/create/update/delete`, `contacts:read/create/update/delete`) in `packages/auth/src/permissions.ts`'s `PERMISSION_MATRIX`, synced to `roles.permission_set` via migration.
- `GET`/`POST /api/v1/companies`, `GET`/`PATCH`/`DELETE /api/v1/companies/{id}`, and the same four for `/api/v1/contacts` — cursor pagination, `Idempotency-Key` on `POST`/`PATCH`, the standard error envelope, cross-org `:id` returns `404`, duplicate `contacts.email` on `POST` returns `409`.
- `preview_contact_erasure`/`execute_contact_erasure` `SECURITY DEFINER` functions (mirroring M1.6's `user` pair) — contact GDPR erasure wired into the same migration that introduced the table, not deferred.
- `packages/ui`'s `EntityTable` (list/loading/empty/error/row-actions/cursor pagination, no sorting/search/bulk actions — the smallest reusable shape proven against two real consumers) and the full Companies/Contacts list/create/detail/edit/soft-delete UI (`apps/web/app/companies`, `apps/web/app/contacts`), reusing the API route handlers in-process rather than a browser `fetch` (ADR-004).
- `apps/web/app/_shared/owner-options.ts`/`owner-option.ts` — the organization-member owner-selector abstraction, split into a server-only data-fetching half and a client-safe pure-helper half after a real production build failure (`Module not found: Can't resolve 'net'`) proved the split was necessary, not speculative.

**Fixed**
- **Deleted-company relationship regression** (found during staging verification, not local testing): a contact linked to a company that had since been soft-deleted rendered the raw `companyId` UUID instead of a readable label, and any edit to that contact — even one touching only an unrelated field — failed outright, because the edit form always resent the unchanged `companyId` and the domain layer re-validated every *supplied* `companyId` as currently active regardless of whether it had changed. Fixed with a tenant-scoped `getCompanyByIdIncludingDeleted` read helper (display-only, never used by active-list/relationship-validation paths), a `"<name> (deleted)"` display convention (never a raw id), and a hidden `originalCompanyId` marker so the update path only re-validates a *genuine* reassignment. This is the regression class every later CRM resource in Milestone 2.2 was explicitly designed to avoid repeating.
- Two stale `docs/04-API-Architecture.md` claims (an out-of-date error-envelope/idempotency-routing description, and out-of-order subsections) corrected during the milestone's own closeout audits.

**Known gaps, explicitly deferred (not oversights)**
- Owner filters/selects display a raw user UUID when the owner isn't independently resolvable — `public.users` RLS remains self-scoped only (M1.2, unchanged). Closed in Milestone 2.2-P0 (`get_organization_member_identities`) for every later resource; not retrofitted onto Companies/Contacts as part of Milestone 2.1 itself.
- No Activities/Notes/Tags, no kanban, no enrichment, no n8n, no AI — deliberately the smallest possible CRM slice, per this milestone's own stated goal.

**Closeout — final validation**
- Final closeout audit (commit `9515b0a`) independently re-verified schema, RLS/tenancy, RBAC, `packages/crm`, the API, idempotency (including a real two-connection concurrency re-run), and DSR/compliance dispatch from source. Monorepo **887/887** passing, migration-safety clean, lint/typecheck/build clean.
- Staging live verification surfaced the deleted-company regression above; fixed and re-verified live in staging (commit `b814e27`) — the previously-affected contact's Company column read `"Staging Test Company (deleted)"`, never the raw UUID, and an unrelated field edit saved successfully without error.
- **Milestone 2.1 status: PASS — CLOSED** (`docs/13-Technical-Design-Review.md` "Milestone 2.1 — Final Closeout").

## Milestone 2.2 — Deals & Pipelines

**Added**
- `pipelines`/`pipeline_stages`/`deals` tables (`docs/03-Database-Architecture.md` §2.2) — `organization_id`-scoped RLS (`select`/`insert`/`update` to `authenticated` only, no `delete` grant/policy, no `anon` access on any of the three). A two-composite-FK design on `deals` (`deals_stage_org_fk` + `deals_stage_pipeline_fk`) makes it structurally impossible, at the database level, for a deal's `stage_id` to belong to a different organization or a different pipeline than the deal's own; `deals_company_org_fk`/`deals_contact_org_fk` are `ON DELETE SET NULL`, so a hard-deleted company or GDPR-erased contact never corrupts or removes a referencing deal. A partial unique index (`pipelines_org_active_default_idx`) proves at most one active default pipeline per organization, permanently, independent of which code path writes to the table.
- `get_organization_member_identities(uuid)` (`SECURITY DEFINER`, Milestone 2.2-P0) — resolves active organization members' id/email/full_name for owner selectors/display without broadening `public.users`' own self-scoped RLS; independently re-verifies the caller's own active membership in the target organization on every call, never trusting the parameter alone.
- `seed_default_pipeline(uuid)` (`SECURITY DEFINER`, internal-only — never granted to `authenticated`/`anon`) — idempotent, per-organization-advisory-locked seeding of a "Sales Pipeline" with five deterministic stages (Lead/10, Qualified/20, Proposal/30, Won/40 `is_won_stage`, Lost/50 `is_lost_stage`). Called atomically from `create_organization_with_owner()` for every new organization, and once via a backfill loop for every organization that already existed.
- `packages/crm`'s `pipelines.ts`/`pipeline-stages.ts`/`deals.ts` — full create/read/list/update/soft-delete for all three resources. `deals.status` is a fully derived field: neither `CreateDealInput` nor `UpdateDealInput` declares a `status` field at all, and `stage_id` is the single source of truth (`deriveDealStatus`) for whether a deal is `open`/`won`/`lost`. A stage classification change (`is_won_stage`/`is_lost_stage`) cascades `deals.status` for every referencing deal, including soft-deleted ones, in the same transaction.
- 8 new RBAC permission keys (`deals:read/create/update/delete`, `pipelines:read/create/update/delete`) — `org_admin` gets all 8, `org_member` gets deals read/create/update (no delete) and pipelines read-only, `org_viewer` gets read-only on both, agency/portal roles get none. `pipeline_stages` has no permission keys of its own — stage operations authorize under the parent pipeline's own `pipelines:*` keys.
- `/api/v1/deals`, `/api/v1/pipelines`, `/api/v1/pipelines/{id}/set-default`, `/api/v1/pipelines/{id}/stages(/{stageId})` — same cursor-pagination/`Idempotency-Key`/error-envelope conventions as Milestone 2.1, same cross-org-and-nonexistent-indistinguishable `404` rule, adversarially proven nested-stage IDOR safety (a stage belonging to a different pipeline than the URL's `{id}` returns the identical `404` as a genuinely nonexistent one).
- `/deals` (list, filters, cursor pagination, inline create), `/deals/{id}` (detail/edit/soft-delete), `/deals/board` (minimal `PipelineBoard` kanban view — presentation-only `packages/ui` component, keyboard-accessible "Move to stage" select as the sole, required move mechanism; drag-and-drop explicitly deferred), `/pipelines` and `/pipelines/{id}` (pipeline + nested stage management, default-pipeline switching via its own dedicated action, never a hidden `PATCH` field).
- Five hidden `originalXId` markers (company/contact/owner/pipeline/stage) on the deal edit form, extending the Milestone 2.1 deleted-company fix's pattern to every relationship a deal carries, so an unrelated field edit never re-validates a historical relationship that has since become inactive, while a genuine reassignment is still correctly rejected.

**Fixed**
- A missing regression test for the interaction between GDPR contact erasure and `deals.primary_contact_id` — the `ON DELETE SET NULL` foreign-key behavior was structurally correct but unproven end-to-end through the real `executeContactErasure` code path. Closed with a dedicated test (`packages/compliance/tests/contact-erasure.test.ts`) proving a deal survives contact erasure with `primary_contact_id` set to `null` and every other field intact.

**Known gaps, explicitly deferred (not oversights)**
- The Deals board fetches a pipeline's active deals in a single page at the domain layer's own `MAX_LIMIT` (100) — a pipeline with more than 100 active deals shows only the first 100 on the board; not engineered around with cursor-looping, which would be new read-model scope.
- No Activities/Notes/Tags, no agency roll-up views for Deals/Pipelines, no reporting, no proposals — out of scope, per the frozen Milestone 2.2 design.

**Closeout — final validation**
- Full monorepo **1377/1377** tests passing across all 7 packages (database 391, auth 257, tenancy 28, compliance 27, crm 195, ui 39, web 440), lint/typecheck/build all clean, forced/uncached.
- A from-source adversarial audit (Milestone 2.2G, `docs/13-Technical-Design-Review.md`) independently re-verified migrations, RLS, `SECURITY DEFINER` function grants, the RBAC matrix, API mass-assignment resistance, idempotency, and UI/PipelineBoard source — one MEDIUM finding (the contact-erasure/deal-survival test gap above), remediated in the same milestone.
- The five Milestone 2.2 migrations were applied to the staging Supabase project and independently re-verified live (Milestone 2.2H) — schema, constraints, indexes, RLS policies, grants, and all three `SECURITY DEFINER` function bodies matched the committed migration source exactly; `authenticated` confirmed unable to physically `DELETE` any of the three new tables.
- Production functionality manually verified by the project owner: login, dashboard, Companies, Contacts, Deals (list/create/board), Pipelines (list/detail/edit), the default Sales Pipeline with its five correctly-classified stages, default-pipeline delete protection, and tenant/organization context resolution.
- **Milestone 2.2 status: PASS — CLOSED** (`docs/13-Technical-Design-Review.md` "Milestone 2.2 — Overall Closeout").

## Milestone 2.3 — Activities, Notes & Tags

**Added**
- `activities`/`notes`/`tags`/`taggings` tables (`docs/03-Database-Architecture.md`) — `organization_id`-scoped RLS, no `DELETE` grant/policy on activities/notes/tags (soft-delete only, matching every other CRM entity); taggings is the one deliberate exception (no `deleted_at`, physical `DELETE` only — a relationship row, not a standalone historical record). A composite tenant-safety FK (`taggings_tag_org_fk`) makes it structurally impossible for a tagging's `tag_id` to belong to a different organization. Polymorphic `related_to_type`/`related_to_id` (activities, notes) and `taggable_type`/`taggable_id` (taggings) are deliberately not real foreign keys (Postgres cannot express a type-conditional FK) — tenant-safety and target-existence for these is a domain-layer responsibility, never claimed as DB-enforced.
- `packages/crm`'s `activities.ts`/`notes.ts`/`tags.ts` — full CRUD for Activities/Notes/Tags, create/list/delete for Taggings (no update — a tagging is created or removed, never modified in place). `relationship-validation.ts`'s `validateRelatedToRelationship` is a fixed TypeScript `switch` over exactly `company`/`contact`/`deal` — never dynamic SQL.
- 12 new RBAC permission keys (`activities:*`, `notes:*`, `tags:*`) — `org_admin` gets all 12, `org_member` gets read/create/update on all three (no delete), `org_viewer` gets read-only. Taggings has no permission family of its own — authorizes under `tags:*`, mirroring `pipeline_stages` → `pipelines:*`.
- 8 new API routes (`/api/v1/activities`, `/api/v1/notes`, `/api/v1/tags`, `/api/v1/taggings`, each with a `{id}` variant) — same cursor-pagination/`Idempotency-Key`/error-envelope conventions as every prior CRM resource, plus explicit `isValidUuid` guards on every `{id}` path parameter (malformed `:id` → clean `404` before ever touching the database — a hardening step not yet retrofitted onto pre-2.3 resources, see Known gaps below).
- A single shared `ActivityTimeline` UI (`packages/ui/src/activity-timeline.tsx` + `apps/web/app/_shared/activity-timeline/`), embedded identically in Company/Contact/Deal detail pages — merged Activities+Notes chronological feed, create/edit/delete, Tags attach/create-and-attach/remove, all server-side `can()`-gated. Explicitly one shared implementation, not three near-duplicate per-resource copies.
- GDPR-erasure vocabulary correction: `"Erased user"` creator-label fallback (`created_by` nulled by `execute_user_erasure()`'s FK cascade — reachable, now correctly labeled instead of the generic "Unknown") and `"Erased contact"` (the physically-absent-Contact fallback, replacing the previously misleading "Deleted contact," which implied recoverability). `execute_contact_erasure()` extended to scrub directly-related Activities/Notes to `NULL` and physically remove directly-related Taggings on Contact erasure.

**Fixed**
- The one real cross-stack test-coverage gap found during closeout: `note-logic`/`tag-logic`'s own cross-org rejection had never been independently proven at the UI-integration layer (only `activity-logic` had), even though the 2.3D API layer beneath already covered it exhaustively for all four resources. Closed with two narrow tests mirroring the existing `activity-logic` cross-org test.
- A closeout-time incident, found and fixed on staging, not in application code: two manually-created RBAC test accounts (needed because this product currently has no invite/member-management UI — `create_organization_with_owner()` is the only membership-creating path, and it always assigns `org_admin`) could log in but `/dashboard` reported no linked organization, despite a correct, active `memberships` row. Root cause: `public.users.default_organization_id` was never set for these manually-created accounts — a step the normal signup path (`create_organization_with_owner()`) performs atomically alongside the membership, but which a standalone `memberships` insert does not. Fixed with one exactly-scoped `UPDATE`, touching no RLS policy, migration, or application code.

**Known gaps, explicitly deferred (not oversights)**
- Activity/Note pagination is bounded at a fixed page size per fetch (no true unified cursor across the two independently-paginated resources) — documented design limitation, not silently truncated data (a "Load more" affordance remains visible).
- Tag-name resolution for attached tags is bounded at `MAX_LIMIT` (100) — an organization with more active tags than that could see a `Tag <id-prefix>…` fallback for some; never a full raw UUID.
- Pre-2.3 resources (Companies/Contacts/Deals/Pipelines) still lack the `isValidUuid` path-parameter guard 2.3D's own routes have — relies on Next.js's own production error suppression instead, untested by this repo's own suite for those routes specifically. Outside Milestone 2.3's own scope (a 2.1/2.2-era gap, not a 2.3 regression).
- A dead, structurally-unreachable `"Deleted contact"` string remains in `deals/page.tsx`'s own list-column fallback (the page's own resolution loop always populates the lookup map before this branch could fire) — cosmetic vocabulary inconsistency only, not a defect.
- The DSR list page's raw-UUID display and the minimal `erasure-actions.tsx` copy (both pre-existing, M1.6-era) remain unchanged — explicitly out of Milestone 2.3's scope, not part of the Activities/Notes/Tags surface.
- No invite/member-management UI exists yet in this product at all — every membership beyond a fresh signup's own `org_admin` currently requires direct database action. Not a 2.3 regression; surfaced during this milestone's own closeout while creating RBAC test accounts.

**Closeout — final validation**
- A fresh, from-source final audit (Milestone 2.3G Phase 1) found every layer (database, domain, RBAC, API, UI, GDPR behavior) COMPLETE, with the one test-coverage gap above as its only actionable finding — no cross-tenant leak, RBAC/RLS bypass, PII exposure, unsafe dynamic SQL, or exposed secret.
- The four Milestone 2.3 migrations were applied to the staging Supabase project and independently re-verified live (2.3G Phase 2B/2C) — tables, columns, constraints, indexes, RLS policies, grants, the `execute_contact_erasure()` function body, retention policies, and the RBAC permission-set snapshot all matched the committed migration source exactly, zero drift.
- Staging application behavior manually verified by the project owner across all three CRM-relevant roles — org_admin, org_member, and org_viewer — covering Activity/Note/Tag create/update/delete/attach/detach, with one real incident (a missing Preview `DATABASE_URL`) and one real regression (the `default_organization_id` gap above) found and fixed along the way.
- Full monorepo **1,827/1,827** tests passing across all 7 packages (database 477, auth 343, ui 39, compliance 32, crm 310, tenancy 28, web 598), lint/typecheck/build all clean, migration-safety gate clean at 40 migrations with zero drift against staging.
- **Milestone 2.3 status: PASS — CLOSED** (`docs/13-Technical-Design-Review.md` "Milestone 2.3 — Overall Closeout").

## Milestone 2.4 — Agency Roll-Up Views

**Added**
- Four agency roll-up database views (`agency_rollup_companies`/`agency_rollup_contacts`/`agency_rollup_deals`/`agency_rollup_pipelines`, `docs/03-Database-Architecture.md`) — `security_invoker = false`, each joined to `organizations` and scoped by `agency_id = current_agency() AND current_role_key() IN ('agency_owner','agency_admin')`, with an explicit `REVOKE ALL` + `GRANT SELECT ... TO authenticated` in the same migration that creates each view (never relying solely on the platform-wide default-ACL migration). Column sets are deliberately minimal per resource: Contacts excludes email/phone/job_title/linkedin_url/owner_id (PII minimization); Deals excludes `stage_id` (no stages roll-up exists yet) and `primary_contact_id`/`probability`/`owner_id`; Pipelines exposes only `id`/`organization_id`/`name` ("identify and label, never manage"). Empirically, `INSERT`/`UPDATE`/`DELETE` against all four fail with Postgres's own "cannot insert/update/delete into view" error (non-updatable, due to the join) — a structural guarantee independent of the grant, documented as an additional layer, not a substitute for it.
- 4 new RBAC permission keys (`companies:agency-rollup-read`, `contacts:agency-rollup-read`, `deals:agency-rollup-read`, `pipelines:agency-rollup-read`) — granted only to `agency_owner`/`agency_admin`.
- `packages/tenancy/src/agency-rollup.ts` — `listCompaniesForAgency`/`listContactsForAgency`/`listDealsForAgency`/`listPipelinesForAgency`, each querying only its matching roll-up view under `withTenantContext`. Deliberately authorization-free at this layer (no `can()`, no `@ai-revenue-os/auth` dependency), matching the existing `listOrganizationsForAgency` trust model exactly — authorization is enforced one layer above, in `apps/web`, consistent with this repository's established package-boundary convention (mirrors `create-client-org-logic.ts`).
- `apps/web/app/agency/rollup-logic.ts` and four new pages (`/agency/companies`, `/agency/contacts`, `/agency/deals`, `/agency/pipelines`) — this is where `can()` is actually checked, before any roll-up query runs. Client organization names are composed in application code via a single `listOrganizationsForAgency` call per request (never a widened view), with a `"Unknown client organization"` fallback instead of ever rendering a raw UUID. Company/pipeline name resolution for the Contacts/Deals pages is independently `can()`-gated per secondary resource, degrading to `null`/"—" rather than failing the whole page. Read-only throughout — no create/edit/delete/move-stage control exists on any of the four pages, verified by dedicated structural tests.

**Fixed**
- No application defect found during implementation. One test-design correction during 2.4D (an overly broad "no write keywords" regex tripped on the module's own doc comments and function names) — replaced with precise markup-pattern assertions (`<form`, `<button`, `"use server"`, `onClick`, etc.), disclosed as a test-quality fix, not a product defect.

**Known gaps, explicitly deferred (not oversights)**
- No Activities/Notes/Tags roll-up, no reporting, no impersonation, no organization-context switching, no write controls of any kind on the roll-up console — out of scope, per the frozen Milestone 2.4 design.
- The 25-row default roll-up page size (`packages/tenancy`'s own `MAX_LIMIT` convention) has no "load more" UI yet — an already-disclosed design limitation carried from 2.4C, not a new gap.
- This product still has no invite/member-management UI (carried forward from Milestone 2.3) — every membership beyond a fresh signup's own `org_admin`, or a client org's own agency-created membership, still requires direct database action. Surfaced again during this milestone's own staging test-account setup, not a 2.4 regression.

**Closeout — final validation**
- A fresh, from-source final audit (Milestone 2.4E, verification-only pass) found every layer (database views, RBAC, domain layer, UI composition/authorization) COMPLETE, with one "should-close-before-closeout" automated-test gap (the four `/agency` navigation links and their back-links were not directly asserted) — closed with dedicated structural tests in the same milestone, no application defect found.
- The five Milestone 2.4 migrations (4 roll-up views + 1 RBAC permission-set update) were applied to the staging Supabase project and independently re-verified live — grants, `security_invoker` setting, and the RBAC permission-set snapshot all matched the committed migration source exactly, zero drift.
- **Staging application behavior manually verified by the project owner** (browser-driven, not automated) as `agency_owner`: unauthenticated `/agency` redirects to `/login`; an `org_member` account is denied and redirected to `/dashboard`; a dedicated staging `agency_owner` test account (created via the product's own `create_agency_with_owner()` function, the only supported agency-creation path) reached `/agency` and all four roll-up pages successfully with correct empty states and a working "create client organization" control.
- **A minimal client CRM fixture was created directly in the staging database** — one company, one contact (with a real email/phone on the underlying record, to prove the roll-up's column-level PII exclusion is an actual masking, not an accidental absence of data), one pipeline with two stages (`Qualified`, `sort_order 0`; `Proposal`, `sort_order 1`, added after the initial fixture to exercise the Deals Board's stage-move UI), and one deal (`M24 Test Company`, `1250 USD`, `status: open`). This was **database fixture data, never an application-code change** — no migration, RLS policy, authentication logic, or permission logic was modified to create it; it used the same repository-established `withTenantContext`/direct-insert test-fixture conventions already used throughout this repository's own test suite, executed once against staging over the existing trusted admin connection, never a new mechanism.
- **The full agency CRM roll-up console was then manually browser-verified** by the project owner against this fixture (not automated — Next.js/React rendering has no browser-driving test framework anywhere in this repository, by long-established convention): the Companies/Contacts/Deals/Pipelines roll-up pages each rendered the fixture's row with the correct client-organization label (never a raw UUID), the Contacts row showed no email/phone despite the underlying record having both, and the Deals row showed company/pipeline **names**, never raw ids.
- **The underlying Milestone 2.2 Deals Board was also manually re-verified** against this same fixture, end to end: the deal appeared under `Qualified (1)` on `/deals/board`; a second active stage (`Proposal`) was added to prove multi-stage board behavior; the deal was moved `Qualified → Proposal` through the normal UI "Move to stage" control, confirmed to persist after a full browser refresh, confirmed consistent across `/deals` (list), the deal detail page, and the board; then moved back `Proposal → Qualified` through the same UI, with final state re-confirmed both in the browser (`/deals` showing `M24 Test Company`, `1250 USD`, `open`, `Qualified`) and independently in the database. This is Milestone 2.2 functionality, not new Milestone 2.4 scope — re-verified here because it was the natural vehicle for proving the roll-up console against real, non-trivial CRM data.
- Full monorepo **1,968/1,968** tests passing across all 7 packages (database 533, auth 381, ui 39, compliance 32, crm 310, tenancy 46, web 627), lint/typecheck/build all clean, migration-safety gate clean at 45 migrations with zero drift against staging.
- **Milestone 2.4 status: PASS — CLOSED** (`docs/13-Technical-Design-Review.md` "Milestone 2.4 — Overall Closeout").

## Milestone 2.5 — Core API Conventions Applied Platform-Wide

This milestone shipped no new resource — it closed three gaps between
`docs/04-API-Architecture.md`'s always-documented API contract and what
M1.4–M2.3D had actually shipped, each disclosed in that doc before this
milestone began, not discovered mid-implementation.

**Added**
- Structured API error envelope (`{ "error": { "code", "message",
  "request_id" } }`) applied platform-wide, replacing the flat
  `{ "error": "<string>" }` every route previously emitted despite the
  contract having always specified the structured shape. New
  `apps/web/app/api/v1/_shared/api-error.ts` (`ApiErrorCode` — a 7-value
  union — plus `buildApiErrorBody`/`apiError`) is the one canonical
  constructor every route now uses; `request_id` is a fresh `randomUUID()`
  per response, never asserted equal between two independently-generated
  errors. 49 route files and 24 internal consumers updated; `FormState`
  UI-facing shapes (`error?: string`) deliberately left unchanged.
- Atomic `Idempotency-Key` support for the three compliance mutations that
  previously lacked it (`POST /api/v1/consent`, `POST /api/v1/data-
  subject-requests`, `POST /api/v1/data-subject-requests/{id}/execute`).
  `packages/compliance`'s four mutation functions each gained an optional
  trailing `existingClient?: PoolClient` parameter so the idempotency
  reservation, the mutation, and its completion commit or roll back
  together as one atomic transaction — the same `runInClientOrTransaction`
  pattern `packages/crm` already used, generalized out of
  `packages/crm/src/transaction.ts` and into
  `packages/database/src/tenant-context.ts` so neither package needed a
  new dependency on the other. `POST /api/v1/organizations` and `GET
  .../data-subject-requests/{id}/preview` remain deliberately excluded
  (no `organizationId` to key on pre-creation; confirmed read-only,
  respectively) — both disclosed in `docs/04` §2.1/§2.2, not silent gaps.
- Malformed-path-UUID hardening extended from Activities/Notes/Tags/
  Taggings (M2.3D) to Companies, Contacts, Deals, Pipelines, and Pipeline
  Stages — 18 handler functions across 7 files now reject a non-UUID-
  shaped path `{id}`/`{stageId}` with a clean `404` (via the same shared
  `isValidUuid` check M2.3D established), before it ever reaches
  Postgres, in the same auth-then-shape-then-lookup order every other
  hardened route already used. Nested pipeline-stage routes validate
  `{id}` and `{stageId}` independently, extending the existing
  adversarially-proven nested-resource IDOR indistinguishability to a
  malformed-parent/malformed-child/both-malformed matrix.

**Fixed**
- Confirmed, by direct empirical probe (a temporary test, run once then
  fully removed before implementation began), that the pre-2.5C defect on
  Companies/Contacts/Deals/Pipelines/Pipeline Stages was an **uncaught
  `DatabaseError`** on a malformed path id, not merely a wrong status
  code — a materially worse defect than initially assumed.
- 11 pre-existing tests that asserted full-body `toEqual` across two
  independently-generated error responses (which only ever worked by
  coincidence with the old flat-string envelope) corrected to compare
  `code`/`message` only, never `request_id`.

**Known gaps, explicitly deferred (not oversights)**
- Malformed *query/body/filter* UUID fields (e.g. `ownerId`, `companyId`
  filters) on Companies/Contacts/Deals/Pipelines/Pipeline Stages remain
  unvalidated and surface as a generic `500` — a different input class
  than the path-parameter hardening this milestone delivered, disclosed
  in `docs/04-API-Architecture.md` §2.6 as a separate, still-open gap.
- `POST /api/v1/organizations` has no `Idempotency-Key` support — would
  require a schema change (`idempotency_keys.organization_id` is
  currently `NOT NULL`), out of scope for a mechanical retrofit.
- Cursor pagination itself (the third item in this milestone's original
  roadmap name) required no code changes — every resource has used it
  consistently since its own introducing milestone; this milestone's real
  work was the error-envelope and idempotency/UUID-hardening convergence.

**Closeout — final validation**
- Full monorepo **2,036/2,036** tests passing across all 7 packages
  (database 533, auth 381, ui 39, compliance 39, crm 310, tenancy 46, web
  688) — a monotonic increase from the Milestone 2.4 baseline of 1,968
  across all three sub-phases (2.5A 1,999 → 2.5B 2,025 → 2.5C 2,036),
  lint/typecheck/build all clean, zero new migrations (no database schema
  change of any kind in this milestone).
- Each sub-phase (2.5A, 2.5B, 2.5C) underwent its own independent,
  read-only final acceptance audit before being committed and pushed — no
  staging or browser verification was performed or is claimed for this
  milestone, since no new table, view, RLS policy, or user-facing page
  was added; evidence here is exclusively automated/code-level.
- Two real architectural findings were surfaced and resolved *before*
  implementation rather than worked around silently: 2.5B's discovery
  that `packages/compliance`'s mutations couldn't safely participate in
  `withIdempotency` without the `existingClient` change above, and 2.5C's
  correction of an initial handler-count estimate (18, not 19) before any
  code was written.
- `docs/04-API-Architecture.md` re-verified, across two independent final
  audits, to contain zero remaining stale or contradictory statements
  about the error envelope, idempotency, or UUID-hardening conventions.
- **Milestone 2.5 status: PASS — CLOSED** (`docs/13-Technical-Design-Review.md` "Milestone 2.5 — Overall Closeout").

## Milestone 3.1 — Website Intelligence: Tracking Script + Ingestion Endpoint

**Added**
- `tracking_sites`/`website_visitors`/`visitor_sessions`/`visitor_events`
  schema (3.1A) — `tracking_sites.id` is the intentionally public,
  non-secret site key; `resolve_tracking_site()` resolves it to an
  `organization_id` with no `auth.uid()` guard, by design, since a public
  tracking beacon has no authenticated identity to check.
- `packages/intelligence` (3.1B) — `ingestTrackingEvent`, the one atomic
  ingestion transaction (TOCTOU-safe site re-check → consent check →
  resolve/create visitor → resolve/create session → append event), plus
  the `check_visitor_cookie_tracking_consent()` database prerequisite and
  `visitor_sessions.anonymous_session_id` (client-generated correlation
  UUID, never an authorization credential).
- `rate_limit_counters` + `check_tracking_rate_limit()` (atomic
  fixed-window, opaque bucket-hash keyed) and
  `record_visitor_cookie_tracking_consent()` (site-key-scoped, append-only
  consent write) — the 3.1C-A database prerequisites for the public HTTP
  surface below.
- `packages/auth`'s `resolveOrganizationContextForTrackingSite`,
  `packages/compliance`'s `recordVisitorCookieTrackingConsent`, and
  `apps/web/app/track/_shared/rate-limit.ts` (3.1C-B) — thin wrappers
  connecting the database prerequisites to application code.
- `POST /track/collect`, `POST /track/consent` (3.1C-C) — same-origin
  public routes (not a separate `track.<platform-domain>` subdomain),
  non-oracle `204` responses, closed 4-code error vocabulary, CORS-open
  with no credentials, rate-limited across three independent dimensions
  (`anonymous_id`/source IP/resolved tracking site).
- `GET /track/script` (3.1D) — the browser tracking script itself, a
  fixed, tenant-independent, hand-authored standalone-JavaScript payload
  (no bundler, zero new dependency). Public API: `window.
  aiRevenueOsTracker.consent(status)` / `.track(eventType, fields?)`.
  Identity (`anonymousId`/`anonymousSessionId`) is memory-only before
  consent, persisted to namespaced `localStorage`/`sessionStorage` keys
  only after an explicit grant, cleared on withdrawal, never reused on a
  later re-grant. Automatic event capture is `pageview` only —
  `click`/`form_submit` are explicit-only, with no automatic DOM/form
  scraping anywhere in the script. `url`/`referrer`/`landingPage` are
  reduced to `origin + pathname` before transmission; only `utm_source`/
  `utm_medium`/`utm_campaign` are ever captured. Every request uses
  `credentials: "omit"` — no cookies. Platform origin for every network
  call is derived exclusively from the executing `<script>` element's own
  `src`, never the host page's origin. No consent-banner/CMP UI is part
  of this milestone's scope.

**Fixed**
- 3.1C-A: the rate-limit function's opportunistic cleanup had no upper
  bound on `p_window_seconds`, letting the currently-active window's own
  row be deleted mid-window for a sufficiently long window. Bounded to
  the same 86400-second horizon as the cleanup's own retention threshold,
  before commit.
- 3.1C-C: the source-IP resolver accepted any non-empty header value as
  its own distinct rate-limit bucket identifier, with no actual IP-shape
  validation. Fixed using Node's built-in `node:net isIP()` (zero new
  dependency) — a malformed or missing value now collapses to the fixed
  `"unknown"` bucket.
- `docs/04-API-Architecture.md`'s original design (a separate `track.
  <platform-domain>` subdomain, consent accepted inline in the ingestion
  payload) was superseded during this milestone's Approved Architecture
  decision (same-origin routes, consent as a structurally separate call)
  — corrected in that document at this milestone's closeout, along with
  `docs/06-n8n-Workflow-Architecture.md`'s stale description of ingestion
  as n8n-queued (it is direct and synchronous, per Decision B).

**Known gaps, explicitly deferred (not oversights)**
- Visitor identification (matching an anonymous visitor to a known
  `contacts` row), n8n-mediated event processing, and lead scoring remain
  entirely unbuilt — Milestones 3.2/3.3/3.4. `website_visitors.
  identified_contact_id` is schema-ready and unpopulated by any code path
  in this milestone.
- No `identify()`/visitor-profile/trait API exists on the tracking
  script — deliberately out of this milestone's scope, reserved for 3.2.
- No consent-banner/CMP UI ships as part of this milestone — the
  installing customer's own site/CMP is responsible for calling the
  script's `consent()` API.
- The tracking script's `Retry-After` handling parses only the
  delta-seconds form, not the HTTP date form — falls back to its safe
  60-second default for a date-form value rather than parsing it.

**Closeout — final validation**
- Full monorepo **2,517/2,517** tests passing across all 8 packages (ui
  39, database 674, intelligence 45, auth 390, compliance 51, tenancy 46,
  crm 310, web 962) — a monotonic increase from the Milestone 2.5
  baseline, `pnpm lint`/`typecheck`/`build` clean, zero RLS/grant
  regression.
- Each sub-phase (3.1A, 3.1B, 3.1C-A, 3.1C-B, 3.1C-C, 3.1D) underwent its
  own independent, adversarial final acceptance audit before being
  committed and pushed, following this repository's standard audit →
  implement → final acceptance audit → commit → push discipline. No
  browser/staging verification was performed or is claimed for this
  milestone — 3.1C-C/3.1D's real HTTP/browser-shaped behavior was
  verified via real Postgres-backed route tests and Node `vm`-sandboxed
  execution of the exact served script bytes.
- Two genuine security defects were found and fixed *before* commit
  rather than shipped and patched later (see **Fixed** above) — both
  disclosed, neither silently corrected.
- **Milestone 3.1 status: PASS — CLOSED** (`docs/13-Technical-Design-Review.md` "Milestone 3.1 — Overall Closeout").

## Milestone 3.2 — Website Intelligence: Visitor Identification

**Added**
- Visitor identification, live behind `POST /track/identify` and the
  browser tracking script's new `aiRevenueOsTracker.identify(assertion)`
  method (3.2E) — matches an anonymous website visitor to a known
  `contacts` row, the gap Milestone 3.1 explicitly left open.
- **Trust model: Ed25519 asymmetric signing, via Node's built-in
  `node:crypto` only, zero new dependency.** The customer's own trusted
  backend generates and permanently retains the private key; this
  platform only ever receives, verifies, and stores the corresponding
  public key. **This milestone does not use HMAC or any shared/reusable
  signing secret** — an HMAC/shared-secret design was considered
  earlier in this milestone's own design process and was never
  implemented, once a Phase-0 feasibility check found the
  encryption-at-rest primitive that design assumed did not actually
  exist in this repository (see **Fixed** below). Assertions use a
  compact, non-JWT format (`base64url(claims) + "." + base64url(
  signature)`, no `alg` header) — deliberately not JWT/JWS-compatible,
  to avoid reproducing JWS's own algorithm-confusion attack surface for
  a single-algorithm use case.
- `visitor_identifications` (append-only identification audit/replay
  log, tenant-scoped single-use `jti` via `UNIQUE (organization_id,
  token_jti)`) and `tracking_site_public_keys` (registered Ed25519 SPKI
  public keys only, never a private key) — new tables, 3.2A.
- `website_visitors.identification_suppressed_at` — additive column,
  the GDPR erasure anti-relink flag (3.2A/3.2F, see below).
- Staff public-key management: `GET`/`POST /api/v1/tracking-sites/
  {trackingSiteId}/public-keys`, `POST .../public-keys/{keyId}/revoke`
  (3.2B) — session auth, new `tracking:manage-identity-keys` permission,
  `org_admin` only.
- `packages/auth`'s Ed25519 assertion parsing/claims validation/
  signature verification and tenant/site-scoped key resolution (3.2B/
  3.2C), and `packages/intelligence`'s `identifyVisitor` (3.2C) — the
  one atomic transaction behind `/track/identify`: live consent
  re-check, resolve-or-create visitor, erasure-suppression guard,
  contact resolution by the assertion's own email claim, A→B conflict
  policy, structural jti replay protection, and a `visitor.identified`
  transactional-outbox emission, all in one transaction.
- Consent-withdrawal identity unlink (3.2F) — withdrawing cookie-
  tracking consent atomically clears an identified visitor's binding in
  the same transaction as the consent-status write.
- Contact-erasure anti-relink (3.2F) — a hard-erased contact's
  previously-identified visitor(s) are permanently suppressed from any
  future identification, to any contact, closing the gap where the
  browser's continued possession of the same `anonymous_id` could
  otherwise re-associate a hard-erased person's retained history with a
  replacement contact. Additive `CREATE OR REPLACE` on
  `execute_contact_erasure()` — the pre-existing effective body is
  unchanged, only two new statements added.

**Fixed**
- **Architecture amendment, before any implementation code was written**:
  the originally-accepted design cited `integration_connections.
  credentials_encrypted` and `/api/v1/api-keys` as existing precedent
  for a reversible-encrypted-secret HMAC signing model. A mandatory
  Phase-0 feasibility check found, by direct repository search rather
  than by assuming the documentation was current, that neither actually
  existed. Per this repository's own standing discipline, this was
  reported as a blocker and the turn stopped without writing any code —
  no plaintext-secret workaround was substituted. The architecture was
  then formally amended to Ed25519 asymmetric signing (see **Added**
  above), which removes the reversible-secret requirement entirely by
  construction.
- **Found by the first Final Implementation Acceptance Audit, fixed in a
  dedicated remediation pass, independently re-verified by a second
  audit**:
  - **BLOCKER** — `emit_visitor_identified_event()` (the `SECURITY
    DEFINER` outbox-emission function) originally accepted
    `organization_id` as a caller-trusted parameter with no
    revalidation, meaning any authenticated-role database caller could
    invoke it directly with fabricated or cross-tenant identifiers and
    forge an outbox event for another tenant. Fixed by removing the
    `organization_id` parameter entirely — it is now always derived
    from `website_visitors`, with the visitor's current binding and
    same-organization contact relationship independently re-proven
    before every insert.
  - **HIGH** — a signed assertion's `jti`, replayed after the visitor
    had since been legitimately rebound to a different contact, could
    hit an unguarded code path and throw an uncaught database exception,
    surfacing as an HTTP `500` distinguishable from this endpoint's
    otherwise-uniform `204` non-oracle response. Fixed by applying the
    same replay-detection handling already used on the normal
    identification path to the conflict-rejection path as well.
  - **LOW** — a migration comment incorrectly described a `SECURITY
    DEFINER` bypass-RLS read path for `tracking_site_public_keys` that
    was never actually implemented; corrected to describe the real,
    ordinary-RLS read path.

**Known gaps, explicitly deferred (not oversights)**
- `emit_visitor_identified_event()` does not independently re-check
  `identification_suppressed_at` or `contacts.deleted_at` — the current
  `identifyVisitor` flow already guarantees neither state is reachable
  through it, so this is a defense-in-depth gap for a future/direct
  caller, not a live vulnerability. Preserved, not fixed, at this
  milestone's own explicit direction.
- The outbox emitter has no event-level idempotency — a repeated direct
  call for the same current binding creates a repeated
  `visitor.identified` event. No consumer of this event exists yet
  (that is Milestone 3.3's own scope), and this codebase never exposes
  Postgres functions directly to browser clients.
- n8n-mediated processing (Milestone 3.3, the first n8n workflow) and
  any consumer of the `visitor.identified` outbox event remain entirely
  unbuilt and out of this milestone's scope.

**Closeout — final validation**
- Full monorepo **2705/2705** tests passing across all 8 packages (ui
  39, database 717, auth 457, compliance 51, crm 315, tenancy 46,
  intelligence 73, web 1007) — run twice, both fully green (concurrency
  is exercised by this milestone's own real `Promise.all`/`Promise.
  allSettled` race tests, not simulated). `pnpm lint`/`typecheck`/
  `build` clean across all 9 packages. Fresh `supabase db reset`
  applies all five Milestone 3.2 migrations cleanly, in order, from a
  fully torn-down local database.
- Two independent, read-only, adversarial Final Implementation
  Acceptance Audits were performed — the first found the BLOCKER and
  HIGH above (and stopped without fixing them, per its own explicit
  instruction); a dedicated remediation pass fixed exactly those three
  findings and added 12 new tests, nothing else; the second audit
  independently re-verified every fix from scratch — including direct
  hostile SQL invocation as the real `authenticated` role, not merely
  re-running the remediation's own test suite — and returned **GO**.
- **Milestone 3.2 status: PASS** (`docs/13-Technical-Design-Review.md`
  "Milestone 3.2 — Overall Closeout"). Not yet committed or pushed as of
  this entry.

## Milestone 3.3 — Lead Enrichment (AI Revenue OS side, provider-agnostic)

**Added**
- **Provider-agnostic enrichment domain/schema** — `contact_enrichment`/
  `company_enrichment` (new, one row per `(organization_id, entity, provider)`,
  upserted never accumulated; `status`, `normalized_result`, `raw_payload`,
  `error`, `cost_usd`, `source_event_id`, `fetched_at`, `expires_at`) and
  `workflow_runs` (new, `workflow_key` — a static code-defined identifier,
  not a DB-driven pointer — `source_event_id`, `status`, `attempt_count`,
  `provider`, `cost_usd`, `error`, `error_classification`). Deliberately
  separate tables from `contacts`/`companies` themselves — no code path
  anywhere in this milestone writes a provider result into a customer-
  entered CRM field. This platform never holds a provider credential and
  never calls a provider directly; n8n calls the provider on its own side
  and pushes an already-normalized result back (provider selection itself
  is explicitly deferred to a later n8n workflow-authoring sub-phase).
- **Service-to-service (API-key) request authentication, wired up for the
  first time** — `resolve_api_key()` (`SECURITY DEFINER`, mirrors
  `resolve_tracking_site()`'s own no-`auth.uid()`-guard precedent) plus
  `packages/auth`'s `resolveServiceActorFromApiKey`/`ServiceActor`/
  `hasScope`. Deliberately **not** `resolveRequestContext()`/`can()` — a
  machine credential is not a human staff role; authorization is
  scope-based (`api_keys.scopes`, a column that has existed unused since
  M1.7) via a separate, narrower mechanism. `packages/database/scripts/
  issue-api-key.mjs` gained a `--scopes` flag. No `/api/v1/api-keys`
  self-service management route exists yet — issuance is still the
  internal script only (see docs/04 §2.3 correction below).
- **`POST /api/v1/contacts/{id}/enrichment`, `POST /api/v1/companies/{id}/
  enrichment`** — the API-key-authenticated (`enrichment:write` scope)
  write-back endpoints n8n's own workflow calls with an already-normalized
  result. 64KB bounded-body reader (real byte-counted streaming, not
  trusting a declared `Content-Length`), a strict field allowlist
  (`workflowKey` is deliberately never caller-supplied — always the fixed
  server-side `'lead_enrichment'` constant), and a dedicated
  30/minute-per-organization rate limit reusing `check_tracking_rate_limit()`
  under a namespaced bucket prefix (verified mechanically generic, no
  collision with the tracking surface's own dimensions). A live re-check
  immediately precedes every write (same transaction): a contact/company
  that no longer exists or is soft-deleted rejects the write, indistinguishable
  from any other rejection reason.
- **`GET /api/internal/dispatch-events`** — the cron-driven trigger (Vercel
  Cron, `vercel.json`, every minute) for the in-process outbox dispatcher,
  protected by a dedicated `CRON_SECRET` (SHA-256-hash-then-`timingSafeEqual`
  comparison), never session or API-key auth. Not under `/api/v1/*` —
  internal platform infrastructure, never tenant- or n8n-facing.
- **Bounded-batch, lock-free, lease-based dispatcher redesign**
  (`packages/database/src/events.ts`, replacing this milestone's own
  first-draft unbounded, advisory-lock-based design — M1.7's original
  dispatcher was unbounded too, but never held any lock at all) — see
  **Fixed** below for the two hostile-audit-driven remediation rounds
  that produced this final shape.

**Fixed — found by successive hostile Final Implementation Acceptance
Audits, each remediated in a dedicated pass, each independently
re-verified from scratch before the next audit**
- **HIGH (first audit)** — the original design ran an entire dispatch pass
  (every pending event across every tenant, unbounded) inside one database
  transaction shared with a caller-held advisory lock, holding that
  transaction open across every consumer's external HTTP call, serially.
  No `LIMIT` meant a real pre-existing backlog could hold the lock and a
  pooled connection open for the whole batch's wall-clock duration and
  risk a live-lock under a serverless function timeout. **Fixed** by a
  full redesign: a fixed, code-defined `DISPATCH_BATCH_SIZE` (10) per
  call; no advisory/session lock of any kind (removed entirely, not
  mechanically preserved — a transaction-scoped lock cannot span the new,
  deliberately non-batch-wide transaction model); no transaction spans any
  external HTTP call; the pending-event `SELECT` itself is scoped to the
  calling consumers' own registered event types (closing a head-of-line-
  blocking regression the fix's own first draft introduced and the same
  audit round caught before sign-off).
- **HIGH (second audit)** — the first remediation's own "claim-first"
  design (insert a durable claim row *before* calling a consumer's
  `handle()`, delete it on a caught failure) left a real crash window: a
  process kill (a function timeout, an OOM, a deploy rollover) strictly
  between the claim committing and either delivery completing or the
  catch block's own cleanup left a row permanently indistinguishable from
  a genuine success — silently, permanently un-retried, with no automated
  recovery. Reproduced directly against real Postgres before any fix was
  written. **Fixed** by an additive migration
  (`20260902090000_add_event_delivery_lease_state.sql`) giving
  `event_deliveries` two new columns, `status` (`'leased'`/`'delivered'`)
  and `lease_expires_at`, modeling three real states — `unclaimed → leased
  (in flight, possibly by a since-crashed process) → delivered (terminal)`
  — with acquisition and stale-lease reclamation as the *same* single
  atomic `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE` statement, fixed
  at a 120-second lease duration (generous headroom over the one real
  consumer's 10-second external-call timeout). A crashed lease self-heals
  once it expires, via that same statement — no separate sweeper process.
  Terminal success is an independently persisted write, distinct from the
  lease itself, never subject to reclamation again.
- **MEDIUM (third audit, targeted)** — the completion check driving
  `events.processed_at` counted *any* `status='delivered'` row for an
  event, with no restriction on which consumer produced it — a
  historical, renamed, or removed consumer's own unrelated delivered row
  could satisfy the count even while the *current* invocation's own
  applicable consumer had just failed, silently and permanently excluding
  a genuinely undelivered event from all future retry. Reproduced
  directly, then **fixed**: the completion query is now scoped to
  `consumer = ANY($currentApplicableConsumerNames)` (parameterized, never
  interpolated), compared against a deduplicated count of those names —
  not `applicable.length` itself, since nothing structurally guarantees a
  caller never registers two entries sharing one name.
- A fourth, fully independent, fully read-only Final Implementation
  Acceptance Audit — targeted specifically at this last fix, hostile
  reproduction of all twelve scenarios named in its own audit brief
  against real PostgreSQL, not trusting any prior report — found nothing
  further and returned **GO**.

**Known gaps, explicitly deferred (not oversights)**
- `contact.created`/`company.created` triggers are documented (`docs/06`
  §2) as alternate triggers for this same workflow but are **not wired**
  — no domain code in this repository emits either event yet. The one
  real, firing trigger today is `visitor.identified` (Milestone 3.2).
  Correctly scoped as complete for this milestone's own authorized slice,
  not a partial implementation of a broader one.
- `raw_payload` has no active TTL-purge mechanism — the `expires_at`
  column is computed and stored, but nothing yet reads or enforces it.
- The dispatcher's inner `if (applicable.length === 0) continue` branch is
  now structurally unreachable dead code, given the outer event-type-
  scoped `SELECT` (a consequence of the first remediation round, not a
  defect) — confirmed by direct proof, not removed, since it documents
  intent cheaply and touching it was out of scope for the fix that made
  it unreachable.
- **At-least-once delivery, not exactly-once external side effects** — an
  unavoidable distributed-systems boundary, not something this or any
  purely-local design can close. Every outbound trigger this milestone's
  one consumer sends carries `event.id` verbatim as a stable identifier
  downstream processing can use to deduplicate; whether n8n's own
  workflow actually does so is outside this repository's control
  (already disclosed in the Milestone 3.3 Architecture Resolution
  Report). This system's own bookkeeping cannot double-count regardless
  — `workflow_runs`' `source_event_id`-keyed uniqueness constraint
  guarantees that independently of how many times n8n itself is
  triggered for the same event.
- Provider selection itself, the real n8n workflow JSON, and any provider
  credential remain entirely out of this milestone's scope — the AI
  Revenue OS side is built provider-agnostically per the accepted
  architecture; provider-specific integration is a later n8n workflow-
  authoring sub-phase.
- A small number of pre-existing, unrelated tracking-rate-limit tests
  (`track-collect`/`track-consent-route`/`track-rate-limit`, none touched
  by this milestone) are intermittently flaky under heavy concurrent
  full-suite load — independently reproduced across multiple audit
  sessions, a real-clock fixed-window timing characteristic, not a logic
  defect; did not manifest in this milestone's own final verification
  runs.

**Closeout — final validation**
- Full monorepo **2788/2788** tests passing across all 8 packages (ui 39,
  database 739, auth 477, compliance 52, crm 315, tenancy 46,
  intelligence 94, web 1026) — reproduced clean under the repository's
  literal standard `pnpm test` command (`turbo run test`, normal
  parallelism, no `--no-file-parallelism`/`--concurrency` workaround),
  fresh and again against a real accumulated backlog. `pnpm lint`/
  `typecheck`/`build` clean across all 9 packages. Fresh `supabase db
  reset` applies all six Milestone 3.3 migrations cleanly, in order
  (five schema/RLS/function migrations plus the additive lease-state
  migration), from a fully torn-down local database.
- Dedicated regression suites at final sign-off: dispatcher **21/21**,
  dispatch-events API + enrichment write-back API **19/19**, intelligence
  enrichment **21/21**, contact erasure **24/24** (including a new
  regression proving a real GDPR erasure cascade-deletes a pre-existing
  enrichment row via the actual `executeContactErasure` path, not a raw
  `DELETE`).
- **Four** independent, read-only, adversarial Final Implementation
  Acceptance Audits were performed in sequence — the first three each
  found exactly one new finding (HIGH, HIGH, then MEDIUM, described
  above), each remediated in its own dedicated, narrowly-scoped pass with
  hostile regression tests added, each independently re-verified from
  scratch by the next audit rather than trusted; the fourth found nothing
  further. Every hostile scenario named across all four audits — genuine
  two-connection concurrent lease acquisition, stale-lease reclamation
  under real concurrency, a delivered row's permanent unreclaimability,
  immediate caught-failure retryability, no cost double-counting under
  genuine concurrent writes, and all twelve `processed_at` completion
  scenarios — was reproduced directly against real PostgreSQL, not
  inferred from passing unit tests alone.
- **Milestone 3.3 status: PASS** (`docs/13-Technical-Design-Review.md`
  "Milestone 3.3 — Overall Closeout"). Not yet committed or pushed as of
  this entry.

## Milestone 3.4 — Rules-Based Lead Scoring

**Added**
- **`lead_scores`/`scoring_rules` (new)** — deterministic, contact-level-only
  lead scoring; no company-level score exists or is planned, company
  attributes are an input to the contact score only. `lead_scores` is
  historized/insert-only (never updated in place) — `id`,
  `organization_id`, `contact_id`, `score` (0–100, `CHECK`-bounded),
  `grade` (`GENERATED ALWAYS AS ... STORED` — `A`≥80/`B`≥60/`C`≥40/`D`<40,
  fixed v1 thresholds, not organization-configurable — structurally
  incapable of drifting from `score`, no code path can ever insert a
  mismatched pair), `breakdown` (jsonb — `{ruleId, field, operator,
  matched, contribution}` tuples only, never free-text/raw PII beyond
  what the same RLS-scoped staff reader already sees on the record
  directly), `source_event_id`, `computed_at`. Composite tenant-safe FK
  to `contacts`, `ON DELETE CASCADE` — a hard-erased contact's entire
  score history is deleted with it. `scoring_rules` is organization-owned
  configuration — `field` (11-value fixed allowlist), `operator` (9-value
  fixed allowlist), `value` (jsonb), `weight` (bounded [-100,100]),
  `is_active` (the sole enable/disable mechanism — no `deleted_at`, no
  physical delete either, matching `contact_enrichment`/`workflow_runs`'
  own no-physical-delete convention).
- **Deterministic rule evaluator (`packages/intelligence/src/scoring.ts`,
  `computeScore`)** — a fixed, hand-written TypeScript interpreter over a
  plain, pre-loaded fact object. **No `eval`, no `new Function`, no
  dynamic SQL construction from rule content, and no LLM/agent
  involvement anywhere in this module** — a rule's `{field, operator,
  value}` is strictly allowlisted data, never an executable expression.
  Score is explicitly clamped to [0, 100] regardless of how many rules
  matched, since a sum of individually-bounded weights can still exceed
  either edge.
- **`scoring-rules:read`/`scoring-rules:write` permissions** — `org_admin`
  only, no agency-scoped role, same reasoning as
  `tracking:manage-identity-keys` (Milestone 3.2B): configuring the
  criteria that qualify a lead is a security/business-sensitive,
  per-organization decision. `roles.permission_set` snapshot updated in
  the same migration discipline as every prior permission addition.
- **Staff APIs** — `GET /api/v1/contacts/{id}/lead-scores` (historized
  series, `?latest=true` for the current score, `contacts:read`),
  `POST /api/v1/contacts/{id}/lead-scores/recalculate` (on-demand
  recompute, `contacts:update`), `GET`/`POST /api/v1/scoring-rules`,
  `PATCH /api/v1/scoring-rules/{id}` (`scoring-rules:read`/`write`,
  `org_admin` only). Strict field-allowlist request validation
  (`scoring-rule-validation.ts`), mirroring `enrichment-validation.ts`'s
  own established style.
- **Read-only contact-detail Lead Score UI** — a "Lead score" section
  added to the existing `contacts/[id]` page (score, grade, computed-at
  timestamp, or "No score computed yet"), reading via the same
  server-resolved, RBAC-checked actor the rest of the page already uses.
  Deliberately no dashboard, no rules-management UI — out of this
  milestone's scope.
- **`visitor.identified` → `lead_scoring` dispatcher integration** — a
  second `EventConsumer` (`lead_scoring`) registered alongside
  `lead_enrichment` on the same event type, reusing `workflow_runs` for
  event-trigger deduplication (an explicit, atomic claim —
  `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE ...`, mirroring
  `event_deliveries`' own lease acquire/reclaim pattern) rather than a
  new mechanism, since `lead_scores`' historized/insert-only design has
  no unique constraint to dedupe against for free the way
  `contact_enrichment`'s own monotonic upsert does.
- **Post-enrichment score recalculation, durably retryable** — a
  successful `contact_enrichment`/`company_enrichment` write-back
  recalculates that contact's score under its own distinct workflow key
  (`lead_scoring_post_enrichment`, keyed by the write-back's own
  `sourceEventId` — never the same key as the dispatcher-triggered path,
  so no prior success can ever permanently block a later, genuinely new
  attempt). `workflow_runs` gained a nullable, informational
  `contact_id` column (additive migration, not a foreign key — same
  reasoning as `source_event_id`) so a periodic recovery sweep
  (`recoverPendingPostEnrichmentScoring`, invoked by the same cron tick
  that already drives `dispatchPendingEvents`) can find and automatically
  retry a failed or crashed-mid-flight attempt with no manual
  intervention and no dependency on a future `visitor.identified` event.
  Enrichment persistence is never coupled to scoring's own outcome — the
  scoring call is a separate, best-effort step outside the write-back's
  own transaction, structurally incapable of rolling it back.

**Fixed — found by two dedicated Final Implementation Acceptance Audits,
each remediated in a targeted pass, each independently re-verified before
sign-off**
- **HIGH** — the scoring-rule field-allowlist check used JavaScript's
  `in` operator against a plain object, which consults the prototype
  chain — `field: "__proto__"` (and `constructor`/`toString`/`valueOf`/
  `hasOwnProperty`/etc.) passed the allowlist check, then crashed with an
  uncaught `TypeError` two lines later. Reproduced end-to-end through the
  real `POST`/`PATCH` handlers with a real `org_admin` session before any
  fix — no row was ever written (the crash preceded the insert), but the
  request failed as an unhandled exception rather than a clean `400`.
  **Fixed**: both allowlist checks now use
  `Object.prototype.hasOwnProperty.call(...)`, an own-property check
  immune to prototype-chain lookup.
- **MEDIUM** — the original post-enrichment scoring hook called the bare,
  untracked scoring function inside a swallowed `try/catch` with no
  durable record of the attempt — a thrown exception left zero trace,
  and nothing was ever positioned to retry it. **Fixed** by the durable,
  automatically-retried recovery mechanism described above, reusing the
  existing `workflow_runs` claim/lease infrastructure and the existing
  cron-driven dispatch route rather than inventing a second retry
  system or a new event type (a new event type was considered and
  rejected: `public.events` has zero grants to `authenticated`, so
  emitting one would have required a new `SECURITY DEFINER` function —
  an explicit stop condition — and a safe alternative existed).
- A concurrency bug found and fixed during the same audit pass, ahead of
  either numbered finding above: the dispatcher-triggered claim query
  originally reclaimed a `'running'` row on a plain `status <>
  'succeeded'` check, which does not exclude a genuinely still-in-flight
  attempt — two truly concurrent callers could both "win" the same claim
  and both insert a duplicate score. Reproduced directly against real
  Postgres, then fixed with the same time-based lease-staleness
  condition `event_deliveries`' own claim already enforces (120 seconds).
- A final, fully independent, fully read-only Final Targeted
  Implementation Acceptance Audit — hostile re-reproduction of both
  fixes plus a full crash-window enumeration, tenant-isolation probe
  against a deliberately malformed cross-org `workflow_runs` row, and a
  fresh multi-consumer `processed_at` re-verification — found nothing
  requiring further remediation and returned **GO**.

**Known gaps, explicitly deferred (not oversights)**
- **MEDIUM** — `recalculateContactScore` gathers facts, loads rules, and
  inserts the historized score across three separate transactions, not
  one atomic snapshot — a rule change or contact/company mutation
  landing in the narrow window between them is not isolated by a single
  point-in-time snapshot. No invariant is violated (no crash, no
  corruption, no cross-tenant leak); the historized design already
  treats drift as an accepted signal. Not fixed this milestone.
- **LOW** — a process crash strictly between enrichment's own transaction
  committing and the post-enrichment scoring claim's own `INSERT`
  executing leaves no durable trace for that one specific attempt — the
  narrowest possible inter-statement crash window, self-correcting via
  any later legitimate trigger for the same contact.
- **LOW/informational** — a crash after the score `INSERT` but before the
  claim's own completion `UPDATE` can produce one additional accepted
  historized row on stale retry — the same at-least-once bookkeeping
  boundary already accepted for `event_deliveries` since Milestone 3.3,
  not a new class of risk.
- **LOW/informational** — `computeScore` itself performs no internal
  clamping of a per-rule `weight`; fully mitigated by two independent
  upstream gates (application validation's `Number.isInteger` check, and
  the database column's `integer` type), neither of which a real code
  path can bypass.
- **Informational** — a malformed cross-organization `workflow_runs`
  bookkeeping row (a `contact_id` claiming an `organization_id` it does
  not actually belong to — reachable only by directly forging a row,
  never through any real code path) fails closed on every retry attempt
  and can never produce a cross-tenant score, but is retried indefinitely
  since nothing distinguishes "permanently invalid" from "transient" in
  the recovery sweep's own retry predicate.
- No AI/agent-assisted scoring exists or was built — explicitly excluded
  from this milestone's own accepted design (Implementation
  Authorization), not a partial implementation of a broader one. Any
  future agent-adjusted scoring is out of this milestone's scope
  entirely.

**Closeout — final validation**
- Full monorepo **2864/2864** tests passing across all 8 packages (ui 39,
  database 743, auth 477, compliance 52, crm 315, tenancy 46,
  intelligence 134, web 1058) — reproduced clean under the repository's
  literal standard `pnpm test` command, fresh and again against a real
  accumulated backlog, both fully green, independently reproduced across
  all three audit passes (initial acceptance, targeted remediation,
  final targeted acceptance). `pnpm lint`/`typecheck`/`build` clean
  across all 9 packages. Fresh `supabase db reset` applies all four
  Milestone 3.4 migrations cleanly, in order, from a fully torn-down
  local database.
- Dedicated regression suites at final sign-off: `scoring.test.ts`
  **25/25**, `scoring-adversarial.test.ts` **15/15**,
  `lead-scoring-api.test.ts` **32/32**, `enrichment.test.ts` **21/21**,
  `identify.test.ts` **28/28**, `enrichment-write-back-api.test.ts`
  **12/12**, `dispatch-events-api.test.ts` **7/7**, `compliance-api.test.ts`
  **25/25**, `track-consent-route.test.ts` and `track-identify.test.ts`
  (consent/identification regression, unaffected).
- **Two** independent, read-only, adversarial Final Implementation
  Acceptance Audits were performed in sequence — the first found one
  HIGH and one MEDIUM finding (the prototype-chain validation bug and
  the untracked post-enrichment scoring hook, both described above),
  remediated in one dedicated, narrowly-scoped pass with hostile
  regression tests added and a real concurrency bug found and fixed
  along the way; the second, fully independent, found nothing further
  and returned **GO**. Every hostile scenario named across both audits —
  prototype-chain field bypass against both `POST` and `PATCH`, the full
  crash-window enumeration (before claim, after claim, during scoring,
  after insert, after success), tenant isolation of the cross-org
  recovery sweep against a deliberately malformed row, duplicate/
  replayed recovery safety, and multi-consumer `processed_at`
  correctness — was reproduced directly against real PostgreSQL, not
  inferred from passing unit tests alone.
- **Milestone 3.4 status: PASS** (`docs/13-Technical-Design-Review.md`
  "Milestone 3.4 — Overall Closeout"). Not yet committed or pushed as of
  this entry.

## Milestone 3.5 — Revenue Dashboard v1

**Added**
- **`/dashboard` rebuilt from the bare M1.3-era shell into five
  organization-wide, read-only sections**, each calling `packages/crm`/
  `packages/intelligence` domain functions in-process from a Server
  Component — no new API route, no browser-side `fetch()`, no chart
  library, anywhere in this milestone:
  - **Deals overview** — Open Deals (count), Open Pipeline Value and
    Average Open Deal Size (both grouped per currency, never combined,
    NULL amounts excluded from the sum/average and explicitly
    disclosed, never silently treated as zero), Win Rate
    (`won / (won + lost)`, open deals never diluting the denominator,
    `null`/"No closed deals yet" on a zero denominator rather than a
    fabricated `0%`). Deal-value terminology only — never "revenue,"
    "MRR," or "ARR" — since no realized-revenue ledger exists in this
    schema.
  - **Deals by Stage** — every non-deleted pipeline/stage represented,
    including a stage with zero deals; grouped by pipeline so two
    identically-named stages in different pipelines stay distinct.
  - **Lead Intelligence** — grade distribution (A/B/C/D) and a bounded
    top-5 high-score contact list, both derived from `lead_scores`'
    latest row per contact only (`DISTINCT ON`), never double-counting a
    contact whose score changed over time; exposes only name/email/
    score/grade/computed-at, never a scoring breakdown or raw
    enrichment payload.
  - **Identified Visitor Intelligence** — a single "Identified Visitors
    — Last 30 Days" count, timestamped from each visitor's own latest
    `visitor_identifications` `event_type='identified'` row, never
    `website_visitors.first_seen_at`.
  - **Recently Created Deals** — a fixed-limit-5 list ordered
    `created_at DESC` with a deterministic `id DESC` tie-break, reusing
    `listDeals` (Milestone 2.2) completely unmodified — not an activity
    log, not a win/close-date history.
- **New domain-layer read functions, zero new migration**:
  `getDealDashboardMetrics` (`packages/crm/src/dashboard-metrics.ts`),
  `getLeadScoreDistribution`/`getHighScoreContacts`/
  `getIdentifiedVisitorMetrics` (`packages/intelligence/src/dashboard-
  metrics.ts`) — each a small, fixed set of SQL aggregate queries
  against tables that already existed, tenant-scoped via the same
  `withTenantContext` mechanism every other domain function already
  uses. A live-Postgres index audit at the start of this milestone found
  every needed index already present.
- **Authorization reuses two existing permissions, introduces none**:
  deal-shaped sections gate on the existing `deals:read` grant; Lead
  Intelligence and Visitor Intelligence both gate on the existing
  `contacts:read` grant. The gate is content-only — `/dashboard` itself
  stays reachable by every authenticated user regardless of role,
  since it is the universal landing page and the fallback redirect
  target every console page's own access decision already uses.

**Fixed**
- No implementation defect required remediation this milestone. The
  Final Implementation Acceptance Audit (below) found zero BLOCKER,
  HIGH, or MEDIUM findings — the two LOW findings it did surface are
  recorded under Known gaps, not remediated as bugs, per the audit's own
  explicit instruction not to silently fix or upgrade their severity.

**Known gaps, explicitly deferred (not oversights)**
- **LOW** — Deals by Stage has no disclosure mechanism, analogous to
  the KPI section's own null-amount note, for the case where an open
  deal sits on a since-soft-deleted stage: it stays counted in the
  top-level Open Deals KPI while disappearing from the visible stage
  groups. Both numbers are individually accurate; this is a narrow,
  inherited, cross-section transparency gap, not a wrong-number defect.
- **LOW** — the Recently Created Deals automated test for the `id DESC`
  tie-break proves set-membership and repeatability only, not the
  specific tie-break rule itself. The production SQL was independently
  verified correct against real Postgres during the closeout audit — a
  test-rigor gap, not a shipped-behavior defect.
- **Informational** — no browser-level responsive/accessibility
  verification exists for any Milestone 3.5 UI, consistent with this
  repository's established no-jsdom testing-limitation precedent.
- **Informational** — the closeout audit's final full-suite run did not
  follow a fresh `supabase db reset` (the CLI was unavailable in that
  environment); the suite instead ran fresh/uncached against the
  existing, purely-additive local dev database.
- No forecast, pipeline velocity, weighted-pipeline value, or
  revenue-history trend view was built — none of those are truthfully
  derivable without a stage-transition-history table or a closed-date
  column, neither of which exists in this schema. Not a partial
  implementation of a broader one; explicitly out of this milestone's
  own accepted scope.

**Closeout — final validation**
- Full monorepo **2992/2992** tests passing across all 8 packages (ui
  39, database 743, auth 477, compliance 52, crm 329, tenancy 46,
  intelligence 150, web 1156), reproduced fresh (not cache-replayed).
  `pnpm lint`/`typecheck`/`build` clean across all 9 packages.
  `git diff --check` clean.
- Dedicated regression suites at final sign-off: `dashboard.test.ts`
  **98/98**, `packages/crm`'s `dashboard-metrics.test.ts` **14/14**,
  `packages/intelligence`'s `dashboard-metrics.test.ts` **16/16**.
- **One** independent, read-only, adversarial Final Implementation
  Acceptance Audit was performed after all six sub-phases (3.5A–F) —
  re-reading every implementation file fresh rather than trusting any
  prior sub-phase report, reconstructing the complete role × dashboard-
  section authorization matrix directly from `packages/auth/src/
  permissions.ts`, and independently reproducing 18 hostile scenarios
  against real Postgres with raw SQL copied verbatim from the actual
  production queries (mixed currencies, NULL vs. numeric-zero amount,
  zero-closed-deals, closed-with-zero-wins, multiple pipelines, a
  zero-count stage, a soft-deleted deal, a soft-deleted stage with a
  surviving deal, a cross-tenant deal, an A→D lead-score history, a
  cross-tenant lead score, old-visitor/recent-identification, recent-
  visitor/old-identification, a consent-withdrawn visitor, a
  cross-tenant visitor, a `created_at`-tied recent-deals pair with an
  independent `id DESC` ground-truth comparison, and an `updated_at`-
  newer-than-`created_at` ordering case) — **18/18 passed**. Found
  exactly two LOW findings and two informational limitations (all
  above), zero BLOCKER/HIGH/MEDIUM, and returned **GO**.
- **Milestone 3.5 status: PASS** (`docs/13-Technical-Design-Review.md`
  "Milestone 3.5 — Overall Closeout"). Not yet committed or pushed as
  of this entry.

## Milestone 4.1 Phase 1 — Brain Foundation: Database + GDPR Foundation

**Status: Phase 1 of Milestone 4.1 ACCEPTED. Milestone 4.1 as a whole,
and Phase 4 (AI Agents), remain IN PROGRESS — not complete.**

**Added**
- **pgvector enabled** (`vector` extension, verified installed at
  version 0.8.2 locally) — schema-only prerequisite, no embedding ever
  generated, no similarity index created.
- **Six new Brain storage tables** (`docs/03-Database-Architecture.md`
  §2.9): `brain_knowledge_documents`, `brain_entity_profiles`,
  `brain_entity_profile_history`, `brain_embeddings`,
  `brain_embedding_entity_refs`, `brain_sync_state`. Entity references
  use a relational, three-nullable-composite-FK design
  (`contact_id`/`company_id`/`deal_id`, exactly one set, real composite
  tenant-safe FKs `ON DELETE CASCADE`) plus a new
  `brain_embedding_entity_refs` junction table — a deliberate deviation
  from this feature's own original jsonb-array `entity_refs` design
  (`docs/11-AI-Revenue-Brain.md` §4), trading some scalability past
  ~4-5 entity types for DB-enforceable tenant/entity invariants instead
  of an application-trusted convention.
- **`deals` gained `unique(organization_id, id)`** — a previously-
  unverified schema gap discovered during implementation (no composite
  FK could otherwise target `deals`), fixed with the exact precedent
  already established for `contacts`.
- **RLS + grants on all six tables**: `authenticated` gets ordinary
  `SELECT`/`INSERT`(/`UPDATE` where mutable) — no `DELETE` grant
  anywhere; `anon` gets nothing. Every Brain FK carrying a tenant-owned
  parent is a real composite `(organization_id, id)` FK, adversarially
  verified against live Postgres (cross-tenant parent attacks against
  `brain_entity_profiles`, `brain_entity_profile_history`,
  `brain_embeddings`, `brain_embedding_entity_refs` all attempted and
  rejected by the FK layer, independent of RLS).
- **Retention registration**: `brain_entity_profiles`/
  `brain_entity_profile_history`/`brain_embeddings`/
  `brain_embedding_entity_refs` added to `data_retention_policies`
  (2555-day platform default). `brain_sync_state` (no personal data)
  and `brain_knowledge_documents` (no write path — see Changed, below)
  deliberately excluded.
- **`execute_contact_erasure()` extended for Brain data** —
  targeted-capture design: the function captures every `brain_embeddings`
  id linked to the target contact *before* the contact delete fires,
  then deletes each captured embedding in full after the delete
  (`brain_entity_profiles`/`brain_entity_profile_history`/
  `brain_embedding_entity_refs` are removed structurally by their own
  `ON DELETE CASCADE` FKs). A shared embedding — one a surviving
  company/deal also has a ref on — is deleted in full, never partially
  redacted, since Phase 1 has no deterministic way to isolate only the
  erased contact's portion of a shared chunk. An unrelated embedding
  (including one that happens to have zero refs for an unrelated
  reason) is never reachable, because the delete is scoped to the
  pre-captured id set, not to "currently orphaned." `preview_contact_
  erasure()` deliberately not extended, matching established
  precedent.
- **71 new database tests** across three files
  (`brain-schema.test.ts`, `brain-rls.test.ts`,
  `brain-gdpr-erasure.test.ts`) covering schema/constraint validation,
  cross-tenant FK/RLS adversarial attacks, grants, retention, vector
  column behavior, and GDPR erasure (including three mandatory hostile
  tests: multi-entity PII, same-org unrelated orphan, cross-org
  safety) — plus a 9-line update to the pre-existing
  `compliance-schema.test.ts` retention-row-list assertion.

**Changed**
- **`brain_knowledge_documents` shipped SELECT-only for
  `authenticated`** (found during acceptance audit, corrected in the
  fix round): `content_text` is free text with no deterministic entity
  linkage, so it cannot participate in the GDPR erasure cascade above.
  Rather than grant an ordinary RLS-scoped write path with zero
  validation and zero erasure coverage, this table ships schema-only —
  no INSERT/UPDATE grant, no application/API/UI write path anywhere.
  Live-tested: SELECT succeeds; INSERT/UPDATE/DELETE/TRUNCATE all fail
  with a genuine grant-level `permission denied`.

**Fixed**
- **BLOCKER, found and fixed before commit** — the first
  implementation's Brain-embedding purge deleted a chunk only when it
  currently had zero entity refs. A chunk shared between the erased
  contact and a surviving company/deal ref was therefore never
  deleted, leaving the erased contact's own personal data (name/email/
  phone, in the hostile reproduction) fully readable in `chunk_text`
  after erasure. Fixed by the targeted-capture design described above
  — the entire shared artifact is now deleted whenever the erased
  contact was linked to it, regardless of what else remains linked.
- **HIGH, found and fixed before commit** — the same purge predicate
  was scoped to "any currently-orphaned chunk in the organization," not
  to this specific erasure, so it could delete an unrelated,
  already-orphaned embedding with nothing to do with the erased
  contact. Fixed by keying the delete to the pre-captured id set
  instead of an orphan scan.
- Both defects were independently reproduced against live Postgres
  (not merely inferred), and the regression tests written to catch
  them were independently proven to fail against the original
  defective implementation, reinstalled live and never written to a
  file, before being confirmed to pass against the fix.

**Known gaps, explicitly deferred (not oversights)**
- **MEDIUM** — `brain_entity_profiles.profile`/`brain_entity_profile_
  history.profile` (jsonb) carry no schema-level constraint preventing
  a company/deal profile from embedding a specific contact's personal
  data. Not a stored-data defect today (nothing writes to this column
  yet); documented as an explicit Phase 2 ingestion invariant in the
  migration's own comment, to be enforced or re-evaluated when
  ingestion is actually built.
- **LOW** — two stale SQL comments (describing the replaced "purge
  orphans if zero refs" design instead of the shipped targeted-capture
  design) were left behind by the fix round and corrected in a
  dedicated comment-only follow-up pass, proven not to change any
  executable SQL.
- Not built this phase, by design: `packages/brain`, CRM domain-event
  emission for Brain ingestion, the backfill/bootstrap script,
  `brain_sync_state` integration, embedding generation, semantic
  search, any AI/model-provider dependency, and Brain API routes/
  Server Actions/UI/RBAC permissions/agent functionality.

**Closeout — final validation**
- `packages/database` full suite **825/825** passed (35 files).
  `packages/compliance` full suite **52/52** passed, no regression.
  Full monorepo test suite (cache bypassed): **8/8 tasks successful**,
  including `apps/web` **1156/1156**. `pnpm lint`/`typecheck` (cache
  bypassed): **8/8 packages clean**. `git diff --check` clean.
- **Three** independent read-only audits: a Final Implementation
  Acceptance Audit (one BLOCKER, one HIGH, both reproduced live —
  **NO-GO**), a targeted fix round, and a Final Re-Acceptance Audit
  that independently re-derived every claim from source and fresh live
  Postgres reproduction rather than trusting the fix round's own report
  (**GO**, zero BLOCKER/HIGH remaining). A subsequent comment-only
  cleanup pass corrected two LOW-severity stale comments, re-validated
  clean.
- **Milestone 4.1 Phase 1 status: PASS** (`docs/13-Technical-Design-
  Review.md` "Milestone 4.1 Phase 1"). Milestone 4.1 overall, and
  Phase 4 overall, remain in progress. Not yet committed or pushed as
  of this entry.
