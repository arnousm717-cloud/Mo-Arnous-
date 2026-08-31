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

### 2.1G-C — Done (Contacts UI)

Contacts list, inline create, detail, edit, and soft-delete —
`apps/web/app/contacts` (+`/[id]`) — built by mirroring 2.1G-B's
Companies UI pattern exactly: same ADR-004 architecture (Server
Component → resolved context → pure access decision → Server Action →
framework-independent `*-logic.ts` → the existing 2.1F-B Contacts
handlers, in-process, no browser `fetch()` to `/api/v1/*`), same
`EntityTable` usage, same link-based cursor continuation, same two-step
delete confirmation with non-GDPR copy, same CSS Modules discipline —
imported directly from `../companies/{owner-options,companies.module.css}`
without modifying either file, avoiding a second copy of logic that
isn't Companies-specific (active-member listing, shared styling).

**Filters**: `companyId`/`ownerId`/`lifecycleStage`, all three preserved
together across the filter form and cursor "Load more" links, matching
`contacts-api.test.ts`'s already-proven filter behavior — no new filter
logic, no offset, no search, no invented total counts.

**Company relationship — a real edge case found and handled**: `listCompanies`
(and therefore the new `listActiveCompanyOptions`) already excludes
soft-deleted companies by design (2.1D), so a contact whose linked
company is later soft-deleted would otherwise have its `companyId`
silently drop out of the edit form's `<select>` options — on resubmit,
an unrelated field change could then silently null out a real, still-
valid `companyId` the user never intended to touch. Fixed with a small,
targeted fallback in `ContactEditForm`: if the contact's stored
`companyId` isn't in the active options list, it's added as a synthetic
option (id-only, no name resolvable) so it stays selected and is never
lost on resubmit unless the user deliberately picks something else. No
cascade-delete behavior was invented — the contact's `companyId` is
never touched by a company's own soft-delete, exactly as the existing
backend already guarantees.

**Duplicate email / identity invariant / invalid relationship**: none
reimplemented client-side — `mapCrmError`'s existing
`DuplicateContactEmailError` → 409 and `ValidationError`/
`InvalidCompanyRelationshipError`/`InvalidOwnerError` → 400 mapping is
surfaced to the form as-is. A short "provide at least one of first
name, last name, or email" hint is UX only.

**Owner-display limitation**: unchanged and still open — Contacts reuses
`listActiveOwnerOptions` as-is (imported, not modified), so the owner
filter/select shows raw user ids for the same reason recorded in the
2.1G-B entry above. No `users` RLS change, no SECURITY DEFINER function,
no migration were made or attempted here either, per the standing
instruction. Still to be resolved separately before Milestone 2.1
closeout.

**Tests**: 31 new (`apps/web/tests/contacts-console.test.ts`) — access
(6 roles), `listActiveCompanyOptions` (soft-deleted exclusion), create
(mass-assignment ignored, identity invariant rejected, duplicate email
409 + case-insensitive, invalid owner and cross-org company relationship
both produce safe non-leaking errors, unauthorized rejected, same-key
replay reuses the row with no duplicate insert, new key creates a
genuinely new row), update (partial-update semantics, explicit-clear-to-
null, `org_viewer` forbidden, duplicate-email-on-update rejected,
invalid company relationship rejected safely, idempotent replay), delete
(`org_admin` success + subsequent 404, `org_member` forbidden, confirmed
still physically present with `deleted_at` set), the company-relationship-
safety edge case above (contact stays readable and keeps its stored
`companyId` after the linked company is soft-deleted), and security
(pure agency actor denied, unaffiliated user denied, demoted actor's
stale key rejected). All 31 passed on the first run. Deliberately does
not re-test `handleListContacts`/`handleGetContact`'s own behavior —
`contacts-api.test.ts` (21 tests, unmodified) already covers it
exhaustively and these pages add no logic beyond URL/param assembly.

**Full validation**: monorepo 873/873 (`ui` 21, database 284, auth 196,
crm 87, tenancy 28, compliance 26, web 231 — includes the 31 new
Contacts UI tests plus the unmodified 22 `companies-api.test.ts`, 21
`contacts-api.test.ts`, 27 `companies-console.test.ts`, and every other
pre-existing suite); migration-safety 31/31, **no new migration**;
lint/typecheck/build clean across all 7 packages — a real Next.js
production build again confirms clean compilation, now with `/contacts`
and `/contacts/[id]` alongside the existing routes; `git diff --check`
clean; secret scan clean. No transient/flaky failures this run.

**Not part of this step**: no change to Companies UI files (only
imported from), no `packages/ui` change, no new permission, no schema/
migration/RLS change, no staging/Production operation.

**Remaining at this point**: 2.1G-D (final UI/adversarial/visual
verification) — completed next, see the Milestone 2.1 closeout below.

### Milestone 2.1 — Final Closeout

2.1G-D (final UI/adversarial/visual verification, commit `d4e6d49`)
re-audited the full Companies/Contacts implementation from source rather
than trusting prior reports, found and fixed one small non-architectural
responsive CSS gap (`flex-wrap` missing on the filter/confirm-action
rows) and two stale documentation claims in `docs/04`, and added 4
idempotency-conflict tests closing a genuine UI-layer coverage gap —
monorepo 877/877, migration-safety 31/31, GO for closing 2.1G.

The Milestone 2.1 final closeout audit (commit `9515b0a`) independently
re-verified schema, RLS/tenancy, RBAC, `packages/crm`, the API,
idempotency (including a fresh re-run of the real two-connection
concurrency test), DSR/compliance dispatch, and both UI features from
source — no blocking gap found, one more small `docs/04` staleness
corrected (the general error-envelope/idempotency-routing principles had
never been revisited to match what actually shipped). GO for staging
deployment.

**Staging live verification surfaced one real bug, since found, fixed,
and re-verified live**: a Contact linked to a Company that had since
been soft-deleted rendered the Company column as the raw `companyId`
UUID instead of a readable label — and, found while proving the fix's
own required regression coverage (not assumed from the bug report
alone), any edit to such a contact, even one touching an unrelated
field, failed outright with `InvalidCompanyRelationshipError`, because
the edit form always resent the unchanged `companyId` and
`updateContact` correctly-but-too-broadly re-validates every *provided*
`companyId` as currently active. Fixed at commit `b814e27`:

- A new, tenant-scoped, read-only `getCompanyByIdIncludingDeleted`
  (`packages/crm`) resolves a soft-deleted company's name for display —
  never used by the active list/filter/relationship-validation paths,
  which continue to exclude soft-deleted companies exactly as before.
- Both the Contacts list and detail pages render `"<name> (deleted)"` —
  never the raw id, even for a genuinely unresolvable reference (generic
  `"Deleted company"` fallback).
- The edit form now carries a hidden `originalCompanyId` marker so
  `update-logic.ts` can tell "resubmitted unchanged" apart from "a
  genuine reassignment" — only a real reassignment is validated as
  pointing to an active company; an unrelated edit no longer touches the
  relationship at all, closing the update-failure bug. A genuine
  reassignment to an invalid company is still correctly rejected
  (verified by a dedicated test).
- No schema, migration, RLS, RBAC, or API-contract change. Monorepo
  887/887 (877 + 3 new `packages/crm` tests + 7 new UI-console tests),
  migration-safety 31/31, lint/typecheck/build clean.

**Manually verified live in staging** (Vercel Preview deployment for
commit `b814e27`, Ready): logged in with the staging test account;
`/contacts` loaded; the previously-affected contact ("Company Relation
Test") remained visible with its Company column reading exactly
`"Staging Test Company (deleted)"` — never the raw UUID — on both the
list and detail pages; an unrelated field edit (phone → `0612345678`)
saved successfully with no `InvalidCompanyRelationshipError`; the
contact remained linked to the deleted company; a full browser refresh
confirmed both the phone change and the company relationship persisted.

**Operational note, not a deviation from this milestone's own scope**:
the Vercel project is currently configured to auto-deploy every push to
`main` as a Production deployment — commit `b814e27` therefore also
became visible as a Production deployment automatically, purely as a
side effect of the ordinary `main` push already covered by this
milestone's approved commit/push gates. No deliberate Production
deployment, promotion, redeploy, alias change, environment-variable
change, schema change, migration, or Supabase Production operation was
performed. This auto-deploy behavior is a standing fact about the
current Vercel project configuration, not something this milestone's
work introduced or changed.

**Owner-display limitation**: unchanged from the 2.1G-B/C/D entries
above and the final closeout audit — Companies/Contacts owner
filters/selects still show raw user UUIDs (`public.users` RLS remains
self-scoped only). Non-blocking, tracked separately, not touched by
this fix.

**Milestone 2.1: CLOSED.** Every gate has now passed: implementation
complete, final source-level audit PASS, staging database state
verified live with zero drift, and — following this fix — staging
*application* behavior for the one issue staging verification actually
surfaced is now also confirmed PASS live, not just by local tests.
Remaining work (owner display names) is explicitly non-blocking and
tracked as its own future, separately-scoped item, not part of
Milestone 2.1's own requirements.

---

## Milestone 2.2 — Deals & Pipelines

Milestone 2.2 is **Deals & Pipelines (kanban)**. **Status: CLOSED** — full
implementation (2.2-P0 through 2.2H) is complete; see the "Milestone 2.2
— Overall Closeout" entry at the end of this section for the final
sign-off record and evidence. The remainder of this section is kept as
written during planning and implementation: the six design decisions
frozen up front, followed by each sub-milestone's own entry in the order
it was actually built.

Six design decisions were frozen before any implementation began:

1. **Owner display** resolved first, as its own prerequisite (2.2-P0,
   below), rather than deferred into the Deals UI itself.
2. **Pipeline RBAC**: distinct `pipelines:read/create/update/delete` keys,
   not folded into `deals:*`.
3. **Pipeline/stage deletion**: soft delete only (`deleted_at`), no hard
   `DELETE` path, active selectors exclude deleted rows.
4. **Default pipeline**: every org gets exactly one seeded "Sales
   Pipeline" (5 deterministic stages), idempotent, safe for existing orgs.
5. **Pipeline-stage API**: nested under `/api/v1/pipelines/{id}/stages`.
6. **Currency**: stored per deal, ISO-4217-shaped, default `EUR`, no FX.

Also frozen: `stage_id` is the single source of truth for a deal's
won/lost state — `deals.status` is fully derived by the domain layer from
`stage_id`, never independently settable via the API.

All six decisions above are implemented — see each sub-milestone entry
below, in build order, starting with decision 1's own prerequisite step.

### Milestone 2.2-P0 — Organization Member Identity Display

**Problem.** Since 2.1, Companies/Contacts owner selectors and the
"assigned owner" display showed a raw `auth`/`public.users` UUID —
`public.users`' own RLS is strictly self-scoped (`id = auth.uid()`,
locked since M1.2), so no existing query path could resolve a
teammate's name or email for display. This was accepted as a known,
non-blocking limitation at Milestone 2.1's close and explicitly
scoped out as a separate prerequisite before Deals (which needs the
same capability for its own owner field) rather than fixed ad hoc.

**Why a SECURITY DEFINER function, not broadened `public.users` RLS.**
Broadening `public.users`' RLS policy to let any org member read any
other org member's row would be a permanent, blast-radius-wide change —
every future query against `public.users` would inherit it, and every
column on that table (not just the three an owner selector needs) would
become newly readable by teammates. A narrow, purpose-built function
keeps the change local and legible instead: it exposes exactly
`user_id`/`email`/`full_name`, nothing else, only for organizations the
caller is independently verified to belong to, and `public.users`' own
policy is untouched. This mirrors the exact discipline already
established by `_validate_contact_erasure`/`_validate_user_erasure`:
`organization_id` is passed as an explicit parameter but is **never**
trusted as the security boundary by itself — the caller's own active
membership in that exact organization is independently re-derived
inside the function via `auth.uid()` on every call.

**Function contract** — one additive migration
(`20260814090000_create_organization_member_identity_function.sql`,
32 migrations total):

```sql
create or replace function public.get_organization_member_identities(p_organization_id uuid)
returns table (user_id uuid, email text, full_name text)
language plpgsql
security definer
set search_path = public
```

- Raises if `auth.uid()` is null (caller must be authenticated).
- Raises if the caller has no `status = 'active'` membership in
  `p_organization_id` — checked independently of the parameter's value,
  so it cannot be used to enumerate another org's members.
- Returns only rows for `status = 'active'` memberships of that exact
  org — a removed member (the caller's own, or a target row) is excluded.
- `EXECUTE` revoked from `PUBLIC`, granted only to `authenticated`. The
  `REVOKE` is redundant with `20260812140000`'s cluster-scoped
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` (which already denies
  `PUBLIC` execute on any new function `postgres` creates) but is
  restated explicitly so this migration's own end state is
  self-contained, matching that same migration's own restatement
  precedent for grants.
- `public.users`' own RLS (`id = auth.uid()`) is unchanged — verified
  both by not touching it and by a dedicated test confirming a user
  still cannot `SELECT` a teammate's row directly.

**Application layer.** One resource-neutral abstraction, split across
two files specifically to satisfy Next.js's client/server module
boundary:

- `apps/web/app/_shared/owner-options.ts` — server-only.
  `listActiveOwnerOptions(ctx)` calls the function above through the
  existing `withTenantContext` path (ADR-004 — no new data-access
  pattern). Imports `@ai-revenue-os/database`, so importing any real
  (non-type) export from this file into a `"use client"` component pulls
  `pg` — and transitively Node's `net`/`tls` — into the browser bundle
  and fails the production build. Discovered by the build itself
  failing with `Module not found: Can't resolve 'net'`, not by
  inspection.
- `apps/web/app/_shared/owner-option.ts` — pure, zero server imports.
  `OwnerOption` type, `withResolvedOwnerFallback`, `resolveOwnerLabel`
  (display-label strategy: full_name when non-empty, else email, never
  a raw UUID). Client components (`company-edit-form.tsx`,
  `contact-edit-form.tsx`, the two create forms) import only from this
  file; server components (`page.tsx`/`[id]/page.tsx`) import
  `listActiveOwnerOptions` from the server-only file and the pure
  helpers from this one.

Companies and Contacts both consume this same abstraction — no
duplicated owner-resolution logic between them. RBAC, create/update
validation, and the API contract are all unchanged; this is a display-
layer change only.

**Two related bugs fixed proactively** (found while implementing, not
reported separately):
- A read-only detail view (e.g. `org_viewer`) previously only fetched
  owner options when the viewer could also update the record, so it
  could never resolve an owner's label at all. Fixed by fetching
  whenever the viewer can update *or* the record has an owner set.
- An edit form's owner `<select>` whose `defaultValue` matched no
  `<option>` (owner's membership since deactivated) would silently
  submit its first option's value on save, clearing a real owner
  assignment as a side effect of an unrelated field edit —
  `withResolvedOwnerFallback` keeps the current owner selectable with a
  safe `"Unknown member"` label instead.

**Verification.** Full monorepo 889/889 (database 297 incl. 12 new
`organization-member-identities` tests; auth 196; crm 90; tenancy 28;
compliance 26; web 252 incl. 10 new `owner-options` tests), migration-
safety 32/32, lint clean, typecheck clean, production build clean
(after the client/server split above). `git diff --check` clean, no
secrets in changed/new files.

**Explicitly not done in this step**: 2.2A has not started; no
`deals`/`pipelines`/`pipeline_stages` table, RLS policy, RBAC key, or
API route exists; `docs/12`'s milestone map is unchanged.

**Milestone 2.2-P0: DONE.** Milestone 2.2 overall remains open —
decisions 2–6 above are frozen but unimplemented.

### Milestone 2.2A — Deals & Pipelines database foundation

Schema, RLS, grants, and default-pipeline seeding only — no domain layer
(`packages/crm` deals module), no RBAC permission keys, no API routes, no
UI. **2.2B has not started.**

**Migrations** (three, additive only):

1. `20260814100000_create_pipelines_deals_schema.sql` — `public.pipelines`,
   `public.pipeline_stages`, `public.deals`; adds
   `contacts_organization_id_id_key unique (organization_id, id)` to
   `public.contacts` (required so `deals.primary_contact_id` has a
   composite-unique target, mirroring `companies`' own pre-existing one);
   `set_updated_at()` triggers on all three new tables (the same M1.2/2.1B
   trigger function, no new helper).
2. `20260814100100_enable_pipelines_deals_rls.sql` — RLS + grants, exact
   companies/contacts precedent: `SELECT`/`INSERT`/`UPDATE` own-org
   policies, no `DELETE` policy, `authenticated` gets exactly
   `SELECT, INSERT, UPDATE`, `anon` gets nothing.
3. `20260814100200_create_seed_default_pipeline_function.sql` —
   `seed_default_pipeline()`, its integration into
   `create_organization_with_owner()`, and the existing-organization
   backfill.

**Schema** (`docs/03-Database-Architecture.md` §2.2's target columns,
implemented exactly):

- `pipelines(id, organization_id, name, is_default, deleted_at,
  created_at, updated_at)` + `unique(organization_id, id)`.
- `pipeline_stages(id, organization_id, pipeline_id, name, sort_order,
  probability, is_won_stage, is_lost_stage, deleted_at, created_at,
  updated_at)` + `unique(organization_id, id)` + `unique(pipeline_id,
  id)`.
- `deals(id, organization_id, company_id, primary_contact_id, pipeline_id,
  stage_id, amount, currency, probability, expected_close_date, status,
  owner_id, deleted_at, created_at, updated_at)`.

**Composite-FK / tenant-safety design** — every cross-table reference is
a composite FK, never a bare single-column one, matching
`contacts_company_org_fk`'s precedent exactly:

- `pipeline_stages.pipeline_id` → `pipelines(organization_id, id)`
  (`pipeline_stages_pipeline_org_fk`, `ON DELETE CASCADE` — stages have no
  meaningful existence without their pipeline, unlike `deals.company_id`'s
  genuinely optional relationship).
- `deals.company_id` → `companies(organization_id, id)`, `ON DELETE SET
  NULL` (nullable, same as `contacts.company_id`).
- `deals.primary_contact_id` → `contacts(organization_id, id)`, `ON DELETE
  SET NULL` (nullable).
- `deals.pipeline_id` → `pipelines(organization_id, id)`
  (`deals_pipeline_org_fk`, tenant-safety half) — `ON DELETE RESTRICT`
  (explicit; `pipeline_id` is `NOT NULL`, so `SET NULL` is not an option).
- `deals.stage_id` → `pipeline_stages(organization_id, id)`
  (`deals_stage_org_fk`, tenant-safety half) — `ON DELETE RESTRICT`.
- `deals.(pipeline_id, stage_id)` → `pipeline_stages(pipeline_id, id)`
  (`deals_stage_pipeline_fk`, pipeline-**membership**-safety half — proves
  the stage actually belongs to *this deal's own pipeline*, not merely to
  the same organization; without it, a stage from a different pipeline in
  the same org could be assigned to a deal) — `ON DELETE RESTRICT`.

All six adversarial scenarios the frozen plan required (cross-org
company/contact/pipeline/stage, same-org-wrong-pipeline stage) were
verified empirically against a real local Postgres before being written
into the permanent test suite, and are covered by dedicated tests.

**CHECK constraints**: `deals_currency_format` (`currency ~
'^[A-Z]{3}$'`, format-only, not a fixed enum — decision 6), default
`'EUR'`; `deals_probability_range` / `pipeline_stages_probability_range`
(`NULL` or `0..100`); `deals_status_allowed` (`open`/`won`/`lost`);
`pipeline_stages_not_won_and_lost` (`NOT (is_won_stage AND
is_lost_stage)`).

**RLS**: `organization_id = current_org()` on `SELECT`/`INSERT`/`UPDATE`,
no `DELETE` policy, on all three tables — identical shape to
companies/contacts. No agency roll-up view added (out of 2.2A's scope).

**Grants**: `authenticated` → `SELECT, INSERT, UPDATE` only, verified via
`information_schema.role_table_grants`; `anon` → nothing; `TRUNCATE`/
`REFERENCES`/`TRIGGER` already denied to both roles by M1.9's
schema-scoped `ALTER DEFAULT PRIVILEGES` (proven to correctly cover
future tables, unlike the function-privilege analog from 2.2-P0) — no
explicit revoke needed for these three new tables.

**`seed_default_pipeline(p_organization_id uuid)`** — internal privileged
helper, deliberately **not** a general `authenticated` RPC (unlike
2.2-P0's `get_organization_member_identities`, which performs its own
independent membership check before returning anything). This function
takes a bare organization id with **no caller-identity check of its
own** — its only two legitimate callers,
`create_organization_with_owner()` and this migration's own backfill
loop, both run as `postgres`, which owns this function and therefore
retains full rights on it regardless of any `GRANT`/`REVOKE` state
(ordinary PostgreSQL owner-privilege semantics — not a bypass this
migration introduces). `EXECUTE` is revoked from `PUBLIC` and
**deliberately not granted to `authenticated`** — verified empirically
(`has_function_privilege` for `anon`/`authenticated`/`PUBLIC` all `false`)
and by a dedicated test proving an authenticated session gets
`permission denied` calling it directly, even for its own organization.
`SECURITY DEFINER`, `SET search_path = public` — confirmed via
`pg_proc`.

Ensures exactly one active default "Sales Pipeline" (5 stages: Lead(10) /
Qualified(20) / Proposal(30) / Won(40, `is_won_stage`) / Lost(50,
`is_lost_stage`)) for a given organization. Idempotent — a second call
no-ops if an active default already exists (verified by a dedicated
test).

**Concurrency**: uses `pg_advisory_xact_lock(hashtext(p_organization_id::
text))` to serialize concurrent callers targeting the *same*
organization, released automatically at the end of the calling
transaction — deliberately not a check-then-insert-and-catch-the-
unique-violation pattern, which would leave a caller's transaction in
Postgres's aborted state without an explicit `SAVEPOINT`. Proven with a
genuine two-real-connection test: both concurrent calls for the same new
organization complete successfully (`fulfilled`, not one erroring), and
the result is exactly one pipeline with exactly 5 stages — never a
duplicate or partial set. Two *different* organizations never block each
other (separate lock keys).

**`create_organization_with_owner()` integration**: extended via
`CREATE OR REPLACE` (same signature, OID/grants preserved) — one line
added (`perform public.seed_default_pipeline(v_org_id);`) immediately
before the final `RETURN`, after the existing
organization/membership/`default_organization_id`/`membership.created`-
event writes. If seeding raises, the entire transaction rolls back with
it — the same atomicity guarantee already proven for the
`membership.created` event insert (same function, same transaction). All
prior behavior (NULL-safe caller-identity guard, membership creation,
`default_organization_id`, event emission) is unchanged and re-verified
by a dedicated regression test.

**Existing-organization backfill**: a `DO` block at the end of the third
migration calls the *same* `seed_default_pipeline()` function once per
existing organization — never a second, duplicated definition of "Sales
Pipeline" + 5 stages. Ran against zero pre-existing organizations in this
local environment (a freshly-exercised database has none at any given
time); the mechanism itself — seeding an organization with zero prior
pipeline rows, exactly the pre-2.2A shape — is proven by a dedicated
test.

**Default-pipeline invariant — stated precisely, not overstated**: the
partial unique index (`pipelines_org_active_default_idx`, `WHERE
is_default AND deleted_at IS NULL`) guarantees **at most one** active
default pipeline per organization, always, regardless of write path. The
seed/signup integration guarantees **at least one** at
organization-creation/backfill time. Neither, nor both together,
guarantees **exactly one forever**: 2.2A ships the table grants required
by this step's own spec (`authenticated` has raw `UPDATE` on
`pipelines`), but no RBAC/domain-layer rule yet exists to stop an
authenticated caller from setting the organization's only default
pipeline's `is_default` to `false`, or soft-deleting it — both were
proven to **succeed today** by dedicated tests, producing zero active
default pipelines for that organization. This is a known, deliberate gap
for 2.2B (or a later step) to close, not a bug fixed here — enforcing
"exactly one forever" at the DB layer (e.g. a trigger blocking the last
active default from being unset/deleted) would be materially more
machinery than this step's frozen scope approved, so it was not added.

**Status-derivation boundary — stated precisely, not overstated**:
`deals.status` has no `CHECK`/trigger tying it to
`pipeline_stages.is_won_stage`/`is_lost_stage`. Direct SQL can create a
schema-valid deal with `status = 'open'` referencing a won-flagged
`stage_id` — proven by a dedicated test. Deriving/enforcing that
relationship from `stage_id` (the frozen Milestone 2.2 design: `stage_id`
is the single source of truth, `status` is domain-layer-derived, never
independently settable via the API) is explicitly the future 2.2B
domain layer's (`packages/crm`) responsibility, never this schema.

**Verification**: full monorepo 1003/1003 across all 7 tested packages
(database 390, incl. 90 new: 50 schema + 22 RLS + 18 seed-function/
concurrency/invariant tests; auth 196; crm 90; tenancy 28; compliance 26;
web 252; ui 21) — the only new tests added this step are the 90 in
`packages/database`; no test in any other package was touched,
weakened, or deleted. Migration-safety 76/76 (3 new migration files, all
classified safe, no override needed), lint/typecheck/production build
all clean, `git diff --check` clean, no secrets in new files.

**Milestone 2.2A: DONE** (database foundation only). **Milestone 2.2
overall remains open** — no domain layer, RBAC keys, API routes, or UI
exist yet for Deals/Pipelines; **2.2B has not started.**

### Milestone 2.2B — Deals & Pipelines domain layer (`packages/crm`)

Domain logic only — no RBAC permission keys, no API routes, no UI. No
2.2A migration was modified; three new source files
(`pipelines.ts`/`pipeline-stages.ts`/`deals.ts`) plus one shared
extraction (`relationship-validation.ts`), exported through
`packages/crm/src/index.ts`. **2.2C has not started.**

**Closes the two gaps 2.2A deliberately deferred, both at the domain
layer only:**

1. **Status derivation.** `deals.status` is never an independent create/
   update input — `CreateDealInput`/`UpdateDealInput` have no `status`
   field at all, and every function only reads the specific named fields
   it expects off `input` (never spreads/forwards a raw object), so even
   a smuggled `status` key is structurally ignored (proven by a dedicated
   test). On `createDeal`, status is derived from the target stage's
   `is_won_stage`/`is_lost_stage` flags. On `updateDeal`, status is
   re-derived whenever `stageId` genuinely changes, written atomically
   together with `stage_id` in the same `UPDATE`. `updatePipelineStage`
   cascades a status recompute to every deal referencing that stage (see
   below) when a stage's own classification changes.
2. **Zero-default prevention.** `updatePipeline` has no `isDefault` field
   in its input type at all — switching the default is exposed only
   through `setDefaultPipeline`, which unsets the old default then sets
   the new one in one transaction, never transiently violating the
   partial unique index. `softDeletePipeline` rejects deleting the
   organization's current active default with a typed
   `CannotDeleteDefaultPipelineError`, requiring `setDefaultPipeline` to
   switch the default first — this package never auto-selects a
   replacement.

**The precise, non-overstated claim**: *all supported `packages/crm`
domain operations preserve exactly one active default pipeline for
organizations initialized through the approved seed flow
(`seed_default_pipeline()`).* The database itself still only guarantees
**at most one** (the partial unique index, unchanged from 2.2A) — direct
SQL bypassing this package can still produce zero active defaults,
exactly as documented in the 2.2A record above. 2.2B closes the gap for
every operation *this package* exposes, not at the database layer, and
this doc does not claim otherwise.

**Pipeline-stage referenced-by-active-deals decision.** `softDeletePipelineStage`
does **not** reject deleting a stage still referenced by active deals.
This resolves Section 5's open question in favor of the design already
frozen earlier in Milestone 2.2 planning (see this doc's own Milestone
2.2 design record, decision 3): *"unrelated deal edits must keep working
when pipeline/stage is soft-deleted."* Deals keep their `stage_id`/
`pipeline_id` pointing at the soft-deleted row — mirroring the existing
Companies/Contacts precedent (a soft-deleted company's dependent
contacts keep their `companyId` unchanged) — and `updateDeal`'s own
partial-update semantics (below) are what keep unrelated edits to those
deals working. `softDeletePipeline` mirrors this same decision for
non-default pipelines. Neither soft-delete cascades to the other
direction: deleting a pipeline never cascades to its stages, and stage
soft-delete never touches deals.

**Stage-classification cascade.** When `updatePipelineStage` changes
`isWonStage`/`isLostStage` (final value differs from current — a genuine
classification change, not merely resupplying the same value), it
recomputes `status` for every deal referencing that stage, org+stage
scoped, in the same transaction. **Deliberately includes soft-deleted
deals**, not just active ones — status is treated as a pure derived/
denormalized field kept unconditionally in sync with its stage's current
classification, decoupled from the deal's own soft-delete lifecycle.
This repository's soft-delete convention treats `deleted_at` as ordinary,
recoverable deletion (restoration is a first-class, tested operation
elsewhere in this codebase) — keeping status in sync even while deleted
means a restored deal shows the *correct* current status, never one that
went stale while it was deleted. Proven by a dedicated test. The cascade
uses `status is distinct from $1` so it never touches (and never bumps
`updated_at` on) a deal whose status already matches.

**Relationship partial-update semantics (`updateDeal`).** Applies the
Milestone 2.1 Contacts lesson natively, not via an external hidden-field
workaround: for `companyId`/`primaryContactId`/`ownerId`, a field is only
revalidated when its supplied final value genuinely **differs** from the
currently stored value. An unchanged relationship — even one that has
since become inactive (soft-deleted company/contact, removed membership)
— is never revalidated merely because the field is present in the patch,
proven by dedicated tests for all three fields (an unrelated edit
succeeds after the linked company/contact is soft-deleted or the owner's
membership is removed, whether the field is omitted entirely or
resupplied unchanged). A genuine reassignment (including reassigning to
`null`) is always validated, and reassigning to an already-soft-deleted/
inactive target always fails. `pipelineId`/`stageId` are coupled and
never nullable: reassigning `pipelineId` to a genuinely different
pipeline requires `stageId` to be supplied in the same call (rejected
with a `ValidationError` otherwise — this package never guesses a
replacement stage), and the two are always written together so they can
never disagree even transiently within one operation.

**Company/contact consistency decision.** When both `companyId` and
`primaryContactId` are supplied, this package does **not** require the
contact to belong to that company. Neither the frozen Milestone 2.2
design nor the existing Contacts model (`contacts.company_id` is an
independently optional relationship) requires this constraint, so it was
not invented. Tenant safety remains mandatory regardless — both fields
are independently validated against the caller's own organization.

**Typed errors added**: `InvalidContactRelationshipError`,
`InvalidPipelineRelationshipError`, `InvalidStageRelationshipError`,
`CannotDeleteDefaultPipelineError` — no near-duplicate classes created;
`InvalidStageRelationshipError` alone covers "does not exist," "belongs
to another organization," "is soft-deleted," AND "belongs to a different
pipeline," mirroring the database's own two-composite-FK design at the
domain layer.

**Refactor, not scope creep**: `contacts.ts`'s own private
`validateCompanyRelationship` was moved, unchanged, into the new shared
`relationship-validation.ts` — `deals.ts` needed the identical check a
second time, matching the exact precedent `owner-validation.ts` already
established ("genuine duplication, not speculative sharing"). No
behavior change; covered by the full, unmodified existing
`contacts.test.ts` suite passing unchanged.

**Cursor/list design deviation.** `listPipelineStages` returns a plain
array ordered by `sort_order` (kanban column order), not a cursor
`Page<T>` — the one genuine incompatibility discovered with the shared
convention: `Cursor` is hardcoded to `(createdAt, id)` ordering, the
wrong axis for stages, and stages have no realistic pagination need
(bounded per-pipeline cardinality — `seed_default_pipeline()` always
creates exactly 5). Deals/pipelines both use the unmodified existing
cursor convention; deals additionally filter by `pipelineId`, `stageId`,
`ownerId`, `companyId`, `status`.

**Verification**: full monorepo **1105/1105** across all 7 tested
packages (database 390 — unchanged, no new migration; auth 196; crm
**192**, incl. 102 new: 21 pipelines + 24 pipeline-stages + 57 deals;
tenancy 28; compliance 26; web 252; ui 21). Migration-safety 76/76
(unchanged — no migration touched this step). Lint/typecheck/production
build all clean. `git diff --check` clean, no secrets in changed/new
files. No test in any other package was touched, weakened, or deleted.

**No 2.2A migration was modified.** All three 2.2A migration files are
byte-for-byte unchanged from their committed state.

**Milestone 2.2B: DONE** (domain layer only). **Milestone 2.2 overall
remains open** — no RBAC permission keys, API routes, or UI exist yet for
Deals/Pipelines; **2.2C has not started.**

### Milestone 2.2C — Deals & Pipelines RBAC

Permission-matrix data only — no domain-logic change (`packages/crm`
untouched this step), no API routes, no UI. **2.2D has not started.**

**8 new `PermissionKey`s added** to `packages/auth/src/permissions.ts`:
`deals:read`, `deals:create`, `deals:update`, `deals:delete`,
`pipelines:read`, `pipelines:create`, `pipelines:update`,
`pipelines:delete`. No wildcard/catch-all key. No `pipeline_stages:*` key
set — stages authorize under their parent pipeline's own keys (below).

**Frozen matrix applied exactly**:

| Role | deals:read | deals:create | deals:update | deals:delete | pipelines:read | pipelines:create | pipelines:update | pipelines:delete |
|---|---|---|---|---|---|---|---|---|
| org_admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org_member | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| org_viewer | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| agency_owner | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| agency_admin | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| portal_customer | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

No agency roll-up access granted (explicitly out of this milestone's
scope, same as every other resource added so far).

**Stage authorization mapping (design intent for 2.2D, not yet wired to
any route)**: `pipeline_stages` has no permission keys of its own. A
future stage-level API route authorizes under its parent pipeline's own
keys: `GET` stages → `pipelines:read`; `POST` a stage →
`pipelines:create`; `PATCH` a stage (including the classification change
that cascades `deals.status`, Milestone 2.2B) → `pipelines:update`;
`DELETE` (soft-delete) a stage → `pipelines:delete`. Documented in both
`packages/auth/src/permissions.ts`'s own comment and `docs/08-Security.md`
§3.1.

**Migration**: one additive file,
`20260814110000_update_role_permission_sets_2_2c.sql` — a
`roles.permission_set` data update only (no schema/RLS/function
change), following the exact established pattern (full, deterministic
per-role JSONB replacement, never a merge) from the M1.5 seed, M1.6, and
2.1E permission-set migrations. Only `org_admin`/`org_member`/`org_viewer`
rows are touched; `agency_owner`/`agency_admin`/`portal_customer` rows are
left untouched (they gain none of the 8 keys) and remain byte-identical
to their previously-committed state.

**`roles.permission_set` behavior**: verified byte-equivalent to
`PERMISSION_MATRIX` via `permission-set-sync.test.ts` run against the
real local database after the migration was applied — `toEqual()`
deep-equality on every role's `permission_set`, plus a row-count/role-set
check. This is the same regression guard established at M1.5 and reused
unchanged at every subsequent permission-set update (M1.6, 2.1E, now
2.2C) — the migration's correctness is proven empirically, not merely
asserted in a comment.

**Tests**: `packages/auth/tests/permissions.test.ts`'s independently
hand-written `EXPECTED` matrix (never derived from `PERMISSION_MATRIX`,
by design — the whole point of this file is to catch a wrong value in
the real matrix, not tautologically re-assert it) extended with all 8
new keys for all 6 roles, plus dedicated Milestone 2.2C describe blocks
proving: the full frozen Deals/Pipelines matrix per role; stage
authorization maps to `pipelines:*` (structural check that no
`pipeline_stages:*` key exists anywhere in the matrix, plus a documented-
intent test for the four HTTP-verb mappings); `deals:delete` implies no
DSR/compliance permission; `pipelines:delete` never diverges from
`deals:delete` by accident (no role in the frozen matrix holds one
without the other, proving `can()` has no cross-key inference); every
pre-2.2C permission (all 14 M1.5/M1.6 keys plus the 8 2.1E CRM keys)
unchanged for every role; an unrecognized action string and an
unrecognized role both deny without throwing. The pre-existing
`readOnlyGrants` list in the "deny-by-default" test was updated to
include `deals:read`/`pipelines:read` for `org_viewer` (a required,
narrow update — not a weakening — since that role now legitimately holds
two additional read grants the test's own sweep would otherwise
misreport as unexpectedly denied).

**Security review, confirmed from source**: `org_member` cannot delete
deals (`deals:delete` absent from its grants) or manage pipeline
structure (only `pipelines:read` present); `org_viewer` cannot mutate
anything in either resource; both agency roles and `portal_customer` get
zero direct access to all 8 keys; every grant remains subject to `can()`'s
existing, unmodified `ResourceContext` scope check (`resource.organizationId
!== actor.organizationId` denies regardless of role/permission — proven
by a dedicated 2.2C test using `deals:delete`/`pipelines:delete`); `can()`
itself was not modified in any way — no new authorization mechanism,
branch, or bypass path was introduced, only data added to the existing
`PERMISSION_MATRIX` object and its DB mirror.

**Verification**: full monorepo **1167/1167** across all 7 tested
packages (database 391, incl. 1 new migration — migration-safety now
77/77; auth **257**, incl. 61 new across `permissions.test.ts`
(224 total) and the unchanged-but-now-differently-populated
`permission-set-sync.test.ts` (2, re-verified against the real local DB
post-migration); crm 192 unchanged — no domain-layer file touched this
step; tenancy 28; compliance 26; web 252; ui 21). Lint/typecheck/
production build all clean. `git diff --check` clean, no secrets in
changed/new files.

**No domain/API/UI work included**: confirmed via `git status` — the
only files touched are `packages/auth/src/permissions.ts`,
`packages/auth/tests/permissions.test.ts`, the one new migration, and
this documentation. Zero files under `packages/crm`, `apps/web/app/api`,
or any UI directory.

**Milestone 2.2C: DONE** (RBAC data only). **Milestone 2.2 overall
remains open** — no API routes or UI exist yet for Deals/Pipelines;
**2.2D has not started.**

### Milestone 2.2D — Deals, Pipelines & Pipeline-Stages API

HTTP layer only — no `packages/crm` domain-logic change, no RBAC-matrix
change, no UI. **2.2E has not started.**

**Routes added** (7 route groups, `route.ts` + `handlers.ts` pairs,
following the exact Companies/Contacts split — `route.ts`: HTTP
extraction/auth/same-origin/JSON parsing; `handlers.ts`: org resolution,
`can()`, domain call, error mapping):

- `GET`/`POST /api/v1/deals`, `GET`/`PATCH`/`DELETE /api/v1/deals/{id}`
- `GET`/`POST /api/v1/pipelines`, `GET`/`PATCH`/`DELETE
  /api/v1/pipelines/{id}`
- `POST /api/v1/pipelines/{id}/set-default` — this milestone's own
  explicit design decision, below
- `GET`/`POST /api/v1/pipelines/{id}/stages`, `GET`/`PATCH`/`DELETE
  /api/v1/pipelines/{id}/stages/{stageId}`

Full contract (request/response shapes, filters, field allowlists, error
mapping) recorded in `docs/04-API-Architecture.md` §2.5 — not duplicated
here.

**Default-pipeline HTTP decision.** No frozen HTTP contract existed for
switching a pipeline's default before this step. Chose option A from the
prompt's own preferred list: a dedicated `POST
/api/v1/pipelines/{id}/set-default` action endpoint, calling
`packages/crm`'s existing `setDefaultPipeline` (M2.2B) unchanged —
mirroring the already-established `POST .../{id}/preview` /
`POST .../{id}/execute` dedicated-verb-pair precedent for
`data-subject-requests` (M1.6 Decision D): a state change with real
invariant implications gets its own named endpoint, never a hidden field
on a general-purpose `PATCH`. Confirmed structurally: `PATCH
/api/v1/pipelines/{id}`'s body-extraction function has no code path for
`isDefault` at all (not merely a runtime rejection) — proven by a
dedicated mass-assignment test. `pipelines:update` RBAC. No
`Idempotency-Key` (not one of the six routes this milestone's own
approved plan enumerated, and the operation is already naturally
idempotent).

**Nested-stage IDOR safety — adversarially proven, not merely asserted.**
A request for `/pipelines/A/stages/B` where `B` genuinely exists but
belongs to pipeline `C` (even a `C` the caller legitimately owns in the
same organization) returns the byte-identical `404` body
(`{ "error": "Not found" }`) as a genuinely nonexistent `stageId` or one
in a different organization entirely — proven by dedicated tests
comparing the two JSON bodies for equality, for `GET`, `PATCH`, and
`DELETE` alike, and confirming `PATCH`/`DELETE` never mutate the
wrong-parent stage. This falls directly out of reusing `packages/crm`'s
own `(organization_id, pipeline_id, id)`-scoped lookups (M2.2B) without
adding a redundant, error-message-risking parent pre-check for the
single-stage routes — only `GET`/`POST /stages` (the collection
endpoints, where an empty list would otherwise be ambiguous with "no
such pipeline") explicitly pre-check the parent pipeline's existence.

**RBAC mapping**: `deals:read/create/update/delete` and
`pipelines:read/create/update/delete` (M2.2C, unchanged by this step).
`pipeline_stages` routes authorize under the parent pipeline's own
`pipelines:*` keys — no `pipeline_stages:*` key was added or is needed.
Proven per-role: `org_admin` full access to both resource families;
`org_member` full deals CRUD except delete, pipelines/stages read-only;
`org_viewer` read-only on both; agency roles and `portal_customer` zero
direct access to either.

**Mass-assignment protection**: `id`/`organizationId`/`organization_id`/
`deletedAt`/`createdAt`/`updatedAt` have no extraction path on any new
route (same discipline as Companies/Contacts). `deals` additionally has
no extraction path for `status` under any key, on `POST` or `PATCH` —
proven by a dedicated test injecting `status: "won"` into both verbs and
confirming the response's `status` is unaffected (derived from
`stageId,` per M2.2B). `pipelines/{id}/stages POST` additionally has no
extraction path for a body-supplied `pipelineId` — a stage is always
created under the URL's `{id}`, proven by a dedicated test supplying a
different pipeline's id in the body and confirming it has zero effect.

**Idempotency**: wired on exactly the six routes the approved plan
enumerated (`POST`/`PATCH` for deals, pipelines, and stages) via the
unmodified `apps/web/app/api/v1/_shared/idempotency.ts` — reused, not
changed, no defect found. Never on `GET`, `DELETE`, or `set-default`.

**Soft-delete behavior**: `DELETE` on all three resources is
`packages/crm`'s existing soft-delete only — never a physical `DELETE`.
`DELETE /api/v1/pipelines/{id}` returns `409` (not `400` or `404`) when
the target is the organization's active default, matching
`DuplicateContactEmailError`'s own "valid request, rejected by current
state" category. `DELETE` on a pipeline stage never rejects merely
because active deals reference it (the frozen Milestone 2.2 decision,
unchanged since 2.2B).

**Relationship semantics preserved from 2.2B, verified via API-level
tests reusing no duplicated validation**: a new/reassigned relationship
to a since-soft-deleted company/contact/pipeline/stage is rejected
(`400`); an unrelated field edit on a deal succeeds even after its
linked company, contact, pipeline, or stage has since been soft-deleted;
a wrong-pipeline stage assignment is rejected; reassigning `pipelineId`
without a compatible `stageId` in the same request is rejected; `status`
is always stage-derived, both on create and on a genuine stage move.

**Known limitations / deferred work**: no agency roll-up access to
Deals/Pipelines (explicitly out of scope, matching every other resource
so far); no sorting/search framework, no offset pagination, no saved
views (none required by the frozen design); pipeline-stage `sortOrder`
has no uniqueness enforcement (matches `packages/crm`'s own M2.2B
design — a UX concern, not a data-integrity one); Deals UI, Pipeline
board, and 2.2E generally have not started.

**Verification**: full monorepo **1241/1241** across all 7 tested
packages (database 391 unchanged — no new migration; auth 257 unchanged
— no RBAC-matrix change; crm 192 unchanged — no domain-layer file
touched; tenancy 28; compliance 26; web **326**, incl. 72 new: 30 deals-
API + 19 pipelines-API + 25 pipeline-stages-API (later increased to 30
for deals after two required-but-missing tests — contact-soft-delete
unrelated-edit, demoted-actor-idempotency-replay — were added to use two
initially-unused fixture imports flagged by lint, not removed); ui 21).
Migration-safety 77/77 (unchanged — no migration added). Lint/typecheck/
production build all clean. `git diff --check` clean, no secrets in
changed/new files.

**No `packages/crm` domain-logic, RBAC-matrix, or migration change was
included.** Confirmed via `git status` — every changed file is under
`apps/web/app/api/v1/{deals,pipelines}` or `apps/web/tests`, plus
`docs/04`/`docs/13`.

**Milestone 2.2D: DONE** (HTTP layer only). **Milestone 2.2 overall
remains open** — no Deals UI, no Pipeline board, no UI at all exists yet
for Deals/Pipelines; **2.2E has not started.**

---

### Milestone 2.2E — Deals UI

Server Components/Actions only (ADR-004 preserved) — no browser `fetch`
to the app's own API, no direct browser DB access, no new client-side
data-access pattern. Every route reuses the exact 2.2D `handlers.ts`
functions in-process. **PipelineBoard, pipeline-management pages, and
any schema/RLS/RBAC/API-contract change were explicitly out of scope and
none was made** — confirmed via `git status`: every changed/new file is
under `apps/web/app/{deals,_shared,contacts,dashboard}`,
`apps/web/tests`, `packages/crm/src/contacts.ts`+`index.ts`,
`packages/crm/tests/contacts.test.ts`, plus this doc. `docs/04` is
unchanged (no API contract change).

**Routes added**: `/deals` (list with cursor pagination + filters +
inline create form) and `/deals/{id}` (detail, edit, soft-delete),
following the exact `access.ts`/`actions.ts`/`*-logic.ts` split proven
by Companies/Contacts.

**"Deal" column/title — documented UX limitation, not a bug.**
`public.deals` has no dedicated name/title column (confirmed unchanged
through 2.2A/2.2B/2.2D). No such field was invented here. The list
column and detail-page title use `dealDisplayLabel()`: resolved company
name → resolved primary contact name → a short id-derived label
(`Deal ${id.slice(0,8)}`) — never a full raw UUID. A future milestone
adding a genuine `name` column should replace this function's use
entirely.

**Filters**: `pipelineId`, `stageId`, `ownerId`, `companyId`, `status` —
cursor pagination only, no search/sort/offset/saved-views (matching the
frozen 2.2D API contract exactly).

**Create form**: no `status` input anywhere — status is always
server/domain-derived from the chosen stage (2.2B); there is no code
path for a client to supply one. Only active company/contact/pipeline/
stage/owner options are offered. The pipeline→stage `<select>` is a
presentation-only client-state filter (`selectedPipelineId` +
`key`-remount on the stage `<select>` so a stale cross-pipeline
selection can never survive a pipeline switch) — the real authority
remains `packages/crm`'s `validateStageRelationship`, re-verified
server-side regardless of what the client rendered.

**Historical-relationship display and preservation (the Milestone 2.1
Contacts regression class, deliberately not repeated)**: the detail page
resolves Company/Contact/Pipeline/Stage labels safely — active → name,
soft-deleted → `"<name> (deleted)"` via a tenant-scoped
`*IncludingDeleted` read helper, unresolvable → a generic fallback —
never a raw UUID in the normal flow. The edit form carries five hidden
`originalXId` markers (`originalCompanyId`, `originalPrimaryContactId`,
`originalOwnerId`, `originalPipelineId`, `originalStageId`); only a
field whose submitted value differs from its own original is included
in the `PATCH` body, so an unrelated edit succeeds even after one of the
deal's linked relationships has since been soft-deleted/deactivated,
while a genuine reassignment to a deleted/inactive target is still
rejected (`400`). Reassigning `pipelineId` always resends `stageId` in
the same request (re-validated against the *new* pipeline), matching the
2.2B/2.2D coupling rule.

**New `packages/crm` helper (narrow, explicitly permitted by the
milestone's own audit clause)**: `getContactByIdIncludingDeleted` —
mirrors the existing `getCompanyByIdIncludingDeleted` exactly
(tenant-scoped, read-only, does not filter `deleted_at`; used solely for
display-name resolution, never for the active list/filter/relationship-
validation paths). No migration. 3 new `packages/crm` tests.

**Shared-module extraction (mirroring the 2.2-P0 `owner-options`
precedent)**: `company-options.ts`/`company-display.ts` moved from
`apps/web/app/contacts/` to `apps/web/app/_shared/` (Deals needed the
identical capability a second time); `contact-options.ts`/
`contact-display.ts`/`pipeline-options.ts`/`pipeline-display.ts` created
directly in `_shared` as new capability. Contacts refactored to consume
the shared versions with zero behavior change (full, unmodified
`contacts-console.test.ts` regression — same 40 tests, still green).

**RBAC**: exactly `deals:read/create/update/delete` per the frozen 2.2C
matrix — `org_admin` full UI, `org_member` no delete control, `org_viewer`
read-only (no edit/delete controls rendered at all), agency and portal
roles get no direct `/deals` access (redirected). Unauthorized controls
are absent from the rendered output, not merely disabled, and every
mutation re-checks `can()` server-side regardless of what the client
rendered.

**Idempotency**: reuses the real 2.2D handler path exactly, one stable
key per mounted form instance (`crypto.randomUUID()` in `useState`
initializer). Covered by dedicated create/edit retry, changed-payload
conflict, and authorization-rechecked-before-replay tests.

**Soft-delete**: two-step confirm UI, soft-delete only (`softDeleteDeal`
in-process) — no physical row removal, matching the non-GDPR delete
discipline used by Companies/Contacts.

**Dashboard nav**: one minimal `Deals` link added alongside the existing
Companies/Contacts links — no full sidebar, no Pipelines link yet.

**Styling/accessibility**: CSS Modules only (no Tailwind/shadcn/Radix,
consistent with the rest of the app), proper `<label>`/`<button>`/
`role="alert"` usage, uncontrolled `<select>`s use `defaultValue` (never
per-`<option> selected`).

**Known, honestly-reported limitations**: (1) no dedicated deal name
field — see "Deal" column note above; (2) this agent is text-only and
could not visually render the UI in a browser — correctness here rests
on the automated test suite (lint/typecheck/build/unit+integration
tests) and careful source review, not on a manual visual pass; a human
should still eyeball the rendered pages before this ships to real users.

**Verification**: full monorepo **1294/1294** across all 7 tested
packages (database 391 unchanged — no migration; auth 257 unchanged —
no RBAC-matrix change; tenancy 28, compliance 26, ui 21 all unchanged;
crm **195** — +3 for `getContactByIdIncludingDeleted`; web **376** —
+50 for `deals-console.test.ts`, `contacts-console.test.ts` unchanged at
40). Deals API (30), Pipelines API (19), Pipeline-Stages API (25),
Companies console (29), Contacts console (40), owner-options (10) all
re-run unmodified and green as regressions. Migration-safety unchanged
(no migration added — confirmed via `git status` on
`packages/database/supabase/migrations/`). Lint/typecheck/production
build all clean across all 8 packages. `git diff --check` clean, no
secrets found in changed/new files.

**Incident during implementation, disclosed in full**: a shell `sed`
command intended to strip trailing whitespace from newly-written files
used a bracket expression (`[ \t]`) that this environment's `sed`
parsed as matching space, tab, **or the literal letter "t"** — not tab
as an escape. This silently stripped a trailing "t" from every line in
15 touched files that happened to end in "t" with no whitespace at all
(e.g. `<select` → `<selec`, "just" → "jus", "not" → "no"), corrupting
~35 lines, including JSX in `deal-edit-form.tsx`, `deal-form.tsx`, and
`contact-edit-form.tsx` that would have shipped a broken UI. This was
caught immediately by the next `typecheck` run (malformed JSX tags fail
to compile) rather than shipping silently. Recovery: (1) reproduced the
exact bug in isolation to confirm the precise corruption rule; (2)
rewrote 3 files verbatim from known-good content already present earlier
in this same session's transcript; (3) for the remaining files, built an
automated dictionary-assisted scan (every line-ending word checked
against `/usr/share/dict/words` for "would `word+t` be a real word")
to generate a candidate list, then manually inspected every candidate
in full sentence context before changing anything — deliberately
choosing manual review over blind automated substitution, since several
corruptions (e.g. "start"→"star", "not"→"no") silently produced other
valid English words that a purely automated fix could have gotten wrong
in the opposite direction; (4) re-ran the full corruption scan a second
time to confirm zero remaining instances, then re-ran the entire
verification suite (lint/typecheck/1294 tests/build) from a clean state
to confirm the fix. No corrupted code reached this report as "passing."

**Milestone 2.2E: DONE.** **Milestone 2.2 overall remains open** — no
Pipeline board, no pipeline-management UI; **2.2F has not started.**

---

### Milestone 2.2F — Pipeline Management UI + minimal PipelineBoard

Server Components/Actions only (ADR-004 preserved) — every route reuses
the exact 2.2D `handlers.ts` functions in-process, no browser `fetch` to
the app's own API, no direct browser DB access, no new client-side
data-access pattern. **No schema/RLS/RBAC/API-contract change was made**
— confirmed via `git status`: `packages/database/supabase/migrations/`
and `packages/auth` both show zero diff this milestone; every changed/
new file is under `apps/web/app/{pipelines,deals/board}`,
`apps/web/tests`, or `packages/ui`. `getPipelineByIdIncludingDeleted`/
`getPipelineStageByIdIncludingDeleted` (2.2B) and `_shared/pipeline-
options.ts`/`pipeline-display.ts` (2.2E) already existed — no new
`packages/crm` function was added this milestone.

**Pipeline management routes**: `/pipelines` (list, active pipelines
only, default badge, stage count via the existing `listActiveStageOptions`
composition, inline create form) and `/pipelines/{id}` (name-only edit,
a separate "Default pipeline" section calling `POST .../set-default`
through its own dedicated action — deliberately never combined with the
name-edit form, so the two operations can never be confused — soft-delete,
and nested stage management for that one pipeline).

**Stage management**, nested in `/pipelines/{id}`: an always-visible
inline edit form per stage (name/sortOrder/probability/isWonStage/
isLostStage, pre-filled, matching every other edit form's own "no
toggle-based edit mode" convention) plus its own two-step soft-delete
confirm, and a create form below the list. Update/create field
validation (0..100 probability, won/lost mutual exclusivity, sortOrder
must be an integer) is NOT reimplemented — remains exclusively
packages/crm's; a genuine won/lost classification change is left to
`updatePipelineStage` (2.2B) to cascade `deals.status` for every
referencing deal, unchanged. `canUpdate` (`pipelines:update`) and
`canDelete` (`pipelines:delete`) gate the stage edit-fields and delete
control independently, not coupled — the current RBAC matrix happens to
grant both only to `org_admin`, but the component does not assume that
coincidence.

**Soft-delete UX**: deleting the organization's active default pipeline
surfaces the existing 409 domain error as-is (`CannotDeleteDefaultPipelineError`)
— this milestone never auto-picks a replacement default. The delete form
proactively hides the delete control and explains why when the pipeline
being viewed is already the default, rather than only discovering that
after a doomed submission. Soft-deleting a stage still referenced by
active deals is explicitly permitted (the frozen 2.2B design) — the UI
states plainly that referencing deals keep pointing at it and remain
fully readable/editable; nothing here moves, nulls, or hard-deletes.

**Minimal PipelineBoard** (`packages/ui/src/pipeline-board.tsx`, new
named exports `PipelineBoard`/`PipelineBoardState`/`PipelineBoardCard`/
`PipelineBoardStage`/`PipelineBoardProps`): presentation-only, same
discipline as `entity-table.tsx` — no data fetching, no `can()` checks,
no idempotency, no fetch, CSS Modules only. `loading`/`empty`/`error`/
`ready` states mirror `EntityTableState` exactly; `empty` means zero
*stages* (an unconfigured pipeline) — an individual stage column with
zero cards is a normal, non-error render, never the board-level empty
state. A card's `moveControl` is an opaque, caller-supplied `ReactNode`
(the same `rowActions` render-prop precedent `EntityTable` already
established) rather than an `onMove` callback, keeping the component
free of any assumption about how a move happens.

**Board route**: `/deals/board`, a dedicated route rather than a view
toggle on `/deals` — audited both; `/deals` already carries five filters,
cursor pagination, and a create form, and the board needs a
fundamentally different data shape (one pipeline's active deals grouped
by stage, not a filtered paginated flat list), so a second route keeps
both pages single-purpose. One link each way (`/deals` → "Board view",
`/deals/board` → "Back to list"); no new navigation system, no sidebar.
Reuses `decideDealsConsoleAccess` (`deals:read`) unchanged — the board is
a view of Deals data, not a new resource.

**Board pipeline selection**: defaults to the organization's active
default pipeline; a plain `<select>` + submit (server-driven `method="get"`,
same pattern as `/deals`'s own filter form) switches between active
pipelines only — a deleted pipeline can never be selected. A stale/
invalid/deleted `pipelineId` query value falls back to the default
pipeline safely, never displaying a raw id.

**Board data**: one fetch of the selected pipeline's active stages
(`handleListPipelineStages`, already sort_order-ordered) and one fetch of
its active deals (`handleListDeals` with `pipelineId` + `limit=100`) —
reusing existing handlers, no new read-model layer. **Known, documented
limitation**: a pipeline with more than 100 active deals only shows the
first 100 on the board (`packages/crm`'s own `MAX_LIMIT`) — a real
scale limit, not silently engineered around with cursor-looping, which
would be new read-model scope this milestone excludes.

**Historical deleted-stage handling on the board** (§18/§21, audited
explicitly): a deal whose `stageId` points at a since-soft-deleted stage
would match none of the board's active-stage columns — rather than
silently disappearing, it is placed in an explicit synthetic "Deleted
stage" holding column (only rendered when at least one such deal exists),
with the same move control offering every active stage in the pipeline
as a recovery destination. This column's presentation-only `id` is never
a database identifier passed anywhere requiring validity.

**Deal card display**: `dealDisplayLabel()` (2.2E, unchanged) for the
label — never a full raw UUID — plus a pre-formatted amount/currency
string when present. Deliberately minimal per this milestone's own
instruction: no company/contact context line was added to avoid
overfilling the card (the label already resolves to the company or
contact name when one exists).

**Accessible stage move — the required functional interaction**: every
card's `moveControl` is a plain `<select>` of the pipeline's other active
stages plus an explicit "Move" submit button (`apps/web/app/deals/board/
stage-move-form.tsx`) — fully operable by keyboard/screen reader, no
pointer required. This is the ONLY move mechanism in this milestone;
**drag-and-drop is explicitly deferred, not implemented** — building it
would require a new drag-and-drop library (none exists in this
repository's dependency tree) and would materially complicate both
accessibility and testing for a milestone whose acceptance criterion is
the keyboard-accessible move, not drag-and-drop polish. A move calls
`moveDealToStageAction` → `move-logic.ts` → `handleUpdateDeal` with only
`{ stageId }` in the body — the exact same Deal PATCH path
`../[id]/update-logic.ts` uses, not a second write path; `status` is
never sent and is always re-derived server-side from the new stage
(2.2B), proven by dedicated won/lost/back-to-open tests. A destination
can only ever be an active stage in the same pipeline — a wrong-pipeline
or soft-deleted stage id is rejected by the unchanged domain layer
(`InvalidStageRelationshipError` → 400), never offered as a `<select>`
option in the first place by construction (the `<select>` is built only
from that pipeline's own active stages).

**Idempotency**: reuses the existing mechanism unchanged, one stable key
per mounted `StageMoveForm` instance. Dedicated tests cover retry-replay
(no duplicate/inconsistent write), changed-payload conflict, and
authorization-rechecked-before-replay (a demoted actor cannot replay a
stale move with continued authority).

**RBAC**: pipeline/stage management is gated exactly on
`pipelines:read/create/update/delete` per the frozen 2.2C matrix
(`org_admin` full management, `org_member`/`org_viewer` read-only,
agency/portal roles no access) — unchanged, confirmed via `packages/auth`
having zero diff. The board's stage-move is gated on `deals:update` (the
same permission `/deals/{id}`'s own edit form already requires) —
`org_admin`/`org_member` can move, `org_viewer` and agency roles cannot;
unauthorized controls are absent from rendered output, not disabled, and
every mutation re-checks `can()` server-side regardless of what the
client rendered.

**Known, honestly-reported limitations**: (1) the single-fetch 100-deal
board cap (above); (2) this agent is text-only — no manual browser/
keyboard/drag-and-drop verification was performed; correctness rests on
the automated test suite (lint/typecheck/build/1376 unit+integration
tests, including `renderToStaticMarkup`-based `PipelineBoard` tests that
prove rendering structure but cannot prove a real click/submit fires)
and careful source review, not a rendered-page or real-keyboard pass —
that belongs to a later, explicitly-scoped manual/staging verification
step (2.2H per the kickoff prompt), not this one.

**Verification**: full monorepo **1376/1376** across all 7 tested
packages (database 391 unchanged — no migration; auth 257 unchanged — no
RBAC-matrix change; tenancy 28, compliance 26 unchanged; crm 195
unchanged — no domain-layer file touched; ui **39** — +18 new
`PipelineBoard` tests; web **440** — +47 `pipelines-console.test.ts` +17
`deals-board.test.ts`). Deals API (30), Pipelines API (19),
Pipeline-Stages API (25), Deals console (50), Companies/Contacts console
(29/40), owner-options (10) all re-run unmodified and green as
regressions. Migration-safety unchanged (no migration added).
Lint/typecheck/production build all clean across all 8 packages
(`/pipelines`, `/pipelines/[id]`, `/deals/board` all present in the build
output). `git diff --check` clean, no secrets found in changed/new files.

**Source-integrity note**: unlike 2.2E, no bulk text-replacement command
(e.g. `sed`) was run against any file this milestone — every edit used
the Read/Edit/Write tools directly. A targeted re-check for the same
corruption signature found in 2.2E (`<selec`/`<inpu` truncations) was
still performed as due diligence across every new/changed file; none
found.

**Milestone 2.2F: DONE.** **Milestone 2.2 overall remains open** —
2.2G (final audit) and 2.2H (manual/staging verification) have not
started.

---

### Milestone 2.2G — Final Adversarial/Security/UI Audit

Fresh, from-source audit of the complete 2.2 implementation (2.2-P0
through 2.2F) — migrations, RLS, SECURITY DEFINER functions, RBAC
matrix, domain layer, API handlers, idempotency, UI, and PipelineBoard —
against source directly, not against prior milestone reports. No code
was modified during the audit itself (working tree confirmed clean
before/after). Full detail: **1376/1376** tests, lint/typecheck/build/
migration-safety all clean, zero `.only`/`.skip`, zero mocked security
boundaries, no removed regression coverage, no accidental 2.3+ scope.

**One MEDIUM finding, now CLOSED**: no automated test proved that GDPR
contact erasure's interaction with `deals.primary_contact_id` (via
`deals_contact_org_fk ... on delete set null (primary_contact_id)`,
2.2A) actually works end-to-end through the real
`executeContactErasure` → `execute_contact_erasure()` path — the
identical, already-tested sibling was `company_id`
(`packages/database/tests/pipelines-deals-schema.test.ts`), never
`primary_contact_id`. **Remediated**: one new test added to
`packages/compliance/tests/contact-erasure.test.ts` ("deal
relationship: primary_contact_id survives contact erasure") — seeds a
real pipeline/stage/deal referencing a real contact, executes the real
`executeContactErasure` (never a direct `DELETE` shortcut), and asserts:
the contact is physically gone; the deal still exists, neither
soft-deleted nor hard-deleted; `primary_contact_id` is `null`; every
other field (`id`, `organization_id`, `pipeline_id`, `stage_id`,
`status`, `amount`, `currency`) is byte-identical to its pre-erasure
value. **Passes against the current implementation, unmodified** — no
schema/domain/API/UI change was needed or made. Full monorepo re-verified
green at **1377/1377** (1376 + 1) after the addition.

All other 2.2G audit findings were INFORMATIONAL/LOW and require no
action: (1) `deriveDealStatus`/`deriveStatusFromFlags` are two separate
functions expressing the identical open/won/lost precedence — currently
consistent, a latent duplication only; (2) the default-pipeline
"at-most-one" (DB-guaranteed, permanent) vs. "exactly-one" (domain-layer-
guaranteed for every operation it exposes; a raw same-org UPDATE
bypassing the app could still flip it) distinction was already correctly
disclosed in the 2.2A schema migration's own comment before this audit,
not a new gap; (3) one transient test failure was observed during a
full-parallel monorepo run in `contact-erasure.test.ts`'s pre-existing,
2.2-untouched chaos-trigger (fault-injection) test — reproducible only
under parallel load, passes cleanly in isolation and on every other run;
not a 2.2 regression, not modified or weakened by this remediation.

**Milestone 2.2G: PASS.** Full closeout record, including 2.2H, follows
in the "Milestone 2.2 — Overall Closeout" entry below.

---

### Milestone 2.2 — Overall Closeout

Milestone 2.2H (staging deployment & live verification) ran in four
parts after 2.2G closed. This entry distinguishes three separate tiers
of evidence — automated technical evidence, staging-database
verification, and manual production verification — rather than
presenting them as one undifferentiated claim.

**2.2H Phase 1 — pre-deployment read-only audit.** Confirmed, before any
write: the linked Supabase project is `damunjcpwxthdjaonatb`, name
`ai-revenue-os-staging` (not the unlinked, differently-named other
project on the same account) — the only staging-identity check this
milestone required before authorizing a write. Confirmed the pending
migration set was exactly the five Milestone 2.2 migrations, with zero
drift against local history. Re-confirmed the migration source's own
security posture (RLS enabled, `authenticated`-only grants with no
`DELETE`, no `anon` grant, `seed_default_pipeline` ungrantable to
`authenticated`/`anon`, `SECURITY DEFINER` + explicit `search_path` on
all three new functions) directly from the migration files. No Vercel
project link, credential, or documented staging URL was found in this
environment — noted as a gap for Phase 2C/2D, later closed by the manual
production verification below instead.

**2.2H Phase 2A — staging migration apply.** The five pending migrations
(`20260814090000`, `20260814100000`, `20260814100100`, `20260814100200`,
`20260814110000`) were applied to `damunjcpwxthdjaonatb` via
`supabase db push --linked`. Post-push `supabase migration list`
confirmed all 36 migrations synchronized (local timestamp = remote
timestamp), zero pending, zero remote-only entries.

**2.2H Phase 2B — staging database verification (live, catalog-level,
not merely re-reading migration source).** Columns, constraints, and
indexes for `pipelines`/`pipeline_stages`/`deals` were read directly
from staging's `pg_attribute`/`pg_constraint`/`pg_indexes` and matched
the migration source exactly, including the `pipelines_org_active_
default_idx` partial unique index and the full two-composite-FK design
on `deals` (`deals_stage_org_fk` + `deals_stage_pipeline_fk`,
`deals_contact_org_fk ... on delete set null`). RLS was confirmed
enabled live (`pg_class.relrowsecurity = true`) with exactly the nine
expected `organization_id = current_org()` policies and no others. Live
`has_table_privilege`/`has_function_privilege` checks confirmed
`authenticated` has `select/insert/update` but never `delete` on any of
the three tables, `anon` has none of the four, and `seed_default_pipeline`
has no `EXECUTE` grant to `authenticated` or `anon` at all. All three
`SECURITY DEFINER` function bodies, pulled live via
`pg_get_functiondef`, were byte-for-byte identical to the committed
migration source. Aggregate row counts (2 organizations → 2 pipelines →
10 stages) were consistent with every pre-existing organization
receiving exactly one seeded default pipeline with exactly five stages,
though a per-organization row-level breakdown was not obtainable with
the credentials available in that session (documented as a LOW-severity,
non-blocking coverage gap in the Phase 2B report — the structural
guarantees that make a duplicate or missing default impossible were
independently confirmed live regardless). One process incident occurred
during this phase — a CLI command briefly printed the staging project's
service-role key to command output; it was not reused, persisted, or
committed anywhere, and key rotation was recommended as a follow-up
outside this documentation-only step's scope.

**Manual production verification (user-attested — not independently
performed or technically re-verified by the assistant; no Production
access exists in this environment).** Confirmed working directly against
the deployed Production application: login; dashboard; authenticated
`org_admin` session; Companies; Contacts; Deals list/create; Deals
board; Pipelines list; pipeline detail/edit; the default "Sales Pipeline"
existing with its five stages (Lead/10, Qualified/20, Proposal/30,
Won/40 `is_won_stage=true`, Lost/50 `is_lost_stage=true`); creating a new
pipeline; adding a new stage; the active default pipeline's delete
protection; the production database connection; and tenant/organization
context resolution for the logged-in user.

**Automated technical evidence, re-run at closeout (commit
`6ef77c9718431720e7f60a237adb442e4d980e33`, `main`, working tree
clean).** `pnpm lint` clean across all 8 packages; `pnpm typecheck` clean
across all 8 packages; `pnpm test` **1377/1377 passing**, 0 failed,
across all 7 tested packages (database 391, auth 257, tenancy 28,
compliance 27, crm 195, ui 39, web 440); `pnpm build` clean, every
Deals/Pipelines route present in the build output. No open blocking
defect exists — 2.2G's one MEDIUM finding (missing GDPR-erasure/deal-
survival regression coverage) was remediated and closed in the same
commit; remaining LOW/INFORMATIONAL items across 2.2G and 2.2H Phase 2B
are documented in their own entries above and are explicitly
non-blocking.

**Milestone 2.2: PASS — CLOSED.** Every gate has passed: implementation
complete (2.2-P0 through 2.2G), staging database state verified live
with zero drift, and production functional behavior confirmed manually
by the project owner. Milestone 2.3 is in progress — see the next
section.

---

## Milestone 2.3 — Activities, Notes & Tags

### Frozen design

Four new tables: `activities`, `notes`, `tags`, `taggings`. Design and
scope were frozen across two design-only sessions before any code was
written, and are recorded here for reference rather than re-derived from
the migrations:

- **Activities vs. Notes**: kept as two distinct concepts. `activities`
  are typed, chronological timeline events (`call`/`email`/`meeting`/
  `note`/`task`, with `due_at`/`completed_at`); `notes` are a persistent,
  freely-editable annotation with no timeline semantics. A `type='note'`
  activity and a standalone note are deliberately not the same thing.
- **Polymorphic associations**: `activities.related_to_type`/
  `related_to_id` and `notes.related_to_type`/`related_to_id` target
  exactly `company`/`contact`/`deal`; `taggings.taggable_type`/
  `taggable_id` targets the same three. Naming is intentionally
  inconsistent between the two families (`related_to_*` vs.
  `taggable_*`) — not a stylistic slip, a deliberate signal that
  Activities/Notes and Taggings are different kinds of relationship.
  Postgres cannot express a type-conditional foreign key
  (docs/03-Database-Architecture.md §3), so target existence/tenancy for
  these columns is a `packages/crm` domain-layer responsibility, deferred
  to Milestone 2.3B — this migration proves only the allowed-type CHECK
  and the row's own `organization_id`, never target existence.
- **Taggings is the one deliberate exception to this project's
  soft-delete convention**: no `deleted_at`, no `updated_at`, no update
  trigger, and — uniquely among the four new tables — `authenticated`
  holds a real `DELETE` grant with a matching RLS policy. A tagging is a
  relationship row, not a standalone historical CRM record; removing one
  is always a physical, tenant-scoped delete. This mirrors the one other
  table in the project with the same shape, `idempotency_keys`
  (`idempotency_keys_delete_own`, 20260813110000). The accepted residual
  risk — a same-org caller with direct DB/PostgREST access, bypassing the
  application's `tags:*` RBAC entirely, could delete a tagging without
  permission — is judged LOW severity (no cross-tenant exposure, no PII,
  fully reversible by re-applying the tag) and is documented in the RLS
  migration's own comments rather than redesigned.
- **`organization_id` on `taggings`**: required, not derived via a join.
  No table in this project derives tenancy indirectly — RLS is
  structurally dependent on every tenant-owned table carrying its own
  `organization_id` — so `taggings` follows the same rule as every other
  table.

### GDPR correction (pre-implementation)

The first frozen design specified `activities.related_to_id`/
`notes.related_to_id` as normal non-null columns, which directly
contradicted the standing "no dangling identifiers after erasure" rule
the moment a direct-contact GDPR erasure needed to leave the row in
place. The corrected, implemented design:

- `related_to_id` (activities, notes) is **nullable at the DB level**,
  reserved exclusively for the contact-erasure path. Ordinary
  create/update (2.3B, not yet built) must always supply a non-null
  value — enforced at the domain/API layer only, never a DB `CHECK`,
  because a `CHECK (related_to_id is not null)` would block the erasure
  function's own `UPDATE`.
- `related_to_type` is deliberately **preserved** (e.g. stays `'contact'`)
  on erasure — non-identifying category metadata, not a personal
  identifier, useful for audit/timeline rendering ("this was once linked
  to a Contact").
- `notes.body` was corrected from the originally-frozen `NOT NULL` to
  **nullable**, for the identical reason — discovered during 2.3A's own
  pre-implementation audit, before any migration was written.
- No `erased_at` marker was added: `related_to_type='contact' AND
  related_to_id IS NULL` is unambiguous by construction, since only the
  compliance function's own code path can produce that combination.
- UI copy (2.3D, not yet built) must render this state as **"Erased
  contact"**, never "Deleted contact" — "deleted" is reserved project-wide
  for the recoverable soft-delete pattern.
- Taggings are **physically removed**, not nulled, on direct-contact
  erasure — a tagging carries no free text and `taggable_id` is `NOT
  NULL` by schema, so nulling was never an option regardless.
- **Category A vs. Category B**, explicitly scoped: this milestone closes
  Category A only — a direct relational reference
  (`related_to_type`/`taggable_type = 'contact'` and the erased contact's
  own id). Category B — an Activity/Note related to a *different* entity
  (a Company or Deal) whose free-text `subject`/`body` happens to mention
  the erased contact by name — is a known, deliberately unaddressed
  compliance limitation. Reliable detection of personal-data mentions in
  free text requires NLP/semantic scanning, explicitly out of scope for
  Milestone 2.3. Verified by a dedicated regression test (see below) that
  proves such an Activity survives completely untouched.

### 2.3A — Database foundation + GDPR/retention wiring

**Migrations** (all forward-only; no previously-committed migration was
edited):

- `20260817090000_create_activities_notes_tags_schema.sql` — the four
  tables, exactly as designed above, plus `set_updated_at` triggers
  (activities/notes/tags only — not taggings) and indexes
  (`*_org_active_idx` partial indexes on `deleted_at is null`,
  `*_org_related_idx`/`*_org_taggable_idx` for polymorphic lookups,
  `tags_org_active_name_idx` for case-insensitive per-org active-name
  uniqueness).
- `20260817090100_enable_activities_notes_tags_rls.sql` — RLS enabled on
  all four; `authenticated` gets exactly SELECT/INSERT/UPDATE on
  activities/notes/tags (no DELETE) and exactly SELECT/INSERT/DELETE on
  taggings (no UPDATE); `anon` gets nothing. Matches the
  companies/contacts/pipelines/deals precedent exactly, with taggings'
  DELETE exception documented inline.
- `20260817090200_extend_contact_erasure_and_retention.sql` — extends
  `execute_contact_erasure()` (2.1C) via `CREATE OR REPLACE` to scrub
  directly-related Activities/Notes (`related_to_id`/free-text columns
  set to NULL, row survives) and physically delete directly-related
  Taggings, all inside the function's existing single transaction; adds
  `data_retention_policies` rows for `activities`/`notes`
  (`retention_days=2555`, matching the `contacts` platform default) per
  the docs/10 §8 standing rule that a new personal-data table's retention
  wiring lands in the same PR that introduces the table. `tags` and
  `taggings` deliberately have no retention row — tags are not personal
  data, and taggings are governed by physical deletion at erasure time,
  not a time window.

**A self-caught regression, found and fixed before commit.** While
writing this migration's `CREATE OR REPLACE FUNCTION
public.execute_contact_erasure`, the caller-identity guard was copied
from the function's *original* Milestone 2.1C source
(`20260812130000_create_contact_erasure_functions.sql`) instead of its
actual latest-applied body. That original guard —
`if p_caller_user_id is null or p_caller_user_id <> auth.uid() then` —
is NULL-unsafe: `<>` against a NULL `auth.uid()` evaluates to SQL NULL,
and PL/pgSQL treats a NULL `IF` condition as false, so the guard silently
does not fire. This exact defect was found and fixed project-wide in
`20260812140000_harden_function_execution_privileges.sql`, which rewrote
`execute_contact_erasure()` (among six sibling functions) to the
NULL-safe form (`auth.uid() is null OR p_caller_user_id is null OR
p_caller_user_id IS DISTINCT FROM auth.uid()`). This migration's first
draft, by copying from the pre-hardening source, silently reverted that
fix for this one function — reintroducing a path where an
authenticated-but-unidentified session (`role=authenticated`, no
resolvable JWT `sub`) supplying any real org_admin's user id could
irreversibly erase that org's contact, bypassing caller-identity
verification entirely.

This was caught by the project's own full verification suite, run before
commit as required by this milestone's process: the pre-existing
regression test `function-execution-privilege-hardening.test.ts` >
"execute_contact_erasure rejects an unauthenticated caller impersonating
a real org_admin, and the contact survives" failed. The failure was
confirmed empirically (not just read from the SQL) — reproduced twice
against local Postgres, isolated down to the byte-identical original
guard text with no other code involved, and confirmed absent from the
correctly-guarded sibling `preview_contact_erasure`. Fixed by restoring
the NULL-safe guard form in this migration (now the only version that
has ever shipped in this migration file — the vulnerable intermediate
state was never committed). The local dev database was reset
(`supabase db reset`) and every migration replayed from the corrected
files to guarantee the applied state matches the committed source
exactly, with no drift from an intermediate manual patch. Not reachable
through the application's normal request path (real Supabase JWTs always
carry a `sub` when `role=authenticated`) — only via direct DB/PostgREST
access bypassing the API — but treated with full severity given the
irreversible, PII-hard-delete nature of the function it sits on.

**Tests added** (all real Postgres, never mocked, following this
project's established fixture/RLS-adversarial conventions):

- `packages/database/tests/activities-notes-tags-schema.test.ts` (51
  tests) — columns/types/nullability/defaults, `type`/`related_to_type`/
  `taggable_type` CHECKs, the nullable-`related_to_id`/nullable-`body`
  GDPR-path proof, `organization_id` FKs, `created_by` `ON DELETE SET
  NULL` FKs, `tags_org_active_name_idx` case-insensitive uniqueness
  (including reuse-after-soft-delete and per-org independence),
  `taggings_tag_org_fk` composite tenant-safety FK (cross-org rejection
  + cascade delete when a tag is removed), the `unique(tag_id,
  taggable_type, taggable_id)` duplicate-tagging guard, indexes, and
  `updated_at` triggers.
- `packages/database/tests/activities-notes-tags-rls.test.ts` (31 tests)
  — cross-tenant SELECT/UPDATE isolation on all four tables, `WITH CHECK`
  spoofing/mutation prevention, the exact `authenticated`
  SELECT/INSERT/UPDATE (no DELETE) grant matrix for
  activities/notes/tags, `anon` zero-grant proof, genuine `permission
  denied` on DELETE/TRUNCATE for activities/notes/tags, and a dedicated
  section proving taggings' DELETE exception precisely: same-org DELETE
  succeeds, cross-org DELETE affects zero rows, UPDATE is rejected at the
  grant level (no policy exists at all).
- `packages/compliance/tests/contact-erasure.test.ts` — three new
  `describe` blocks using the real `executeContactErasure()` path (never
  a direct SQL delete): (1) full end-to-end proof — seeds a Contact with
  a directly-related Activity, Note, Tag, and Tagging, erases the
  contact, and asserts the contact is physically gone, the Activity/Note
  survive not-soft-deleted with `related_to_type` unchanged but
  `related_to_id`/free-text columns NULL and all unrelated fields
  (`type`, `created_at`) intact, the Tagging is physically gone, the Tag
  itself is untouched, and no reference to the erased contact's UUID
  remains anywhere in the org's `related_to_id`/`taggable_id` columns;
  (2) the Category B scope-boundary proof — an Activity related to a Deal
  whose free text mentions the erased contact by name survives completely
  untouched, proving Category A cleanup is precise, not a blanket sweep;
  (3) the existing audit-write-failure chaos/rollback test was extended
  to also seed an Activity/Note/Tagging referencing the contact and
  assert all three remain in their exact pre-erasure state after the
  forced rollback, proving the 2.3A mutations share the same single
  transaction as the pre-existing contact delete. Also added: platform-
  default retention-row tests for `activities`/`notes`
  (`retention_days=2555`) and a proof that no retention row exists for
  `tags`/`taggings`.
- `packages/database/tests/compliance-schema.test.ts` — the pre-existing
  "platform-default retention rows visible" test's hardcoded expected
  list was updated to include `activities`/`notes` in sorted order — a
  necessary, expected consequence of this milestone's own retention rows,
  not a defect.

**Verification (local dev Postgres, forced/uncached, after the guard fix
and a full `supabase db reset` replay of all 34 migrations from the
corrected source files):**

- Migration safety gate: pass, 39 migrations checked.
- `pnpm test`: **all 7 tested packages green** — database 476/476
  (including the previously-failing `function-execution-privilege-
  hardening.test.ts`, now 41/41), compliance 32/32, crm 195/195, web
  440/440, tenancy 28/28, auth and ui unaffected and green.
- `pnpm lint`: clean, 0 warnings/errors, all 8 packages.
- `pnpm typecheck`: clean, 0 errors, all 8 packages.
- `pnpm build`: clean; no new routes (2.3A is database-only — no API, no
  UI, per this step's explicit scope).
- `git diff --check`: clean. Secret scan of every new/changed file: clean
  (only the well-known local Supabase dev connection string, identical to
  every existing test file in this project).

**Explicitly out of scope for 2.3A, deferred to later 2.3 sub-steps**:
`packages/crm` domain modules (createActivity/createNote/createTag/
addTagging and polymorphic target validation), RBAC permission keys
(`activities:*`/`notes:*`/`tags:*`), API routes, `ActivityTimeline` UI,
Category B free-text GDPR scanning (not planned at all, a permanent
documented limitation). The DB layer does **not** validate that a
polymorphic target (a `related_to_id`/`taggable_id`) actually exists or
belongs to the caller's organization — that is 2.3B's responsibility;
this migration proves only the allowed-type CHECK and the row's own
`organization_id`.

### Milestone 2.3B — Activities, Notes & Tags domain layer

`packages/crm` domain logic only — no RBAC keys, no API routes, no UI,
no migration, no change to 2.3A's schema or GDPR erasure logic.

**New modules**: `activities.ts`, `notes.ts` (both full CRUD:
create/getById/list/update/softDelete, following the established
companies.ts/contacts.ts/deals.ts conventions exactly — `runInClientOrTransaction`/`withTenantContext`,
`toX(row)` mappers, `has()`-guarded partial updates, `null` return for
not-found, cursor pagination via the shared `pagination.ts`); `tags.ts`
(Tags full CRUD plus Taggings create/list/delete — Taggings live inside
`tags.ts` rather than a separate file, since a Tagging has no
independent lifecycle apart from a Tag being attached/detached, matching
the frozen 2.3 design's framing).

**relatedToId/taggableId is required at ordinary create-time despite DB
nullability** (2.3A's schema allows NULL solely for GDPR erasure) —
enforced here at the domain layer for Activities, Notes, and Taggings'
target side; `notes.body` is required and non-whitespace for the
identical reason. `relatedToType`/`relatedToId` are structurally absent
from `UpdateActivityInput`/`UpdateNoteInput` — not reassignable in
Milestone 2.3 (frozen design), so no revalidation-of-historical-
relationship code path exists at all for updates. `createdBy` on
Activities/Notes is sourced exclusively from `ctx.userId` (trusted
request context, matching `packages/compliance`'s own `actor_user_id`
convention) — never from caller input.

**Polymorphic validation** (`relationship-validation.ts`): added
`validateDealRelationship` (completing the company/contact/deal set) and
a single dispatcher `validateRelatedToRelationship` using a fixed
`switch` over exactly `company | contact | deal` — no dynamic SQL,
reused unchanged by Activities, Notes, and Taggings' target-side
validation. Added `validateTagRelationship` for Taggings' tag-side
validation. Taggings validate BOTH sides before insert (the tag itself
and the polymorphic target), each collapsing "doesn't exist / wrong org
/ soft-deleted" into one indistinguishable error, matching every
existing `InvalidXRelationshipError`'s own discipline — no cross-tenant
existence leak.

**GDPR historical-state reads**: `getActivityById`/`getNoteById`/
`listActivities`/`listNotes` exclude only soft-deleted rows — a row
produced by `execute_contact_erasure()` (`related_to_id`/free-text
columns NULL, `related_to_type` still `'contact'`) is read back exactly
as stored, never rejected, never repaired, never given a fabricated
identifier. Proved by tests that directly reproduce that exact row shape
via `seedAsAdmin`, never through the domain layer (which cannot produce
it itself).

**Tests**: `activities.test.ts` (43), `notes.test.ts` (36), `tags.test.ts`
(36, including Taggings) — 115 new tests, all passing on first run.
Cover: field/type/allowlist validation, mass-assignment guards
(`organizationId`/`createdBy` always from `ctx`, never `input`), all 9
required cross-org rejection cases (Activity/Note/Tagging ×
Company/Contact/Deal), cross-org Tag attachment, soft-deleted-target
rejection, duplicate Tag name and duplicate Tagging conflict mapping,
the GDPR-erased historical-state read proof, and the
soft-deleted-target-does-not-revalidate-an-unrelated-update proof.

**A self-caught, test-only defect fixed before commit**: 6 new test
cases used a `...({...} as never)` spread pattern TypeScript rejects
(`TS2698`, "spread types may only be created from object types") — fixed
by casting the whole object literal instead of the spread fragment; no
behavioral change.

**Verification**: `pnpm test` all green — database 476/476, auth
257/257, ui 39/39, compliance 32/32, crm 310/310 (was 195, +115), web
440/440, tenancy 28/28; lint/typecheck/build clean; `git diff --check`
clean; migration-safety gate unchanged at 39 (confirms no migration
added); secret scan clean.

**Milestone 2.3B: COMPLETE.**

### Milestone 2.3C — Activities, Notes & Tags RBAC

Permission-matrix data only — no domain-logic change (`packages/crm`
untouched this step), no API routes, no UI. **2.3D has not started.**

**12 new `PermissionKey`s added** to `packages/auth/src/permissions.ts`:
`activities:read`, `activities:create`, `activities:update`,
`activities:delete`, `notes:read`, `notes:create`, `notes:update`,
`notes:delete`, `tags:read`, `tags:create`, `tags:update`,
`tags:delete`. No wildcard/catch-all key. No `taggings:*` key set —
Taggings authorize under their owning Tag's own keys instead (below),
mirroring `pipeline_stages`' own precedent exactly (a relationship/child
resource authorizes under its owning resource's keys, never its own
family).

**Frozen matrix applied exactly**:

| Role | activities:read | activities:create | activities:update | activities:delete | notes:read | notes:create | notes:update | notes:delete | tags:read | tags:create | tags:update | tags:delete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| org_admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| org_member | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| org_viewer | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| agency_owner | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| agency_admin | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| portal_customer | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

No agency roll-up access granted (explicitly out of this milestone's
scope, same as every other resource added so far — no
`agency_rollup_activities`/`agency_rollup_notes`/`agency_rollup_tags`
view exists).

**Taggings authorization mapping (design intent for 2.3D, not yet wired
to any route)**: Taggings have no permission keys of their own. A future
Taggings API route authorizes under its owning Tag's own keys: `GET`
taggings → `tags:read`; `POST` a tagging → `tags:create`; `DELETE` a
tagging → `tags:delete`. There is no `PATCH` mapping — Taggings have no
update operation at any layer (2.3A schema, 2.3B domain layer), so
`tags:update` is never consulted for a tagging route. Documented in
`packages/auth/src/permissions.ts`'s own comment.

**Migration**: one additive file,
`20260817090300_update_role_permission_sets_2_3c.sql` — a
`roles.permission_set` data update only (no schema/RLS/function
change), following the exact established pattern (full, deterministic
per-role JSONB replacement, never a merge) from the M1.5 seed, M1.6,
2.1E, and 2.2C permission-set migrations. Only `org_admin`/
`org_member`/`org_viewer` rows are touched; `agency_owner`/
`agency_admin`/`portal_customer` rows are left untouched (they gain none
of the 12 keys) and remain byte-identical to their previously-committed
state.

**`roles.permission_set` behavior**: verified byte-equivalent to
`PERMISSION_MATRIX` via `permission-set-sync.test.ts` run against the
real local database after the migration was applied (`db reset`,
replaying all 40 migrations from the corrected source) — `toEqual()`
deep-equality on every role's `permission_set`, plus a row-count/role-set
check. Same regression guard established at M1.5 and reused unchanged at
every subsequent permission-set update (M1.6, 2.1E, 2.2C, now 2.3C) —
passed on first run.

**Tests**: `packages/auth/tests/permissions.test.ts`'s independently
hand-written `EXPECTED` matrix (never derived from `PERMISSION_MATRIX`)
extended with all 12 new keys for all 6 roles, plus dedicated Milestone
2.3C describe blocks proving: the full frozen Activities/Notes/Tags
matrix per role; Taggings authorization maps to `tags:*` (structural
check that no `taggings:*` key exists anywhere in the matrix or in this
test file's own independently maintained key list, plus a
documented-intent test for the three HTTP-verb mappings, explicitly
noting there is no PATCH); `activities:delete`/`notes:delete`/
`tags:delete` never diverge from each other or from
`data-subject-requests:execute` by accident (no role in the frozen
matrix holds one delete without the other two, proving `can()` has no
cross-key inference); every pre-2.3C permission (all 22 M1.5/M1.6/2.1E
keys plus the 8 2.2C Deals/Pipelines keys) unchanged for every role; an
unrecognized action string and an unrecognized role both deny without
throwing. The pre-existing `readOnlyGrants` list in the "deny-by-default"
test was updated to include `activities:read`/`notes:read`/`tags:read`.

**Verification**: `pnpm test` all green — database 477/477 (up from
476; the +1 is `migration-safety.test.ts`'s own dynamic per-migration-
file test count, not a new hand-written test), auth 343/343 (up from
257), ui 39/39, compliance 32/32, crm 310/310, web 440/440, tenancy
28/28; `pnpm audit --audit-level=high` clean; lint/typecheck/build
clean; `git diff --check` clean; migration-safety gate pass at 40
migrations; secret scan clean.

**Milestone 2.3C: COMPLETE.**

### Milestone 2.3D — Activities, Notes, Tags & Taggings API layer

`apps/web/app/api/v1` routes only — no domain-logic change
(`packages/crm` untouched), no RBAC-matrix change (`packages/auth`
untouched), no migration, no UI. **2.3E has not started.**

**8 new routes**, following the established `handlers.ts`/`route.ts`
split exactly (Companies/Contacts/Deals/Pipelines precedent):

- `GET /api/v1/activities`, `POST /api/v1/activities`
- `GET /api/v1/activities/{id}`, `PATCH /api/v1/activities/{id}`, `DELETE /api/v1/activities/{id}`
- `GET /api/v1/notes`, `POST /api/v1/notes`
- `GET /api/v1/notes/{id}`, `PATCH /api/v1/notes/{id}`, `DELETE /api/v1/notes/{id}`
- `GET /api/v1/tags`, `POST /api/v1/tags`
- `GET /api/v1/tags/{id}`, `PATCH /api/v1/tags/{id}`, `DELETE /api/v1/tags/{id}`
- `GET /api/v1/taggings`, `POST /api/v1/taggings`
- `DELETE /api/v1/taggings/{id}` — **no GET-by-id, no PATCH** (Taggings
  have no update operation at any layer, 2.3A schema through 2.3C RBAC)

**Taggings authorization**: no `taggings:*` permission family exists
(2.3C frozen design) — `taggings/handlers.ts` imports `resolveActor`
directly from `../tags/handlers.ts` rather than duplicating it, checking
`tags:read`/`tags:create`/`tags:delete` respectively, mirroring the
`pipeline_stages` → `pipelines:*` precedent exactly (a relationship/child
resource authorizes under its owning resource's keys). No idempotency
machinery on `POST /api/v1/taggings` (deliberate) — duplicate creation is
already uniquely constrained at the database level
(`taggings_tag_id_taggable_type_taggable_id_key`) and maps to 409 through
that constraint alone.

**Malformed-UUID hardening (closes the known 2.3B open point)**: before
this milestone, no route in the entire API — including Companies/
Contacts/Deals/Pipelines — validated UUID *shape* anywhere; a
malformed-but-non-empty string (e.g. `"not-a-uuid"`) reached Postgres
unvalidated and surfaced as a raw `invalid input syntax for type uuid`
error. A new shared helper, `apps/web/app/api/v1/_shared/uuid.ts`
(`isValidUuid`, reusing `packages/crm/src/pagination.ts`'s own
`UUID_PATTERN` regex verbatim rather than inventing a second one), is
used by every new Activities/Notes/Tags/Taggings route to reject this
input before it ever reaches a query. Classification: a malformed route
`:id` → 404, extending the existing "cross-org and nonexistent are
indistinguishable" doctrine to a third case (never reveals *why* a path
identifier didn't resolve); a malformed relationship/filter UUID
(`relatedToId`, `tagId`, `taggableId`, `createdBy`) → 400, matching how a
well-formed-but-invalid relationship value already maps to 400 elsewhere.
Deliberately scoped to only the new routes — the identical pre-existing
gap on Companies/Contacts/Deals/Pipelines is a known, unaddressed,
out-of-scope issue, not silently fixed here and not worsened.

**Error mapping** mirrors the established `mapCrmError` `instanceof`
pattern exactly: `ValidationError` and the relevant
`InvalidXRelationshipError`s → 400 (relationship fields are body/query
inputs here, never a path resource identifier); `DuplicateTagNameError`/
`DuplicateTaggingError` → 409; cross-org or nonexistent `:id` → 404,
response body byte-identical to the nonexistent case (tested); an
invalid/cross-org relationship attempt never distinguishes "target
belongs to another org" from "target doesn't exist" (tested,
response-body-equality assertion). No raw Postgres error, SQLSTATE, or
stack trace ever reaches a response body.

**Mass-assignment protection**: every `extractCreateInput`/
`extractUpdateInput` is an explicit allowlist, never a body spread —
`id`/`organizationId`/`organization_id`/`createdBy`/`created_by`/
`createdAt`/`created_at`/`updatedAt`/`updated_at`/`deletedAt`/
`deleted_at` have no extraction code path at all. `createdBy` on
Activities/Notes is always `actor.userId` (packages/crm's own 2.3B
sourcing), never read from the request body. Activities/Notes `PATCH`
additionally has no `relatedToType`/`relatedToId` extraction — a
smuggled value in the body has no effect (tested). Taggings has no
update endpoint at all.

**Tests**: `activities-api.test.ts` (29), `notes-api.test.ts` (30),
`tags-api.test.ts` (23), `taggings-api.test.ts` (26) — 108 new tests, all
passing on first run. `crm-api-fixtures.ts` extended with
`seedActivity`/`seedNote`/`seedTag`/`seedTagging` (direct-SQL, matching
every existing `seed*` helper's own convention). Coverage: the full
auth/RBAC/tenancy/IDOR matrix per resource (mirroring `deals-api.test.ts`
exactly — org_admin full CRUD, org_member no-delete, org_viewer
read-only, pure-agency-actor and unaffiliated-user 403, cross-org
GET/PATCH/DELETE 404 with response-body equality against the
nonexistent-id case, collection list never leaking another
organization's rows); Taggings' specific authorization-mapping proof
(`GET`→`tags:read`, `POST`→`tags:create`, `DELETE`→`tags:delete`,
`org_member` denied `DELETE` specifically because it lacks
`tags:delete`, `org_viewer` denied `POST`/`DELETE`); all 9 required
cross-org relationship-create-attack cases (Activity/Note/Tagging ×
Company/Contact/Deal) plus Tagging→cross-org-Tag; malformed-UUID
hardening for every `:id`/body/filter UUID input; mass-assignment
injection tests; the GDPR historical-read proof (`GET`/list correctly
serialize a row with `relatedToId`/`subject`/`body` null and
`relatedToType` still `'contact'`, without erroring); soft-delete-vs-
physical-delete proofs (Activities/Notes/Tags survive in the database
after "delete" with `deletedAt` set; a deleted Tagging is genuinely gone
from the table); idempotency replay/conflict/no-header/demoted-actor
tests for Activities/Notes/Tags, and the deliberate-no-idempotency proof
for Taggings (two identical POSTs both attempt real inserts, the second
collides with the unique constraint → 409, row count stays 1).
Same-origin enforcement verified by structural source inspection against
every new mutating `route.ts` (byte-for-byte pattern match against
`deals/route.ts`) rather than a new per-resource integration test class
— matching the established repository convention exactly, where
`isSameOrigin()` itself has exactly one dedicated unit-test location
(`organizations-api.test.ts`) and no existing resource (including Deals)
re-tests it per route.

**Verification**: `pnpm audit --audit-level=high` clean; lint/typecheck
clean, 8/8 packages; `pnpm test` all green — database 477/477, auth
343/343, ui 39/39, compliance 32/32, crm 310/310, web 548/548 (up from
440, +108), tenancy 28/28; `pnpm build` clean, exactly 8 new routes in
the build's own route inventory (`/api/v1/activities`,
`/api/v1/activities/[id]`, `/api/v1/notes`, `/api/v1/notes/[id]`,
`/api/v1/tags`, `/api/v1/tags/[id]`, `/api/v1/taggings`,
`/api/v1/taggings/[id]`); `git diff --check` clean; migration-safety gate
pass, unchanged at 40 migrations (confirms no migration added); secret
scan clean.

**Milestone 2.3D: COMPLETE.**

### Milestone 2.3E — Activity Timeline UI (Company/Contact/Deal integration)

The first UI integration for Activities, Notes, and Tags/Taggings —
`docs/07-UI-UX-System.md`'s own `ActivityTimeline` ("polymorphic timeline
for activities/notes on a contact/company/deal detail page") plus a
minimal Tags area, embedded on all three existing detail pages. No
schema/migration/RLS/GDPR-erasure-function/RBAC-matrix/API-contract
change — UI only. **2.3F has not started.**

**Documentation contradiction found and resolved before implementation**:
`docs/07` §2/§5 states the UI is "Built on shadcn/ui primitives (Radix +
Tailwind)." This is stale/aspirational, not what is actually
implemented — verified directly: zero `tailwind.config.*` anywhere in
the repo, zero shadcn/Radix/Tailwind dependency anywhere, and the two
composites `docs/07` itself names as already built (`EntityTable`,
`PipelineBoard`) are both plain React + CSS Modules. `ActivityTimeline`
and the new `TagList` composite follow the real, actual, locked
architecture (CSS Modules, `packages/ui/src/`), matching `EntityTable`'s
own file shape exactly — not `docs/07`'s stale framing.

**Architecture — one shared implementation, not three** (frozen 2.3E
decision): `packages/ui/src/activity-timeline.tsx` +
`activity-timeline.module.css` and `tag-list.tsx` + `tag-list.module.css`
are presentation-only (no data fetching, no `can()`, no tenant context —
same discipline as `EntityTable`/`PipelineBoard`). All
data-fetching/RBAC/mutation logic lives in one shared web integration
area, `apps/web/app/_shared/activity-timeline/`, parameterized by
`relatedToType: "company" | "contact" | "deal"` — Companies/Contacts/
Deals detail pages each supply only their own `relatedToType`/
`relatedToId`/`returnPath`/`actor` and render `<ActivityTimelineSection>`.
No per-record-type duplication of Server Actions, forms, or mutation
logic — genuinely identical business logic across all three, per
CLAUDE.md's "no duplicate logic" rule.

**Shared files**: `loader.ts` (merges Activities + Notes into one
chronological stream, reusing the 2.3D API handlers directly in-process,
ADR-004 — never a raw domain call), `activity-logic.ts`/`note-logic.ts`/
`tag-logic.ts` (Server-Action-body FormData parsing, mirroring
`contacts/[id]/update-logic.ts`'s own shape exactly), `actions.ts` (the
`"use server"` bindings), `activity-form.tsx`/`note-form.tsx`/
`delete-entry-form.tsx`/`entry-actions.tsx`/`tag-controls.tsx` (client
components), `section.tsx` (the Server Component tying it together, all
`can()` checks), `types.ts`, `related-label.ts`, `timeline-limit.ts`.

**UX**: 100% server-rendered, matching the established MPA architecture
exactly (no exception found anywhere in 2.1/2.2's own UI) — mutations are
`useActionState` Server Actions with a full-page `redirect()` on success,
never a client-side optimistic update; delete uses the exact two-step
disclosure pattern from `delete-contact-form.tsx` (no Dialog primitive
exists to reuse); no toast (none exists). Vertical card-list, single
column at every width (a timeline has no natural narrow-vs-wide
degradation the way `EntityTable`'s row/card split does). Each entry
shows a type badge (Call/Email/Meeting/Task/"Logged note" for
`type='note'` Activities, "Note" for a standalone Note — deliberately
different labels so the two are never visually confused, per the frozen
2.3 design's own distinction), subject/body, creator (resolved via the
existing `listActiveOwnerOptions`/`resolveOwnerLabel` — reused unchanged,
zero new code needed since `createdBy` is the same kind of id as
`ownerId`), and timestamp.

**Pagination — bounded `limit`, not a fabricated cursor** (frozen 2.3E
decision, documented limitation): Activities and Notes are two
independently-cursored resources with no genuine unified cursor without
an API/domain change, which is out of scope. Both are fetched with the
same `limit` (default 10, `?timelineLimit=N` query param, capped at 100);
"Load more" is a real `<Link>` to the same page with a larger `limit` —
re-fetches both resources fresh and re-merges, using only the
already-existing, already-tested `limit` parameter, never a new API
capability. `hasMore` is true whenever either underlying list's own
`nextCursor` is non-null OR the combined raw fetch already exceeded the
display limit, so a genuinely larger dataset is never silently capped
without a visible way to see more.

**GDPR historical state — empirically confirmed structurally
unreachable, not merely assumed**: an Activity/Note directly related to
an erased Contact (`execute_contact_erasure()`, 2.3A: `relatedToId` set
to `null`) can never again match `loadTimeline`'s own
`relatedToType`+`relatedToId` exact-match filter — including the filter
for the record it used to belong to — proven by a test that seeds
exactly this state and confirms the row is absent from the fetched
result, not merely tolerated. This is a *good* security property (no
live page can ever surface a stale/dangling reference to an erased
contact), not a gap: the row simply becomes invisible to any per-record
timeline the moment it's erased. The frozen "Erased contact" fallback
(`related-label.ts`'s `resolveRelatedToLabel`) is implemented and unit
tested regardless, for defensive correctness and future reuse (e.g. a
possible future cross-record activity feed), even though no current
2.3E page has a visible "related to X" label for it to appear in — every
timeline entry is already implicitly scoped to the page the viewer is
already on.

**Tags/Taggings** (included in 2.3E per your explicit instruction, wider
than `docs/07`'s own narrower `ActivityTimeline` definition): chips
displaying attached Tags with a validated-hex-or-neutral color swatch
(free-form `tags.color` is never interpolated into a raw CSS string —
React's `style` object only ever assigns one known property, so there is
no injection surface either way, but a strict `#rgb`/`#rrggbb` match is
still required before using the value at all, per the explicit
instruction to render neutrally when safety isn't guaranteed), an
"attach existing tag" `<select>` (excluding already-attached tags), and
a "create & attach new tag" fallback — both gated on `tags:create`.
Removing a Tagging is a single-click physical delete (no soft-delete —
the Tag itself is never touched, only the Tagging relation) with no
2-step confirm (the lowest-stakes, most trivially-reversible action in
this feature, mirroring the same reasoning already accepted for its
server-side hard-delete design). **Known, documented limitation**: the
org's active-tag list (for the "attach existing" picker and for
resolving an attached Tagging's own name/color) is fetched with
`limit=MAX_LIMIT` (100, `packages/crm`'s own existing ceiling) — an
organization with more than 100 active tags could have some attached
tags fail to resolve a name for this specific join, falling back to a
truncated, clearly-synthetic label (never a raw full UUID) — a display-
completeness limitation, not a data-loss or security issue, out of scope
to fully solve without a dedicated Tag-management/search UI (explicitly
excluded from 2.3E).

**RBAC**: every visible/mutating control gated server-side via `can()`
in `section.tsx`, computed once, never client-side — `activities:*`/
`notes:*`/`tags:*` exactly as frozen in 2.3C, no `taggings:*` (Taggings
authorize under `tags:*`, reusing the 2.3D API handlers' own enforcement
unchanged). The UI is never the authorization boundary: every
`handleX` call still independently re-checks `can()` regardless of what
this milestone's own code chose to render.

**Tests**: `apps/web/tests/activity-timeline.test.ts` (43 new tests, all
passing on first run) — per-record scoping (Company/Contact/Deal
timelines never cross-leak), merged chronology correctness, empty-stream
and handler-error behavior, the empirical GDPR-unreachability finding
above, `resolveRelatedToLabel`/`parseTimelineLimit` unit tests,
Activity/Note create-update-delete logic across org_admin/org_member/
org_viewer (including a forged HTML/script-looking payload round-tripping
as inert stored text, never sanitized/mangled server-side — React's
default escaping is the sole, structural safety net, confirmed by a
dedicated grep-based test asserting zero `dangerouslySetInnerHTML`/
`<iframe>` anywhere in the new component files), Tag/Tagging list-attach-
create-remove logic including the duplicate-Tagging-conflict-maps-to-a-
safe-message proof, and cross-org IDOR passthrough confirmation. Full
existing `companies-console.test.ts`/`contacts-console.test.ts`/
`deals-console.test.ts` regression suites re-run unchanged (119 tests,
all passing) to confirm the embedded section doesn't break existing
detail-page behavior.

**Verification**: `pnpm audit --audit-level=high` clean; lint/typecheck
clean, 8/8 packages (one self-caught, non-security fix: `parseTimelineLimit`
was originally defined inside `section.tsx`, a `.tsx`/JSX file — Vite's
import-analysis couldn't parse it when a test imported it directly, so
it was extracted to its own pure `timeline-limit.ts`, mirroring the
existing `owner-option.ts`/`owner-options.ts` pure-vs-framework-specific
split precedent); `pnpm test` all green — database 477/477, auth
343/343, ui 39/39, compliance 32/32, crm 310/310, web 591/591 (up from
548, +43), tenancy 28/28; `pnpm build` clean, zero new API routes (UI-only
milestone, confirmed by an unchanged route inventory); `git diff --check`
clean; migration-safety gate pass, unchanged at 40 migrations; secret
scan clean.

**Milestone 2.3E: COMPLETE.**

### Milestone 2.3F — GDPR-erasure vocabulary correction (CRM UI)

**Scope**: presentation-only. A read-only audit (this milestone's own
Phase 1) found that no document in this repository independently defines
"Milestone 2.3F" — the "GDPR UI copy polish" framing existed only as this
session's own forward-reference, written into this file and docs/12
during 2.3E. 2.3F's actual scope was therefore derived from the audit's
own evidence, not asserted from that label, and narrowed to exactly two
findings once traced to their root cause.

**Canonical vocabulary distinction (frozen this milestone)**:

- `"<name> (deleted)"` — an ordinary soft-deleted CRM record, still
  physically present, resolvable via the record's own `*IncludingDeleted`
  read helper. Recoverable in principle. Unchanged.
- `"Unknown member"` — a non-null `ownerId`/`createdBy` whose membership
  has become `'removed'`. Not GDPR-related; a separate, pre-existing
  design decision (`_shared/owner-option.ts`).
- `"Erased contact"` — a Contact reference that is physically absent
  (`getContactByIdIncludingDeleted` returns null), which for `contacts`
  can only occur via `execute_contact_erasure()` (GDPR hard-delete);
  ordinary soft-delete always leaves the row queryable here. Changed this
  milestone from the prior, misleadingly-recoverable-sounding
  `"Deleted contact"` (`_shared/contact-display.ts`).
- `"Erased user"` — a Timeline Activity/Note's creator label when
  `createdBy` is null. `resolveOwnerLabel`'s own `if (!ownerId) return
  null` guard means this is the *only* reason the resolved label is ever
  null (an inactive-but-identified member resolves to `"Unknown member"`
  instead) — and `created_by` on an existing row only ever becomes null
  via `execute_user_erasure()`'s `ON DELETE SET NULL` cascade, never any
  other code path. New this milestone (`_shared/activity-timeline/
  creator-label.ts`), replacing the generic `"Unknown"` fallback
  previously shown by `packages/ui/src/activity-timeline.tsx` for this
  specific case. `packages/ui`'s own defensive `?? "Unknown"` fallback is
  deliberately left in place as a last-resort default for any future
  caller that doesn't apply `resolveCreatorLabel` — the GDPR-aware
  resolution happens in the web integration layer
  (`_shared/activity-timeline/section.tsx`), never in the presentation
  package, preserving 2.3E's presentation-only boundary for
  `packages/ui`.

**Reachability, re-confirmed empirically**: a directly-related Activity/
Note whose `related_to_id` was nulled by `execute_contact_erasure()`
(2.3A) remains structurally unreachable through any live per-record
timeline fetch — re-confirmed by this milestone's audit, not just
carried over from 2.3E's finding. By contrast, `created_by` going null
via `execute_user_erasure()` does *not* touch `related_to_id`, so that
row stays fully visible on its record's own timeline — this is the
reachable case Finding A (the "Erased user" label) actually addresses.
A new test proves this distinction directly: an Activity with
`created_by` nulled (simulating the erasure cascade) is found by
`loadTimeline`, while the existing `related_to_id`-nulled case remains
absent.

**Files changed**: `apps/web/app/_shared/activity-timeline/creator-label.ts`
(new, pure resolver, mirrors `related-label.ts`'s exact style — no DB
access, no actor resolution, no tenant logic, no RBAC); `section.tsx`
(applies `resolveCreatorLabel` when mapping each Activity/Note entry,
before entries reach `packages/ui`); `_shared/contact-display.ts`
(`"Deleted contact"` → `"Erased contact"` for the physically-absent
branch only — the soft-deleted-but-present `"<name> (deleted)"` branch is
untouched). No migration, no domain/API/RBAC change — `createdBy: null`
was already returned by the existing 2.3D API; this milestone only
changes how it is labeled.

**Tests**: extended `activity-timeline.test.ts` (+5 net: `resolveCreatorLabel`
unit tests for the null and non-null cases; an integration-style test
seeding an Activity, nulling its `created_by` via direct SQL to simulate
the erasure cascade, and confirming the `loadTimeline` → `resolveCreatorLabel`
composition — the exact composition `section.tsx` performs — yields
`"Erased user"`; a companion test confirming a normal, non-erased
creator's label passes through unchanged) and `deals-console.test.ts`
(updated the existing physically-absent-contact test's expectation from
`"Deleted contact"` to `"Erased contact"`, with an added no-raw-UUID
assertion). No test was weakened to make this pass. Full existing
regression suites (591/591 web, plus every other package) re-run and
green.

**Deferred, explicitly out of scope**: `apps/web/app/data-subject-requests/**`
was not modified. The list page (`data-subject-requests/page.tsx`)
renders a raw `dsr.subjectId` UUID directly, and the execute-erasure
surface (`data-subject-requests/[id]/erasure-actions.tsx`) is a minimal,
unstyled M1.6-era component relying only on the word "irreversible" —
both are real, pre-existing findings from this milestone's own audit,
but predate the Activities/Notes/Tags domain this session has built
since 2.3B and were explicitly frozen out of 2.3F's scope rather than
silently pulled in. A second, narrower finding — `apps/web/app/deals/
page.tsx`'s own list-column fallback (`contactNameById.get(...) ??
"Deleted contact"`, line ~138) — was also left unchanged: it is
defensive/unreachable dead code (the page's own resolution loop always
populates `contactNameById` for every referenced id before this render
function runs), was not part of the audit's named Finding B scope
(`contact-display.ts`), and changing it would have widened this
milestone beyond the approved, evidence-backed scope. Flagged here for a
future pass, not fixed now.

**Verification**: `pnpm install --frozen-lockfile` clean (lockfile
unchanged); `pnpm audit --audit-level=high` clean; lint/typecheck clean,
8/8 packages; `pnpm test` all green — database 477/477, auth 343/343, ui
39/39, compliance 32/32 (including `contact-erasure`/`user-erasure`
regression), crm 310/310, web 596/596 (up from 591, +5), tenancy 28/28;
`pnpm build` clean; `git diff --check` clean; migration-safety gate pass,
unchanged at 40 migrations; secret scan clean; confirmed zero
`dangerouslySetInnerHTML` introduced; confirmed `package.json`/
`pnpm-lock.yaml`/`packages/database`/`packages/crm`/`packages/auth`/
`packages/compliance`/API routes/`data-subject-requests/**` all
untouched (`git status`/`git diff --stat`).

**Milestone 2.3F: COMPLETE.**

### Milestone 2.3 — Overall Closeout

Milestone 2.3G ran in four parts, mirroring the 2.2G/2.2H precedent
(final adversarial audit, then staging deployment + live database
verification, then manual staging application verification, then this
closeout record) — with one real, disclosed incident along the way,
consistent with this project's practice of recording what actually
happened rather than only the parts that went smoothly.

**2.3G Phase 1 — final cross-stack audit.** A fresh, from-source audit
of the complete 2.3A–2.3F implementation (database, domain, RBAC, API,
UI, GDPR behavior) found every layer COMPLETE, with one real, narrow
test-coverage gap: `activity-timeline.test.ts` had an explicit cross-org
regression test for `activity-logic.ts` but not for `note-logic.ts` or
`tag-logic.ts`, even though the 2.3D API layer beneath already covered
cross-org rejection exhaustively for all four resources. No genuine
security/privacy defect was found — no cross-tenant leak, no RBAC/RLS
bypass, no PII exposure, no unsafe dynamic SQL, no exposed secret. Two
narrow, non-blocking items were newly discovered and explicitly deferred
as outside Milestone 2.3's own scope: pre-2.3 resources
(companies/contacts/deals/pipelines) lack the `isValidUuid` path-parameter
guard that 2.3D's own routes have (relies on Next.js's untested-by-this-repo
production error suppression instead); and a dead, unreachable
`"Deleted contact"` string in `deals/page.tsx`'s own list-column fallback
(the page's resolution loop always populates the lookup map before this
branch could fire). Neither required a scope-widening stop.

**2.3G Phase 2A — cross-stack test-gap closure.** Two tests added to
`activity-timeline.test.ts` (`note-logic`/`tag-logic` cross-org
rejection, mirroring the existing `activity-logic` test exactly),
closing the one real gap from Phase 1. Test-only change (54 lines, one
file). Committed `93a5bca` (`test: close Milestone 2.3 cross-stack
tenant-isolation gaps`), pushed, GitHub Actions CI #98 user-verified
green.

**2.3G Phase 2B/2C — staging deployment + live verification.** The four
pending Milestone 2.3 migrations (`20260817090000`/`090100`/`090200`/`090300`)
were identified via a read-only `supabase migration list --linked`
comparison against the confirmed staging project
(`damunjcpwxthdjaonatb`, `ai-revenue-os-staging`) — 36 of 40 local
migrations already applied, zero drift, zero unexpected entries. Applied
via `supabase db push --linked`; one non-blocking warning occurred (a
separate post-push catalog-caching step failing on a missing certificate
file inside the CLI's own internal sandboxed edge-runtime path,
unrelated to the migration application itself — independently confirmed
non-blocking via a fresh post-push `migration list` showing all 40
migrations synchronized, zero drift). Live catalog-level verification
(not a re-read of migration source) confirmed: all 4 tables present with
correct column nullability, constraints, and indexes; RLS enabled on all
4 with the exact intended policy set (no `DELETE` policy on
activities/notes/tags, no `UPDATE` policy on taggings); zero `anon`
grants; `execute_contact_erasure()`'s live body confirmed to contain the
NULL-safe auth guard and all three scrub/delete steps; both platform
retention entries present at 2555 days; the `roles.permission_set`
snapshot correctly reflects the 12 new keys per role, matching
`PERMISSION_MATRIX` exactly.

**2.3G Phase 2D — manual staging application verification, including
one real incident.** The first Preview build attempt failed because the
Preview environment was missing `DATABASE_URL` entirely — fixed by
adding it (the Supabase Transaction Pooler connection string) to the
Preview environment specifically, never touching Production. Once fixed,
the build succeeded, and `apps/web/scripts/verify-preview-environment.mjs`
(the real, already-wired M1.9 build-gate — not merely the synthetic unit
test) is what actually validated the Preview deployment's
`NEXT_PUBLIC_SUPABASE_URL`/`DATABASE_URL` against the expected staging
project ref live, before the build was allowed to proceed. Application
verification then proceeded successfully: Activity/Note/Tag
create/update/delete/attach/detach all confirmed working against real
staging data.

For RBAC-specific verification, two temporary staging-only test accounts
were needed (org_member, org_viewer) — none existed previously, since
this product currently has no invite/member-management UI at all (a
finding surfaced during this same investigation: `create_organization_with_owner()`,
the only membership-creating code path, always assigns `org_admin`).
Creating them via the Supabase Auth Admin API (not raw SQL) plus one
narrow, exactly-scoped `INSERT` into `memberships` surfaced a real,
genuine incident: both new accounts could log in but `/dashboard`
reported "Your account isn't linked to an organization yet," despite a
correct, verified-active `memberships` row. Root-caused (proven both
from source and live query, not guessed) to `public.users.default_organization_id`
being left `NULL` — `get_my_membership_context()`
(`packages/database/supabase/migrations/20260806100859_create_membership_context_function.sql`)
reads this field first and returns zero rows before ever reaching the
`memberships` join if it's null, unlike the normal signup path
(`create_organization_with_owner()`), which sets it atomically in the
same transaction as the membership itself — a step the manual
account-creation plan had not accounted for. Fixed with a single,
exactly-scoped `UPDATE public.users SET default_organization_id = ...
WHERE id IN (<the two test user ids>)`, touching no other row, no RLS
policy, no migration, and no application code. Re-verified after the
fix: both users' `get_my_membership_context()` confirmed live (via
simulated JWT claims inside a read-only `BEGIN...ROLLBACK`, never
persisted) to return the correct organization/role; both users
confirmed, live, to see zero rows of a second, unrelated staging
organization's data (direct RLS proof, not inference); `/dashboard`
manually confirmed working for both accounts by the project owner, with
the organization-context error gone.

**Evidence-tier note, for transparency against the 2.1/2.2 precedent**:
2.1 and 2.2's own closeouts each recorded a *separate* "manual production
verification" tier, distinct from staging (2.2H's fourth part explicitly
labeled "user-attested — not independently performed by the assistant").
For 2.3, the verification performed and described above was against the
Vercel **Preview** deployment pointed at the staging Supabase project;
no separately-described Production-deployment verification step
occurred in this closeout. (2.1's own closeout separately noted that,
at that time, the Vercel project auto-deployed every `main` push as a
Production deployment too — whether that configuration still holds
today, and whether it applies to the Preview deployment tested here, is
not something this environment can independently confirm.) Recorded
here as a factual observation, not a blocker — the project owner
directed this closeout with the evidence above judged sufficient.

**Automated technical evidence, re-run at closeout (commit `93a5bca`,
`main`, working tree clean).** `pnpm lint`/`typecheck`/`build` clean
across all 8 packages; `pnpm audit --audit-level=high` clean; `pnpm test`
**1,827/1,827 passing** across all 7 tested packages (database 477, auth
343, ui 39, compliance 32, crm 310, tenancy 28, web 598); migration-safety
gate clean, 40 migrations, zero drift against staging; secret scan clean
throughout every phase of 2.3G, including the live staging investigation
(only public project refs/names/IDs were ever read or printed — no
password, token, service-role key, or connection string was exposed at
any point).

**Milestone 2.3: PASS — CLOSED.** Every gate has passed: implementation
complete (2.3A through 2.3F), a fresh final audit found no blocking
defect, the one real test-coverage gap it found was closed, staging
database state was verified live with zero drift, and staging
*application* behavior — including RBAC across all three CRM-relevant
roles (org_admin/org_member/org_viewer) — was confirmed working by the
project owner, with one real incident (the Preview `DATABASE_URL`
misconfiguration) and one real regression (manually-created memberships
missing `default_organization_id`) found and fixed along the way, both
disclosed above rather than omitted. Milestone 2.4 is next — see
`docs/12-Implementation-Milestones.md`.

## Milestone 2.4 — Agency Roll-Up Views

### Milestone 2.4A — Database roll-up views

Four new views (`agency_rollup_companies`/`agency_rollup_contacts`/
`agency_rollup_deals`/`agency_rollup_pipelines`), each following the exact
`agency_rollup_organizations` (M1.4) pattern: `security_invoker = false`,
joined to `organizations`, `WHERE o.agency_id = current_agency() AND
current_role_key() IN ('agency_owner','agency_admin')`, with an explicit
`REVOKE ALL` + `GRANT SELECT ... TO authenticated` written into the same
migration that creates each view — not left to the platform-wide default-ACL
migration alone, per the lesson of the earlier default-table-privileges
incident (M1.7/M1.9). Column sets are deliberately minimal: Contacts excludes
email/phone and other PII-shaped fields; Deals excludes `stage_id` (no
stages roll-up exists) and `primary_contact_id`/`probability`/`owner_id`;
Pipelines exposes only `id`/`organization_id`/`name`. `INSERT`/`UPDATE`/
`DELETE` against every view fail with Postgres's own "cannot
insert/update/delete into view" error — a structural, join-driven guarantee
independent of (and stronger than, not a substitute for) the explicit grant.

### Milestone 2.4B — RBAC

Four new permission keys (`companies:agency-rollup-read`,
`contacts:agency-rollup-read`, `deals:agency-rollup-read`,
`pipelines:agency-rollup-read`), added only to `agency_owner`/`agency_admin`
in `PERMISSION_MATRIX`. One migration performing two full, deterministic
`roles.permission_set` replacements — the same pattern used for every prior
permission-set migration in this repository.

### Milestone 2.4C — Domain layer

`packages/tenancy/src/agency-rollup.ts` — `listCompaniesForAgency`/
`listContactsForAgency`/`listDealsForAgency`/`listPipelinesForAgency`, each
querying only its matching 2.4A view under `withTenantContext`, ordered for
stable pagination, with a local `resolveAgencyRollupLimit` (`DEFAULT_LIMIT
25`, `MAX_LIMIT 100`) rather than a new dependency on `packages/crm`'s own
pagination module. Deliberately authorization-free at this layer — no
`can()`, no `@ai-revenue-os/auth` dependency — matching the established,
pre-existing trust model of `listOrganizationsForAgency` exactly. This was a
genuine architectural decision point, not an oversight: `packages/tenancy`
has never depended on `@ai-revenue-os/auth`, and the real repository
precedent (`create-client-org-logic.ts`) already enforces authorization one
layer above, in `apps/web` — confirmed and approved before implementation.

### Milestone 2.4D — Agency console UI

`apps/web/app/agency/rollup-logic.ts` plus four new pages (`/agency/companies`,
`/agency/contacts`, `/agency/deals`, `/agency/pipelines`), extending the
existing `/agency` console shell with four navigation links. This is the
layer where `can()` is actually checked — a 2.4C roll-up function is never
called unless the matching `*:agency-rollup-read` permission already
returned true. Client-organization names are composed here via a single
`listOrganizationsForAgency` call per request (never a widened 2.4A view),
falling back to `"Unknown client organization"` rather than ever rendering a
raw UUID; company/pipeline name resolution for the Contacts/Deals pages is
independently `can()`-gated per secondary resource. Zero write controls
exist on any of the four pages (no `<form>`, no `<button>`, no Server
Action, no click handler) — proven by dedicated structural tests, not just
asserted.

### Milestone 2.4E — Final audit, test-gap closure & staging verification

A verification-only audit (database security, RBAC, domain layer, UI
authorization/composition, tenant isolation, organization-label safety,
write-path absence, and a genuine test-gap analysis) found the milestone
complete, with exactly one "should-close-before-closeout" gap: the four
`/agency` navigation links and their corresponding back-links were not
directly asserted. Closed with structural source-level tests extending
`apps/web/tests/agency-rollup-console.test.ts`, following this repository's
existing convention (no browser/rendering test framework introduced). The
five Milestone 2.4 migrations (4 views + 1 RBAC update) were then applied to
the staging Supabase project and independently re-verified live — grants,
`security_invoker`, and the RBAC permission-set snapshot all matched the
committed migration source exactly, zero drift. See "Milestone 2.4 — Overall
Closeout" below for the full manual staging/browser verification that
followed.

### Milestone 2.4 — Overall Closeout

**Automated verification (this repository's own test suite, re-run at
closeout, working tree clean, commit `efbc6df`).** `pnpm lint`/`typecheck`/
`build` clean across all 8 packages; `pnpm test` **1,968/1,968 passing**
across all 7 tested packages (database 533, auth 381, ui 39, compliance 32,
crm 310, tenancy 46, web 627); migration-safety gate clean, 45 migrations,
zero drift against staging.

**Database verification (direct, read-only and scoped-write queries against
the linked staging Supabase project, `damunjcpwxthdjaonatb` /
`ai-revenue-os-staging`, over the same trusted admin channel used throughout
this milestone).** The five Milestone 2.4 migrations were independently
re-verified live with zero drift (2.4E). Every subsequent staging write in
this closeout was minimal, explicitly pre/post-verified, and none of it
touched application code, migrations, RLS policies, authentication logic, or
permission logic:
- One dedicated staging `agency_owner` test account, created via the
  product's own `create_agency_with_owner()` function — the only supported
  agency-creation path, exercised exactly as the real application would.
- One dedicated staging `org_admin` membership attached to an *existing*
  client organization (`M24 Test Client`, created earlier through the
  agency console's own real "create client organization" flow) — no
  supported invite/member-management UI exists yet in this product (a
  known, already-disclosed gap carried from Milestone 2.3), so this used the
  same direct-membership-insert pattern already established in this
  repository's own test suite (`organization-member-identity.test.ts`),
  executed once against staging.
- One `public.users.default_organization_id` correction for that same test
  account — a recurrence of the exact class of gap first found and fixed
  during Milestone 2.3's own closeout (a manually-created membership does not
  get this field set the way `create_organization_with_owner()`'s atomic
  signup path does); fixed with the same single-column, pre/post-verified
  `UPDATE` pattern.
- One minimal client CRM fixture created directly in the staging database —
  one company, one contact (populated with a real email/phone on the
  underlying record specifically so the roll-up view's exclusion of those
  columns is a proven masking, not an accidental absence of data), one
  pipeline with two active stages (`Qualified`, `sort_order 0`; `Proposal`,
  `sort_order 1`, added specifically to exercise the Deals Board's
  multi-stage move UI), and one deal (`M24 Test Company`, `1250 USD`,
  `status: open`). This was fixture *data*, inserted via the same
  application-layer INSERT shape `packages/crm`'s own domain functions
  issue, never a new mechanism, RLS change, or application-code change.

**Manual staging/browser verification (performed by the project owner —
this repository has no browser-driving test framework of any kind, by
long-established convention, so this category of evidence is necessarily
manual, not automated).**
- Unauthenticated `/agency` correctly redirected to `/login`.
- An `org_member` account was correctly denied and redirected to
  `/dashboard`.
- Logged in as the new `agency_owner` test account: `/agency` and all four
  roll-up pages (`/agency/companies`, `/agency/contacts`, `/agency/deals`,
  `/agency/pipelines`) loaded successfully, each showing the fixture's row
  with the correct client-organization label (never a raw UUID); the
  Contacts roll-up row showed no email/phone despite the underlying contact
  record having both; the Deals roll-up row showed company and pipeline
  **names**, never raw ids; no create/edit/delete/write control was present
  anywhere on any of the four pages.
- Logged in as the new `org_admin` test account, the Milestone 2.2 Deals
  Board and related CRM pages were re-verified end to end against the same
  fixture (Milestone 2.2 functionality, re-verified here as the natural
  vehicle for proving the roll-up console against real, non-trivial data,
  not new Milestone 2.4 scope): the deal appeared under `Qualified (1)` on
  `/deals/board`; after the second stage was added, the board showed both
  `Qualified` and `Proposal` columns; the deal was moved
  **Qualified → Proposal** through the normal "Move to stage" UI control
  and confirmed to persist after a full browser refresh; `/deals` (list
  view) and the deal detail page both showed `Stage = Proposal`,
  consistent with the board; the deal was then moved back
  **Proposal → Qualified** through the same UI, with final state
  re-confirmed in the browser (`/deals` showing `M24 Test Company`,
  `1250 USD`, `open`, `Qualified`) and independently cross-checked against
  the database (`updated_at` advanced across both moves, proving a genuine
  round trip, not a stale read).

**Milestone 2.4: PASS — CLOSED.** Every gate has passed: implementation
complete (2.4A through 2.4D), a fresh final audit found no blocking defect,
the one real test-coverage gap it found was closed, the five staging
migrations were verified live with zero drift, and staging *application*
behavior — including the full agency roll-up console and a fresh
end-to-end Deals Board stage-move round trip against real fixture data —
was confirmed working by the project owner. No application code,
migration, RLS policy, authentication logic, or permission logic was
changed during any part of the manual staging verification itself; every
staging write was a pre/post-verified, narrowly-scoped fixture operation,
disclosed above rather than omitted. Milestone 2.5 is next — see
`docs/12-Implementation-Milestones.md`.

## Milestone 2.5 — Core API Conventions Applied Platform-Wide

This milestone closed a documented design/implementation discrepancy in
`docs/04-API-Architecture.md` §1 rather than adding new resources: the API
contract had always specified a structured error envelope, atomic
`Idempotency-Key` handling, and UUID path-shape validation, but three real
gaps existed between that specification and what M1.4–M2.3D actually
shipped. Each sub-phase closed exactly one gap, in isolation, with its own
read-only audit → implementation → final acceptance audit → commit → push
cycle. No migration, RLS policy, authentication logic, RBAC permission, or
business-validation rule was changed anywhere in Milestone 2.5 — confirmed
independently in each sub-phase's own final audit and re-confirmed in this
closeout.

### Milestone 2.5A — Structured API Error Envelope

Every error response across all `/api/v1` routes previously emitted a flat
`{ "error": "<string>" }` body, despite `docs/04-API-Architecture.md` §1
having always specified a structured `{ "error": { "code", "message",
"request_id" } }` contract — a discrepancy the API doc itself disclosed
before this milestone rather than silently omitted. Closed by converging
the code on the documented contract (never the reverse): a new
`apps/web/app/api/v1/_shared/api-error.ts` (`ApiErrorCode` — a 7-value
union covering `UNAUTHENTICATED`/`FORBIDDEN`/`NOT_FOUND`/
`VALIDATION_ERROR`/`CONFLICT`/`IDEMPOTENCY_CONFLICT`/`INTERNAL_ERROR`;
`buildApiErrorBody`/`apiError`, the latter using `randomUUID()` for
`request_id`) became the one canonical constructor every route's
`handlers.ts`/`route.ts` uses — confirmed via `git diff | grep apiError |
sort -u` returning exactly one distinct call pattern across the entire
diff, no route left building an error body inline. 49 route files and 24
internal consumers (`*-logic.ts` plus five `page.tsx` files extracting
`.error.message` from the new object shape) were updated; `FormState`
interfaces themselves were left unchanged (`error?: string`) since they are
UI-facing, not wire-format. Cross-resource contract tests (`api-error-
envelope.test.ts`, 20 tests) prove 401/403/404/400/409/500 all use the
structured envelope across every resource family, success responses are
unaffected, and tenant isolation is unchanged. A pre-existing lesson
surfaced and fixed during this sub-phase's own audit: 11 pre-existing test
files had been asserting full-body `toEqual` across two independently-
generated error responses (cross-org vs. nonexistent), which only ever
worked by coincidence with a flat string body — corrected to compare
`code`/`message` only, never `request_id`, which legitimately differs per
response.

### Milestone 2.5B — Atomic Idempotency for Compliance Mutations

`Idempotency-Key` support existed for every CRM mutation (Companies,
Contacts, Deals, Pipelines, Pipeline Stages, Activities, Notes, Tags) since
their own milestones, but had never been extended to the three compliance
mutations added in M1.6 (`POST /api/v1/consent`, `POST /api/v1/data-
subject-requests`, `POST /api/v1/data-subject-requests/{id}/execute`) — a
gap `docs/04-API-Architecture.md` §2.2 had already flagged. A genuine
architectural blocker was found and reported *before* any wiring code was
written, not discovered mid-implementation: `packages/compliance`'s four
mutation functions (`recordConsent`, `fileDataSubjectRequest`,
`executeUserErasure`, `executeContactErasure`) each independently opened
their own `withTenantContext` transaction, so naive `withIdempotency`
wiring would reserve the idempotency key and run the mutation as two
separate, non-atomic transactions — a failure between them would leave a
committed key with no corresponding mutation, or vice versa. Approved fix:
generalize `packages/crm`'s own existing, already-proven
`runInClientOrTransaction` pattern out of `packages/crm/src/transaction.ts`
and into `packages/database/src/tenant-context.ts` (exported from
`packages/database`'s own index; `packages/crm/src/transaction.ts` reduced
to a one-line re-export, its 8 internal callers confirmed zero-diff), then
give each of the four compliance functions an additive, optional trailing
`existingClient?: PoolClient` parameter — omitted, each opens its own
transaction exactly as before this milestone; supplied, the mutation runs
on the idempotency reservation's own client, so reservation, mutation, and
completion commit or roll back together as one atomic unit. Zero change to
any function's validation, SQL text, or `SECURITY DEFINER` call. Proven,
not assumed: `packages/compliance/tests/transaction-participation.test.ts`
(7 tests) manually drives real Postgres transactions to confirm each
function's write is visible mid-transaction on the shared client and fully
undone after rollback; three additional failure-injection tests
(`compliance-api.test.ts` ×2, `dsr-erasure-dispatch.test.ts` ×1) drive
`withIdempotency` with a callback that runs the real mutation then throws,
proving mutation + audit + reservation roll back together and a real retry
then succeeds exactly once. `POST /api/v1/consent` and `POST /api/v1/data-
subject-requests` gained full idempotency; `/execute` gained it using a
separate idempotency-scoped actor object (since `executeUserErasure`'s own
domain context is just `{ userId }`, with no `organizationId` to key on
directly) and a deliberate design choice that a business-rule rejection
(e.g. the sole-`org_admin` erasure blocker) is never cached or replayed —
it rolls back the entire reservation, so a retry is always freshly re-
evaluated rather than serving a stale denial. `POST /api/v1/organizations`
and `GET /api/v1/data-subject-requests/{id}/preview` were confirmed, by
direct architecture/code inspection, out of scope: the former has no
`organizationId` available to key on (the organization doesn't exist yet
at request time, and `idempotency_keys.organization_id` is `NOT NULL` —
retrofitting would require a schema change, out of scope for a mechanical
retrofit); the latter is confirmed read-only and side-effect-free, so
there is no side effect to deduplicate.

### Milestone 2.5C — Malformed Path UUID Hardening

M2.3D had already closed this exact gap for Activities/Notes/Tags/Taggings
(a malformed, non-UUID-shaped path `{id}` → clean `404`, via a shared
`isValidUuid` check), but explicitly left it open for the pre-2.3D
resources — Companies, Contacts, Deals, Pipelines, Pipeline Stages —
disclosed as a known gap in `docs/04` at the time. Confirmed empirically,
not assumed: a temporary probe test (created, run, then fully removed
before any implementation, `git status` verified to leave zero trace)
proved the actual pre-2.5C behavior on GET/DELETE was an **uncaught
`DatabaseError`**, not merely a wrong status code. Closed by extending the
same M2.3D `apps/web/app/api/v1/_shared/uuid.ts` (`isValidUuid`) check to
every path `{id}`/`{stageId}` parameter across all five resources, in the
same position in the request-handling order M2.3D established (auth →
403/401 short-circuit → UUID-shape check → 404 → domain/DB access — never
reordered, proven by direct line-by-line trace in the final audit): 18
handler functions in total (Companies 3, Contacts 3, Deals 3, Pipelines 3,
`set-default` 1, Pipeline Stages list/create 2, Pipeline Stages
`{stageId}` 3 — an initial "19 handlers" scope estimate was an arithmetic
error, corrected before implementation, confirmed not to have caused any
handler to be missed). Nested pipeline-stage routes validate `{id}` and
`{stageId}` independently, so a malformed parent, a malformed child, or
both malformed at once all resolve to the same indistinguishable `404` as
a genuinely nonexistent or cross-organization id — extending the
adversarially-proven nested-resource IDOR safety M2.2B established to a
third case. 11 new tests across five resource test files cover malformed-
vs-cross-org-vs-nonexistent indistinguishability, auth/RBAC-executing-
before-validation, and the nested parent/child/both-malformed matrix.
Explicitly out of scope, and disclosed as a separate, still-open gap in
`docs/04` §2.6: malformed *query/body/filter* UUID fields (e.g. `ownerId`,
`companyId` filters) on these same resources still reach Postgres
unvalidated and surface as a generic `500` — a different class of input
(not a path parameter) that this sub-phase never claimed to cover.

### Milestone 2.5 — Overall Closeout

**Automated verification (this repository's own test suite, re-run at
closeout, working tree clean, commit `5704ef5`, the tip of 2.5C).** `pnpm
lint`/`typecheck`/`build` clean across all 8 packages; `pnpm test`
**2,036/2,036 passing** across all 7 tested packages (database 533, auth
381, ui 39, compliance 39, crm 310, tenancy 46, web 688) — a monotonic
increase across all three sub-phases from the Milestone 2.4 baseline of
1,968 (2.5A: 1,999; 2.5B: 2,025; 2,5C: 2,036), never a decrease; migration-
safety gate clean, no new migrations in Milestone 2.5 (zero database schema
change of any kind — confirmed by `git diff --stat` across all three sub-
phase commits touching no file under `packages/database/migrations/`).

**No database or manual staging/browser verification was performed for
this milestone, and none is claimed.** Unlike Milestone 2.4, Milestone
2.5's scope is entirely a code-level API-contract convergence — no new
table, view, RLS policy, or user-facing page was added — so its evidence
is exclusively the automated test suite above plus the read-only,
empirical, from-source final acceptance audit each sub-phase underwent
before being committed (2.5A, 2.5B, 2.5C final audits, each independently
finding the implementation complete before any push).

**Milestone 2.5: PASS — CLOSED.** All three sub-phases (2.5A structured
error envelope, 2.5B atomic compliance idempotency, 2.5C malformed path-
UUID hardening) shipped, each following the same audit → implement → final
acceptance audit → commit → push discipline as every prior milestone in
this repository, each closing a gap `docs/04-API-Architecture.md` had
already disclosed rather than introducing new undocumented behavior. Two
real architectural findings were surfaced and resolved before
implementation rather than worked around silently: 2.5B's non-atomic
compliance-transaction blocker (resolved via the `runInClientOrTransaction`
generalization) and 2.5C's arithmetic scope-count correction (18 handlers,
not 19, confirmed not to have caused any omission). `docs/04-API-
Architecture.md` was re-verified, across two independent final audits, to
contain zero remaining stale or contradictory statements about the error
envelope, idempotency, or UUID-hardening conventions as of the end of
2.5C. Every deliberate exclusion (organizations POST, DSR preview,
query/body/filter UUID fields) is disclosed in `docs/04` as a named,
reasoned gap, never a silent omission. Phase 2 — CRM is now fully
delivered; Phase 3 (Website Intelligence, starting with 3.1 Tracking
Script + Ingestion Endpoint) is next — see
`docs/12-Implementation-Milestones.md`.

## Milestone 3.1 — Website Intelligence: Tracking Script + Ingestion Endpoint

**Status: COMPLETE — CLOSED.** All six sub-phases shipped: 3.1A (schema +
tenant-resolution mechanism), 3.1B (database prerequisites + domain
layer, `packages/intelligence`), 3.1C-A (rate-limit/consent-write
database prerequisites), 3.1C-B (domain/context wrappers), 3.1C-C
(public `/track/collect`/`/track/consent` HTTP routes), and 3.1D (the
`GET /track/script` browser tracking script). See "Milestone 3.1 —
Overall Closeout" below for final validation, and the 3.1C-A/3.1C-B/
3.1C-C/3.1D sections for what each sub-phase shipped. Visitor
identification (Milestone 3.2, not yet started) and n8n integration
(Milestone 3.3, the first n8n workflow, per `docs/12-Implementation-
Milestones.md`'s Phase 3 map) remain deliberately out of this milestone's
scope. No browser/staging verification is claimed for this milestone —
see the Overall Closeout section for exactly what verification method
was used instead for the sub-phases with a real HTTP/browser-facing
surface.

### Milestone 3.1 — Approved Architecture

Two architecture decisions were made before any implementation, following
this repository's established audit → propose → approve → implement
discipline:

**Decision A — public tracking tenant resolution.** A dedicated,
single-purpose `tracking_sites` credential (never `api_keys`) resolves an
anonymous ingestion request to `organization_id`. The browser never
supplies `organization_id` as tenant authority — only the opaque
tracking-site identifier, which the backend resolves server-side via a
narrow `SECURITY DEFINER` function before establishing tenant context.
The credential is intentionally public/non-secret (unlike `api_keys`),
unguessable (`gen_random_uuid()`), and structurally incapable of granting
anything beyond tracking ingestion. All subsequent visitor/session/event
writes execute through the existing, unmodified `withTenantContext`
mechanism — no parallel tenant-isolation mechanism was introduced.

**Decision B — 3.1 uses direct synchronous domain-layer ingestion, not
n8n.** `docs/06-n8n-Workflow-Architecture.md` §3 ("Workflow: Website
Visitor Intelligence") describes the *Phase-3-complete* end state, where
ingestion is eventually queued into n8n — that description does not
apply to 3.1/3.2, which precede Milestone 3.3 (the first n8n workflow).
`docs/06` §3 should be corrected/annotated to make this explicit once
3.1C's ingestion endpoint actually ships and the discrepancy becomes
user-facing; not corrected in 3.1A itself, since nothing in 3.1A
contradicts it yet (no ingestion behavior exists at all). **Done at
Milestone 3.1's overall closeout** — `docs/06` §3 now carries an explicit
current-state note.

**Consent policy — universal strict default.** `cookie_tracking` consent
must be `granted` before any `website_visitors`/`visitor_sessions`/
`visitor_events` row is ever persisted, for every organization, with no
tenant-configurable bypass in 3.1. `docs/06` §3's phrase about an
organization's "configured consent requirement" describes a mechanism
that does not exist anywhere in this repository's schema or code and is
not a 3.1 feature — flagged for eventual correction, not implemented.
Consent recording is architecturally a separate call from event
ingestion (never a field inside the ingestion payload the server reads
for authorization), keyed directly by the tracking script's client-
generated `anonymous_id` — verified directly against `consent_records`'
own migration DDL that `subject_id` carries no foreign key, so a consent
grant can exist before any `website_visitors` row does. Enforcement
itself (the actual consent check gating a write) arrives with the
ingestion endpoint in 3.1C — 3.1A only lays the schema groundwork this
policy depends on. Pre-consent anonymous identifiers are a memory-only
product/architecture default for the future tracking script (3.1D), not
a claimed universal legal requirement.

### Milestone 3.1A — Tracking Sites + Website Visitor Intelligence Schema

Schema-only sub-phase: three migrations
(`20260820090000_create_tracking_visitor_intelligence_schema.sql`,
`20260820090100_enable_tracking_visitor_intelligence_rls.sql`,
`20260820090200_create_resolve_tracking_site_function.sql`), zero
application code, zero routes, zero domain package. `packages/intelligence`
was deliberately not created in 3.1A, per the approved scope — reserved
for 3.1B.

**`tracking_sites`** — `id` (the public tracking-site identifier itself,
`gen_random_uuid()`), `organization_id`, `label`, `created_by`,
`created_at`, `revoked_at`. Deliberately not hashed at rest: analyzed
explicitly against `api_keys.key_hash`'s own precedent and rejected as
the wrong model — a value published in every installing customer's page
source by design has no confidentiality to protect, so hashing it would
defend against a threat (database-read exposure) that provides no actual
protection, since the same value is already readable from the public
page. Its real security properties are unguessability (`gen_random_uuid()`'s
~122 bits) and narrow scope, not secrecy. `allowed_origins` and
`last_seen_at` were deliberately excluded from this initial shape — the
former is unenforced/undesigned in 3.1 (see below), the latter would
introduce a write-on-every-beacon hot-row pattern with no current writer
to justify it. Multiple rows per organization are supported (one per
tenant property); rotation is a new row plus revoking the old one, `id`
itself is never mutated or reused.

**`resolve_tracking_site(p_site_key uuid) returns table(organization_id
uuid)`** (`SECURITY DEFINER`, `set search_path = public`) — resolves the
identifier to its owning organization, or zero rows for a nonexistent or
revoked identifier, deliberately indistinguishable (mirrors this
platform's established cross-org/nonexistent-indistinguishable doctrine,
`docs/04-API-Architecture.md` §2.6, applied here to credential
resolution). The only function in this schema's history with no
`auth.uid()` caller-identity guard — every other `SECURITY DEFINER`
function here (`create_organization_with_owner`,
`preview_user_erasure`, etc.) begins with `if auth.uid() is null then
raise exception`, and this one deliberately must not, since a public
tracking beacon has no authenticated identity to check; its
authorization primitive is possession of the identifier itself. Returns
`organization_id` only — no label, no timestamps, no distinguishable
"revoked" vs. "never existed" signal. `EXECUTE` granted to `authenticated`
only (verified directly against `packages/database/src/tenant-
context.ts`: the application backend always executes Postgres queries as
`authenticated`, for every caller type, including the future anonymous
ingestion path — there is no direct `anon`-to-Postgres connection
anywhere in this architecture); `PUBLIC`/`anon` have zero `EXECUTE`,
inherited automatically from the M1.7-era default-privilege hardening
(`20260812140000`), no explicit revoke needed. Malformed (non-UUID-
shaped) input is rejected by Postgres itself at the parameter type-cast
boundary with a raw error — confirmed empirically, not assumed — and is
explicitly documented as the future ingestion endpoint's own
responsibility to validate before calling this function (3.1C,
mirroring Milestone 2.3D/2.5C's `isValidUuid` precedent), not something
invented or duplicated at the database layer.

**`website_visitors`/`visitor_sessions`/`visitor_events`** — implemented
per `docs/03-Database-Architecture.md` §2.3 as corrected in this same
sub-phase (see `docs/03`'s own Milestone 3.1A implementation note):
`website_visitors` gained `UNIQUE (organization_id, anonymous_id)` for
race-safe resolve-or-create; `visitor_sessions`/`visitor_events` each
gained an `organization_id` column beyond docs/03's original one-line
spec, which never listed one for either table. This is a genuine,
reported schema discrepancy, not a silent deviation: every other
high-volume child table in this repository needing a tenant-safety
composite FK to its parent (`activities`, `notes`, `taggings`,
`pipeline_stages`, `deals` — `20260812120000` through `20260817090000`)
denormalizes `organization_id` onto the child row specifically to make
that composite FK possible; a plain `session_id`/`tracking_site_id`/
`visitor_id` FK alone provides zero structural tenant-safety guarantee
independent of RLS. The full cross-tenant FK chain: `tracking_sites`
(`unique(organization_id, id)`) ← `visitor_sessions`
(`visitor_sessions_tracking_site_org_fk`) and `website_visitors`
(`unique(organization_id, id)`) ← `visitor_sessions`
(`visitor_sessions_visitor_org_fk`) ← `visitor_sessions`
(`unique(organization_id, id)`) ← `visitor_events`
(`visitor_events_session_org_fk`) — mirroring the `pipelines` →
`pipeline_stages` → `deals` two/three-level composite-FK precedent
(`20260814100000`) exactly, adversarially tested (a session/event cannot
reference a parent row belonging to a different organization, even via
direct SQL bypassing the application layer). `website_visitors.
identified_contact_id` also gained a composite FK to `contacts`
(`on delete set null`, mirroring `deals.primary_contact_id`) — schema-
ready, deliberately unpopulated by any 3.1A code path (Milestone 3.2's
responsibility). `visitor_sessions.tracking_site_id` is `NOT NULL` —
confirmed safe against the pre-implementation invariant audit (a
brand-new table with zero existing rows has no backfill incompatibility).

**RLS** — standard ADR-003 tenant-isolation policy shape on all four
tables (`organization_id = current_org()`), no broad cross-tenant
policy, no anonymous `INSERT` policy, no RLS bypass for ordinary
visitor/session/event writes. The only pre-tenant, cross-organization
read anywhere in this sub-phase is `resolve_tracking_site()` itself —
it does not touch these tables' own RLS policies. `anon` has zero grant
of any kind on any of the four tables, adversarially confirmed. No
`DELETE` grant/policy exists on any of the four (lifecycle is
`revoked_at` for `tracking_sites`, nonexistent for the other three in
3.1A — hard-delete is a structural safety net tested directly, never an
ordinary application path).

**Tests** — 53 new tests across three files: `tracking-visitor-
intelligence-schema.test.ts` (18, cross-tenant composite-FK rejection
for every parent/child pair, `UNIQUE(organization_id, anonymous_id)`
enforcement and its correct same-`anonymous_id`-different-org
permissiveness, `event_type` CHECK, hard-delete cascade/restrict/set-null
behavior for every relationship), `tracking-visitor-intelligence-
rls.test.ts` (24, cross-tenant SELECT/UPDATE/INSERT-spoofing isolation
for all four tables, `anon` zero-grant confirmation), `tracking-site-
resolver.test.ts` (11, correct resolution/revoked/nonexistent-
indistinguishable behavior, minimal-column-return verification,
malformed-UUID raw-Postgres-error confirmation, full privilege-boundary
matrix mirroring `function-execution-privilege-hardening.test.ts`'s own
style). Two test-authoring corrections found and fixed during
implementation (not schema defects): an `anon`-vs-RLS error-message
assertion initially expected a table-grant-denied message but the actual,
empirically-confirmed behavior — identical on the long-established
`companies` table, not new here — is `permission denied for function
current_org`, since every RLS policy in this schema evaluates that
function; and an unset-session-GUC assertion initially expected an empty
string but Postgres returns SQL `NULL` for a never-set custom GUC in a
fresh transaction.

### Milestone 3.1A — Validation

Full monorepo **2,092/2,092** tests passing across all 7 packages
(database 589, auth 381, ui 39, compliance 39, crm 310, tenancy 46, web
688) — a monotonic increase from the Milestone 2.5 baseline of 2,036
(+56: 53 new hand-written tests plus 3 auto-generated
`migration-safety.test.ts` cases, one per new migration file, all
correctly classified as non-destructive). `pnpm lint`/`typecheck`/`build`
clean across all 8 packages. Three new, purely additive migrations
(`CREATE TABLE`/`CREATE INDEX`/`CREATE POLICY`/`CREATE FUNCTION` only, no
`DROP`/`TRUNCATE`/destructive statement of any kind) applied cleanly to
the local Supabase instance. `git diff --check` clean; secret scan of the
full diff found no credential-shaped content beyond the well-known,
publicly-documented local Supabase default connection string already
used identically by every other test file in this repository. Zero
files under `apps/`, zero RLS/RBAC/auth/permission logic outside the one
new, narrowly-scoped resolver function, zero migrations touching any
pre-existing table.

**Milestone 3.1A: schema and tenant-resolution mechanism complete, not
a milestone close.** 3.1B (domain layer), 3.1C (ingestion + consent-
record endpoints, rate limiting), and 3.1D (tracking script, site-key
exposure) remain to be built before Milestone 3.1 itself can be
considered for an Overall Closeout section.

### Milestone 3.1B — Pre-Implementation Audit and Database Prerequisites

**Status: IN PROGRESS — `packages/intelligence` itself does not exist
yet.** This subsection covers only the read-only pre-implementation
audit and the two narrowly-scoped database prerequisites it surfaced —
not the domain-layer implementation, which remains a separate, later
step of its own.

**Pre-implementation audit** found two genuine, empirically-verified
blockers rather than assuming the schema was ready as-is:

1. **Consent access.** `consent_records`' own RLS (`org_admin`-only
   `SELECT`, `20260810100100_enable_compliance_rls.sql`) makes the table
   completely unreadable to the role-less ingestion pathway — proven,
   not reasoned about: a real, `granted` `consent_records` row was
   seeded, then read using exactly the session shape the ingestion
   pathway would use (`organization_id` set, no role at all), and the
   read returned zero rows despite the row genuinely existing. A domain
   layer built against this table directly would see "no consent" for
   every visitor, permanently.
2. **Session semantics.** No documentation anywhere in this repository
   specified visitor-session identity, timeout, or continuity rules.
   Proceeding without an explicit decision would have meant inventing a
   business rule silently.

**Approved resolutions, implemented in this same sub-phase:**

- **`check_visitor_cookie_tracking_consent(organization_id, anonymous_id)
  returns boolean`** (`20260820100100`, `SECURITY DEFINER`, `STABLE`,
  `search_path = public`) — answers exactly one question: is the latest
  `cookie_tracking` consent state for this organization/visitor
  `granted`. Filters `subject_type = 'visitor'`,
  `consent_type = 'cookie_tracking'`, orders
  `recorded_at desc, id desc limit 1` (a deterministic tie-break,
  approved as sufficient without an additional schema column — the
  residual same-instant-collision case is vanishingly rare and
  self-correcting, not a blocker). No matching row and a withdrawn
  latest row both resolve to `false`, deliberately indistinguishable,
  mirroring this platform's established cross-org/nonexistent-
  indistinguishable doctrine. The **same deliberate exception** as
  `resolve_tracking_site()` — no `auth.uid()` guard, since the ingestion
  pathway has no authenticated identity to check; its authorization
  primitive is an already-resolved `organization_id` plus the visitor's
  own opaque `anonymous_id`. `EXECUTE` to `authenticated` only;
  `PUBLIC`/`anon` have zero `EXECUTE` by construction. **Does not modify
  `consent_records`' existing RLS policies in any way** — confirmed by a
  regression test proving a role-less read still sees nothing directly,
  and an `org_admin`-scoped read still works exactly as before.
- **Session identity — a client-generated opaque UUID, not a
  server-side timeout heuristic.** `visitor_sessions` gained
  `anonymous_session_id uuid not null` plus
  `UNIQUE (organization_id, tracking_site_id, visitor_id,
  anonymous_session_id)` (constraint
  `visitor_sessions_org_site_visitor_session_key`, `20260820100000`) —
  an **additive follow-up migration**, not an edit to the original 3.1A
  schema migration (`visitor_sessions` had zero rows in every
  environment this milestone has touched, confirmed before writing the
  migration, so the `NOT NULL` column needed no default/backfill step).
  The four-column uniqueness scope is deliberate: the same client-
  generated UUID may legitimately, independently repeat across
  different organizations, different tracking sites, or different
  visitors within the same organization, without collision — only the
  exact 4-tuple must be unique, which is also the scope a future
  resolve-or-create upsert will target. The client session UUID is
  explicitly **not** an organization identifier, not an authorization
  credential, never trusted for tenant selection, and never a database
  primary key — `visitor_sessions.id` remains the real, server-generated
  PK. Browser storage lifetime, cookie/localStorage policy, and any
  timeout heuristic remain undecided and are not invented here — 3.1B
  accepts an already-supplied session UUID as a correlation identifier,
  nothing more. Session-start attribution fields (`referrer`,
  `utm_source/medium/campaign`, `landing_page`, `device_type`) are
  unchanged by this patch and are expected to describe session-start
  context only, never silently overwritten by later events in the same
  session — a domain-layer rule for the still-unbuilt 3.1B
  implementation to honor, not something this schema patch enforces
  itself.

**Validation.** Full monorepo **2,118/2,118** tests passing across all 7
packages (database 615, auth 381, ui 39, compliance 39, crm 310, tenancy
46, web 688) — a monotonic increase from the Milestone 3.1A baseline of
2,092 (+26: 24 new hand-written tests plus 2 auto-generated
`migration-safety.test.ts` cases). `pnpm lint`/`typecheck`/`build` clean
across all 8 packages. Both new migrations are purely additive (`ALTER
TABLE ADD COLUMN`/`ADD CONSTRAINT`/`CREATE FUNCTION` only, no
destructive statement) and applied cleanly across a fresh `supabase db
reset` replaying the full 50-migration chain in order. The original
3.1A migration files were not edited. Three pre-existing 3.1A test files
required a small, expected update (supplying the newly-required
`anonymous_session_id` in their own `visitor_sessions` fixture inserts)
— a consequence of the additive `NOT NULL` column, not a defect in
either the new migration or the original tests.

**Milestone 3.1B database prerequisites: complete** (this subsection's own
scope). The domain layer itself is covered in the next subsection.

### Milestone 3.1B — Domain Layer (`packages/intelligence`)

**Status at this sub-phase's own close (historical — see "Milestone 3.1 —
Overall Closeout" below for final status): IN PROGRESS overall (Milestone
3.1) — the domain layer is now built, but no HTTP route, public
endpoint, tracking script, rate limiting, or n8n integration exists
anywhere in this repository as of this point in the milestone.** 3.1C
(public ingestion + consent-record endpoints, rate limiting) and 3.1D
(tracking script) remain unbuilt. No browser/staging verification is
claimed — this sub-phase has no user-facing surface.

**Package created**: `packages/intelligence`, dependency set confirmed
`@ai-revenue-os/database` only — re-verified against `docs/02-Software-
Architecture.md` §4's own aspirational `intelligence: database, crm` row
before building, and against the strong, directly-applicable precedent
already established there and in `packages/tenancy/src/agency-
rollup.ts`'s own header comment ("does not take on a new dependency on
`@ai-revenue-os/crm` merely to reuse [something]... not guessed at now"
— cited, not re-derived). No identification logic exists anywhere in
this package — `identified_contact_id` is never referenced in any
`INSERT` statement it issues, structurally, not by convention.

**Public API**: `checkCookieTrackingConsent`, `resolveOrCreateVisitor`,
`resolveOrCreateVisitorSession`, `appendVisitorEvent`, and the one
atomic composition, `ingestTrackingEvent` — mirroring `packages/crm`'s
established `(ctx: RequestContext & { organizationId: string }, input,
existingClient?: PoolClient)` / `runInClientOrTransaction` convention
exactly, not a new shape invented for this package.

**Atomic ingestion**: `ingestTrackingEvent` runs entirely inside one
`withTenantContext` transaction. Order: (1) re-check `tracking_sites`
(`id` + `organization_id` match + `revoked_at is null`) — the TOCTOU
defense against revocation happening between 3.1C's future `resolve_
tracking_site()` call and this write; if invalid, `{ accepted: false,
reason: "tracking_site_revoked" }`, indistinguishable whether the site
is missing, belongs to a different organization, or is genuinely
revoked; (2) `checkCookieTrackingConsent` via the 3.1B-prerequisite
`check_visitor_cookie_tracking_consent()` function — never a direct
`consent_records` read; if not granted, `{ accepted: false, reason:
"consent_not_granted" }`, indistinguishable between absent and withdrawn;
(3)-(5) resolve/create visitor, resolve/create session, append event,
all on the same `PoolClient`. `packages/intelligence` deliberately does
**not** call `resolve_tracking_site()` itself — that pre-tenant
credential resolution remains 3.1C's own boundary responsibility;
`organizationId`/`trackingSiteId` arrive already trusted.

**Visitor semantics**: a single `INSERT ... ON CONFLICT (organization_id,
anonymous_id) DO UPDATE SET last_seen_at = now() RETURNING *` — race-safe
by Postgres's own guarantee (the same `ON CONFLICT` idiom already
precedented in `packages/database/src/events.ts`'s `event_deliveries`
upsert). `first_seen_at` is never referenced in the `DO UPDATE` clause.

**Session semantics**: `INSERT ... ON CONFLICT (organization_id,
tracking_site_id, visitor_id, anonymous_session_id) DO UPDATE SET id =
visitor_sessions.id RETURNING *` — the `DO UPDATE SET id = id` idiom
makes `RETURNING` fire on the conflict path too (unlike `DO NOTHING`,
which returns zero rows on conflict) while touching no actual data.
Verified empirically before writing this function, not assumed:
`visitor_sessions` has zero triggers, and a direct conflict-path round
trip confirmed every session-start attribution column (`referrer`,
`utm_*`, `landing_page`, `device_type`) survives byte-for-byte unchanged
across a repeat call. `ended_at` is never referenced anywhere in this
package — remains untouched/null, no timeout or expiration logic
invented.

**Event semantics**: `eventType` validated against `pageview`/
`form_submit`/`click` in application code before any query, mirroring
`packages/crm`'s own domain-level-rejection-ahead-of-the-DB-CHECK
convention. `occurredAt` has no input field at all — always
database-assigned. `metadata` defaults to `{}`; no payload-size
enforcement (an HTTP/3.1C-boundary concern).

**Error/result model**: `IntelligenceError` base class +
`InvalidEventTypeError`/`InvalidSessionRelationshipError`, mirroring
`packages/crm`'s `CrmError` family — no `ApiErrorCode`, no
`NextResponse`, no HTTP coupling anywhere in this package (structurally
tested, not just asserted). Consent-absent and tracking-site-revoked are
deliberately **not exceptions** — `IngestResult`'s discriminated union
represents them as data, mirroring `packages/compliance`'s own
`previewUserErasure`/`previewContactErasure` precedent for an expected
"cannot proceed" outcome (`{ canProceed, blockerReason }`), re-verified
against that file directly before choosing this shape, not assumed.

**A genuine finding, resolved during implementation, not hidden**: the
first version of the atomicity/failure-injection test used a DDL-based
chaos trigger on `visitor_events`, mirroring `packages/compliance`'s own
`contact-erasure.test.ts` convention. Under real `turbo run test`
concurrent load across all 8 packages, this reproducibly caused
`error: deadlock detected` — `DROP TRIGGER`/`DROP FUNCTION` require an
`ACCESS EXCLUSIVE` lock on `visitor_events`, which can genuinely
deadlock against an ordinary concurrent `INSERT` into that same table
from a sibling test file (this package's own `concurrency.test.ts`/
`ingest.test.ts` both insert into it, and vitest parallelizes test files
within one package by default). Resolved by redesigning the test to use
a real, already-existing constraint violation (a session belonging to a
different organization, rejected by `visitor_events_session_org_fk`)
instead of any DDL at all — no table-level lock, no deadlock surface,
and arguably a more representative failure mode than a synthetic one.
Verified clean across two consecutive full, fresh, 8-package concurrent
`turbo run test` executions after the fix.

**Validation**: full monorepo **2,163/2,163** tests passing across all 8
packages (database 615, auth 381, ui 39, compliance 39, crm 310, tenancy
46, web 688, **intelligence 45** — new) — a monotonic increase from the
Milestone 3.1B database-prerequisite baseline of 2,118. `pnpm lint`/
`typecheck`/`build` clean across all 8 packages. No migration created,
no RLS/grant modified, no `auth`/`crm`/`compliance`/`web` dependency
added, no HTTP route, no n8n code, anywhere in this sub-phase.

**Milestone 3.1B: database prerequisites and domain layer both
complete.** `packages/intelligence` exists and is fully tested. As of
this section, 3.1C (public ingestion + consent-record endpoints, rate
limiting) and 3.1D (tracking script) remained unbuilt, and Milestone 3.1
overall remained IN PROGRESS. **Superseded below** — 3.1C-A through 3.1D
subsequently shipped; see the sections immediately following and the
"Milestone 3.1 — Overall Closeout" section for the final, current status.

### Milestone 3.1C-A — Tracking Security Prerequisites

Two new `SECURITY DEFINER` database objects, closing the two remaining
gaps 3.1C's own pre-implementation audit identified before any HTTP route
could be built: `rate_limit_counters` (RLS enabled, zero policies, zero
grants — access exists solely through the function below) plus
`check_tracking_rate_limit(p_bucket_hash, p_window_seconds, p_limit)
returns boolean` (atomic fixed-window check-and-increment, one function
serving every rate-limit dimension via an opaque, application-computed
bucket hash — never a raw identifier), and `record_visitor_cookie_
tracking_consent(p_site_key, p_anonymous_id, p_status) returns boolean`
(resolves `organization_id` internally from `tracking_sites`, mirroring
`resolve_tracking_site()`'s own precedent, making cross-tenant forgery
structurally impossible rather than merely checked; append-only). Both
`EXECUTE`-granted to `authenticated` only, matching every prior tracking
function's privilege model. **A genuine security defect was found and
fixed before commit**: the rate-limit function's opportunistic cleanup
initially had no upper bound on `p_window_seconds`, which could delete
the currently-active window's own row mid-window for a sufficiently long
window; fixed by bounding it to the same 86400-second horizon as the
cleanup's own retention threshold. Committed `7047911`.

### Milestone 3.1C-B — Domain/Context Wrappers

Thin wrappers connecting the 3.1C-A database prerequisites to
application code, each following an already-established package
convention rather than inventing a new one: `packages/auth`'s
`resolveOrganizationContextForTrackingSite(siteKey)` (mirrors
`resolveOrganizationContextForUser`), `packages/compliance`'s
`recordVisitorCookieTrackingConsent(siteKey, anonymousId, status,
existingClient?)`, and `apps/web/app/track/_shared/rate-limit.ts`'s
`checkTrackingRateLimit`/`hashTrackingRateLimitBucket` (SHA-256 bucket
hashing, fixed 60-second window, a small hardcoded per-surface/dimension
limit table). Committed `2df8028`.

### Milestone 3.1C-C — Public Tracking HTTP Routes

`POST /track/collect` and `POST /track/consent` — same-origin `apps/web`
Route Handlers, not a separate `track.<platform-domain>` subdomain (a
deliberate divergence from `04-API-Architecture.md`'s original design,
corrected there at this milestone's closeout). Orchestration: bounded
body read → validate/canonicalize → derive trusted source IP → IP limit
→ anon limit → resolve tracking site → site limit (using the *resolved*
`trackingSiteId`, never the raw `siteKey`) → the one domain call → a
uniform `204` (persisted, no-consent, revoked, and nonexistent-site
outcomes are all identical — no tenant-state oracle). Closed 4-code error
vocabulary (`400`/`413`/`429`/`500`), CORS-open with no credentials.
**A genuine security defect was found and fixed before commit**: the
initial source-IP resolver accepted any non-empty header value as a
rate-limit bucket identifier with no actual IP-shape check, letting
arbitrary strings each become their own persisted bucket; fixed using
Node's built-in `node:net isIP()` (zero new dependency) — a malformed or
missing value now collapses to the fixed `"unknown"` bucket, never its
own distinct identifier. Committed `ab5aaf6`.

### Milestone 3.1D — Browser Tracking Script

`GET /track/script` serves a fixed, tenant-independent, hand-authored
standalone-JavaScript tracker (no bundler, zero new dependency) as a
plain string constant — no DB access, no auth, no secret. Installation:
`<script src="https://<platform-domain>/track/script"
data-site-key="<tracking_sites.id>" async>`; the global
`window.aiRevenueOsTracker` exposes exactly `consent(status)` and
`track(eventType, fields?)`. Key design resolutions, each previously
flagged as unresolved by the 3.1D pre-implementation audit and settled
before implementation began: `anonymousId`/`anonymousSessionId` are
memory-only before consent, persisted to `localStorage`/`sessionStorage`
respectively (namespaced keys, never generic names) only after an
explicit grant, cleared on withdrawal, and never reused on a later
re-grant; automatic event capture is `pageview` only — `click`/
`form_submit` are reachable exclusively through the explicit `track()`
call, with no DOM/form scraping of any kind anywhere in the script;
`url`/`referrer`/`landingPage` are reduced to `origin + pathname` before
transmission (query strings and fragments are never read into any
variable, let alone transmitted); only `utm_source`/`utm_medium`/
`utm_campaign` are ever captured from a query string; every request uses
`credentials: "omit"` (no cookies, ever); no consent-banner/CMP UI is
part of 3.1D's scope (the installing customer's own site/CMP calls the
script's `consent()` API); platform origin for every network call is
derived exclusively from the executing `<script>` element's own `src`,
never the host page's origin, so an embed on an arbitrary third-party
site cannot be tricked into calling that site's own origin instead.
Tested via `node:vm` sandbox execution of the exact served script
(byte-identical proof against the live `GET /track/script` response, not
only the source constant) with hand-written browser-API stubs — no
jsdom/happy-dom, no new dependency. Committed and pushed `a023cd9`.

### Milestone 3.1 — Overall Closeout

**Automated verification (this repository's own test suite, re-run at
closeout, working tree clean, HEAD `a023cd9`).** `pnpm lint`/`typecheck`/
`build` clean across all 8 packages; `pnpm test` **2,517/2,517 passing**
across all 8 packages (ui 39, database 674, intelligence 45, auth 390,
compliance 51, tenancy 46, crm 310, web 962) — a monotonic increase
across every sub-phase from the Milestone 3.1B baseline of 2,163, never a
decrease; zero database schema regression, migration-safety gate clean.

**No browser/staging verification was performed for this milestone, and
none is claimed** — consistent with this repository's standing
discipline of never fabricating staging/browser verification. 3.1C-C/
3.1D's real HTTP/browser-shaped behavior was instead verified via real
Postgres-backed route tests and Node `vm`-sandboxed execution of the
exact served script bytes, not a live browser session.

**Milestone 3.1: PASS — CLOSED.** All six sub-phases (3.1A schema,
3.1B domain layer + database prerequisites for consent/session identity,
3.1C-A rate-limit/consent-write database prerequisites, 3.1C-B domain/
context wrappers, 3.1C-C public HTTP routes, 3.1D browser script) shipped,
each following the same audit → implement → final acceptance audit →
commit → push discipline as every prior milestone in this repository. Two
genuine security defects were found and fixed *before* commit rather than
shipped and patched later: 3.1C-A's unbounded rate-limit cleanup window,
and 3.1C-C's unvalidated source-IP bucket identifier — both disclosed
above, not silently corrected. One disclosed, deliberate architectural
divergence from the original design intent: tracking endpoints ship
same-origin on `apps/web` rather than on a separate `track.<platform-
domain>` subdomain, and consent recording is a structurally separate call
from event ingestion rather than an inline field — both corrected in
`docs/04-API-Architecture.md` at this closeout. Visitor identification
(Milestone 3.2), n8n-mediated processing (Milestone 3.3), and any
`identify()`/visitor-profile API remain explicitly unbuilt and out of
scope — 3.1D's own public API deliberately exposes nothing beyond
`consent()`/`track()`. Phase 2 — CRM and Milestone 3.1 — Website
Intelligence: Tracking Script + Ingestion Endpoint are now both fully
delivered; Milestone 3.2 — Visitor Identification has not started.

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
