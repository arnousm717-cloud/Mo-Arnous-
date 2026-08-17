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
by the project owner. Milestone 2.3 has not started.

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
