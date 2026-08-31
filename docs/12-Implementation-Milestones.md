# 12 — Implementation Milestones

Breaks `09-Development-Roadmap.md`'s phases into small, independently-deployable milestones. **Phase 1 is fully detailed below** since it's what starts next. Phases 2-8 are given as a milestone *map* (names + one-line goals) so the shape of the full plan is visible without fabricating detailed API/DB/UI specs for work that's many months out and will be refined once we actually reach it — each phase gets the same full treatment as Phase 1 at the start of that phase.

**Workflow**: milestones are built and approved one at a time, in order. No milestone begins until you've explicitly approved it. A milestone is "done" when its own Tests pass and its Documentation is updated — not before.

---

## Phase 1 — Foundation (9 milestones)

### M1.1 — Repo & Environment Bootstrap

- **Goal**: Every later milestone has a real, deployable target from day one — nothing but a health check, but it's live in three environments.
- **Deliverables**: Turborepo monorepo scaffold (`apps/web`, `apps/marketing` stub, `packages/config`, `packages/database` skeleton); Vercel projects for staging + prod linked to git branches; Supabase projects provisioned for dev/staging/prod (EU region); GitHub Actions CI (lint, typecheck, build) on every PR.
- **Database migrations**: None — migration tooling (Supabase CLI) wired up, no tables yet.
- **API changes**: `GET /api/v1/health` (new) → `200 OK`.
- **UI changes**: Blank Next.js app shell; themeable root layout scaffold with the CSS variable structure from `07-UI-UX-System.md` §2, populated with placeholder values only.
- **AI changes**: None.
- **Tests**: CI green (lint/typecheck/build) on every PR; smoke test hitting `/api/v1/health` in each environment post-deploy.
- **Documentation**: `apps/web/README.md`, `packages/database/README.md` (how to run locally); ADR-001 (modular monolith) logged in `docs/adr/`.

### M1.2 — Core Tenancy Schema + RLS + Tenant-Context Mechanism

- **Goal**: Land the multi-tenant data model and the RLS mechanism everything else depends on, proven by isolation tests before any product feature touches it.
- **Deliverables**: `agencies`, `organizations`, `users`, `memberships`, `roles` tables (`03-Database-Architecture.md` §2.1); `current_org()`/`current_agency()`/`current_role()` reading from request-scoped `set_config` (§5); Supavisor connection pooling enabled.
- **Database migrations**: Create the five tables above; seed `roles` with the six defined roles; enable RLS with baseline `tenant_isolation_select`/`tenant_isolation_write` policies on all tenant-scoped tables.
- **API changes**: None yet — verified directly against the database, not through route handlers.
- **UI changes**: None.
- **AI changes**: None.
- **Tests**: RLS isolation suite (org A genuinely cannot read/write org B's rows), run against a real test Postgres instance — the single most important test category per `10-CLAUDE.md` §5.
- **Documentation**: ADR-003 (shared-schema RLS) logged in `docs/adr/`.

### M1.3 — Auth & Signup Flow

- **Goal**: A real person can sign up, get an organization, and log back in — the first end-to-end slice a human can actually use.
- **Deliverables**: Supabase Auth wired into `packages/auth`; signup creates `users` + `organizations` + `memberships` (as `org_admin`) in one transaction; login; the API middleware resolving `organization_id` per request for JWT-session callers specifically (other caller types land in later milestones once they exist).
- **Database migrations**: A `SECURITY DEFINER` function performing the atomic signup transaction (not a plain client-issued `INSERT ... RETURNING`) — M1.2 found that Postgres requires the `SELECT` policy to also pass for `RETURNING`, which a brand-new organization row can never satisfy under `id = current_org()` (ADR-003). Otherwise none beyond M1.2.
- **API changes**: Supabase Auth-backed signup/login endpoints wired through the app; session middleware.
- **UI changes**: Signup page, login page, a bare authenticated shell ("Welcome, {org name}").
- **AI changes**: None.
- **Tests**: Signup → org creation → login round-trip integration test; a test confirming a logged-in user's requests resolve to their own `organization_id` and never another's.
- **Documentation**: None expected — confirmed at PR review, not assumed.

### M1.4 — Agency Hierarchy + Basic White-Label Theming

- **Goal**: An agency can create and manage client organizations under its own brand — the capability the entire GTM strategy depends on.
- **Deliverables**: Agency-created client `organizations` (`agency_id` set); `brand_themes` table with server-side theme resolution (`07-UI-UX-System.md` §2 — no client-side flash); Agency Console shell (client org list/grid, `07` §6).
- **Database migrations**: `brand_themes`, `custom_domains` (schema only — verification flow is a Phase 7 feature).
- **API changes**: `POST /api/v1/organizations` (agency-scoped create), `GET /api/v1/organizations` (agency-scoped list, `04-API-Architecture.md` §2).
- **UI changes**: Agency Console (client org list); theme applied on every page render from `brand_themes`.
- **AI changes**: None.
- **Tests**: Theme resolution test, including the contrast auto-adjust fallback (`07` §2); RLS test that an agency lists only its own orgs.
- **Documentation**: None beyond confirming implementation matches `07-UI-UX-System.md` §2 as written.

### M1.5 — RBAC Enforcement

- **Goal**: The six roles actually restrict behavior, not just exist as a schema enum.
- **Deliverables**: `can(actor, action, resource)` facade in `packages/auth`; real permission matrix (resource+action pairs, `08-Security.md` §3) wired to every route handler/Server Action; UI conditionally hides/disables actions by role.
- **Database migrations**: Populate `roles.permission_set` with the real matrix (schema already existed since M1.2).
- **API changes**: Every existing route handler now passes through `can()`.
- **UI changes**: Role-appropriate hiding of write actions (e.g., `org_viewer` sees no write buttons).
- **AI changes**: None.
- **Tests**: Permission-matrix unit tests (every role × every defined action); integration test that a write attempt from `org_viewer` is rejected server-side, not just hidden client-side.
- **Documentation**: None — confirm implementation matches `08-Security.md` §3.

### M1.6 — GDPR Primitives

- **Goal**: Consent, deletion requests, audit logging, and retention exist and are exercised end-to-end before any real personal data accumulates.
- **Deliverables**: `consent_records`, `data_subject_requests`, `audit_logs`, `data_retention_policies` tables; the deletion-cascade orchestration job, built extensibly from day one (covers `users`/`memberships` now, designed to gain more tables in later milestones, not rewritten each time); audit logging wired to auth events and DSR lifecycle transitions (`08-Security.md` §6).
- **Database migrations**: The four tables above; the two-tier deletion model implemented as a real hard-delete/anonymize function, not just documented.
- **API changes**: `POST /api/v1/consent`, `POST /api/v1/data-subject-requests`, `GET /api/v1/data-subject-requests/{id}`.
- **UI changes**: Minimal internal/admin view to file and track a DSR — not the full self-service experience (that's Phase 6).
- **AI changes**: None.
- **Tests**: **The single most important test in this milestone**: a DSR filed against a test user actually hard-deletes/anonymizes per `03`'s deletion model — not a `deleted_at` no-op. Audit log immutability test (attempt to mutate an entry, confirm rejection).
- **Documentation**: None — this is the milestone where `08-Security.md` §5 stops being aspirational and starts being true.

### M1.7 — Platform Infrastructure (api_keys, events outbox)

- **Goal**: Lay down the two tables every later phase's automation depends on, with minimal internal-only issuance — not the tenant-facing self-service experience (that's Phase 7).
- **Deliverables**: `api_keys` table + an internal (non-self-service) issuance path for a `service`-role key; `events` outbox table with Unit-of-Work-committed writes from at least one real domain event already emitted by earlier milestones (e.g., `membership.created`); outbox dispatcher skeleton (in-process subscribers only — n8n fan-out starts in Phase 3).
- **Database migrations**: `api_keys`, `events`, `webhook_events_seen` (cheap to land now alongside the rest of platform infrastructure, even though no inbound webhooks exist yet).
- **API changes**: None tenant-facing (internal-only key issuance via an admin script/route).
- **UI changes**: None.
- **AI changes**: None.
- **Tests**: Outbox atomicity test (domain write + outbox write commit together or not at all — kill the transaction mid-way, confirm no partial state); dispatcher idempotency test (redelivery doesn't double-process).
- **Documentation**: None — confirm implementation matches `02-Software-Architecture.md` §5/§7 (Unit-of-Work).

### M1.8 — Observability & Dependency Hygiene

- **Goal**: The app is observable and scanned before it has any real users, not after the first incident.
- **Deliverables**: Sentry (or equivalent) wired into `apps/web` and Edge Functions; structured logging with secret/PII redaction; dependency vulnerability scanning enabled in CI; a published, one-page vulnerability disclosure policy.
- **Database migrations**: None.
- **API changes**: None functionally — every route now logs structured request/response metadata.
- **UI changes**: None.
- **AI changes**: None.
- **Tests**: Redaction test — a log line containing a fake API key or email address is confirmed scrubbed before it reaches the log sink.
- **Documentation**: The disclosure policy itself (published); confirm implementation matches `08-Security.md` §10.

### M1.9 — CI/CD Hardening & Environment Separation

- **Goal**: Close Phase 1 by making the deploy pipeline itself trustworthy.
- **Deliverables**: Confirmed (not assumed) that Vercel preview deployments point at the dedicated staging Supabase project, never prod; a migration-safety check in CI (no destructive migration without an explicit flag); `docs/adr/` created with the Phase 1 ADRs actually written as files.
- **Database migrations**: None new.
- **API changes**: None.
- **UI changes**: None.
- **AI changes**: None.
- **Tests**: A CI check that a preview deployment's environment variables genuinely point at staging, not production — a config-correctness test, not a manual habit.
- **Documentation**: ADR-001, ADR-002 (n8n boundary — logged now even though n8n isn't built until Phase 3, since the decision is already made), ADR-003, ADR-004 written as real files, not "to be logged."

---

## Phase 2 — CRM (2.1 detailed; 2.2 onward remain a map, per §"Phases 2-8" below)

### 2.1 — Companies & Contacts

- **Goal**: Ship the first real CRM entities — Companies and Contacts — with full tenant-isolated CRUD, proving the RLS/RBAC/API pattern every later CRM resource repeats. This is deliberately the smallest possible CRM slice: no Deals, Pipelines, Activities, Notes, Tags, kanban, enrichment, n8n, or AI in this milestone.
- **Deliverables**: `companies`/`contacts` tables (schema, RLS, grants); `packages/crm` (new package — creation/validation logic only); 8 new RBAC permission keys (`companies:read/create/update/delete`, `contacts:read/create/update/delete`); `/api/v1/companies`, `/api/v1/contacts` route handlers (full CRUD, cursor pagination, `Idempotency-Key`, the standard error envelope); `contacts` wired into the GDPR retention/DSR architecture in this same milestone (`preview_contact_erasure`/`execute_contact_erasure`, mirroring M1.6's `user` pair) — not deferred, per `docs/10-CLAUDE.md` §8's standing rule that a new personal-data table's retention/erasure wiring lands in the same PR that introduces the table.
- **Database migrations**: Two new tables (`companies`, `contacts`) with `organization_id`-scoped RLS + base grants (ADR-003 pattern — no `DELETE` grant/policy on either, since ordinary "delete" is an `UPDATE` setting `deleted_at`, matching the existing `public.users` precedent); a `data_retention_policies` row for `contacts`; the `preview_contact_erasure`/`execute_contact_erasure` `SECURITY DEFINER` functions. `contacts.lifecycle_stage` uses a minimal, intentionally narrow initial set — `lead`/`prospect`/`customer`/`inactive` — no deal/pipeline-stage semantics; extendable later via a reviewed migration if real product need justifies it, not expanded speculatively now.
- **API changes**: `GET/POST /api/v1/companies`, `GET/PATCH/DELETE /api/v1/companies/:id`, and the same four for `/api/v1/contacts` — first real use of `docs/04-API-Architecture.md` §1's general conventions (cursor pagination, `Idempotency-Key`, error envelope) by a resource other than the three already-implemented ones. Cross-org `:id` access returns `404`, matching the DSR-route precedent. A duplicate `contacts.email` within one organization on `POST` returns `409 Conflict` — never an implicit upsert; `PATCH` is the only path that updates an existing contact.
- **UI changes**: None in this milestone's minimal core — `EntityTable` (`docs/07-UI-UX-System.md`) is real, separate work with no `packages/ui` yet to build it in, sequenced as its own step once schema/API/RBAC exist. **Since delivered**: Milestone 2.1G (`docs/13-Technical-Design-Review.md`) shipped `packages/ui`'s initial `EntityTable` plus the full Companies/Contacts list/create/detail/edit/soft-delete UI, once schema/API/RBAC were in place.
- **AI changes**: None.
- **Tests**: Database/constraint tests; RLS adversarial tests (org A cannot read/update/soft-delete org B's company or contact, a cross-org `company_id` cannot be assigned to a contact, direct SQL as `authenticated` cannot bypass RLS, a soft-deleted record is excluded from default reads); domain/validation tests (`packages/crm`); API route tests (auth/authz boundary, 404-vs-403, `Idempotency-Key` replay, 409 on duplicate email); RBAC permission-matrix coverage for the 8 new keys; **GDPR erasure tests** proving `execute_contact_erasure()` cannot affect another organization's contact data, independently re-validates rather than trusting a prior preview (mirroring `execute_user_erasure()`'s own re-validation discipline), and is structurally distinct from the ordinary `deleted_at` soft-delete path.
- **Documentation**: This entry; the corresponding `docs/13` TDR entry and detailed design section.

---

## Phases 2-8 — Milestone Map (names + one-line goals only)

Full 8-part detail for each of these is written at the start of its phase, once Phase 1 is done and real implementation experience can sharpen the plan rather than guessing at it now.

**Phase 2 — CRM**: 2.1 Companies & Contacts (delivered — `docs/13-Technical-Design-Review.md` "Milestone 2.1") · 2.2 Deals & Pipelines (kanban) (delivered — `docs/13-Technical-Design-Review.md` "Milestone 2.2", closed) · 2.3 Activities/Notes/Tags (delivered — `docs/13-Technical-Design-Review.md` "Milestone 2.3 — Overall Closeout", closed) · 2.4 Agency Roll-Up Views (delivered — `docs/13-Technical-Design-Review.md` "Milestone 2.4 — Overall Closeout", closed) · 2.5 Core API Conventions Applied Platform-Wide (pagination, idempotency, error envelope) (delivered — `docs/13-Technical-Design-Review.md` "Milestone 2.5 — Overall Closeout", closed)

**Phase 3 — Website Intelligence**: 3.1 Tracking Script + Ingestion Endpoint (delivered — `docs/13-Technical-Design-Review.md` "Milestone 3.1 — Overall Closeout", closed) · 3.2 Visitor Identification · 3.3 Lead Enrichment (first n8n workflow) · 3.4 Rules-Based Lead Scoring · 3.5 Revenue Dashboard v1

**Phase 4 — AI Agents**: 4.1 Brain Foundation (schema, pgvector, existing-source ingestion) · 4.2 Queued Agent-Execution Worker · 4.3 Orchestrator + Model Router + Tool Layer + Approval Gate · 4.4 Research Agent · 4.5 Sales Agent · 4.6 Scoring Agent · 4.7 Marketing Agent · 4.8 Support/Chat Agent · 4.9 AISurfaceCard (3 variants) + Agent Monitoring

**Phase 5 — Automations**: 5.1 CRM Automation Builder · 5.2 Email Automation · 5.3 Proposal Generator · 5.4 Customer Onboarding Workflow · 5.5 Reporting Workflow · 5.6 Brain Source: Email Sync · 5.7 Brain Source: Meeting Ingestion · 5.8 LinkedIn Automation (isolated, last)

**Phase 6 — Customer Portal**: 6.1 Portal Auth + Route Tree · 6.2 Portal Proposal/Document Views · 6.3 Portal Support/Chat Agent · 6.4 Self-Service Profile Edit

**Phase 7 — Enterprise**: 7.1 Public API GA + Self-Service API Keys · 7.2 Outbound Webhook Self-Service · 7.3 Custom Domains + Fuller Theme Editor · 7.4 SSO/MFA · 7.5 SOC2 Readiness Program · 7.6 Formal Pentest · 7.7 Custom Roles/Permissions

**Phase 8 — Scale**: 8.1 DB Scaling (pooling, replicas, partitioning) · 8.2 Dedicated-DB Escape Hatch · 8.3 Workflow/Integration Marketplace · 8.4 Advanced Analytics/BI Export · 8.5 Cost Optimization Pass · 8.6 Brain Fine-Tuning Evaluation · 8.7 SLA Tiers + Status Page
