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
