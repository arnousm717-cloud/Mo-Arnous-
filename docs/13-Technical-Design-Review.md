# 13 — Technical Design Review (Phase 1 Gate)

Reviewed as a joint engineering leadership panel — the standards Stripe (correctness, reversibility), Linear (craft, no half-measures), OpenAI (safety of anything agentic, even the infrastructure it'll later run on), Vercel (deploy/runtime realities), and Microsoft (enterprise-grade operational rigor) would each hold this to. Scope: the 9 milestones of Phase 1 (`12-Implementation-Milestones.md`). No production code is written in this document — this is the last gate before M1.1 starts.

**How to read this**: each milestone gets a 15-category risk table, then seven required-for-done sections, then a GO/NO-GO verdict. A "GO" with a condition means implementation may proceed, but the milestone is not considered *complete* until that condition is met — it is not a blocker to starting Phase 1 overall, it is a bar for closing that specific milestone.

---

## M1.1 — Repo & Environment Bootstrap

| # | Category | Assessment |
|---|---|---|
| 1 | Engineering risk | Low. Real risk is unpinned tool versions (Node/pnpm/Turborepo) causing drift across sessions — pin them now. |
| 2 | Architecture risk | None exercised yet; risk is silently wrong Next.js runtime defaults propagating into every later milestone unnoticed. |
| 3 | Database risk | None yet; risk is migration tooling misconfigured against the wrong Supabase project, only discovered at M1.2. |
| 4 | AI risk | None. |
| 5 | Security risk | Confirm env-var/secret scoping between staging/prod now, and sanity-check default Supabase anon-key exposure scope. |
| 6 | Performance risk | None — no real traffic. |
| 7 | Scalability risk | None. |
| 8 | Cost risk | Minimal; risk is over- or under-provisioning a plan tier before real usage data exists. |
| 9 | DevOps risk | The real risk here: CI secrets misconfigured (false-green builds) or branch→environment mapping wrong (preview pointing at prod). |
| 10 | Testing strategy | Smoke test only — correct scope for this milestone, but do not skip it. |
| 11 | Rollback strategy | Trivial (Vercel instant rollback) — establish it as muscle memory now. |
| 12 | Migration strategy | N/A yet; decide migration safety rails now, not retrofitted later. |
| 13 | Monitoring strategy | Intentionally deferred to M1.8 — explicit deferral, not an oversight. |
| 14 | Observability strategy | Same intentional deferral. |
| 15 | Disaster recovery | N/A; confirm Supabase backup defaults are enabled at project creation (zero cost to do now). |

- **Prerequisites**: None (first milestone).
- **Success criteria**: `/api/v1/health` returns 200 in all three environments; CI green on a trivial PR.
- **Exit criteria**: All environments deployed and reachable; CI blocks merge on lint/typecheck/build failure; a fresh clone can run locally from the README alone, verified by actually doing it.
- **Required documentation**: `apps/web/README.md`, `packages/database/README.md`.
- **Required tests**: CI smoke test; post-deploy health-check ping per environment.
- **Manual QA checklist**: [ ] Fresh clone runs locally with no tribal knowledge [ ] Staging/prod URLs resolve [ ] PR triggers a preview deploy.
- **Automated QA checklist**: [ ] CI lint/typecheck/build gate [ ] Automated health-check ping per environment post-deploy.
- **GO / NO-GO: GO.**

---

## M1.2 — Core Tenancy Schema + RLS + Tenant-Context Mechanism

The highest-stakes milestone in Phase 1 — every later milestone's security posture depends on this one being right.

| # | Category | Assessment |
|---|---|---|
| 1 | Engineering risk | Getting `set_config(..., true)` semantics subtly wrong (e.g., `is_local=false`) could leak tenant context across pooled connections — severe, hard-to-detect bug class. |
| 2 | Architecture risk | **The single unverified assumption flagged in the architecture review**: does transaction-local `set_config` behave correctly under Supavisor's transaction-mode pooling? Must be spiked and proven, not assumed. |
| 3 | Database risk | RLS policy bugs are the most dangerous bug class on this entire platform — a missing clause or a policy on the wrong table silently leaks cross-tenant data. |
| 4 | AI risk | None yet. |
| 5 | Security risk | This milestone **is** the security foundation — a defect here undermines every claim in `08-Security.md`. Highest security risk in Phase 1. |
| 6 | Performance risk | `security definer` function calls on every row access have real per-query overhead — needs a baseline check, not premature optimization. |
| 7 | Scalability risk | Shared-schema RLS is a proven pattern at scale; the actual scalability-adjacent risk is the pooling interaction in #2. |
| 8 | Cost risk | None significant at this stage. |
| 9 | DevOps risk | RLS must be enabled in the *same* migration as table creation — never a follow-up migration that leaves a window where a table exists unprotected. |
| 10 | Testing strategy | RLS isolation tests are the actual gate for this platform, run against a real Postgres instance — never mocked. |
| 11 | Rollback strategy | Down-migrations for RLS-enabled tables must be scripted and tested, not assumed reversible. |
| 12 | Migration strategy | This milestone sets the precedent: additive-only forward migrations, reviewed before merge, no manual production hotfixes. |
| 13 | Monitoring strategy | Instrument `set_config` failures now even though full monitoring lands in M1.8 — cheap to log from day one. |
| 14 | Observability strategy | Same — build with future instrumentation points in mind. |
| 15 | Disaster recovery | N/A yet — no real tenant data exists. |

- **Prerequisites**: M1.1 complete.
- **Success criteria**: RLS isolation suite passes 100%; tenant-context mechanism verified under Supavisor transaction-mode pooling specifically, not just direct connections.
- **Exit criteria**: Every tenant-scoped table has RLS + passing isolation tests; `current_org()`/`current_agency()`/`current_role()` unit-tested independent of any route handler.
- **Required documentation**: ADR-003 written as a real file.
- **Required tests**: RLS isolation suite; a dedicated pooling-behavior integration test (not a one-time manual spike — it must live in the permanent test suite).
- **Manual QA checklist**: [ ] Attempt a cross-org query via `psql` as a non-superuser role simulating each caller type, confirm denial [ ] Manually run the pooling spike and record the result in the PR.
- **Automated QA checklist**: [ ] CI-run RLS isolation suite on every PR touching `packages/database` [ ] Pooling-behavior test in the permanent CI suite.
- **GO / NO-GO: GO, conditional.** This milestone is not "done" until the Supavisor pooling-behavior spike has actually been run and passed — code review alone is not sufficient sign-off here.

---

## M1.3 — Auth & Signup Flow

| # | Category | Assessment |
|---|---|---|
| 1 | Engineering risk | The three-way write (users + organizations + memberships) must be one atomic transaction — a partial failure leaves an orphaned org with no admin. |
| 2 | Architecture risk | Low; risk is Supabase Auth's identity lifecycle drifting out of sync with the app's own `users` table without a clear reconciliation mechanism. |
| 3 | Database risk | FK integrity between `auth.users` and the app's `users` table must be enforced, not assumed. |
| 4 | AI risk | None. |
| 5 | Security risk | Password policy and session expiry/rotation must be an explicit, reviewed decision, not left at platform defaults; decide deliberately whether `org_admin` access requires email verification first. |
| 6 | Performance risk | None significant at this scale. |
| 7 | Scalability risk | None yet. |
| 8 | Cost risk | Auth MAU pricing tier implications — awareness note, not a blocker. |
| 9 | DevOps risk | Transactional email (verification, password reset) must be a real, tested dependency — a stubbed email step silently breaks signup for real users. |
| 10 | Testing strategy | The atomic-transaction partial-failure test matters more than the happy path here. |
| 11 | Rollback strategy | Supabase Auth config should be config-as-code, not manual dashboard changes that can't be diffed or reverted cleanly. |
| 12 | Migration strategy | None beyond M1.2's schema. |
| 13 | Monitoring strategy | Track signup funnel drop-off (verification not completed) from day one — this is literally the top of the business funnel. |
| 14 | Observability strategy | This milestone ships before M1.8's Sentry wiring lands — early errors here may go temporarily unobserved. Accepted, sequenced gap, not an oversight. |
| 15 | Disaster recovery | If Auth's identity store and the app's `users` table diverge, a reconciliation runbook is needed — document it even if not yet automated. |

- **Prerequisites**: M1.2 complete.
- **Success criteria**: Real signup → org → login round trip works in staging; the three-way write is provably atomic under failure injection.
- **Exit criteria**: A real (not stubbed) transactional email provider is wired and verified; session behavior matches `08-Security.md` §1.
- **Required documentation**: None new — confirm no drift from existing docs.
- **Required tests**: Atomic-transaction failure-injection test; session-expiry/refresh test.
- **Manual QA checklist**: [ ] Sign up with a real email, verify, log out, log back in [ ] Attempt signup with an already-used email, confirm clean error [ ] Interrupt the flow mid-way (close tab after auth, before org creation), confirm no orphaned state.
- **Automated QA checklist**: [ ] CI integration suite for signup/login/logout/refresh [ ] Chaos-style test killing the transaction mid-way, asserting full rollback.
- **GO / NO-GO: GO, conditional.** Not complete until a real transactional email provider (not a stub) is wired and verified end-to-end.

---

## M1.4 — Agency Hierarchy + Basic White-Label Theming

| # | Category | Assessment |
|---|---|---|
| 1 | Engineering risk | Three-layer theme-specificity resolution must be architected correctly now even with only 2 of 3 layers active, so adding the org-override layer later doesn't require rework. |
| 2 | Architecture risk | Low — closely matches `07-UI-UX-System.md` §2, a well-specified design. |
| 3 | Database risk | `brand_themes` unique-per-agency must be a DB constraint, not just app-layer logic, to prevent a race condition creating duplicate rows. |
| 4 | AI risk | None. |
| 5 | Security risk | Agency-scoped org listing must go through an explicit `agency_rollup_*`-style view or equivalent RLS policy — this is the first real exercise of that discipline and deserves extra scrutiny. |
| 6 | Performance risk | Server-side theme resolution adds a DB round-trip per request unless cached — worth a basic cache (keyed by agency, invalidated on update) now rather than deferred. |
| 7 | Scalability risk | None significant at this milestone's scale. |
| 8 | Cost risk | None. |
| 9 | DevOps risk | None beyond standard deploy risk. |
| 10 | Testing strategy | The contrast-validation auto-adjust fallback needs a test with a genuinely non-compliant color — a compliant-only test leaves the fallback path unverified. |
| 11 | Rollback strategy | Low-stakes, visual-only data — easy to revert. |
| 12 | Migration strategy | Straightforward additive migration. |
| 13 | Monitoring strategy | None specific beyond M1.8's general wiring. |
| 14 | Observability strategy | Same. |
| 15 | Disaster recovery | Low severity — branding data loss is easily recreated. |

- **Prerequisites**: M1.2, M1.3 complete.
- **Success criteria**: An agency creates 2+ client orgs, each correctly themed; org listing is provably scoped to the requesting agency only.
- **Exit criteria**: Contrast-validation fallback tested against a real failing color, not just a passing one; agency-scoped listing implemented as an explicit named mechanism.
- **Required documentation**: None new — confirm `07-UI-UX-System.md` §2 matches implementation.
- **Required tests**: Theme-resolution unit tests (all 3 layers, even with 1 dormant); RLS/roll-up test for agency-scoped listing.
- **Manual QA checklist**: [ ] Create an agency + 2 client orgs, confirm both inherit the theme [ ] As agency A, attempt to view agency B's orgs via direct API manipulation, confirm denial.
- **Automated QA checklist**: [ ] CI suite covering theme resolution and agency-scoped RLS.
- **GO / NO-GO: GO.**

---

## M1.5 — RBAC Enforcement

| # | Category | Assessment |
|---|---|---|
| 1 | Engineering risk | Biggest risk is inconsistent coverage — some routes wired through `can()`, others missed during the broad pass across every existing handler. A missed route is a silent security hole. |
| 2 | Architecture risk | Low — the facade pattern is simple and well-specified. |
| 3 | Database risk | None new. |
| 4 | AI risk | None yet, but this facade is what Phase 4's agent tool layer reuses — worth building generically enough now to avoid rework later. |
| 5 | Security risk | This milestone **is** a security control; the risk is exactly #1 — incomplete enforcement coverage. |
| 6 | Performance risk | Negligible per-request overhead. |
| 7 | Scalability risk | None. |
| 8 | Cost risk | None. |
| 9 | DevOps risk | None significant. |
| 10 | Testing strategy | Exhaustive role × action matrix testing, already the right approach. |
| 11 | Rollback strategy | Standard code rollback; no data migration involved. |
| 12 | Migration strategy | Permission-data population only. |
| 13 | Monitoring strategy | Log permission *denials* specifically from day one — a spike could indicate an attack or a UI bug; cheap to add now. |
| 14 | Observability strategy | Same. |
| 15 | Disaster recovery | N/A. |

- **Prerequisites**: M1.2, M1.3 complete.
- **Success criteria**: 100% of route handlers pass through `can()`, verified by an automated check, not a manual audit.
- **Exit criteria**: Full role × action matrix passes; an automated (even simple grep-based) check confirms no handler bypasses the facade.
- **Required documentation**: None new — confirm `08-Security.md` §3 matches.
- **Required tests**: Full permission-matrix suite; route-handler-coverage check.
- **Manual QA checklist**: [ ] Log in as each of the 6 roles, attempt every documented action, confirm expected allow/deny.
- **Automated QA checklist**: [ ] CI permission-matrix tests [ ] Route-handler coverage check.
- **GO / NO-GO: GO**, with the automated coverage check treated as part of this milestone's own exit criteria, not a nice-to-have.

---

## M1.6 — GDPR Primitives

| # | Category | Assessment |
|---|---|---|
| 1 | Engineering risk | Resist over-building a fully generic cascade framework for only 2 tables — extend later, per this platform's own "ship narrow" value. |
| 2 | Architecture risk | Low — well-specified in `08-Security.md`. |
| 3 | Database risk | The hard-delete/anonymize function must correctly distinguish which columns anonymize vs. which rows fully remove — getting this backwards is subtle and severe. |
| 4 | AI risk | None yet. |
| 5 | Security risk | This is the platform's core compliance guarantee — the highest correctness bar in this milestone. A DSR that appears to succeed but leaves recoverable data is a severe, hard-to-detect failure. |
| 6 | Performance risk | None at this scale. |
| 7 | Scalability risk | A cascade across dozens of tables (later phases) could become long-running — design it as an async/queued job now, mirroring the same lesson already learned for agent execution. |
| 8 | Cost risk | None. |
| 9 | DevOps risk | None significant. |
| 10 | Testing strategy | The critical test is direct database inspection post-DSR, not an API-level check — an API-level-only test could pass even if a soft-delete regression were reintroduced. |
| 11 | Rollback strategy | A DSR fulfillment must not be reversible by design — but the *code* must be safe to roll back if buggy; a dry-run/preview mode is worth adding given the severity of getting this wrong. |
| 12 | Migration strategy | Straightforward additive migration for the 4 tables. |
| 13 | Monitoring strategy | Wire the 30-day SLA-timer breach alerting now — cheap today, real regulatory risk if missed later. |
| 14 | Observability strategy | Verify audit-log completeness for every DSR lifecycle transition actually happens, not just that it's designed to. |
| 15 | Disaster recovery | No recovery exists once hard-deleted if the cascade has a bug — exactly why a dry-run/preview step is worth the extra effort now. |

- **Prerequisites**: M1.2, M1.3 complete.
- **Success criteria**: A DSR filed against a real test user results in verified, irreversible removal/anonymization, confirmed by direct database inspection.
- **Exit criteria**: A dry-run/preview mode is implemented for DSR execution (recommended scope addition); SLA-timer alerting is wired.
- **Required documentation**: None new — confirm `08-Security.md` §5 is now true rather than aspirational.
- **Required tests**: Hard-delete verification test (direct DB query); audit-log completeness test for every DSR transition; SLA-timer alert test.
- **Manual QA checklist**: [ ] File a DSR against a seeded test user, execute it, manually inspect the database directly (not through the app) to confirm actual removal.
- **Automated QA checklist**: [ ] CI suite covering cascade correctness and audit logging.
- **GO / NO-GO: GO, with a recommended scope addition.** Add a dry-run/preview step to DSR execution before this milestone closes — hard deletion is irreversible, and this is exactly the class of risk this review process exists to catch before it ships, not after.

---

## M1.7 — Platform Infrastructure (api_keys, events outbox)

| # | Category | Assessment |
|---|---|---|
| 1 | Engineering risk | Outbox idempotency keyed only on `event_id` (not `(event_id, consumer)`) would let one consumer's processing block another's — needs explicit multi-consumer test coverage even with only one consumer today. |
| 2 | Architecture risk | Low — well-specified Unit-of-Work pattern. |
| 3 | Database risk | `api_keys.key_hash` must never be logged or returned post-creation — real risk of accidental inclusion in an error message or debug log during development. |
| 4 | AI risk | None yet, though Phase 4's tool layer and Phase 3's n8n integration build directly on this schema — already validated against those future needs in the architecture review. |
| 5 | Security risk | Internal-only key issuance must be genuinely inaccessible from any tenant-facing surface — resist the "make it public for now, lock down later" shortcut. |
| 6 | Performance risk | Sanity-check outbox polling interval/backpressure under simulated load now — cheap to verify, expensive as a later incident. |
| 7 | Scalability risk | None significant yet — growth is tied only to internal test events at this stage. |
| 8 | Cost risk | None. |
| 9 | DevOps risk | None significant. |
| 10 | Testing strategy | Already well-specified (atomicity + idempotency) — good. |
| 11 | Rollback strategy | Standard. |
| 12 | Migration strategy | Straightforward additive. |
| 13 | Monitoring strategy | Dispatcher failure/backlog depth should be observable from day one — unbounded queue growth is an early warning worth catching now. |
| 14 | Observability strategy | Same. |
| 15 | Disaster recovery | A manual "drain the outbox backlog" runbook should exist even in minimal form. |

- **Prerequisites**: M1.2 complete; benefits from M1.3/M1.6 existing to provide a real event to test against.
- **Success criteria**: A real domain event is emitted, lands in the outbox, and is dispatched to an in-process subscriber, verified end-to-end.
- **Exit criteria**: Multi-consumer idempotency test passes; internal key issuance confirmed inaccessible from any tenant-facing route.
- **Required documentation**: None new — confirm `02-Software-Architecture.md` §5/§7 matches.
- **Required tests**: Outbox atomicity test; multi-consumer idempotency test; internal-route access-control test.
- **Manual QA checklist**: [ ] Trigger a real event, manually inspect the outbox table, confirm dispatch [ ] Attempt to access internal key issuance from an unauthenticated/tenant context, confirm denial.
- **Automated QA checklist**: [ ] CI suite covering atomicity, idempotency, and access control.
- **GO / NO-GO: GO.**

---

## M1.8 — Observability & Dependency Hygiene

| # | Category | Assessment |
|---|---|---|
| 1 | Engineering risk | Low; risk is redaction rules being a hardcoded list of today's known secrets rather than a robust pattern-match, so a future secret type isn't automatically covered. |
| 2 | Architecture risk | None. |
| 3 | Database risk | None. |
| 4 | AI risk | None yet. |
| 5 | Security risk | The redaction test is the critical control — if under-scoped (one secret pattern only), future secret types leak into logs undetected. |
| 6 | Performance risk | Structured logging/Sentry overhead is generally negligible; sanity-check it anyway. |
| 7 | Scalability risk | Log volume growth is a cost/retention consideration, not a blocker. |
| 8 | Cost risk | Sentry/logging tier costs scale with volume — set a budget alert now rather than discover a surprise bill later. |
| 9 | DevOps risk | None significant. |
| 10 | Testing strategy | Broaden the redaction test beyond one secret shape (API keys, emails, and similar patterns), not just the first one built. |
| 11 | Rollback strategy | Disabling a logging integration is low-risk and reversible. |
| 12 | Migration strategy | N/A. |
| 13 | Monitoring strategy | This milestone **is** the monitoring strategy — confirm alerts actually route to a human channel, not just a dashboard nobody checks. |
| 14 | Observability strategy | Same. |
| 15 | Disaster recovery | N/A. |

- **Prerequisites**: M1.1-M1.7 ideally complete (more to observe); sequencing as second-to-last is reasonable.
- **Success criteria**: A deliberately-triggered staging error appears in Sentry with correct context and zero leaked secret/PII values.
- **Exit criteria**: Alert routing confirmed to reach a real human channel; dependency scan passes with zero known criticals.
- **Required documentation**: Published vulnerability disclosure policy.
- **Required tests**: Broadened redaction test; alert-routing test.
- **Manual QA checklist**: [ ] Trigger a deliberate error, confirm correct, redacted capture in Sentry [ ] Temporarily pin a known-vulnerable package, confirm CI blocks it, then revert.
- **Automated QA checklist**: [ ] CI dependency scan on every PR [ ] Redaction unit tests.
- **GO / NO-GO: GO.**

---

## M1.9 — CI/CD Hardening & Environment Separation

| # | Category | Assessment |
|---|---|---|
| 1 | Engineering risk | Low; risk is the "preview points at staging" check being a one-time manual verification rather than continuously enforced. |
| 2 | Architecture risk | None new. |
| 3 | Database risk | The migration-safety check must have real teeth — actually fail CI on a genuinely destructive migration, not just warn. |
| 4 | AI risk | None. |
| 5 | Security risk | Confirming environment separation is itself a security control, preventing a preview deploy from ever touching real tenant data — one of the more consequential "small" milestones for risk reduction. |
| 6 | Performance risk | None. |
| 7 | Scalability risk | None. |
| 8 | Cost risk | None. |
| 9 | DevOps risk | This whole milestone reduces DevOps risk; residual risk is the check itself having a gap (wrong env var checked) — needs an adversarial test. |
| 10 | Testing strategy | The environment-config-correctness test is genuinely valuable and non-trivial — worth real engineering time. |
| 11 | Rollback strategy | N/A — this milestone establishes rollback/safety infrastructure for everything else. |
| 12 | Migration strategy | Hardens the migration process itself; correctly sequenced after real migrations exist to test against. |
| 13 | Monitoring strategy | N/A beyond M1.8's wiring. |
| 14 | Observability strategy | Same. |
| 15 | Disaster recovery | A written "bad migration reached prod" runbook should exist by exit, even if never yet exercised for real. |

- **Prerequisites**: M1.1-M1.8 complete.
- **Success criteria**: A deliberately-destructive migration is blocked in CI without an explicit override; a deliberately-misconfigured preview env var is caught by the separation check.
- **Exit criteria**: All Phase 1 ADRs exist as real files; a brief DR runbook for a bad-migration-to-prod scenario exists.
- **Required documentation**: ADR-001 through ADR-004; the DR runbook.
- **Required tests**: Destructive-migration-blocking test; environment-separation adversarial test.
- **Manual QA checklist**: [ ] Attempt to merge a PR with a deliberately destructive migration, confirm CI blocks it [ ] Attempt to misconfigure a preview env var, confirm the check catches it.
- **Automated QA checklist**: [x] Environment-separation invariant tests [x] Real Vercel Preview build-gate enforcing it [x] CI migration-safety gate.
- **GO / NO-GO: GO.**

### Implementation progress (M1.9, in progress — not yet closed)

**Done — CI environment-separation guard.** `packages/database/src/environment-target.ts`
(`verifyEnvironmentTarget`, exported from the package barrel) is a pure,
no-network function: given a deployment context (`production` / `preview` /
`development`) and the two targets a Preview deployment resolves at runtime
— the Supabase Auth project (`NEXT_PUBLIC_SUPABASE_URL`) and the Postgres
project (`DATABASE_URL`, parsed from its Transaction Pooler username per
ADR-004) — it fails closed unless both equal the expected staging project
ref (`EXPECTED_STAGING_PROJECT_REF = "damunjcpwxthdjaonatb"`, committed in
that file: a project ref is a public identifier, not a credential, so this
carries no secret-exposure risk; rotate it there if staging is ever
recreated). `production` and `development` are never evaluated against the
staging ref — this guard's only job is stopping Preview from silently
resolving to Production. `packages/database/tests/environment-target.test.ts`
covers the full pass/fail matrix, including the exact M1.9 adversarial
scenario (Preview's Auth target resolves to Production while its DB target
also resolves to Production) and confirms failure messages never contain a
password, connection string, or key.

**What this proves vs. what it doesn't — three distinct layers.** M1.9's
environment-separation guarantee is now backed by three separate things,
which must not be conflated:

1. **Pure configuration invariant tests**
   (`packages/database/tests/environment-target.test.ts`, 21 tests) —
   prove `verifyEnvironmentTarget()`'s own decision logic is correct
   against synthetic inputs. No I/O, no real values, runs anywhere.
2. **Real Vercel Preview build enforcement**
   (`apps/web/scripts/verify-preview-environment.mjs`, wired into
   `apps/web`'s own `build` script as `node
   ./scripts/verify-preview-environment.mjs && next build`) — reuses
   `verifyEnvironmentTarget()` unchanged, but reads the *real*
   `VERCEL_ENV` / `NEXT_PUBLIC_SUPABASE_URL` / `DATABASE_URL` a genuine
   Vercel build has available at build time. When `VERCEL_ENV === "preview"`
   and either target doesn't resolve to the expected staging project
   (`damunjcpwxthdjaonatb`), the script exits non-zero and **fails the
   build** — Preview cannot deploy with a misconfigured target. Production
   builds (`VERCEL_ENV === "production"`) and any build where `VERCEL_ENV`
   isn't set (local `next build`, `pnpm build` in GitHub Actions) are
   never evaluated against the staging ref — this script only ever
   protects Preview. Covered by `apps/web/tests/verify-preview-environment.test.ts`
   (18 tests): in-process tests against the script's exported pure
   functions, plus a genuine subprocess-level adversarial test that spawns
   the script exactly as `next build` would and asserts on its real exit
   code (0 for correct/production/local, non-zero for every mismatch or
   missing-variable case) — this is the actual "prove the gate has teeth"
   evidence, not just a function-return-value check. GitHub Actions itself
   still cannot exercise this against Vercel's *real* Preview values (it
   has no access to them); what CI proves is that the script's logic is
   correct and that a deliberately-wrong synthetic input reliably produces
   a non-zero exit — the live enforcement happens inside Vercel's own
   Preview build, not inside GitHub Actions.
3. **Live environment verification** (already completed, see the
   addendum above) — the one-time manual end-to-end test: real Preview
   deployment, real signup, real staging Auth + staging Postgres, matching
   rows found directly in staging's
   `public.users`/`organizations`/`memberships`. This is the only layer
   that has ever touched a real Vercel deployment; it is not re-run
   automatically by anything, but layer 2 above now means a *future*
   misconfiguration of the same kind would fail that Preview's build
   automatically, rather than requiring another manual live test to catch.

**Done — CI migration-safety gate.** `packages/database/src/migration-safety.ts`
(`classifyMigrationSql`, exported from the package barrel) is a pure,
offline function: it tokenizes a migration file's raw SQL (correctly
excluding `--`/`/* */` comments, single-quoted string contents, and the
bodies of dollar-quoted (`$$...$$`/`$tag$...$tag$`) function definitions
from analysis) and matches the remaining top-level statements against a
destructive-operation grammar (`DROP TABLE`/`COLUMN`/`TYPE`/`SCHEMA`,
`TRUNCATE`, a `DROP ... CASCADE`, an unconditional or `WHERE`-scoped
top-level `DELETE`, `ALTER COLUMN ... TYPE`, column/table renames). It
fails closed on anything it cannot safely tokenize (an unterminated
string/comment/dollar-quoted body). Calibrated against this repository's
own real migration history, not just synthetic fixtures: `DROP CONSTRAINT`,
`ALTER COLUMN ... DROP NOT NULL`, and `REFERENCES ... ON DELETE/UPDATE
CASCADE` (used throughout the schema) are all correctly left unflagged,
and the `DELETE FROM auth.users` inside the M1.6 GDPR erasure function is
correctly recognized as reviewed source living inside a function body —
not a statement that executes the moment the migration is applied — and is
not flagged. One real classifier bug was found and fixed during this
calibration: `REVOKE TRUNCATE, REFERENCES, TRIGGER ON ...` (the M1.8
default-ACL-hardening migration) was initially misflagged, because
`TRUNCATE` also names a Postgres *privilege* in a `GRANT`/`REVOKE`
statement, not only the destructive command — the rule is now anchored to
the start of a statement, where only the real command can appear.

An intentionally destructive migration can be accepted only via a
committed, auditable override — two comment lines, both required:
`-- migration-safety: destructive-override` and
`-- migration-safety-reason: <non-empty reason>`. A marker without a
reason (or a reason without the marker) never overrides anything; the
underlying finding is still reported even when a valid override is
present, so an override is never a silent pass. This is read only from
genuine SQL comments, never from string literal data, so it cannot be
spoofed by data that merely contains the marker text.

`packages/database/tests/migration-safety.test.ts` (66 tests) covers the
full safe/blocked matrix, the false-positive protections above (including
a dedicated regression test for the `REVOKE TRUNCATE` bug), multi-statement
files, malformed-SQL fail-closed behavior, every override edge case, and —
critically — runs the classifier against **every real migration file**
currently in `packages/database/supabase/migrations/`, asserting none of
them require an override. `packages/database/scripts/check-migration-safety.mjs`
is the CI-invoked wrapper: reads every `.sql` file in that directory,
reuses `classifyMigrationSql()` unchanged, and exits non-zero identifying
the offending file and destructive categories the moment any one migration
is unsafe. It makes no database connection, reads no environment variable,
and requires no credential of any kind — wired into `.github/workflows/ci.yml`
as the very first `run` step (after Node is set up, before `pnpm install`),
so a destructive migration fails CI before any other step runs.

**Done — ADR-002.** `docs/adr/ADR-002-n8n-provider-boundary.md` records the
decision that n8n has no direct Postgres access and must never receive
`DATABASE_URL` or an equivalent privileged credential — it reads/writes
tenant data exclusively through the app's own `/api/v1/*` API, using the
same `api_keys`/`service`-scope credential primitive any external
integrator uses. Precise about implementation status: the credential
schema and its issuance/isolation foundation are implemented (M1.7); that
n8n specifically will use this boundary is a documented architectural
decision, not yet exercised by real traffic; the actual n8n workflows, the
`/api/v1/api-keys` route, and Bearer-token request authentication remain
Phase 3 work. A pre-existing inconsistency was found and corrected as part
of this ADR: `docs/adr/ADR-004-direct-postgres-data-access.md` previously
stated that an external integrator or n8n workflow uses Supabase's
PostgREST — corrected to state they use the app's own `/api/v1/*` API
instead (ADR-002), matching `04-API-Architecture.md` §8, which ADR-004
itself already cited. The two ADRs no longer contradict each other.

**Done — bad-migration-to-production DR runbook.**
`docs/runbooks/bad-migration-to-production.md` covers detection,
containment (including the M1.9.1 project-ref re-verification discipline
before any `--linked` command), assessment, a severity-based recovery
decision tree, a forward-fix-only strategy consistent with this repo's
append-only migration convention, and post-recovery tenant/RLS validation.
It is explicit that Supabase automated backups and point-in-time recovery
are documented in `docs/08-Security.md` §8 only as a target, not confirmed
active anywhere in this repository, and marks any backup/PITR-based
recovery path **UNVERIFIED — MUST CONFIRM IN SUPABASE DASHBOARD BEFORE
USE** rather than assuming it.

**M1.9 implementation deliverables complete.** ADR-001 through ADR-004
exist as real files; environment separation (validator, tests, and the
real Vercel Preview build gate) is implemented; the CI migration-safety
gate and its destructive-migration-blocking test are implemented; the
bad-migration-to-production DR runbook now exists.

**Formal closeout audit performed.** Both literal Exit Criteria are
satisfied — the four ADRs exist as real files, and the DR runbook exists
without overclaiming backup/PITR (explicitly marked **UNVERIFIED — MUST
CONFIRM IN SUPABASE DASHBOARD BEFORE USE**, per `docs/08-Security.md` §8's
own conditional wording, never treated as a confirmed capability). Both
Success Criteria are satisfied: the destructive-migration gate was
re-verified adversarially — a temporary, never-committed fixture correctly
failed without an override and correctly passed (finding still visibly
reported) with a valid override, then fully removed — and the
misconfigured-preview-env criterion was met even more strongly than
required, having been caught for real by the Turbo strict-env-mode
incident, not only synthetically. Full validation re-run at closeout:
462/462 tests, lint/typecheck/build all green, forced/uncached. Preview →
staging live verification, the migration-safety commit's green CI run, and
the Production health check are recorded as user-verified — not
independently re-executed this session, and not upgraded to a stronger
verification level than what was actually established. The one open item
(a literal GitHub PR drill of a destructive migration) is a Manual QA
checklist entry, not one of the two named Exit Criteria, and its
underlying guarantee is independently proven by the adversarial CLI
verification above plus the real, green CI run already on record.

**M1.9 status: PASS — CLOSED.**

---

## Milestone 2.1 — Companies & Contacts

| # | Category | Assessment |
|---|---|---|
| 1 | Engineering risk | Low; the pattern (schema + RLS + grants + RBAC + API) is a direct repeat of what M1.2-M1.7 already validated, not a new pattern. |
| 2 | Architecture risk | None new — `packages/crm` is an already-defined package boundary (`docs/02` §4), not a new one. |
| 3 | Database risk | Two new tenant-scoped tables must ship RLS + base grants in the same migration (ADR-003) — the same discipline every prior tenant-scoped table followed. |
| 4 | AI risk | None. |
| 5 | Security risk | `contacts` is the first genuinely new personal-data table since M1.6 — it must be wired into the GDPR retention/DSR cascade in this same milestone, not deferred (`docs/10-CLAUDE.md` §8); getting this wrong repeats "one of the most common real-world GDPR compliance mistakes" the same doc names explicitly. |
| 6 | Performance risk | None significant at this scale; `organization_id`-leading indexes and the `deleted_at IS NULL` partial index are the standard mitigation already used elsewhere. |
| 7 | Scalability risk | None yet. |
| 8 | Cost risk | None. |
| 9 | DevOps risk | None significant — both migrations pass through the M1.9 migration-safety gate automatically. |
| 10 | Testing strategy | RLS adversarial tests and the GDPR erasure re-validation test matter more than CRUD happy-path tests here. |
| 11 | Rollback strategy | Standard — covered by the M1.9 DR runbook, no new consideration. |
| 12 | Migration strategy | Straightforward additive; sequenced schema-then-GDPR-wiring-then-domain-logic-then-API (§27 of the approved planning report). |
| 13 | Monitoring strategy | N/A beyond M1.8's existing request-logging wrapper, applied to the two new route handlers. |
| 14 | Observability strategy | Same. |
| 15 | Disaster recovery | N/A beyond M1.9's existing migration-safety/DR-runbook coverage — no new recovery scenario introduced. |

- **Prerequisites**: M1.1, M1.2, M1.3, M1.5, M1.6, M1.9 complete (all closed).
- **Success criteria**: A company and a contact can be created, read, updated, and soft-deleted, fully isolated per organization; a `contact`-type GDPR erasure request can be previewed and executed, independently re-validating and provably unable to affect another organization's data.
- **Exit criteria**: Both tables exist with RLS/grants; `packages/crm` exists with tested validation logic; all 8 RBAC keys are enforced; both API resources are live with the standard conventions; `contacts` retention policy and erasure functions exist and are tested.
- **Required documentation**: This entry; `docs/03-Database-Architecture.md` and `docs/04-API-Architecture.md` updated once the actual schema/routes ship (not part of this planning entry — implementation-time documentation, same discipline as every prior milestone).
- **Required tests**: RLS adversarial isolation test (companies + contacts); cross-org `company_id` rejection test; API auth/authz boundary test; RBAC coverage test; GDPR erasure cross-org isolation test; erasure-vs-soft-delete distinction test.
- **Manual QA checklist**: [ ] Create a company, create a contact under it, create a contact with no company [ ] Soft-delete a company, confirm its contacts' `company_id` is left intact but the company doesn't appear as an active relationship in the API response [ ] Attempt a duplicate contact email within one org, confirm `409` [ ] Attempt cross-org access to a company/contact `:id`, confirm `404` [ ] File and preview a `contact`-type DSR, confirm the preview is non-mutating [ ] Execute a `contact`-type DSR erasure, confirm the contact is hard-deleted/anonymized, not just `deleted_at`-marked.
- **Automated QA checklist**: [ ] RLS isolation suite for both tables [ ] RBAC permission-matrix coverage [ ] GDPR erasure re-validation + cross-org isolation tests.
- **GO / NO-GO: GO.**

### Detailed design (2.1 planning — not yet implemented)

This section records the approved design decisions from the 2.1 planning pass, so implementation has a concrete reference rather than re-deriving them.

**Companies** — `id`, `organization_id` (`not null references organizations(id) on delete cascade`), `name` (`not null`), `domain`, `industry`, `employee_count`, `annual_revenue`, `linkedin_url`, `enrichment_status` (schema-complete per `docs/03` but functionally inert until Phase 3 Lead Enrichment), `owner_id` (`references public.users(id) on delete set null`), `deleted_at`, `created_at`/`updated_at`. No uniqueness constraint on `domain` — **approved decision: do not enforce per-organization domain uniqueness in 2.1**, since no existing document establishes this as a business invariant and enforcing it now risks rejecting legitimate records; a lookup index on `domain` may still be added if query patterns justify it. `organization_id`-leading index + partial index `WHERE deleted_at IS NULL` (`docs/03` line 187).

**Contacts** — `id`, `organization_id` (`not null references organizations(id) on delete cascade`), `company_id` (`references companies(id) on delete set null`, nullable — a contact may exist without a company), `first_name`, `last_name`, `email` (unique per `organization_id`), `phone`, `job_title`, `linkedin_url`, `lifecycle_stage` (`check (lifecycle_stage in ('lead','prospect','customer','inactive'))`, nullable — intentionally minimal, no deal/pipeline-stage semantics, extendable later via a reviewed migration if real product need justifies it, not expanded speculatively), `owner_id`, `deleted_at`, `created_at`/`updated_at`. **Approved: a `CHECK` constraint requires at least one non-empty value among `first_name`, `last_name`, `email`** — `phone`/`job_title`/`company_id` alone never satisfy it; enforced identically at the database (`CHECK`), domain (`packages/crm` validation), and API (`400`) layers, not just one of the three.

**Soft-deleted company + contact relationship — approved**: `contacts.company_id` is left **intact** when a company is soft-deleted — `deleted_at` is not a hard delete, so no FK action fires, and rewriting the reference would destroy a real historical relationship for no compliance reason. The API's default company/contact representation must not present a soft-deleted company as an *active* relationship (e.g. omit or clearly mark it), even though the underlying `company_id` value is untouched.

**Duplicate contact email — approved**: `POST /api/v1/contacts` with an email already used (non-deleted) within the same organization returns `409 Conflict`. No implicit upsert. `PATCH` is the only path that updates an existing row; `POST` never silently mutates one.

**RLS/grants**: identical pattern to every existing tenant-scoped table — `organization_id = current_org()` policies for `SELECT`/`INSERT`/`UPDATE`, base grants for `authenticated` on the same three, **no `DELETE` grant or policy on either table** (ordinary "delete" is an `UPDATE` setting `deleted_at`, matching the existing `public.users` RLS precedent exactly — "no delete policy, account removal is a GDPR/DSR cascade"). Both migrations inherit the M1.9-hardened default table privileges automatically.

**RBAC**: new `PermissionKey` values `companies:read`/`create`/`update`/`delete` and `contacts:read`/`create`/`update`/`delete` (the `permissions.ts` file's own existing comment already names this exact gap: *"no CRM permissions exist here yet because no CRM tables exist yet"*). Proposed grants: `org_admin` — all eight; `org_member` — read/create/update, no delete; `org_viewer` — read only; `agency_owner`/`agency_admin` — none directly (agency cross-org access only through named roll-up views, per `docs/10-CLAUDE.md` §2 — a CRM-specific roll-up view is explicitly out of 2.1's scope, no evidence it's required for Companies & Contacts to function standalone).

**GDPR/DSR integration — approved as an in-milestone deliverable, not deferred**: `docs/03-Database-Architecture.md` §2.8 already states the DSR cascade "extends into CRM/Brain tables in later milestones" — this is that milestone for `contacts`. Mirrors the M1.6 `user` pattern exactly: a `data_retention_policies` row for `contacts` (proposed: the same 2555-day default the three existing categories use, adjustable, not a rigid business decision); `preview_contact_erasure(dsr_id, caller_user_id)` / `execute_contact_erasure(dsr_id, caller_user_id)` `SECURITY DEFINER` functions, both independently re-validating caller authorization within the target's own organization, `execute` never trusting a prior `preview` (matching `execute_user_erasure()`'s own discipline exactly); the audit log entry written inside the same transaction as the erasure (Unit-of-Work, `docs/02` §7). **`companies` is out of this requirement** — it holds firmographic/business data, not personal data of a natural person (`owner_id` refers to platform staff, not a data subject), so CLAUDE.md §8's retention/cascade rule doesn't apply to it. The ordinary `deleted_at` soft-delete on `contacts` remains categorically distinct from this erasure path — a soft-deleted contact is not GDPR-erased, and a GDPR-erased contact is never merely `deleted_at`-marked.

**Sequencing**: schema (companies + contacts + RLS + grants) → GDPR retention/erasure wiring for `contacts` → `packages/crm` domain logic → RBAC keys → API routes → UI (`EntityTable`, separate, real work) → adversarial/final verification, matching every prior milestone's plan-then-verify discipline.

### 2.1B — Done (schema, RLS, grants)

`companies`/`contacts` shipped, tested (462 database tests including 42
schema/RLS-specific), and live-verified on staging
(`damunjcpwxthdjaonatb`) via read-only catalog inspection. Not repeated
here — see the 2.1B closeout evidence already on record from this
session.

### 2.1C — Done (Contacts GDPR/DSR integration)

`packages/database/supabase/migrations/20260812130000_create_contact_erasure_functions.sql`
adds the platform-default `contacts` retention row (2555 days — the
current configurable platform default, not a claim that GDPR universally
requires seven years) and mirrors M1.6's `preview_user_erasure`/
`execute_user_erasure` pair exactly: `_validate_contact_erasure`
(private, no `EXECUTE` grant), `preview_contact_erasure(dsr_id,
caller_user_id)`, `execute_contact_erasure(dsr_id, caller_user_id)`, both
`SECURITY DEFINER`, `set search_path = public`.

**Tenant-binding is the one place this pattern is stricter than the user
one, by design**: a contact has no memberships/roles of its own, so
authorization isn't "caller shares any organization with the target" —
`_validate_contact_erasure` takes an explicit `organization_id`
parameter, always resolved server-side from the `data_subject_requests`
row (never caller-supplied), and both `preview`/`execute` independently
re-derive and cross-check that the target contact's own
`organization_id` matches the DSR's `organization_id` before checking
the caller's membership in that exact organization. An org_admin of Org
A cannot use that authority against Org B's contact, even when they
additionally hold a non-admin membership in Org B — proven by a
dedicated adversarial test, not just asserted.

A missing contact and a contact belonging to a different organization
than the DSR produce an **identical** preview result (`can_proceed:
false`, same generic `blocker_reason`, `target_contact_id: null`) —
verified by a test asserting the two results are deeply equal — so
preview can never be used to probe whether another organization's
contact exists.

`packages/compliance/src/data-subject-requests.ts` gained
`previewContactErasure`/`executeContactErasure`, thin wrappers adding no
logic of their own, exported from the package barrel — mirroring
`previewUserErasure`/`executeUserErasure` exactly. No HTTP route change
(deliberately out of this step's scope — the existing
`/api/v1/data-subject-requests/{id}/execute`/`preview` routes remain
hardcoded to the user-erasure functions; dispatching by `subject_type`
is separate, later work).

**Audit entry contains no raw contact PII** — `before`/`after` hold only
`subject_type`, a `had_company_link` boolean, and completion metadata;
a dedicated test serializes the full audit payload and asserts it
contains neither the test contact's name nor its email. **Consent
history is preserved, not deleted or anonymized** — `consent_records`
rows referencing an erased contact are left untouched by design (a
non-resolving `subject_id` after erasure is the approved, intended
state), matching the same "evidence, not a live reference" treatment
`audit_logs` already receives for erased users.

**Transactional safety verified, not assumed**: a chaos-style test
(matching `signup-flow.test.ts`'s established pattern — a temporary
trigger forcing the `audit_logs` insert to fail) proves the contact
hard-delete and the `data_subject_requests` status update both roll
back completely when the audit write fails, leaving zero partial-erasure
state.

`packages/compliance/tests/contact-erasure.test.ts` (17 tests) covers
retention, preview (success, non-mutation, no audit write, soft-deleted
contact still eligible, no PII, cross-org indistinguishability),
execute (success, physically gone not `deleted_at`, works without a
preceding preview, independent re-validation, replay rejection, PII-free
audit), the full tenant-binding adversarial set (DSR/contact org
mismatch, same-org-elsewhere admin, dual-membership caller, forged
`withTenantContext` values, caller-id impersonation), consent-history
preservation, and the transactional-safety chaos test. One pre-existing
M1.6 test (`compliance-schema.test.ts`'s platform-default retention row
enumeration) was updated to include `'contacts'` — a legitimate
consequence of the new row, not a weakened assertion.

**Still open for Milestone 2.1**: `packages/crm`, RBAC keys (2.1E),
`/api/v1/companies`/`/api/v1/contacts` routes (2.1F, including wiring
the DSR route dispatch), UI (2.1G), and the final milestone-wide
adversarial/closeout pass (2.1H). Milestone 2.1 is not closed.

### Security Remediation — Function EXECUTE Privileges + NULL-Safe Auth Guards (post-2.1C, local only)

Two independent, systemic vulnerabilities were found during the 2.1C
staging-deployment verification and a follow-up repository-wide function-
privilege audit, both release-blocking, neither specific to Milestone
2.1's own new functions (they affected every `SECURITY DEFINER` function
in the schema back to M1.3). **This entry documents local implementation
and testing only — staging and Production remediation had not happened
as of this writing; see "Deployment status" below.**

**Root cause 1 — PostgreSQL's compiled-in default grants `EXECUTE` on
every new function to `PUBLIC`.** No migration in this repository's
history had ever revoked it. Confirmed live on staging via
`has_function_privilege()`: `anon` and `authenticated` could both execute
every function in the schema, including the two private helpers
(`_validate_user_erasure`, `_validate_contact_erasure`) whose own doc
comments claimed "not granted to authenticated" — a claim the actual
grants never enforced. The M1.9 default-privilege hardening
(`20260811100000`/`20260811110000`) was explicitly table-scoped only and
never touched functions.

**Root cause 2 — the caller-identity guard shape used by seven functions
was NULL-unsafe.** `p_caller_user_id is null or p_caller_user_id <>
auth.uid()`: SQL's `<>` against a NULL operand evaluates to NULL (never
true/false), and PL/pgSQL's `IF` treats a NULL condition as "do not
execute THEN" — so when `auth.uid()` is NULL (the unauthenticated case),
a caller supplying *any* non-null id parameter sailed past the guard
entirely, impersonating that id. Verified empirically with a disposable
PL/pgSQL probe before the fix was written, not assumed from reading the
SQL. Affected: `create_organization_with_owner`, `create_agency_with_owner`,
`create_client_organization_for_agency`, `preview_user_erasure`,
`execute_user_erasure`, `preview_contact_erasure`, `execute_contact_erasure`.

**A third finding surfaced only during remediation, not part of the
original two root causes**: `ALTER DEFAULT PRIVILEGES ... IN SCHEMA
public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` — the schema-scoped form,
the direct functional analog of 20260811100000's working table-level
statement — silently has **no effect** on functions. Confirmed
empirically (fresh `db reset`, zero pre-existing default-privilege state,
a disposable probe function created/checked/dropped both before and
after the fix) and independently corroborated by PostgreSQL's own bug
tracker: a schema-scoped default privilege can only *add* to the
compiled-in default for functions, never remove from it. Only a
role-scoped statement with **no** `IN SCHEMA` clause
(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS
FROM PUBLIC`) actually suppresses it. This asymmetry is function-specific
— the same schema-scoped form was re-confirmed still correct for tables
in the same session. The migration's Part 2 uses the unscoped form for
this reason, documented inline.

**Remediation — `packages/database/supabase/migrations/20260812140000_harden_function_execution_privileges.sql`**,
four parts: (1) `REVOKE EXECUTE ... FROM PUBLIC` on every existing
function in the schema, re-granting `authenticated` only where a real
grant already existed or was silently missing (the three tenant-context
functions `current_org`/`current_agency`/`current_role_key` had *no*
explicit grant at all pre-fix, relying entirely on the PUBLIC default —
revoking PUBLIC without adding these explicit grants would have broken
every RLS policy in the schema the moment the migration applied); (2) the
future-function default-privilege fix described above; (3)
`CREATE OR REPLACE FUNCTION` redefinitions of the seven vulnerable
functions, changing only the guard (`IF auth.uid() IS NULL OR
p_caller_user_id IS NULL OR p_caller_user_id IS DISTINCT FROM auth.uid()
THEN RAISE EXCEPTION` — `IS DISTINCT FROM` never returns NULL) —
business logic, transaction behavior, `SECURITY DEFINER`, and
`search_path` are otherwise byte-for-byte identical to the shipped
version, `create_organization_with_owner`'s body read fresh from
20260811090200 (the M1.7 `membership.created` event-emission version) so
the redefinition doesn't regress that milestone; (4) idempotent
re-statement of the `authenticated` grants `CREATE OR REPLACE` already
preserves, so the migration's own end state is self-contained and
legible without cross-referencing prior migrations.

**Regression coverage** — `packages/database/tests/function-execution-privilege-hardening.test.ts`
(41 tests): private-helper direct-invocation denial for both `anon` and
`authenticated`; grant-level denial for `anon` on all seven hardened RPCs
and the five RLS-support functions; an exact privilege-matrix assertion
(`has_function_privilege`) across every touched function; a
future-function probe proving zero inherited grants; and the core
regression — a NULL-auth exploit reproduction per function category
(org creation, agency creation, client-org creation under an agency, user
erasure preview/execute, contact erasure preview/execute), each
authenticated with no `sub` claim (`auth.uid()` genuinely NULL) supplying
a real victim's id and asserting the call now raises rather than
succeeds, plus confirmation the impersonated action never took effect
(no org/agency/client-org row created, target user/contact still exists,
DSR status still `pending`). Two legitimate-flow smoke tests confirm an
authenticated caller can still act for themselves and still cannot act
for a different real user (the pre-existing, correct half of the guard,
unaffected by the NULL-safety fix).

**Full validation, local only**: database 271/271 (229 pre-existing + 41
new + 1 net), compliance 26/26, full monorepo 566/566; migration-safety
29/29, no override; lint/typecheck/build clean across all five packages;
`git diff --check` clean; secret scan clean; diff scope exactly two files
(the migration and its test file) — no incidental changes elsewhere.

**Deployment status (updated)**: staging has since received
`20260812140000` via a normal, verified `db push` (both root causes
confirmed closed there — see the staging verification report from that
session). Production has **not** received the migration itself — instead,
both root causes were closed there via a hand-applied, transaction-wrapped
ACL/guard hotfix scoped to only the 13 functions that exist in Production
today (2.1B/2.1C's own tables and functions are deliberately excluded,
since deploying them wasn't in scope for the security fix). Production's
migration history still shows `20260812120000` through `20260812140000`
as pending — this is expected, not a defect: the hotfix was applied via
direct SQL, not `db push`, so it never touched `schema_migrations`. When
`20260812140000` eventually runs there for real (as part of deploying
2.1B/2.1C together), every one of its statements affecting the 13
already-hotfixed functions is idempotent and will no-op safely; its
statements for the 3 contact-erasure functions and `set_updated_at` will
correctly do real work for the first time, since `130000`/`120000` will
have already run immediately before it in the same push.

### 2.1D — Done (packages/crm implementation)

`packages/crm` (new package, `database`/`auth` per `docs/02` §4's
boundary table) implements Companies/Contacts create/get/list/update/
soft-delete — domain logic only, no HTTP concerns, no new migration (the
2.1B schema already covers everything this package needs).

**Tenant context**: every function accepts an already-resolved
`{ userId, organizationId, roleKey? }` and calls `withTenantContext` —
`organizationId` is structurally never a mutation input (`CreateCompanyInput`/`CreateContactInput`
have no such field at all), and every query still explicitly filters
`organization_id = ctx.organizationId` in application SQL on top of RLS,
matching `docs/08` §2's two-layer discipline.

**Owner validation**: strict organization-scoped rule — `ownerId` is
valid only if `null` or if it references a user with an **active**
`memberships` row in exactly the caller's own organization. Agency-level
membership alone never qualifies (`memberships.organization_id` is `NULL`
for agency-scoped rows per ADR-005, so the query excludes them
structurally). Shared between companies and contacts via
`src/owner-validation.ts`, always run inside the same transaction as the
write it guards. An existing `owner_id` is left alone if that membership
later becomes inactive — only a *new* assignment/change re-validates.

**Company name**: rejects empty/whitespace-only (a domain-only rule — no
migration; the DB itself only enforces `NOT NULL`), trims before
persistence.

**Company relationship**: `companyId` is valid only if it resolves to a
company that exists, belongs to the caller's org, and is not
soft-deleted — all three failure modes collapse to the same
`InvalidCompanyRelationshipError`, deliberately indistinguishable. An
already-linked contact's `company_id` is left untouched if that company
is later soft-deleted (no cascade, no FK change, matching the existing
2.1B decision) — the restriction only applies to *new* assignments.

**Contact identity invariant**: mirrors the database `CHECK` exactly
(same non-whitespace regex). `updateContact` validates the **final**
merged state (current row + patch), not just the patch in isolation — an
existing contact with only `email` populated cannot have `email` nulled
out unless the same update also supplies a non-empty `firstName`/`lastName`.

**Email uniqueness**: not pre-checked as authoritative — the existing
partial unique index (`contacts_org_active_email_idx`) remains the
race-safe mechanism; `packages/crm` catches Postgres `23505` scoped to
that exact index name (via the error's `constraint` field) and translates
it to `DuplicateContactEmailError`, never swallowing an unrelated unique
violation.

**Pagination**: opaque base64url `{ createdAt, id }` cursor, `created_at
DESC, id DESC` with `id` as a stable tie-breaker, `(created_at, id) <
(cursor.createdAt, cursor.id)` as the continuation predicate, default
limit 25 / max 100, fetch `limit + 1` to detect `hasMore` without a
separate count query — the first concrete implementation of `docs/04` §1's
documented convention in this repository, shared identically by
`listCompanies`/`listContacts`.

**Domain errors**: `ValidationError`, `DuplicateContactEmailError`,
`InvalidCompanyRelationshipError`, `InvalidOwnerError` — no HTTP status
codes. `getCompanyById`/`getContactById` return `null` identically for
nonexistent, cross-org, and soft-deleted — no `Forbidden` error exists in
this package at all, matching `getDataSubjectRequestById`'s own
established precedent exactly.

**Tests**: 87 (`pagination.test.ts` 14, `companies.test.ts` 27,
`contacts.test.ts` 36, `tenancy.test.ts` 10) — real local Postgres, no
mocking, covering create/get/list/update/soft-delete for both entities,
owner validation (valid/nonexistent/cross-org/inactive-membership,
existing-owner-persists-on-unrelated-update), company-relationship
validation (valid/nonexistent/cross-org/soft-deleted, all
indistinguishable), the identity-invariant final-state case, duplicate
email (plain/case-insensitive/reusable-after-soft-delete/cross-org-allowed),
cursor pagination (no duplicates/gaps across pages, filters), and
cross-tenant adversarial coverage (read/update/soft-delete all rejected
across orgs, forged `organizationId`-shaped input fields have no effect,
a cross-org `companyId` cannot be used to bypass isolation).

**Full validation**: monorepo 653/653 (database 271, auth 138, crm 87
new, tenancy 28, compliance 26, web 103); migration-safety 29/29
unchanged (no new migration); lint/typecheck/build clean across all 7
packages; `git diff --check` clean; secret scan clean; diff scope exactly
`packages/crm/` (new) and `pnpm-lock.yaml` (the expected new-workspace-package
addition) — no incidental changes elsewhere.

**Still open for Milestone 2.1** (superseded below): ~~2.1E (RBAC
keys)~~, 2.1F (API routes + DSR route dispatch), 2.1G (UI), 2.1H (final
adversarial/closeout). Milestone 2.1 is not closed.

### 2.1E — Done (CRM RBAC)

Adds the 8 approved `PermissionKey` values to `packages/auth/src/permissions.ts`:
`companies:read`/`create`/`update`/`delete`, `contacts:read`/`create`/`update`/`delete`.

**Role matrix**: `org_admin` — all 8; `org_member` — read/create/update,
no delete; `org_viewer` — read only; `agency_owner`/`agency_admin`/
`portal_customer` — none. Matches the design approved in the 2.1E
audit report exactly, re-confirmed against fresh reading of
`docs/10-CLAUDE.md` §2 rather than assumed.

**Agency-role decision**: no direct CRM grant for either agency-scoped
role — structural, not just a policy choice. An agency-scoped `Actor`
carries `agencyId`, not `organizationId`, in the general case, and no
`agency_rollup_companies`/`agency_rollup_contacts` view exists yet to
give agency roles a safe cross-org read path. An agency staffer who
separately holds an actual org-scoped membership in a client org already
gets CRM access through that org-scoped role — no new mechanism needed.

**Delete-vs-GDPR**: `companies:delete`/`contacts:delete` authorize only
the ordinary `UPDATE deleted_at = now()` soft-delete `packages/crm`
exposes — never physical `DELETE`, never GDPR hard erasure, which
remains governed exclusively by `data-subject-requests:execute` and is
never coupled to these two keys (proven by a dedicated test asserting
`org_member` holds `contacts:delete` = false and
`data-subject-requests:execute` = false independently, and that no role
other than `org_admin` ever holds either CRM delete key).

**A required database migration, found during the audit and confirmed
necessary during implementation**: `roles.permission_set` (a `jsonb`
column) is asserted byte-identical to `PERMISSION_MATRIX` by
`packages/auth/tests/permission-set-sync.test.ts`, which queries real
local Postgres — adding the 8 keys to the TS matrix without a
corresponding migration would have broken that test (confirmed
empirically: it failed exactly as predicted before the migration was
applied, then passed after). `packages/database/supabase/migrations/20260813100000_update_role_permission_sets_2_1e.sql`
updates only the three roles whose entry actually changes
(`org_admin`, `org_member`, `org_viewer`) via full-replacement `UPDATE`
statements, mirroring the exact pattern of `20260807135700`/`20260810100400`
— every pre-existing key for those roles is explicitly preserved
alongside the new CRM ones, not merely appended. `agency_owner`/
`agency_admin`/`portal_customer` rows are untouched (they gain nothing).

**Tests**: `packages/auth/tests/permissions.test.ts` extended — 8 new
keys added to the exhaustive (role × permission) matrix (independently
hand-written `EXPECTED` values, never derived from `PERMISSION_MATRIX`
itself), plus dedicated `describe` blocks for the CRM matrix per role,
the delete-vs-DSR independence proof, agency-role zero-grant
confirmation, and a full byte-for-byte regression check that all 14
pre-2.1E permissions' expected values are unchanged. One pre-existing
test needed a real fix, not just an addition: the "deny-by-default"
sweep for `org_viewer` previously excluded only `organizations:read`
from its "everything else denies" loop — it now also excludes
`companies:read`/`contacts:read`, the two new grants that would
otherwise have made that test fail (a legitimate consequence of the new
grants, not a weakened assertion).

**Full validation**: `packages/auth` 196/196 (was 138; +58 net — the
permission-set-sync tests plus every new/extended permissions.test.ts
case), `permission-set-sync.test.ts` passes against real local Postgres,
migration-safety 30/30 (was 29 — the one new migration), monorepo
712/712 (database 272 [+1, `migration-safety.test.ts` generating one
test per migration file], auth 196, crm 87, tenancy 28, compliance 26,
web 103); lint/typecheck/build clean across all 7 packages;
`git diff --check` clean; secret scan clean.

**Still open for Milestone 2.1** (2.1F now split into sub-steps, see
below): ~~2.1F~~, 2.1G (UI), 2.1H (final adversarial/closeout). Milestone
2.1 is not closed.

### 2.1F-A — Done (Idempotency-Key foundation)

The Idempotency-Key subsystem backing companies/contacts `POST`/`PATCH`,
scoped narrowly per the approved design — not a repository-wide
framework, not retrofitted onto any existing route.

**Database model**: `public.idempotency_keys` (new table,
`organization_id`-scoped, `unique (organization_id, idempotency_key_hash)`
— the sole access pattern this table has, so no additional index was
added beyond what that constraint already provides). Neither the raw
`Idempotency-Key` header nor the raw request body is ever persisted —
only SHA-256 hashes of each (Node's built-in `crypto`, no new dependency).
RLS: `organization_id = current_org()` for `SELECT`/`INSERT`/`UPDATE`/
`DELETE`, `authenticated` only, no `anon` grant. **One deliberate
departure from the companies/contacts "no `DELETE`" precedent**: this
table gets a real `DELETE` grant/policy, since it holds ephemeral
operational plumbing with no compliance/audit significance (unlike CRM
records), needed for inline expired-key reclamation — no soft-delete
concept applies here.

**Concurrency**: `INSERT ... ON CONFLICT (organization_id,
idempotency_key_hash) DO NOTHING RETURNING` — a returned row means this
transaction owns the reservation; no row means another transaction
already holds it, resolved via `SELECT ... FOR UPDATE` on the existing
row (blocks until that transaction resolves, then reads its final state).
**Empirically verified against real local Postgres with two independent
connections** (a temporary probe script, created/run/deleted within the
same session, no trace left) proving both required properties: (1)
simultaneous identical requests produce exactly one persisted row and one
real mutation; (2) when the reservation owner's transaction rolls back
mid-mutation, the row disappears entirely and a concurrent contender
correctly takes over and completes the mutation exactly once. **One
finding worth recording honestly**: the empirical test revealed that
`INSERT ... ON CONFLICT DO NOTHING` itself already blocks on an
uncommitted conflicting row and resolves correctly based on the other
transaction's outcome — more of the actual waiting happens at the INSERT
statement than originally modeled; the subsequent `SELECT ... FOR UPDATE`
remains correct and necessary (it's what safely reads the final row state
and takes the lock needed for the fingerprint comparison), just not the
sole source of the blocking behavior. A bounded retry loop (max 3
attempts) handles the "owner rolled back, row now gone" case — 3 was
chosen because this path is only ever reached by a genuinely rare race
(another request's unexpected failure happening in the same narrow
window), not a scenario expected to repeat; a fourth consecutive failure
for the same key surfaces as a thrown error (mapped to `500` by whatever
route calls it) rather than spinning further.

**Transaction architecture**: `createCompany`, `updateCompany`,
`createContact`, `updateContact` (`packages/crm`) each gained one
optional, backward-compatible `existingClient?: PoolClient` parameter
(via a small shared `runInClientOrTransaction` helper) — when supplied,
the function runs against that already-open, already-tenant-scoped
transaction instead of opening its own, which is what makes reservation +
mutation + response persistence commit as a single atomic unit. Every
existing caller/test omits it and is completely unaffected (87/87
`packages/crm` tests pass unchanged). No HTTP concept enters
`packages/crm` — `PoolClient` is a database-layer type the package
already imports internally.

**Response persistence**: a deterministic 4xx result returned by the
wrapped callback (e.g. a `packages/crm` validation error, mapped to
`{status, body}` by the *caller*, not by the idempotency helper itself)
is persisted and replayed exactly like a success — retrying the identical
invalid payload with the identical key deterministically reproduces the
identical 4xx. An *unexpected* thrown error propagates out of the entire
transaction, rolling back the reservation itself — no row survives a
5xx-class failure, so a retry starts completely fresh. **A trade-off
recorded explicitly, not glossed over**: exact replay semantics require
storing the real response body, which for a successful contact
create/update includes contact PII (email/phone/name) — mitigated by the
24-hour TTL (approved default), organization-scoped RLS, no `anon`
access, and a firm rule that `response_body` is never included in
structured logs or generic observability metadata.

**Package/file split**: `packages/database` gained only the migration —
no new exported function, since the already-existing `withTenantContext`
is sufficient plumbing. `apps/web/app/api/v1/_shared/idempotency.ts` (new,
matching the existing `_shared/logger.ts`/`_shared/redaction.ts`/
`_shared/same-origin.ts` convention) owns the actual orchestration and is
deliberately generic — it has no knowledge of `Company`/`Contact`/
`packages/crm`'s error classes/RBAC at all, only "run this callback;
persist what it returns; let what it throws roll back everything." No new
workspace package was created.

**Missing header behavior**: `Idempotency-Key` is optional (approved
decision) — a `POST`/`PATCH` without one is not rejected; it simply
proceeds without idempotency protection (calling `packages/crm` directly,
no reservation). This is a 2.1F-B route-layer decision, not implemented
by anything in this step, since no route exists yet to make it in.

**Tests**: 26 total — 11 schema/RLS (`packages/database/tests/idempotency-keys-schema.test.ts`:
constraints, cross-org isolation, exact grant list, `anon` zero-privilege)
plus 15 behavioral (`apps/web/tests/idempotency.test.ts`: hashing
determinism/PII-freeness, first-execution-then-replay, fingerprint-mismatch
conflict, cross-org independence, the two empirically-proven concurrency/
rollback scenarios as real automated tests — not just the throwaway probe
— expiration reclaim-and-reuse, 4xx persistence, and confirmation the raw
key/request body never appear in the stored row).

**Full validation**: monorepo 739/739 (database 284, auth 196, crm 87,
compliance 26, tenancy 28, web 118); migration-safety 31/31, no override;
lint/typecheck/build clean across all 6 TypeScript packages; `git diff
--check` clean; secret scan clean (the only hits were deliberately-named
test-fixture strings proving the never-persisted-in-plaintext property,
not real secrets).

**Not part of this step**: no Companies/Contacts API routes (2.1F-B), no
DSR `subject_type` dispatch change (2.1F-C), no staging/Production
deployment.

### 2.1F-B — Done (Companies & Contacts API routes)

The 10 CRUD/list routes for Companies and Contacts
(`apps/web/app/api/v1/companies`, `.../companies/[id]`,
`.../contacts`, `.../contacts/[id]`), wiring together `packages/crm`
(2.1D), the CRM RBAC matrix (2.1E), and the Idempotency-Key foundation
(2.1F-A) for the first time at the HTTP layer. Full contract recorded in
`04-API-Architecture.md` §2.4 — not duplicated here.

**Route structure**: each collection (`companies`, `contacts`) follows
the existing `organizations`/`data-subject-requests` handler pattern —
`route.ts` owns pure HTTP concerns (session resolution, same-origin
check, JSON parsing, query-param/header extraction, `withRequestLogging`)
and delegates immediately to a sibling `handlers.ts`, which owns org
context resolution, `can()`, the `packages/crm` call, idempotency
orchestration, and domain-error-to-HTTP mapping — preserving the
repository's existing handler testability convention (handlers are
plain, dependency-injectable async functions, exercised directly in
tests without spinning up a real HTTP server). `resolveActor`,
`mapCrmError`, and the response-shaping helper are defined once in each
resource's collection-level `handlers.ts` and imported by the sibling
`[id]/handlers.ts`, avoiding five-function duplication per resource
while keeping the import direction consistent with how the two files
are always read together.

**Findings during implementation**: none rose to the "architectural
contradiction or new migration required" bar the approved scope named as
a stop condition — the existing `packages/crm`/RBAC/idempotency
primitives from 2.1D/2.1E/2.1F-A composed directly at the route layer
with no schema change and no design reversal.

**Tests**: 43 new (`apps/web/tests/companies-api.test.ts`: 22;
`apps/web/tests/contacts-api.test.ts`: 21), covering auth, RBAC (every
role × every verb, including a pure agency actor and a fully
unaffiliated authenticated user), tenancy (cross-org indistinguishable
from nonexistent, never `403`), full CRUD lifecycle, list/pagination/
filters (including contacts' `companyId`/`ownerId`/`lifecycleStage`),
`POST`/`PATCH` idempotency (exact replay, payload-mismatch conflict,
cross-org key isolation, a demoted actor not receiving a stale replay),
and a 10-point adversarial/mass-assignment list (body-level
`organizationId`/`organization_id`/`id`/`deletedAt`/`enrichmentStatus`
injection, unknown-field silent ignoring, and an unexpected-failure case
proving the transaction rolls back with no persisted idempotency row,
followed by a successful retry). Contacts additionally covers its
identity-invariant rule, duplicate/case-insensitive email conflicts,
email reuse after soft-delete, invalid/cross-org/soft-deleted
`companyId` all mapping to the same `400`, and a contact remaining
readable after its linked company is later soft-deleted. A fixture bug
was found and fixed along the way: the new API-level test fixtures
created memberships via direct SQL (bypassing
`create_organization_with_owner()`), which never set
`public.users.default_organization_id` — the column
`get_my_membership_context()` actually keys its resolution on — causing
19/22 companies tests to fail with `403` before the fixture was
corrected to set it explicitly.

**Full validation**: monorepo 782/782 (database 284, auth 196, crm 87,
compliance 26, tenancy 28, web 161 — web includes the 43 new
companies/contacts tests alongside all pre-existing API/idempotency/
logging/redaction suites, unmodified and unweakened); migration-safety
31/31 migrations checked, **no new migration** (none was needed);
lint/typecheck/build clean across all 6 TypeScript packages plus the
Next.js build (all 4 new route paths confirmed present in the build
output); `git diff --check` clean; secret scan of all new/changed files
clean.

**Not part of this step**: no DSR `subject_type` dispatch change
(2.1F-C), no UI, no agency CRM roll-up access, no search, no offset
pagination, no hard-delete, no Deals/Pipelines/Activities/Notes/Tags, no
RBAC changes, no new migration, no staging/Production deployment, no
commit/push.

**Remaining in Milestone 2.1**: 2.1F-C (DSR `subject_type` dispatch for
Companies/Contacts) and 2.1F-D (full API/adversarial verification pass).
Milestone 2.1 and 2.1F as a whole are **not** complete.

### 2.1F-C — Done (DSR subject_type dispatch)

Closes the gap the 2.1F audit flagged: `preview`/`execute` were hardcoded
to the `subject_type='user'` erasure path regardless of what a
`data_subject_requests` row actually said, so a `subject_type='contact'`
DSR (filable and schema-valid since 2.1C) had no real HTTP fulfillment
path at all — `previewContactErasure`/`executeContactErasure` existed in
`packages/compliance` but nothing in `apps/web` ever called them.

**Dispatch design**: both handlers
(`apps/web/app/api/v1/data-subject-requests/[id]/{preview,execute}/handlers.ts`)
now fetch the DSR tenant-scoped via the already-existing
`getDataSubjectRequestById` (RLS: `organization_id = current_org()`)
**before** making any dispatch decision — a cross-org or nonexistent `id`
is a plain `404`, identical either way, exactly as `GET
/api/v1/data-subject-requests/{id}` already behaved. `subject_type` is
read exclusively from that server-fetched row, never accepted from the
request body/query/header, and never assumed. `subject_type='user'`
routes to `previewUserErasure`/`executeUserErasure`; `'contact'` routes to
`previewContactErasure`/`executeContactErasure`; `'visitor'`/
`'portal_user'` are schema-valid but have no fulfillment logic and return
`400` without either erasure function ever being invoked. The
`data-subject-requests:execute` RBAC check is unchanged and still runs
before the DSR fetch — no new permission key was introduced, and a
non-admin is rejected before any DSR lookup happens at all.

**No new SQL, no new migration**: both `packages/compliance` erasure
function pairs already existed (M1.6, 2.1C) with their own independent
`subject_type` guards inside each `SECURITY DEFINER` function (e.g.
`preview_contact_erasure` raises `'... only supports subject_type=contact
(got %)'` if called against a `user`-type DSR). This step is a pure
application-layer routing change — `packages/compliance`'s public API is
untouched, confirmed by dedicated tests (below) that call the erasure
functions directly, cross-wise, and prove the database-level guard alone
would have blocked an incorrect dispatch even without the new app-layer
check.

**Naming**: `handlePreviewUserErasure`/`handleExecuteUserErasure` were
renamed to `handlePreviewErasure`/`handleExecuteErasure` — the old names
became actively misleading once the same functions started handling
`contact`-type requests too. The one existing test file exercising them
(`apps/web/tests/compliance-api.test.ts`) was updated to the new names
only; none of its assertions changed, since every case there still files
a `subject_type='user'` request.

**Tests**: 12 new
(`apps/web/tests/dsr-erasure-dispatch.test.ts`) — user-path regression
(full lifecycle including the `auth.users` hard-delete and a second
`execute` correctly `409`-ing), contact-path end-to-end (including
verifying the `contacts` row is actually gone after `execute`), a
cross-org contact reference rejected without erasure, `visitor`/
`portal_user` both `400` with the DSR left `pending` (parameterized over
both values), nonexistent DSR `404`, cross-org DSR `404` for both
subject types, RBAC/auth boundaries (`401` unauthenticated, `403`
non-admin, `403` for a user with no org membership at all — before any
DSR lookup), and two explicit database-level-guard tests that call
`previewContactErasure`/`executeContactErasure` against a `user`-type DSR
and `previewUserErasure`/`executeUserErasure` against a `contact`-type
DSR directly, asserting each throws the SQL function's own
`subject_type` guard exception. All 12 passed on the first run against
the now-corrected dispatch logic — no fixture bugs found this time.

**Full validation**: monorepo 794/794 (database 284, auth 196, crm 87,
tenancy 28, compliance 26, web 173 — includes the 12 new dispatch tests
and the renamed-but-otherwise-unchanged `compliance-api.test.ts`
suite); migration-safety 31/31, **no new migration**; lint/typecheck/build
clean across all 6 TypeScript packages plus the Next.js build; `git diff
--check` clean; secret scan of all changed files clean. One transient
full-suite failure was investigated during this step and traced to a
stray Postgres trigger left over in the local dev database from an
**earlier, unrelated 2.1F-B verification run** (a chaos-injection test
in `contact-erasure.test.ts` that failed to reach its own cleanup after
an interrupted run) — not a regression from this step's changes; the
stray trigger was dropped and a clean re-run confirmed all suites green.

**Not part of this step**: no UI, no new permission key, no new SQL
function, no migration, no change to Companies/Contacts CRUD/idempotency,
no staging/Production operation.

**Remaining in Milestone 2.1**: 2.1F-D (full API/adversarial verification
pass). Milestone 2.1 and 2.1F as a whole are still **not** complete.

### 2.1G-A — Done (UI foundation: packages/ui + EntityTable)

Preceded by a fresh UI audit/design report (2.1G) that found: no
`EntityTable` anywhere in the codebase (`docs/12-Implementation-
Milestones.md` had already named this as deferred, separate work); no
design-system code at all despite `docs/07-UI-UX-System.md`'s full
target (Tailwind/shadcn/Radix are absent from every `package.json` in
the repo); `packages/ui` already reserved as a package boundary in
`docs/02-Software-Architecture.md` §4 but never created; and a real
architectural tension between ADR-004 (first-party UI queries tenant
data directly, never via `/api/v1/*`) and a literal reading of "use the
2.1F API" for a future API-client layer — resolved by locking Server
Components/Actions to continue the ADR-004 pattern, reusing 2.1F
handler/domain logic in-process rather than a network hop, deferred to
2.1G-B/C. This step implements only the UI foundation those later steps
will build on.

**`packages/ui`** created — the reserved-but-unbuilt boundary from
docs/02 §4, not a new package invented for "a handful of utilities."
Structure mirrors every existing `packages/*` exactly (`exports`,
`typecheck`/`lint`/`test` scripts, shared `@ai-revenue-os/config`
tsconfig/eslint). `react` is a `peerDependency` (a first for this repo,
since no other package renders React) so the consuming app's own React
instance is what actually renders it.

**`EntityTable`** (`packages/ui/src/entity-table.tsx`) — the smallest
component satisfying the locked contract: `columns`/`rows`/`getRowId`,
`state` (`loading`/`empty`/`error`/`ready`), `emptyMessage`/
`errorMessage`, `rowActions`, and cursor-only pagination
(`hasMore`/`isLoadingMore`/`onLoadMore`/`loadMoreLabel`) — no sorting,
inline editing, saved views, or bulk actions (docs/07 §5's full vision),
deliberately deferred until a second real consumer exists to prove the
abstraction against. Presentation only: no data fetching, no
organization-context resolution, no `can()`, no idempotency, no row-
content logging — verified by the absence of any `@ai-revenue-os/auth`/
`database`/`crm` import anywhere in the package.

**Styling**: plain CSS Modules (`entity-table.module.css`) — **no
Tailwind, shadcn/ui, Radix, or any other UI/component framework was
introduced**, per the locked decision. Only the two already-implemented
global theme tokens are referenced (`--font-sans`, `--primary`); every
other value is a `--entity-table-*` custom property scoped locally to
this file, explicitly commented as local-only rather than implying
docs/07's full token set is wired up globally (it is not). Responsive
strategy is horizontal scroll (not a card-per-row degradation), chosen
specifically to avoid a second rendering path duplicating each column's
`render()` output — documented inline in the CSS file.

**Tests**: 21, in `packages/ui/tests/entity-table.test.tsx`, using
`react-dom/server`'s `renderToStaticMarkup` — bundled with `react-dom`,
which the package needs regardless, so this added **zero new
dependencies**. Covers ready/empty/loading/error rendering, column
`render()` mapping, `rowActions` presence/absence, and every Load-More
button state (present/hidden/disabled/labeled) across `hasMore`/
`isLoadingMore` combinations. **Accepted testing limitation, recorded
here rather than worked around**: this repository has no `jsdom`/
`@testing-library/react`/`happy-dom`/Playwright anywhere in its
dependency tree, and none was added in this step (explicitly locked).
`renderToStaticMarkup` proves real React output for every state and
prop combination, but produces static markup with no attached event
listeners — it cannot verify that clicking the rendered Load More
`<button>` actually invokes the `onLoadMore` callback. That specific
gap remains open, by explicit decision, not by oversight.

**Full validation**: monorepo 815/815 (`ui` 21 new, database 284, auth
196, crm 87, tenancy 28, compliance 26, web 173 — all pre-existing
suites unchanged); migration-safety 31/31, **no new migration**; lint/
typecheck/build clean across all 7 packages; `git diff --check` clean;
secret scan clean.

**Not part of this step**: no Companies UI (2.1G-B), no Contacts UI
(2.1G-C), no final UI verification (2.1G-D), no `apps/web` change at
all (nothing yet imports `EntityTable` — real Next.js build-pipeline
integration is proven for the first time in 2.1G-B), no new dependency
of any kind.

**Remaining in Milestone 2.1**: 2.1F-D (already done, see above), 2.1G-B
(Companies UI), 2.1G-C (Contacts UI), 2.1G-D (final UI/adversarial/
visual verification). 2.1G and Milestone 2.1 as a whole remain **not**
complete.

### 2.1G-B — Done (Companies UI)

Companies list, inline create, detail, edit, and soft-delete —
`apps/web/app/companies` (+`/[id]`) — the first real consumer of
`EntityTable` (2.1G-A) and the first proof that this repository's
first-party UI architecture (ADR-004) and the 2.1F Companies API can be
reused together without a network hop.

**Architecture**: every page is a Server Component that resolves
auth/org context itself (`getAuthenticatedUser`/
`resolveOrganizationContextForUser`), gates access through a pure,
directly-testable `decideCompaniesConsoleAccess` (mirrors
`decideDsrConsoleAccess`/`decideAgencyConsoleAccess` exactly), then
calls the existing 2.1F-B handler functions
(`handleListCompanies`/`handleGetCompany`/`handleCreateCompany`/
`handleUpdateCompany`/`handleDeleteCompany`) **in-process** — no browser
`fetch()` to `/api/v1/companies`, no new HTTP client, ADR-004 fully
preserved. This reuses the real, unduplicated 2.1F RBAC check, mass-
assignment allowlisting, and Idempotency-Key reservation/replay logic;
mutations follow the established `"use client"` form → `"use server"`
action → framework-independent `*-logic.ts` split (mirrors
`file-dsr-logic.ts`/`create-client-org-logic.ts`). No technical
incompatibility was found reusing the handlers this way — the only
wrinkle is unwrapping a `NextResponse` (`.status`/`.json()`) instead of
a plain return value, not a blocker.

**Cursor pagination**: link-based (`?cursor=...`), not `EntityTable`'s
`onLoadMore` client callback — a Server Component has nothing to wire
that callback to without browser fetch, which would violate ADR-004.
`EntityTable` needed **no change**: omitting `onLoadMore` already hides
its Load More button entirely (already proven in 2.1G-A's own tests), so
the page simply renders a plain `<Link>` "Load more" preserving the
active `ownerId` filter alongside the new cursor.

**Owner filter/selection — a real gap found during this step**: no
existing tenancy/auth primitive returns other organization members'
display names — `public.users` RLS is strictly self-scoped (`id =
auth.uid()`, M1.2), so even an org_admin cannot read a teammate's
email/`full_name` through the ordinary `withTenantContext` + RLS path a
join would need. The new `owner-options.ts` returns only what IS
legitimately visible — the org-scoped list of active member user ids
(`memberships` RLS) — with **no name, no email**. The owner
filter/select therefore shows raw user ids, a real, reported UX
limitation, not silently worked around with a new migration/RLS
policy/SECURITY DEFINER function (any of which would need separate
explicit approval this step did not seek).

**Delete UX**: a two-step disclosure (button reveals a confirm panel;
both real, keyboard-reachable buttons) — no Dialog primitive exists and
none was added. Copy says the company is removed from the active CRM
and can be restored; it never says "permanently," "erase," or "GDPR."
Soft-delete only — `deleteCompanyForResolvedContext` calls
`handleDeleteCompany` alone; no `packages/compliance` import anywhere
in `apps/web/app/companies/**`.

**Styling**: plain CSS Modules (`companies.module.css`), no Tailwind/
shadcn/Radix. Only `--primary`/`--font-sans` referenced from the real
global tokens; everything else is a locally-scoped value, same
discipline as `packages/ui`.

**Tests**: 27 new (`apps/web/tests/companies-console.test.ts`) — access
decision for all 6 roles, `listActiveOwnerOptions` (active-org-only,
excludes removed memberships), create (mass-assignment/forged-org
ignored, blank-name and non-numeric-employee-count rejected safely,
unauthorized rejected, same-key replay reuses the created row with no
duplicate insert, a new key creates a genuinely new row), update
(touched field changes, untouched field round-trips its *existing*
value rather than becoming null, an explicitly emptied nullable field
becomes null, `org_viewer` forbidden, invalid owner surfaces a safe
message never containing raw SQL/constraint text, same-key replay is
idempotent), delete (`org_admin` success + subsequent 404, `org_member`
forbidden, the row is confirmed still physically present with
`deleted_at` set — never a hard delete), and security (pure agency
actor denied at the access decision, unaffiliated user denied every
mutation, a demoted actor's stale key cannot replay past a since-revoked
membership). Deliberately does **not** re-test
`handleListCompanies`/`handleGetCompany`'s own list/pagination/filter/
404/tenancy behavior — `companies-api.test.ts` (22 tests, unmodified)
already covers that exhaustively and these pages call those exact same
functions with no additional logic beyond URL/param assembly;
duplicating that suite here would test nothing new.

**Full validation**: monorepo 842/842 (`ui` 21, database 284, auth 196,
crm 87, tenancy 28, compliance 26, web 200 — includes the 27 new
Companies UI tests plus the unmodified 22 `companies-api.test.ts` and
every other pre-existing suite); migration-safety 31/31, **no new
migration**; lint/typecheck/build clean across all 7 packages —
critically, a real Next.js production build (not just `tsc`/`vitest`)
now proves `packages/ui`'s `EntityTable` (including its CSS Modules
import) compiles cleanly through Next's actual SWC bundler for the
first time, closing the one integration gap 2.1G-A had explicitly left
open; `git diff --check` clean; secret scan clean. One transient
failure during regression was traced to a stray Postgres trigger left
over from an interrupted, unrelated prior test run (the same class of
issue recorded in the 2.1F-C entry above) — not caused by this step;
removed, and a clean re-run confirmed all suites green.

**Not part of this step**: no Contacts UI (2.1G-C), no final UI
verification (2.1G-D), no new `packages/ui` component, no new
permission, no schema/migration change, no staging/Production
operation.

**Remaining in Milestone 2.1**: 2.1G-C (Contacts UI), 2.1G-D (final UI/
adversarial/visual verification). 2.1G and Milestone 2.1 as a whole
remain **not** complete.

---

## Overall Phase 1 Recommendation

| Milestone | Verdict |
|---|---|
| M1.1 — Repo & Environment Bootstrap | **GO** |
| M1.2 — Core Tenancy Schema + RLS + Tenant-Context | **GO** — conditional on the Supavisor pooling-behavior spike passing before close |
| M1.3 — Auth & Signup Flow | **GO** — conditional on a real (non-stubbed) transactional email provider |
| M1.4 — Agency Hierarchy + Theming | **GO** |
| M1.5 — RBAC Enforcement | **GO** — with automated route-coverage check as an exit criterion |
| M1.6 — GDPR Primitives | **GO** — with a dry-run/preview mode added to DSR execution as a scope addition |
| M1.7 — Platform Infrastructure | **GO** |
| M1.8 — Observability & Dependency Hygiene | **GO** |
| M1.9 — CI/CD Hardening | **GO** |

**Every milestone is GO.** Three carry an explicit condition attached to *closing* that milestone (M1.2's pooling spike, M1.3's real email provider, M1.6's dry-run mode) — none of these block *starting* Phase 1, but none of the three affected milestones should be marked done without them. This is not a rubber stamp: the two highest-stakes items in the entire plan (the RLS/pooling mechanism in M1.2, and irreversible deletion in M1.6) are exactly where this panel is asking for evidence, not just code review, before sign-off.

Implementation may begin at **M1.1**.
