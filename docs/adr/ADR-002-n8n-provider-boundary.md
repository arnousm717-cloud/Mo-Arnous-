# ADR-002: n8n as the Provider-Facing Automation Boundary

**Status**: Accepted; credential primitive implemented in M1.7, consumption deferred to Phase 3
**Context**: `02-Software-Architecture.md` §1, §6; `04-API-Architecture.md` §3, §8; `03-Database-Architecture.md` §5; `06-n8n-Workflow-Architecture.md` §1

## Decision

n8n has no direct PostgreSQL access. It must never receive `DATABASE_URL` or an equivalent privileged database credential. It reads and writes tenant data exclusively through the application's own authenticated `/api/v1/*` API, authenticating with an `api_keys` row scoped to a `service` flag — the same credential primitive, issuance path, and tenant-resolution mechanism any external integrator uses. n8n is treated as just another API consumer, never a privileged internal system.

## Rationale

Two alternatives were considered and rejected:

1. **A privileged direct-Postgres connection for n8n.** Rejected — reintroduces exactly the second, less-scrutinized data-access path ADR-003/ADR-004 already exist to avoid for the app itself.
2. **n8n calling Supabase's PostgREST directly.** Rejected — the app itself doesn't use PostgREST for the same reason ADR-004 gives: PostgREST has no visibility into `app.current_org`, the app's own tenant-context mechanism. Using it for n8n would mean building and reasoning about a second, parallel tenant-resolution path.

One credential primitive (`api_keys`) for every non-session caller keeps issuance, revocation, and tenant-context resolution (`03-Database-Architecture.md` §5, which already names n8n's credential as one of exactly three uniformly-resolved caller types) in one place, and preserves the provider-agnostic promise `02-Software-Architecture.md` §6 depends on — replacing n8n with a different automation engine later is a credential-issuance change, not a data-access or tenant-isolation redesign.

## Consequences

- n8n workflows can only do what the `/api/v1/*` surface exposes — no ad hoc bulk queries or direct schema access. This may force API surface growth ahead of an otherwise-later schedule once Phase 3 workflows are built.
- RLS and the app's `can()` authorization layer apply to n8n exactly as they do to any other API caller, with no separate reasoning path required.
- No privileged Postgres role has to be provisioned, rotated, or accidentally over-granted for n8n specifically.
- Writing this decision down now, ahead of n8n's own implementation, is what turns a future "just give n8n `DATABASE_URL` this once" shortcut into a deliberate, visible reversal of a committed decision rather than a silent drift.

## Implementation Status

- **Implemented (M1.7)**: the `api_keys` schema (hashed keys, `key_prefix`, `scopes`, revocation) and its issuance/isolation foundation — `packages/database/scripts/issue-api-key.mjs` (human-run, `DATABASE_URL`-direct, never reachable from `apps/web`), proven by `packages/database/tests/api-key-issuance-isolation.test.ts`.
- **Documented architectural decision, not yet exercised by real traffic**: that n8n specifically will use this same primitive against the app's own API boundary, never direct Postgres access — this ADR.
- **Deferred to Phase 3**: the actual n8n workflows (`06-n8n-Workflow-Architecture.md`), the `/api/v1/api-keys` route, and Bearer-token request authentication — `resolveRequestContext()` only resolves session auth today (`04-API-Architecture.md` §2.3). This ADR constrains what that future work must satisfy; it does not build it.
