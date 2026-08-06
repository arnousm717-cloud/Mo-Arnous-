# 10 — CLAUDE.md (Development Guide for AI-Assisted Engineering)

This document governs how code is written on AI Revenue OS, by Claude or any other contributor. It assumes the architecture defined in `02` through `08` as settled fact — this file is about *how* we build, not *what* we're building.

> **Note on placement**: this file lives at `docs/10-CLAUDE.md` per the documentation numbering. Claude Code auto-loads a `CLAUDE.md` at the repository root at session start — once implementation begins, create a root `/CLAUDE.md` that points here (or mirrors this content) so it's picked up automatically.

## 1. Coding Standards

- **TypeScript strict mode everywhere** — no `any` without an explicit inline comment justifying why (e.g., an untyped third-party payload boundary). Prefer `unknown` + narrowing over `any`.
- **No implicit tenant context.** Any function touching tenant-scoped data takes `organization_id` as an explicit, typed parameter — never inferred from a global/ambient context that could leak across requests.
- **Functions over classes** for domain logic in `packages/*`; classes are acceptable for stateful integrations (e.g., a provider adapter implementing a shared interface) but not used for plain data transformation.
- **No default exports** — named exports only, for consistent refactor-friendly imports and clearer barrel files.
- **Errors are typed, not stringly-typed.** Domain errors extend a base `DomainError` with a `code`, not a raw thrown string or generic `Error`.
- **No comments explaining what code does.** Comments are reserved for non-obvious *why* (a workaround, a compliance constraint, a subtle invariant) — consistent with the project's overall documentation philosophy of self-explanatory code plus docs-as-source-of-truth for intent.

## 2. Architecture Rules

- **Respect the layering in `02-Software-Architecture.md` §3.** UI components never query Supabase directly for tenant data; they call Server Actions/Route Handlers, which call domain-layer functions in `packages/*`, which call the data access layer in `packages/database`. No skipping layers "just this once."
- **n8n is the only path to external providers, and it authenticates like anyone else.** No provider SDK (email, enrichment, LinkedIn, calendar) is called directly from `apps/web`. If a new provider integration is needed, it is added as an adapter in `packages/integrations` behind the existing interface, backed by an n8n workflow — never a bespoke direct integration (`ADR-002`). n8n's own credential is an `api_keys` row scoped to a `service` role (`04-API-Architecture.md` §3) — the same primitive any external integrator uses, never a separate undocumented mechanism.
- **RLS is defense-in-depth, not the only check.** Every new tenant-scoped table gets an RLS policy *and* an application-layer permission check via the RBAC facade — neither is optional because "the other layer already handles it." Tenant context is resolved via the single request-scoped Postgres session mechanism (`03-Database-Architecture.md` §5), identically for JWT sessions, API keys, and n8n credentials — never a static JWT claim, and never a client-supplied parameter.
- **RLS policies alone are not sufficient — base table grants are required in the same migration.** Tables created via SQL migrations do not automatically receive grants for the `authenticated`/`anon` Postgres roles; without an explicit `GRANT`, every request fails with "permission denied" before RLS is even evaluated (ADR-003). A migration that enables RLS on a new table without also granting it is incomplete.
- **Use a `SECURITY DEFINER` function, not a plain client-issued `INSERT ... RETURNING`, for any write that needs to read back a just-created row across an RLS boundary** (e.g., creating a new organization and returning its id before any tenant context for that row can exist yet). Postgres requires the `SELECT` policy to also pass for the `RETURNING` clause, which a brand-new row can never satisfy under an `id = current_org()`-style policy (ADR-003).
- **Agency cross-org access only through named roll-up views.** Never write a query or endpoint that lets an agency role read another organization's data through a general "agency can see everything" condition — this must always route through an explicit `agency_rollup_*` view (`03-Database-Architecture.md` §5).
- **New AI agent personas or tools go through the orchestrator**, never as a bespoke one-off LLM call embedded in a route handler. If it calls Claude/OpenAI, it goes through `packages/ai-agents`.
- **Any tool that performs a consequential action is tagged `requires_human_approval: true` and never commits directly.** A deal-stage change, a sent email, a booked meeting — these produce a proposal object (rendered via the structured-action `AISurfaceCard` variant, §9) that only a separate, human-only action can confirm. This is enforced at the tool-execution layer (`05-AI-Agent-Architecture.md` §1), not by asking the model nicely in the prompt — a new write-capable tool without this property explicitly set is a defect, not an oversight to fix later.
- **Agent runs execute via the queued worker, never inline within the request that triggered them, from the very first persona shipped.** This is a correctness requirement, not a scale-triggered optimization: a single run with more than one sequential tool call can exceed a serverless function's execution time on day one, with one tenant (`02-Software-Architecture.md` ADR-005).
- **Shared context comes from the AI Revenue Brain, not ad hoc table assembly.** Any persona or feature that needs "what do we know about this contact/company/deal" queries `packages/brain` (`brain.get_entity_context`/`brain.semantic_search`) rather than joining across CRM/email/meeting/conversation tables itself — that duplication is exactly the "isolated AI features" failure mode the Brain exists to prevent (`11-AI-Revenue-Brain.md` §1). A new data source feeding the Brain gets a consent gate and a `brain_sync_state` entry as part of the same PR that adds the ingestion workflow, not a follow-up.
- **Domain events, not direct cross-module calls, for cross-module reactions.** If module A's state change should trigger module B's behavior, emit a domain event via the outbox (`02-Software-Architecture.md` §5) rather than importing module B's internals into module A. The domain-state write and the outbox row write happen in the same database transaction (Unit-of-Work, `02` §7) — never as two separate application-level writes.

## 3. Folder Conventions

Follow the structure defined in `02-Software-Architecture.md` §4 exactly:

```
apps/web             # UI + route handlers + Server Actions only — no domain logic
apps/marketing        # Marketing site, independently deployable
packages/database     # Schema, migrations, RLS policies, generated types
packages/config       # Shared eslint/tsconfig/tailwind config, no runtime code
packages/auth         # Identity, sessions, RBAC facade, portal session auth
packages/tenancy      # Agency/org hierarchy, membership lifecycle, brand-theme + custom-domain rules
packages/compliance   # Consent, deletion/export orchestration, audit logging, retention
packages/ui           # Design system components, theme tokens
packages/crm          # Companies/contacts/deals/pipeline business rules
packages/intelligence # Visitor identification, enrichment orchestration, lead scoring
packages/revenue      # Proposal rules, revenue aggregation, subscription/billing orchestration; also serves Customer Portal data access
packages/automation   # Workflow-enablement rules, campaign orchestration, onboarding provisioning
packages/integrations # Provider-agnostic interfaces + n8n-facing API client
packages/brain        # AI Revenue Brain: ingestion, entity profiles, embeddings, retrieval client
packages/ai-agents    # Orchestrator, personas, tool layer, model router
workflows/            # n8n workflow JSON exports, version-controlled
infra/                # Supabase config, Vercel config, env schemas
docs/                 # This documentation set + docs/adr/ for decisions
```

- A new `packages/*` module is justified only when it represents a genuinely separate bounded context (per `02-Software-Architecture.md` §4's table, which is the single source of truth for this list — if this document and that one ever disagree, `02` wins and this file is out of date) — do not create a new package for a handful of utility functions; those belong inside the most relevant existing package. The Customer Portal is the concrete example: it has no package of its own, because its concerns (session auth, read-only proposal/document access) are thin enough to belong in `auth` and `revenue` respectively.
- Nothing inside `packages/*` imports from `apps/*` — dependencies flow one direction only, app depends on packages, never the reverse.

## 4. Naming Conventions

- **Database**: `snake_case` for tables/columns, singular concept expressed as plural table names (`contacts`, not `contact`), foreign keys as `{referenced_table_singular}_id` (`organization_id`, `company_id`).
- **TypeScript**: `camelCase` for variables/functions, `PascalCase` for types/components/classes, `SCREAMING_SNAKE_CASE` for true constants only (not for config that varies by environment).
- **API routes**: REST resource paths are plural, `kebab-case` for multi-word resources (`/api/v1/data-subject-requests`), matching `04-API-Architecture.md` §2 exactly — do not introduce a new naming pattern for a new resource without checking that document first.
- **Domain events**: `{resource}.{past_tense_verb}` (`deal.stage_changed`, `consent.withdrawn`) — consistent with the events catalogued in `02-Software-Architecture.md` §5; extend that list when adding a new event type, don't invent an inconsistent format. A payload shape change to an existing event type bumps its `event_version` (`02` §5) rather than being pushed as an in-place breaking change to existing consumers.
- **Files**: one primary export per file, filename matches the export in `kebab-case` (`lead-scoring-engine.ts` exporting `LeadScoringEngine`/`computeLeadScore`).

## 5. Testing Strategy

- **Unit tests** for all domain logic in `packages/*` — especially scoring rules, RBAC permission resolution, and the model router's fallback logic — run against real logic, not mocked into meaninglessness.
- **RLS policy tests** are mandatory for every new tenant-scoped table: a test that asserts organization A genuinely cannot read/write organization B's rows, run against a real (test) Postgres instance, not just asserted by code review. This is the single most important test category given the shared-schema multi-tenancy model, and it must cover all three caller types (JWT session, API key, n8n service credential) resolving tenant context identically, not just the JWT-session path.
- **Approval-gate tests** are mandatory for every `requires_human_approval` tool: a test that asserts the underlying write genuinely does not happen from the tool call alone, and only happens after the separate human-confirmation action — this is a distinct test category from ordinary permission tests, because it verifies the *absence* of a side effect, not just its correct gating.
- **Integration tests** for API routes covering the auth/authz boundary explicitly — including the portal-user boundary (a portal session must fail, not just be denied gracefully, when attempting to reach internal CRM endpoints).
- **Agent tests** validate tool-call permission enforcement (an agent persona cannot invoke a tool outside its granted set) and error-handling paths (§7 of `05-AI-Agent-Architecture.md`) — not model output quality, which is evaluated separately via acceptance-rate monitoring in production, not pre-merge tests.
- **n8n workflow tests**: each workflow's error-handling and idempotency behavior (retry of a duplicate webhook doesn't double-process) is tested against a staging workflow instance before promoting workflow JSON to production.
- **No mocking the database in RLS/integration tests** — a mocked Supabase client can pass while the real RLS policy is broken; this class of test must hit a real (test-environment) Postgres instance.

## 6. Documentation Rules

- This `docs/` folder is the source of truth for intent and architecture; code comments are not a substitute for updating the relevant doc when a decision changes.
- Any deviation from a decision recorded in `01`-`09` requires either updating that document or logging an ADR in `docs/adr/` explaining the change — silent architectural drift is not acceptable given how much of this system's safety (multi-tenancy, GDPR) depends on the documented model being the actual model.
- New significant architectural decisions (a new package boundary, a new external provider category, a change to the tenancy model) get an ADR in `docs/adr/` before implementation, not after.
- README files at the root of `apps/web`, `packages/*` describe *how to run/develop* that unit, not *what it's for* — the "what" and "why" live in this `docs/` set.

## 7. Performance Rules

- **Cache/dedupe before calling paid external providers.** Enrichment lookups check `expires_at` on existing `company_enrichment`/`contact_enrichment` rows before triggering a new provider call — never re-fetch per view (`03-Database-Architecture.md` §2.3, `06-n8n-Workflow-Architecture.md` §2).
- **Every tenant-scoped query is indexed on `organization_id`-leading composite indexes** as the default expectation (`03-Database-Architecture.md` §4) — a new query pattern that requires a full scan across a tenant-scoped table is a signal to add an index, not to accept the scan.
- **Agent runs are queued/async from the first persona shipped — this is not volume-gated.** Workflow runs triggered by schedule or webhook may reasonably batch or throttle as volume grows, but agent execution specifically must never run inline within a request, at any volume, because a single multi-tool-call run can already exceed a serverless execution-time limit with one tenant (`02-Software-Architecture.md` ADR-005, `05-AI-Agent-Architecture.md` §1).
- **No speculative scaling work.** Read replicas, dedicated partitioning work, and multi-region are Phase 8 concerns sequenced by observed bottlenecks (`09-Development-Roadmap.md`), not built ahead of real load data — though `brain_embeddings`/`email_messages`/`meetings` growth should be *monitored* starting in Phase 5, even though the partitioning work itself waits for Phase 8 (`03-Database-Architecture.md` §4).

## 8. Security Rules

- Never log secrets, API keys, or raw personal data payloads in plaintext application logs — structured logging redacts known secret-shaped and PII-shaped fields (`08-Security.md` §7).
- Every new endpoint or Server Action resolves `organization_id`/actor identity server-side from the authenticated session — never trusts a client-supplied tenant identifier.
- Any new table holding personal data must be added to the relevant `data_retention_policies` entry and included in the `data_subject_requests` cascade (`08-Security.md` §5) as part of the same PR that introduces the table — not as a follow-up ticket.
- **GDPR erasure is never implemented as a `deleted_at` soft-delete.** A completed `data_subject_requests` deletion always performs actual hard deletion of the row, or irreversible anonymization of personal-data columns where the row must survive for referential/audit reasons (`03-Database-Architecture.md`'s deletion model, `08-Security.md` §5). `deleted_at` is the ordinary, recoverable, user-initiated deletion mechanism for CRM entities — the two are never the same code path, and conflating them is one of the most common real-world GDPR compliance mistakes.
- Column-level encryption (pgsodium/pgcrypto) is required for any new credential/token/secret field, following the existing pattern in `integration_connections` — plaintext credential storage is never acceptable, including "temporarily, for testing."
- New AI tool definitions are reviewed for RBAC scope *and* for the `requires_human_approval` property (§2, §9) before merge — a tool that can write data must declare the exact permission it requires, matching an entry in the RBAC matrix (`08-Security.md` §3), and must declare whether it's consequential enough to require the approval gate.
- Dependency vulnerability scanning must pass in CI before merge (`08-Security.md` §10) — a known critical vulnerability in a dependency is a merge blocker, not a follow-up ticket.

## 9. AI Engineering Guidelines

- **Model provider calls are never hardcoded at the call site.** All reasoning goes through the model router in `packages/ai-agents`, configured via `agent_definitions.model_provider`/`model_name` — this is what keeps the platform able to swap/fallback providers without a code change.
- **Every agent output renders inside the appropriate `AISurfaceCard` variant for what it is** (`07-UI-UX-System.md` §5, §10) — there are three, not one: the content variant (a draft, Accept/Edit/Discard) for prose; the structured-action variant (Accept/Choose Different/Discard, no "Edit") for a proposed change like a deal-stage move; the living-document variant (no commit actions, just a persistent "AI-synthesized" label and confidence tiers) for continuously-updated syntheses like Research Agent briefs. No agent output renders outside one of these three, and no exceptions are made for "this one's probably fine to auto-send" — for anything tagged `requires_human_approval`, that's not a UI convention, it's mechanically enforced at the tool layer (§2).
- **A persona's `system_prompt` is never the complete prompt.** Tenant customization of a persona's voice/context is composed at invocation time with a non-overridable platform safety preamble (anti-hallucination instruction, confidence-tiering requirement, approval-gate reminder) — an organization can change how a persona sounds, never strip what makes its output trustworthy (`05-AI-Agent-Architecture.md` §1).
- **Distinguish confirmed data from inference in prompts and outputs**, explicitly, per persona (`05-AI-Agent-Architecture.md` §4's Research Agent pattern is the template) — an agent should never present an inference with the same confidence as a sourced fact.
- **Tool calls are logged (`agent_tool_calls`) and permission-checked identically to the equivalent human action** — an agent never has implicit standing permission beyond its triggering context.
- **Runaway-loop protection is mandatory on every new persona**: a hard cap on tool-call iterations and wall-clock time, enforced by the queued-execution worker itself (§2, §7) — not a request-scoped timeout — before a run auto-terminates as `failed`. Do not ship a persona without this cap configured.
- **Cost is a first-class concern per persona**: token usage and tool-call provider cost are tracked per `agent_run` (`agent_runs.total_tokens`/`total_cost_usd`, `agent_tool_calls.cost_usd`) and any new persona's expected cost profile should be estimated before it ships, not discovered after a billing surprise.
- **The Brain is retrieval, not training, until an ADR says otherwise.** Do not introduce per-tenant model fine-tuning or weight updates as a side effect of a Brain-related feature — that's an explicitly deferred, separately-evaluated future phase (`11-AI-Revenue-Brain.md` §8), not something to back into incrementally.
- **New Brain data sources are consent-gated before they're ingested, not after.** Any ingestion workflow writing into `brain_embeddings` must check the relevant `consent_records` entry first (`11-AI-Revenue-Brain.md` §3, §10) — content that fails the consent check is stored in its raw source table for the org's own reference (if applicable) but never chunked/embedded into the Brain.

## 10. Refactoring Rules

- Refactor within a package's boundary freely; a refactor that would change a package's public interface (its `index.ts` barrel exports) requires checking every consumer across `apps/*` and other `packages/*`, and updating the relevant architecture doc if the change reflects a real design shift rather than an internal cleanup.
- Do not refactor RLS policies, the RBAC permission matrix, the tenancy hierarchy tables, or the approval-gate mechanism as a side effect of an unrelated feature PR — these are foundational and get their own reviewed, tested change with explicit sign-off given the blast radius of getting them wrong.
- When simplifying, prefer deleting unused code outright over commenting it out or leaving a "kept for reference" branch — git history is the reference, not dead code in the tree.
- A refactor is not "done" until the relevant test suite (§5) passes against it, including RLS isolation tests and approval-gate tests if any tenant-scoped table, policy, or consequential tool was touched.
