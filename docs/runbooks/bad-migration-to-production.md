# Runbook: Bad Migration Reached Production

Required by `docs/13-Technical-Design-Review.md` M1.9 (Disaster Recovery risk #15). Referenced from `docs/08-Security.md` §9.

## Purpose / when to use this runbook

CI's migration-safety gate (`packages/database/scripts/check-migration-safety.mjs`) blocking a destructive migration before merge is **not** a production incident — that is the gate working as designed. This runbook begins only when a migration has actually reached Production, or there is credible evidence that it has (an unexpected `supabase migration list --linked` entry, an error spike after a known deploy window, a tenant report of missing or wrong data).

## Why this can still happen

The migration-safety gate is real prevention, not a guarantee. It cannot catch:

- Semantically destructive SQL outside its detection grammar (e.g. a mass `UPDATE` with an incorrect `WHERE`, or any statement that doesn't match its known destructive-keyword set).
- A destructive migration carrying a technically-valid override (`-- migration-safety: destructive-override` + a non-empty reason) that turns out, on reflection, to have targeted the wrong thing.
- Out-of-band SQL — anything run directly (Studio SQL editor, an ad hoc script) that never went through a migration file or CI at all.
- A wrong-environment or otherwise operational mistake during the manual `supabase db push --linked` step itself — the gate only inspects file content, never which project a human pointed the CLI at.

None of this weakens the gate — it still stops the dominant, obvious "someone forgot a `WHERE` clause" class of incident before merge. This runbook exists for what's left over.

## Severity model

- **Sev A** — schema-only, no confirmed data loss.
- **Sev B** — bounded data loss (a specific table/column, a scoped operation).
- **Sev C** — broad data loss (`TRUNCATE`, `DROP TABLE`, an unconditional `DELETE`, or equivalent).
- **Sev D** — a wrong-environment action (the operator believed they were targeting staging and targeted production, or vice versa) — treated as top priority regardless of what SQL ran, because it means the one safeguard this runbook depends on (§ Containment) failed.

## Detection

Investigate when any of the following appear: `/api/v1/health` or application error-rate/Sentry alerts spiking shortly after a known deploy or migration window (`docs/08-Security.md` §7's structured logger, M1.8); a manual `supabase migration list --linked` (against the correctly re-verified project — see Containment) showing a migration applied that wasn't expected; a tenant/support report of missing or incorrect data.

Preserve, before doing anything else:

- The offending migration's exact filename and its full content (already in git).
- The commit SHA that introduced it.
- The detection timestamp.
- The timestamp `supabase migration list --linked` reports for when the migration actually applied.
- Any relevant Sentry/Vercel Runtime Log entries around that window.

## Containment

1. Stop further production migrations and any unnecessary follow-up deploy that could compound the incident — do not layer more change onto an unassessed state.
2. **Re-verify the linked Supabase project before running any `--linked` command** — read `packages/database/supabase/.temp/project-ref` and, where useful, `packages/database/supabase/.temp/linked-project.json`'s `name` field, and confirm it matches the environment you actually intend to act on. Do this every single time, including here, especially here — urgency during an incident is exactly when this step is most likely to be skipped and most likely to matter. Never hardcode or paste a production credential/connection string anywhere, including into this runbook, a chat message, or a log.
3. Identify the offending migration and its commit SHA from git — never from memory.
4. Do **not** rush a second migration before Assessment is done. A hurried, unassessed fix is how a Sev A becomes a Sev C.

## Assessment

Determine, from evidence, not assumption:

- Schema-only vs data-affecting — read the migration's actual SQL.
- Exact affected table(s)/column(s).
- The migration's applied timestamp (`supabase migration list --linked`).
- Whether application writes continued after the bad migration applied — every write since is potentially built on the corrupted state.
- Estimated blast radius (one tenant vs many, one table vs several).
- Whether tenant isolation / RLS / grants were themselves affected by the migration (not just ordinary tenant data).
- Whether the deployed application and the current schema are now incompatible (see Application/Schema Incompatibility below).

## Recovery decision tree

**A — Schema-only / no confirmed data loss** → prefer a forward-fix migration (see below).

**B — Bounded data loss** → determine whether the lost data can be reconstructed from a verified source (e.g. the `events` outbox table, if the lost data happens to overlap with an event type already emitted — narrow, not a general recovery mechanism, `docs/03-Database-Architecture.md` §2.10). If reconstruction isn't possible and a backup/PITR-based restore looks necessary, **STOP and perform the Backup / PITR safety checkpoint below before taking any restore action.**

**C — Broad data loss** → do not improvise. **STOP and confirm actual backup/PITR capability and available recovery points (see below) before any restore action.**

**D — Wrong environment** → stop immediately. Positively re-identify both the environment you intended to act on and the one you actually acted on (§ Containment step 2). Treat any unintended change made to the second environment as its own, separate incident — restart Assessment for it.

## Forward-fix strategy

This repository treats migrations as append-only history (e.g. `20260810100200_fix_membership_invited_by_cascade.sql` is a real precedent — a prior mistake was corrected with a *new* migration, never by editing or deleting the old one). Recovery follows the same convention: write a **new** corrective migration, never rewrite or delete the offending one, and never delete or hand-edit a migration-history/tracking table as a shortcut.

The corrective migration is not exempt from normal process — it still goes through review, the migration-safety CI gate, and the same manual `supabase db push --linked` procedure as any other migration. If the corrective migration is itself legitimately destructive (e.g. a compensating `DELETE` to remove rows the bad migration incorrectly inserted), use the existing override mechanism with a real, specific, non-empty reason — do not bypass, disable, or work around the gate under time pressure. The gate is part of the recovery's safety net, not an obstacle to route around.

## Backup / PITR — verify before use

**UNVERIFIED — MUST CONFIRM IN SUPABASE DASHBOARD BEFORE USE.**

`docs/08-Security.md` §8 describes automated daily backups and point-in-time recovery (PITR) as a **target**: *"Supabase automated daily backups with point-in-time recovery (PITR) enabled once on a plan that supports it."* That is conditional, forward-looking language. It does **not** prove:

- That backups or PITR are currently active on the affected project.
- Which recovery points, if any, currently exist.
- That a restore has ever actually been drilled and confirmed to work (§8 also states restore-drill verification is "initially manual" — no record of one having been performed exists in this repository).

Before any backup/PITR-based recovery action:

1. Confirm the affected Supabase project (Containment step 2).
2. Inspect that project's actual backup/recovery configuration directly in the Supabase dashboard.
3. Confirm what recovery points actually exist.
4. Confirm what restore mechanism the project's current plan actually supports.
5. Only then choose a restore strategy.

If Supabase currently provides a restore-to-separate-environment/copy mechanism for this project, prefer inspecting a restored copy before replacing or overwriting the affected live state — but that availability must be confirmed in the dashboard first, not assumed from this document. This runbook does not assert that any specific Supabase recovery feature, dashboard button, or CLI command exists beyond what's already used elsewhere in this repository (`supabase link`, `supabase migration list --linked`, `supabase db push --linked`).

## Partially applied migrations

Be precise about what this repository's evidence actually supports. All migrations currently in `packages/database/supabase/migrations/` are plain transactional DDL — none use a non-transaction-safe statement such as `CREATE INDEX CONCURRENTLY` (verified against every file during the M1.9 migration-safety audit). Supabase's migration runner applies each migration file inside its own transaction, so for the migrations that exist today, a single file either fully applies or fully rolls back — it does not leave a half-applied file. This must be re-checked the moment any future migration introduces a non-transactional statement; do not assume it holds indefinitely.

The more realistic "partial" scenario is a **batch**: `supabase db push --linked` applying several pending migrations in sequence, with an earlier one committing before a later one fails. This is not corruption — the migration-tracking table correctly reflects "earlier ones applied, the failing one and anything after it did not." Recovery is to understand the actual applied state (`supabase migration list --linked`), fix whatever caused the failing migration to fail, and continue forward — never to hand-edit the tracking table as a shortcut.

## Application / schema incompatibility

If a migration applies cleanly but the currently-deployed application code assumes the schema *before* the change (e.g. a rename applied before the matching code deploy went out), this is not automatically a database problem. Determine which side is actually authoritative before acting: if the new schema is correct and the application simply hasn't caught up, the fix is usually to expedite the matching application deploy — not to revert the migration, which can make things worse if any new code already depends on it. If the migration itself was the mistake, address it via a forward-fix migration (above), not a database rollback.

## Tenant / RLS / security validation

Post-recovery validation must explicitly confirm tenant isolation wasn't affected, not just that data is present. As appropriate to the incident: expected RLS policies are still in place; expected grants/revocations are unchanged (no new access `authenticated`/`anon` shouldn't have); tenant membership resolution (`get_my_membership_context()`) still resolves correctly; cross-tenant isolation holds; organization/membership relationships are intact.

Do not casually run a security/isolation test suite directly against live Production — this repository's existing suites (`rls-isolation.test.ts`, `rls-cross-tenant.test.ts`, `default-acl-hardening.test.ts`, `table-privilege-hardening.test.ts`) default to a local database via `DATABASE_URL ??=` and would require deliberately overriding `DATABASE_URL` to point at a real project to run elsewhere; their safety against a live production database has not been proven. Prefer running them, if needed, against a restored/staging copy. Against production itself, prefer known-safe, read-only checks — the same two spot-checks already proven once in this project's real history (M1.9.1 Phase D): confirming `TRUNCATE` is denied for the `authenticated` role, and confirming an anonymous `INSERT` via `agency_rollup_organizations` is denied.

## Post-recovery validation

Do not declare recovery successful from a single green health check alone. Confirm, together:

- `/api/v1/health` returns 200.
- A basic application smoke test (a real login/dashboard load against the affected environment, per the same pattern used for M1.3/M1.9.1 live verification in this project).
- Sentry/Vercel Runtime Logs reviewed for the post-recovery window — no new error class introduced by the fix itself.
- `supabase migration list --linked` shows the expected migration set applied, including the corrective one.
- The specific affected schema/data is confirmed correct, not just "no errors."
- Tenant/RLS validation (above) completed.
- The environment acted on is reconfirmed to be the one that was actually affected (Containment step 2, one more time).
- Monitoring continues for a reasonable window after recovery, not just an immediate check.

## Incident record

Record, without ever including a secret or a complete credential/connection string:

- Incident timestamp and detection timestamp.
- The offending migration's filename and commit SHA.
- Affected environment.
- Severity classification and its basis.
- Estimated blast radius.
- Every command/action actually performed during containment and recovery.
- The recovery decision made and why.
- The corrective migration's filename, if one was used.
- Post-recovery validation evidence.
- Final outcome.
- Root cause, in plain language.

## Prevention follow-up

- If the migration-safety classifier missed the pattern that caused this: add a regression test to `packages/database/tests/migration-safety.test.ts` for that specific pattern, and improve the rule if appropriate — matching this project's own precedent (the `REVOKE TRUNCATE` false-positive fix, which shipped with its own dedicated regression test).
- If a technically-valid override allowed the incident through: review the override/review process, not the classifier.
- If out-of-band SQL caused it: address the operational bypass directly — how did a change reach production without going through a migration file and CI at all.
- If wrong-environment targeting caused it: strengthen the environment-verification step itself (Containment step 2) — this is the exact class of risk M1.9's environment-separation work this session was built to reduce, and a wrong-environment migration incident is direct evidence that reduction needs to go further.
- If backups/PITR were found unavailable or unverified during a real incident: record that explicitly as an open operational gap requiring follow-up — never fold it quietly back into `docs/08-Security.md`'s aspirational language.
