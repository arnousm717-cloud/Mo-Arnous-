# ADR-005: Agency-Level Membership Model

**Status**: Accepted, implemented in M1.4 (foundation)
**Context**: `03-Database-Architecture.md` §2.1, §5, §6; `12-Implementation-Milestones.md` M1.4; `13-Technical-Design-Review.md` M1.4

## Decision

Extend the existing `memberships` table rather than inventing a parallel structure or a fake organization:

- `memberships.organization_id` becomes **nullable**.
- `memberships.agency_id` (new column) is **nullable**, `references public.agencies (id) on delete cascade`.
- A `CHECK` constraint enforces **exactly one scope per row**: `organization_id IS NOT NULL` XOR `agency_id IS NOT NULL` — never both, never neither.
- Organization-level roles (`org_admin`, `org_member`, `org_viewer`, `portal_customer`) continue to use `organization_id`, exactly as built in M1.2/M1.3, unchanged.
- Agency-level roles (`agency_owner`, `agency_admin`) use `agency_id` instead.
- A single user may hold **both** an agency-level row and one or more organization-level rows simultaneously — these are independent memberships, not a hierarchy collapsed into one row.

## Rationale

`current_agency()`'s own comment (M1.2, `20260714093501_create_tenant_context_functions.sql`) already deferred this exact question: *"Resolution logic for which agency a request acts on behalf of is an API-middleware concern, built in M1.4."* Three options were considered.

1. **A — implicit "home organization" for the agency itself** (rejected). Every agency signup would create both an `agencies` row and a fake internal `organizations` row solely so the owner has something to hold a `memberships.organization_id` row against. Rejected because it contradicts the schema's own stated intent: `roles.description` for `agency_owner`/`agency_admin` explicitly says "Agency-wide... all client orgs" — not scoped to one organization. A fake org would appear in every org count, every org listing, and every place that assumes `organizations` rows represent real tenants, permanently.
2. **B — a separate `agency_memberships` table**, parallel in shape to `memberships` (rejected, but closest runner-up). Cleanly separates the two concerns, but duplicates the entire shape of `memberships` (user/role/status/timestamps) for no structural gain, and requires its own RLS pattern, its own resolution function, and its own set of tests essentially mirroring the existing ones — two tables to keep in sync conceptually forever, for a distinction (org-scoped vs. agency-scoped) that a single nullable-pair CHECK constraint already expresses cleanly.
3. **C — extend `memberships` with nullable `organization_id`/`agency_id` and an exactly-one-scope CHECK** (chosen). One table, one RLS pattern to reason about, one place `role_id` is joined from. The `roles` table already treats agency-wide and org-scoped roles as members of the same enum-like set (`roles.key check (key in (...))` lists all six together) — this option is the schema-level mirror of that existing decision, not a new one.

## The exactly-one-scope invariant

```sql
alter table public.memberships
  add constraint memberships_exactly_one_scope
  check (
    (organization_id is not null and agency_id is null)
    or
    (organization_id is null and agency_id is not null)
  );
```

This is enforced at the database level, not in application code — the same reasoning as every other tenant-isolation guarantee in this project (`08-Security.md` §2: RLS as defense-in-depth beneath the app layer, never trusted as the sole control). A membership row can never be ambiguously "about" both an organization and an agency at once, and can never be a dangling row that resolves to neither. `unique (user_id, organization_id)` (existing, M1.2) and a new `unique (user_id, agency_id)` together prevent duplicate rows within each scope — Postgres treats `NULL` as distinct from `NULL` in unique constraints, so an org-scoped row (`agency_id null`) never collides with the agency-uniqueness constraint, and vice versa.

## Resolving a user with both an agency-level and an organization-level row

The two contexts are resolved by **two separate, independent functions**, not one overloaded one:

- **`get_my_membership_context()`** (existing, unchanged) resolves organization context via `users.default_organization_id` joined to the matching `organization_id` membership row. Because agency-scoped rows have `organization_id IS NULL`, they can never satisfy this function's join condition (`m.organization_id = o.id`) — the function required **zero code changes** for this ADR to take effect; the schema change alone makes it correctly ignore agency-scoped rows.
- **`get_my_agency_context()`** (new) resolves agency context by querying `memberships` directly for rows where `agency_id is not null`, scoped internally to `auth.uid()` — the same SECURITY DEFINER, no-client-supplied-parameter pattern ADR-003 established for `create_organization_with_owner()` and M1.3 reused for `get_my_membership_context()` itself (the RLS chicken-and-egg problem is identical: resolving `current_agency()` requires reading `memberships`, but reading `memberships` under RLS requires `current_agency()` to already be set).

A user with both kinds of row gets both contexts resolved correctly and independently — calling both functions returns the organization context and the agency context each on their own terms, with no precedence rule needed because they answer different questions ("what org am I acting in right now" vs. "what agency do I belong to"), not competing answers to the same one.

## `default_organization_id` for a pure agency user

Unchanged, and deliberately not extended with a symmetric `default_agency_id` in this foundation pass. A pure agency-level user (an `agency_owner`/`agency_admin` with no organization-level membership row at all) has `default_organization_id = NULL`, exactly as any user with no org membership already behaves — `get_my_membership_context()` returns zero rows for them, which is the existing, already-correct "route to onboarding, not an error page" behavior documented on that function. `get_my_agency_context()` is what resolves their actual identity. No new column was needed because a user's agency membership, unlike organization membership, isn't expected to be one-of-many requiring a stored default in this milestone — if that changes later (a person belonging to multiple agencies), it's a additive column, not a redesign.

## Why agency rollup access must not broaden base-table RLS

Out of scope for this foundation checkpoint (the rollup view itself is a later M1.4 step), but the invariant this ADR establishes is what makes the rollup pattern safe when it's built: `agency_rollup_*` views (per `03-Database-Architecture.md` §5's existing `agency_rollup_deals` example) read `organizations`/child data filtered by `organizations.agency_id = current_agency()`, as a **separate, named, auditable view** — never by loosening `organizations`' own `organization_id = current_org()` policy to also accept an agency match. The exactly-one-scope invariant is precisely what makes `current_agency()` a trustworthy value to filter a rollup view by: it can only ever have been set from a real agency-level membership row, never smuggled in through an organization-scoped one.

## Consequences

- `memberships` remains the single source of truth for both organization and agency identity — no second membership table to keep schema, RLS, and tests in sync with.
- Every existing M1.2/M1.3 test that touches `memberships` must be re-verified after this migration, since it alters the most load-bearing table in the schema (`organization_id` losing its `NOT NULL` constraint is a real behavioral change, even though the existing functions/policies are unaffected by construction).
- `memberships`' existing RLS policies (`organization_id = current_org()`) are left unchanged in this pass — they already correctly exclude agency-scoped rows (a `NULL` never equals `current_org()`), so ordinary authenticated access to agency-scoped rows remains structurally impossible until a deliberate policy is added for it later, the same safe-default-absence pattern already used for `agencies` itself since M1.2.

## Agency deletion behavior

Explicit, deliberate, and asymmetric between the two things an agency owns — stated here because it was previously only implicit in two different foreign keys' `ON DELETE` clauses (`organizations.agency_id`, from M1.2; `memberships.agency_id`, from this ADR) and nobody had written the resulting behavior down as a decision until a security review of the M1.4 backend checkpoint surfaced it:

- **Deleting an agency does NOT delete its client organizations.** `organizations.agency_id references public.agencies (id) on delete set null` (M1.2, unchanged). A deleted agency's client organizations survive intact — all their data, users, and memberships untouched — and simply become standalone organizations with `agency_id = NULL`, indistinguishable from an organization that was never under an agency at all.
- **Deleting an agency DOES delete its agency-level memberships.** `memberships.agency_id references public.agencies (id) on delete cascade` (this ADR). The agency's own `agency_owner`/`agency_admin` staff lose those membership rows immediately — there is nothing left for them to be staff *of*.

**Rationale**: tenant data is precious and must never be casually destroyed as a side effect of an unrelated business-relationship change. An agency relationship ending (the reseller contract lapses, the agency account is closed, an admin fat-fingers a delete) is a fact about the *reseller*, not a fact about the *client organizations* — a client org's contacts, deals, and history don't stop being real data because the agency managing them went away. Cascading that deletion down into every client organization's data would turn a business-layer event into a data-loss incident. The agency's own internal staff memberships, by contrast, have no meaning independent of the agency — there is no "orphaned" state for an `agency_owner` row to sensibly fall back to the way an organization can fall back to being standalone, so cascading those is correct, not merely convenient.

**Consequence worth stating plainly**: after an agency is deleted, its former client organizations are fully functional, ordinary standalone organizations — they keep their own `org_admin`/`org_member`/etc. memberships (organization-scoped rows are untouched by this at all, per the `memberships_exactly_one_scope` invariant keeping the two kinds of row structurally independent), keep all their data, and simply lose the `brand_themes`-inherited agency branding (falling back to the platform default theme — see the theme resolution work this ADR's model was built to support). Nothing about this requires new code to be correct; it falls directly out of the two FK behaviors already in place. This is stated here as a recorded product decision, not merely an incidental fact about foreign keys, so a future change to either `ON DELETE` clause is a deliberate ADR-level decision, not an accidental schema edit.
