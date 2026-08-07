# ADR-004: Direct Postgres Data Access Over PostgREST for Internal App Queries

**Status**: Accepted, implemented in M1.3
**Context**: `03-Database-Architecture.md` §5, ADR-003

## Decision

The app's own backend (Server Actions, Route Handlers in `apps/web`) queries tenant data through a **direct Postgres connection** (via `packages/database`'s query layer), not through Supabase's standard client (`supabase-js` → PostgREST). Supabase Auth (GoTrue) remains the authentication mechanism regardless — this decision is scoped to *data* access, not identity.

## Rationale

`03-Database-Architecture.md` §5 specifies the tenant-context mechanism as `set_config('app.current_org', ..., true)`, populated by API middleware at the start of every request — validated end-to-end in M1.2 (RLS isolation suite, Supavisor pooling spike). PostgREST has no visibility into this custom session variable: it automatically forwards standard JWT claims (which is how `auth.uid()`/`auth.role()` work), but has no built-in mechanism for app-specific session state like `app.current_org`.

Two ways to reconcile this were considered:

1. **Direct Postgres connection, own middleware sets the session variable** (chosen). The app's own code controls the connection and the transaction boundary, so `set_config(..., true)` and the subsequent query are guaranteed to run together, exactly as already proven in M1.2.
2. **Embed `organization_id` in the JWT via a Supabase Auth Hook, keep using PostgREST.** Rejected: this reintroduces the exact staleness problem `03-Database-Architecture.md` §5 was explicitly designed to avoid — an agency user switching organizations would need a JWT refresh to take effect, not the next request.

## Consequences

- `packages/database` gains a real query layer (a `pg` connection pool plus a `withTenantContext`-style helper), not just migrations — the same pattern already built and tested for M1.2's RLS suite, now used by the actual application, not just tests.
- Connection pooling to Postgres must go through Supavisor in every real environment (dev/staging/prod), the same pooler already validated — direct-to-Postgres connections from serverless functions at any real traffic volume would exhaust the connection limit (`02-Software-Architecture.md` §2).
- Supabase's REST API (PostgREST) is still available and still the mechanism any *external* integrator or n8n workflow uses (`04-API-Architecture.md` §8) — this decision only concerns the app's own internal data access, not the public API surface.
- Row Level Security remains fully in effect either way — this is a decision about which client establishes the Postgres session, not about relaxing RLS. Queries still run as the `authenticated` Postgres role with the same session-scoped tenant context, just set directly by our own code instead of relying on PostgREST to forward it.
