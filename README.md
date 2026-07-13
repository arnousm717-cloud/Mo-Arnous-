# AI Revenue OS

Monorepo for AI Revenue OS. See `docs/` for the full architecture, database, API, AI agent, security, and roadmap documentation — start with `docs/01-Vision.md`.

## Local development

Requirements: Node 20+ (see `.nvmrc`), Docker running (for the local Supabase stack), `pnpm` (via `corepack enable` or `npx pnpm`).

```bash
pnpm install
pnpm --filter @ai-revenue-os/database start   # local Supabase (Postgres/Auth/Storage) via Docker
pnpm dev                                       # apps/web on localhost:3000
```

Verify the health check: `curl http://localhost:3000/api/v1/health` → `{"status":"ok",...}`.

## Repo layout

```
apps/web           # Main Next.js app
apps/marketing     # Placeholder — not yet built (docs/09-Development-Roadmap.md)
packages/config    # Shared eslint/tsconfig
packages/database  # Supabase schema, migrations, local dev stack
```

Full package boundaries and the rules for adding new ones: `docs/02-Software-Architecture.md` §4, `docs/10-CLAUDE.md` §3.

## Manual setup this repo does not automate

These require access to real cloud accounts and can't be done from inside the repo:

1. **Supabase**: create three projects (dev/staging/prod, EU region) at [supabase.com](https://supabase.com), then link this repo's `packages/database` to each via `supabase link --project-ref <ref>` per environment.
2. **Vercel**: create a project, connect it to this repo's git remote, and confirm preview deployments (for pull requests) are configured to use **staging** Supabase environment variables — never production. This is a security-relevant check, not just a config nicety (`docs/13-Technical-Design-Review.md`, M1.9).
3. **GitHub repository secrets**: once the above exist, add the Supabase/Vercel keys CI and deployments need as repository secrets — nothing here should ever be committed to `.env` files (only `.env.example` with placeholders is tracked).

## CI

`.github/workflows/ci.yml` runs lint, typecheck, and build on every pull request. It does not yet deploy anything — deployment is handled by Vercel's own git integration once step 2 above is done.
