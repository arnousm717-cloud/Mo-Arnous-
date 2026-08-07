# Runbook: `auth.users` / `public.users` Reconciliation

Required by `docs/13-Technical-Design-Review.md` M1.3 (Disaster Recovery risk #15). Referenced from `docs/08-Security.md` §9.

## Why this can (in principle) diverge

`public.users` is kept in sync with Supabase Auth's `auth.users` by a single mechanism: the `handle_new_auth_user()` trigger (migration `20260806100250_sync_auth_users_to_public.sql`), which fires `after insert on auth.users` and creates the matching `public.users` row in the same transaction as GoTrue's own insert. If the trigger raises, GoTrue's insert rolls back too — there is no code path today that inserts one row without the other.

`public.users.id` also has `references auth.users (id) on delete cascade`, so deleting an `auth.users` row (e.g. via `supabase.auth.admin.deleteUser`) always cascades to `public.users` and, transitively, to `public.memberships`.

Given both of these, the two tables cannot diverge through normal application traffic. Divergence is only possible via **manual/administrative intervention that bypasses the trigger or the FK** — for example:

- A row inserted into `public.users` directly (Studio SQL editor, a manual migration, a script) without a corresponding `auth.users` row.
- The `on_auth_user_created` trigger dropped or altered (e.g. during a future migration) without the change being caught in review.
- A `public.users` row deleted directly while its `auth.users` row remains (the FK enforces the reverse — auth.users deletion always cascades — but nothing stops a direct `delete from public.users`).

## Detection

Run against the target environment (never against local/dev credentials in this file):

```sql
-- auth.users rows with no matching public.users row (should always be empty)
select au.id, au.email, au.created_at
from auth.users au
left join public.users pu on pu.id = au.id
where pu.id is null;
```

A `public.users` row with no matching `auth.users` row is not separately checkable via SQL — the FK (`on delete cascade`) makes it structurally impossible while the constraint exists. If that FK is ever found to be missing (e.g. after a hand-edited migration), that is itself the incident: restore the FK before doing anything else.

## Remediation

**Case: `auth.users` row exists, `public.users` row missing.**

1. Confirm this is genuinely orphaned (not a signup mid-flight — `create_organization_with_owner` runs after the trigger, so a user can legitimately exist with no organization yet, but `public.users` itself should never be missing for more than the duration of one transaction).
2. Backfill the missing row directly, mirroring exactly what the trigger would have inserted:
   ```sql
   insert into public.users (id, email, full_name, avatar_url)
   select id, email, raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'avatar_url'
   from auth.users where id = '<uuid>';
   ```
3. Record the incident (cause, affected user id, remediation timestamp) in the audit trail per `docs/08-Security.md` §6 — this is exactly the kind of before/after state that table exists to capture.
4. Root-cause it: this should never happen given the trigger's atomicity guarantee, so treat every occurrence as a signal something else bypassed normal insert paths (a migration, a manual Studio edit, a platform-level Auth operation) and identify what.

**Case: the `on_auth_user_created` trigger or `handle_new_auth_user()` function is missing entirely** (e.g. accidentally dropped by a later migration).

1. This is the highest-priority variant — every new signup from this point silently produces an `auth.users` row with no `public.users` row, breaking `get_my_membership_context()` and the rest of the tenancy model for every new user.
2. Re-apply migration `20260806100250_sync_auth_users_to_public.sql` (or the current equivalent) immediately.
3. Run the detection query above to find and backfill every user who signed up during the gap.

## Prevention

- The trigger and the FK are both covered by `packages/database/tests/signup-flow.test.ts` ("the auth.users trigger creates a matching public.users row") — a regression that breaks the sync is caught in CI, not just in production.
- Any future migration touching `auth.users`, `public.users`, `on_auth_user_created`, or `handle_new_auth_user()` should re-run that test suite locally before merging, given how load-bearing this single trigger is for the rest of the tenancy model.
