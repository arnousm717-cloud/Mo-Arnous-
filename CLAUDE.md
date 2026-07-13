# CLAUDE.md

Auto-loaded at session start. This is a **condensed** entry point — the full rules live in `docs/10-CLAUDE.md`; this file exists so the essentials are never missed, not to duplicate them.

## Milestone Boundaries

- Work is scoped one milestone at a time per `docs/12-Implementation-Milestones.md`. Never implement functionality beyond the current milestone, even if it seems convenient.
- Every milestone: build → test (lint, typecheck, build, and tests where applicable — zero warnings/errors) → document (update affected docs + `CHANGELOG.md`) → **stop and wait for explicit approval** before the next one.
- Current status: see `CHANGELOG.md` for the last completed milestone.

## Architecture (full detail: `docs/02`–`docs/09`, `docs/11`)

- Modular monolith (Next.js) + Supabase (Postgres/Auth/Storage) + n8n for anything provider-facing. n8n never touches Postgres directly — it calls the app's own API using an `api_keys` row scoped to a `service` role, same as any external integrator (`docs/04-API-Architecture.md` §3).
- Package boundaries are defined once in `docs/02-Software-Architecture.md` §4 — that table is the single source of truth; don't create a new package for a handful of utility functions.
- Tenant context (`organization_id`) is always resolved server-side from a request-scoped mechanism, never from a client-supplied parameter (`docs/03-Database-Architecture.md` §5).
- Consequential AI agent actions (deal-stage changes, sends) are mechanically gated behind human approval at the tool-execution layer, not by prompting the model to ask nicely (`docs/05-AI-Agent-Architecture.md` §1).

## Coding Standards

- TypeScript strict mode everywhere. No `any` without an inline comment justifying why.
- Named exports only in `packages/*` (Next.js `page.tsx`/`layout.tsx` default exports are the one framework-required exception).
- Business logic lives in `packages/*`, never inline in route handlers/Server Actions.
- Comments explain non-obvious *why*, never *what* — no comments that just restate the code.
- No duplicate logic — extract to the relevant package instead of copy-pasting.

## Security (full detail: `docs/08-Security.md`)

- GDPR by design: `deleted_at` is recoverable soft-delete for ordinary use only. A GDPR erasure request always hard-deletes/anonymizes — never the same code path as an ordinary delete.
- Never log or expose secrets, API keys, or raw PII. Structured logging redacts secret/PII-shaped fields.
- Validate every external input at the boundary (API routes, webhooks, forms).
- RBAC facade (`can(actor, action, resource)`) is the only place permissions are checked — least privilege by default, RLS as defense-in-depth beneath it.
- No secret ever committed to the repo. `.env.example` documents variable names with placeholders only.

## Test Commands

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm test           # once test suites exist beyond M1.1
```

All four (five once tests exist) must pass with zero errors and zero warnings before any milestone is considered done.

## Where to look for more

| Topic | Doc |
|---|---|
| Vision, GTM | `docs/01-Vision.md` |
| Software architecture, ADRs | `docs/02-Software-Architecture.md` |
| Database schema, RLS | `docs/03-Database-Architecture.md` |
| API design | `docs/04-API-Architecture.md` |
| AI agents | `docs/05-AI-Agent-Architecture.md` |
| n8n workflows | `docs/06-n8n-Workflow-Architecture.md` |
| Design system | `docs/07-UI-UX-System.md` |
| Security/GDPR | `docs/08-Security.md` |
| Roadmap | `docs/09-Development-Roadmap.md` |
| Full engineering rules | `docs/10-CLAUDE.md` |
| AI Revenue Brain | `docs/11-AI-Revenue-Brain.md` |
| Milestone breakdown | `docs/12-Implementation-Milestones.md` |
| Technical design review / GO-NO-GO gates | `docs/13-Technical-Design-Review.md` |
