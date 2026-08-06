# ADR-003: Shared-Schema RLS Over Schema/Database-Per-Tenant

**Status**: Accepted, implemented in M1.2
**Context**: `03-Database-Architecture.md` §5-§6

## Decision

Multi-tenancy is implemented as a single shared Postgres schema with Row Level Security, keyed on `organization_id`, rather than schema-per-tenant or database-per-tenant isolation. A two-level tenancy hierarchy (`agencies` → `organizations`) is layered on top.

## Rationale

Shared-schema RLS is a proven pattern at scale (thousands of tenants on one Postgres instance), avoids per-tenant migration/provisioning overhead, and fits a solo-founder-paced team's operational capacity far better than schema-per-tenant or database-per-tenant would. The escape hatch for a future large enterprise tenant needing dedicated infrastructure is documented (`03-Database-Architecture.md` §6) but not built until a real tenant needs it.

## Implementation Findings (M1.2)

Three things were discovered only once this was actually built and tested against a real Postgres instance — not visible from the design alone:

1. **`current_role()` renamed to `current_role_key()`.** The documented function name collided with PostgreSQL's own SQL-standard `CURRENT_ROLE` construct. Naming-only correctness fix; `03-Database-Architecture.md` updated to match.

2. **Base table grants are required in addition to RLS policies.** Tables created via SQL migrations do not automatically receive `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants for the `authenticated`/`anon` Postgres roles PostgREST uses — only tables created through Supabase Studio's Table Editor get this automatically. Without explicit `GRANT` statements, every request would fail with "permission denied for table ..." before RLS is ever evaluated, regardless of how correct the policies are. This was caught by the RLS isolation test suite failing with a permission error on the very first real query — exactly the value of testing against a real database rather than reasoning about policies in the abstract. The migration now grants base table privileges explicitly, with RLS remaining the actual row-level enforcement layer beneath that.

3. **`INSERT ... RETURNING` requires the `SELECT` policy to also pass for the returned row.** This surfaced while testing the organization-creation bootstrapping case (a brand-new user creating their first organization, before any `current_org()` context can exist for that not-yet-created row). A plain client-issued `INSERT ... RETURNING id` fails RLS on the implicit read-back, even though the `INSERT` policy itself correctly allows the write. **Consequence for M1.3**: the atomic three-way signup transaction (user + organization + first membership) cannot be a plain client-issued `INSERT`. It needs a `SECURITY DEFINER` Postgres function that performs the creation in a privileged context and returns the new IDs directly, rather than relying on RLS-constrained `RETURNING`. Flagged here so it isn't rediscovered mid-M1.3.

## Verification

- RLS isolation test suite (`packages/database/tests/rls-isolation.test.ts`), 14 tests, run against a real local Postgres instance (Supabase CLI), covering cross-org read/write denial, self-scoping on `users`, the bootstrapping `INSERT` case, and the tenant-context functions' null-by-default and no-leak-across-requests behavior.
- Supavisor pooling-behavior spike (`packages/database/scripts/pooling-spike.mjs`), run against the real Supabase Cloud dev project's transaction-mode pooler (not local Docker, which doesn't run Supavisor): 100/100 simulated alternating requests confirmed correct, 0 context leaks — the specific condition required before this milestone could be marked closed (`docs/13-Technical-Design-Review.md` M1.2).

## Consequences

- Every future tenant-scoped table must ship its RLS policy *and* its base grants in the same migration — documented as a rule in `10-CLAUDE.md` §2, `08-Security.md`.
- Any operation needing to read back a just-created row across an RLS boundary (not just organization creation) should default to a `SECURITY DEFINER` function, not a plain `INSERT ... RETURNING`, unless the row is guaranteed already visible under the caller's existing tenant context.
