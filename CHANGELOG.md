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
