# 09 — Development Roadmap

Paced for a solo founder building with AI assistance (`01-Vision.md`) — phases are strictly gated, no parallel workstreams. Effort estimates assume this pace; a small team could compress phases 3 onward by running independent tracks in parallel. Each phase ends with a demoable, working slice — never a partial cut across multiple phases at once.

---

## Phase 1 — Foundation

**Features**
- Monorepo scaffold (Turborepo), shared config packages
- Agency → Organization → User tenancy hierarchy, memberships, roles
- Supabase Auth integration (staff sessions), RBAC permission facade
- RLS enabled on all tenant-scoped tables from the first migration, using the request-scoped tenant-context mechanism (`03-Database-Architecture.md` §5) from day one — not a static JWT claim that would need reworking later
- `api_keys` and `events` (outbox) tables (`03-Database-Architecture.md` §2.1, §2.10) — foundational infrastructure the very next phase's first n8n workflow and every later domain event depend on
- Basic white-label theming: logo, primary/secondary color, subdomain
- GDPR primitives: `consent_records`, `data_subject_requests`, `audit_logs`, `data_retention_policies` schemas and base orchestration job, built with the two-tier soft-delete/hard-delete distinction (`03-Database-Architecture.md`) correct from the start
- **Connection pooling (Supavisor) enabled from the first deployment** — `02-Software-Architecture.md` §2 states this explicitly as a Phase 1 requirement, not a later optimization, given how common serverless-to-Postgres connection exhaustion is as a failure mode
- **Observability**: structured logging with secret/PII redaction, plus an error-tracking service (Sentry or equivalent) wired in from the first deployment — instrumenting after the app is already built is always more expensive
- **Dependency vulnerability scanning in CI** and a published, lightweight vulnerability disclosure policy (`08-Security.md` §10) — both cheap to set up now, expensive to retrofit onto a larger dependency tree and an established user base later
- CI/CD pipeline (Vercel + Supabase migrations), staging/prod environments, with Vercel preview deployments pointed at a dedicated staging Supabase project, never production data
- First ADRs logged in `docs/adr/` (the modular-monolith, n8n-boundary, and shared-schema-RLS decisions from `02-Software-Architecture.md`) — establishing the practice from the first phase, not retrofitting a decision log later

**Deliverables**
- A deployable empty product shell: an agency can sign up, create a client organization, invite a user, and see a themed (logo/color) empty dashboard
- Working audit log entries for auth and membership events
- A production deployment with pooled connections, error tracking, and dependency scanning already active — not bolted on after the first incident reveals their absence

**Dependencies**
- None (first phase)

**Risks**
- Under-investing here is the single most expensive mistake possible — RLS/tenancy/GDPR primitives retrofitted onto live tenant data later is materially more expensive than building them correctly now (`03-Database-Architecture.md`, `08-Security.md`). This phase should not be rushed to "get to features."
- The operational-hygiene items above (pooling, observability, dependency scanning) are individually small, which makes them easy to defer under schedule pressure — they're listed explicitly here specifically so that pressure doesn't quietly drop them.

**Estimated Effort**: 4-6 weeks

---

## Phase 2 — CRM

**Features**
- Companies, Contacts, Deals, Activities, Notes, Tags
- Pipelines and Pipeline Stages, kanban deal board (`PipelineBoard`)
- Agency admin console: client org list, roll-up view scaffolding (`agency_rollup_*`)
- Core REST API v1 for all CRM resources — shipping from the start with `04-API-Architecture.md`'s foundational conventions: cursor pagination, a standard error envelope, and `Idempotency-Key` support on mutating requests where the organization-scoped idempotency model is structurally applicable (documented exclusions apply), so no resource is ever built against inconsistent API behavior that has to be reconciled later
- Design system components in production use (`EntityTable`, `PipelineBoard`, `ActivityTimeline`)

**Deliverables**
- A fully usable, sellable CRM wedge — the product an agency can put in front of a real client organization and run day-to-day pipeline management on

**Dependencies**
- Phase 1 (tenancy, RBAC, RLS, API scaffold)

**Risks**
- Scope temptation to add "just one more CRM feature" (custom fields, advanced reporting) before the wedge is proven — resist; those are Phase 7/8 concerns

**Estimated Effort**: 6-8 weeks

---

## Phase 3 — Website Intelligence

**Features**
- Tracking script + the dedicated, unauthenticated public ingestion endpoint (`04-API-Architecture.md` §2 — a separate route outside `/api/v1/*` given its opposite security/traffic profile from the rest of the API), consent-gated
- `website_visitors`, `visitor_sessions`, `visitor_events`, visitor identification logic
- Company/Contact enrichment provider integration (via provider-agnostic adapter; the AI Revenue OS side — schema, service-authenticated write-back API, dispatch-trigger infrastructure — shipped in Milestone 3.3, `docs/13-Technical-Design-Review.md` "Milestone 3.3 — Overall Closeout"; the real provider-calling Lead Enrichment n8n workflow itself remains a later n8n workflow-authoring sub-phase, not part of that delivery), with `workflow_runs.cost_usd` tracked from this workflow's first run — since it's triggerable directly from the UI (not only via an agent), this is the first place provider cost needs a home outside `agent_tool_calls`
- Rules-based lead scoring engine (`scoring_rules`, `lead_scores`)
- Revenue Dashboard v1 (pipeline value, win rate, trend charts)

**Deliverables**
- A client organization can install the tracking script, see identified visitors resolve into CRM contacts, and see rules-based lead scores on those contacts

**Dependencies**
- Phase 2 (contacts/companies to resolve visitors against); first real n8n workflow (Lead Enrichment) — establishes the n8n operating pattern used by all later automation phases, using the `api_keys` service-role credential built in Phase 1

**Risks**
- Enrichment provider unit economics (per-lookup cost) must be measured against real usage here, before AI agents add further per-lookup consumption in Phase 4 — this is the checkpoint to validate the cost model this platform depends on
- Consent-gating the tracking script correctly is a GDPR-critical detail, not a nice-to-have — must be verified, not assumed

**Estimated Effort**: 6-8 weeks

---

## Phase 4 — AI Agents

**Features**
- **AI Revenue Brain foundation** (`11-AI-Revenue-Brain.md`): `packages/brain`, `pgvector` enabled, `brain_entity_profiles`/`brain_embeddings`/`brain_knowledge_documents`/`brain_sync_state` schema, ingestion wired to sources that already exist at this point (CRM, website visitors, tasks, conversations, manually-uploaded knowledge documents) — built *before* the personas, since every persona now depends on it for shared context
- **Queued/async agent-execution worker** (`02-Software-Architecture.md` ADR-005): a dedicated worker process dequeues and executes `agent_runs`, enforcing tool-call iteration and wall-clock caps itself — built *before* any persona ships, since this is a correctness requirement (avoiding mid-chain truncation against serverless time limits on a single multi-tool-call run), not an optimization to add once volume justifies it
- Agent orchestrator, model router (Claude primary, OpenAI fallback), shared tool layer with RBAC-checked tool calls, `brain.get_entity_context`/`brain.semantic_search` tools, and the **mechanically-enforced `requires_human_approval` tool property** (`05-AI-Agent-Architecture.md` §1) — consequential tools (`crm.propose_deal_stage_change`, `calendar.propose_meeting`, `email.send`) produce a proposal object rather than committing directly, gated at the tool-execution layer, not by prompt instruction alone
- The non-overridable platform safety preamble composed server-side alongside every persona's tenant-customizable `system_prompt`, so brand-voice customization can never strip the anti-hallucination/confidence-tiering guarantees
- Cost-tracking schema: `agent_runs.total_tokens`/`total_cost_usd`, `agent_tool_calls.cost_usd` — built alongside the orchestrator, not retrofitted once the first cost surprise happens
- All five personas live: Sales Agent, Marketing Agent, Research Agent, Scoring Agent, Support/Chat Agent — each querying the Brain for shared context plus its own thin `agent_memory` for short-term state
- The three `AISurfaceCard` variants in production (`07-UI-UX-System.md` §5 — content, structured action, living document) plus `ResearchBriefCard` for the Research Agent's confidence-tiered output
- Agent monitoring: run/tool-call logging, acceptance-rate tracking (including approval-gate confirm/discard rate as a distinct signal), Brain query volume/cost tracking per persona

**Deliverables**
- Reps see AI-drafted follow-ups and account research briefs inside the CRM, informed by a single unified view of each contact/company/deal rather than five personas each reconstructing their own partial picture; lead scores show agent-adjusted components; AI Chat answers questions over CRM data; consequential agent actions require explicit human confirmation, mechanically, not just by convention

**Dependencies**
- Phase 2 (CRM data to reason over), Phase 3 (enrichment + scoring data as agent inputs and as the Brain's first ingestion sources)

**Risks**
- Largest single-phase risk in the roadmap: AI cost-per-tenant (now compounded by Brain query/embedding cost, not just model/tool-call cost), output quality/trust (hallucination risk in Research/Scoring agents), and the discipline of never letting an agent auto-send/auto-commit without human review (`05-AI-Agent-Architecture.md` §1 principle) — this phase is where the "AI augments judgment, doesn't replace accountability" value is actually tested in production
- Recommend building the Brain foundation and the queued-execution worker first (both are load-bearing infrastructure every persona depends on), then the Research Agent (it's the primary writer of Brain profiles), then shipping remaining personas sequentially (Sales Agent next, as the highest-value/lowest-risk) rather than all five simultaneously
- The Brain is the platform's largest personal-data aggregation surface (`08-Security.md` §5) — its tenant-isolation and consent-gating must be verified adversarially here, not assumed correct from the design doc
- Building the execution worker and approval-gate mechanism *after* personas exist, instead of before, would mean retrofitting both onto five personas simultaneously — the ordering above exists specifically to avoid that

**Estimated Effort**: 11-14 weeks (revised up from 10-13 to account for the queued-execution worker as real, distinct infrastructure work, not something the Brain-foundation estimate already covered)

---

## Phase 5 — Automations

**Features**
- Full n8n workflow catalog live: CRM Automation, Email Automation, Proposal Workflow, Customer Onboarding, Reporting Workflow, and the real provider-calling Lead Enrichment workflow itself (Phase 3/Milestone 3.3 shipped only the AI Revenue OS side of Lead Enrichment — schema, write-back API, dispatch trigger — never the n8n workflow; Website Visitor Intelligence needs no n8n workflow at all and was already fully shipped in Phase 3, direct/synchronous per `06-n8n-Workflow-Architecture.md` §3)
- **Brain source expansion**: Email Sync and Meeting Ingestion workflows (`06-n8n-Workflow-Architecture.md` §10-11) — new provider integrations (mailbox sync, meeting transcription), each requiring a Data Processing Addendum (`08-Security.md` §5) and the new `email_content_processing`/`meeting_recording_processing` consent types before any tenant can enable them
- Proposal Generator (draft, send, tracked view, accept/decline) — send always a distinct, human-triggered step, never auto-chained from draft generation
- Email Automation module (campaigns, sequences, deliverability handling, suppression lists), with `email_sends.consent_verified` giving this workflow the same consent-audit trail as the Brain's email/meeting ingestion
- Tenant-facing workflow builder UI (configure CRM automation rules without engineering involvement)
- LinkedIn Automation — shipped last within this phase, isolated, feature-flagged per organization, beta-labeled, conservative default pacing limits

**Deliverables**
- An agency can onboard a new client org with automated provisioning, send proposals with tracked acceptance, run email campaigns, configure basic automation rules themselves, and — where a tenant opts in and consents — have inbox and meeting content feeding the AI Revenue Brain so agent context includes email/meeting history, not just CRM state

**Dependencies**
- Phase 1-4 (this phase is the automation backbone connecting CRM, Intelligence, and Agent outputs into action); Phase 4's Brain foundation must exist before Email Sync/Meeting Ingestion have anywhere to write

**Risks**
- LinkedIn Automation carries the platform's single highest legal/reputational risk (ToS violations, account bans cascading to agencies' clients) — must ship with the isolation and fail-safe pacing described in `06-n8n-Workflow-Architecture.md` §6, and must remain trivially disable-able per organization
- Email deliverability reputation is a shared platform asset — one tenant's poor sending practice can affect others if not isolated (per-tenant sending domains/reputation tracking should be evaluated here)
- Email Sync and Meeting Ingestion are the platform's most privacy-sensitive connectors (private correspondence, recorded conversations) — the consent-gate-before-ingestion discipline (`11-AI-Revenue-Brain.md` §10) must be verified end-to-end before either ships to any real tenant, not treated as a checkbox
- **Begin monitoring `brain_embeddings`/`email_messages`/`meetings` table growth starting this phase** (`03-Database-Architecture.md` §4) — these are the nearest-term partitioning/scaling pressure points in the whole platform, tied directly to this phase's ingestion volume, even though the actual partitioning work is sequenced in Phase 8

**Estimated Effort**: 9-11 weeks (extended from the original 8-10 for the two new Brain-source connectors)

---

## Phase 6 — Customer Portal

**Features**
- `portal_users` magic-link auth scope, structurally separate from internal product auth, reachable only through the `/api/v1/portal/*` route tree (`04-API-Architecture.md` §4) — enforced at the authentication layer, not just a permission check
- Proposal status/document visibility for end customers via `/api/v1/portal/proposals`, `/api/v1/portal/documents`
- Scoped Support/Chat Agent entry point (role-appropriate tool set only, calling exclusively through the same portal route tree)
- Self-service profile edit (GDPR rectification right)
- Mobile-first responsive treatment (the one surface designed mobile-first per `07-UI-UX-System.md` §8)

**Deliverables**
- An agency's client's own customers can log into a branded portal to check proposal/project status and get AI-assisted support, without any access to internal CRM data

**Dependencies**
- Phase 5 (proposals must exist to have status to show); Phase 4 (Support/Chat Agent)

**Risks**
- Portal is the most externally-exposed surface (real end customers, not just agency staff) — the RBAC boundary between `portal_customer` and every internal role must be verified adversarially (attempt to reach internal endpoints from a portal session), not just assumed correct from the permission matrix on paper

**Estimated Effort**: 5-7 weeks

---

## Phase 7 — Enterprise

**Features**
- Public REST API general availability: scoped API key issuance/management UI (`/api/v1/api-keys`) so tenants can self-serve their own keys, published API docs
- Outbound webhook self-service management (`/api/v1/webhook-subscriptions`, backed by the `webhook_subscriptions` table) — lets agencies register their own endpoints to receive domain events
- Deeper white-label: custom domains (`custom_domains` verification/SSL), fuller theme editor with contrast validation
- SSO (SAML/OIDC) and enforced MFA for agency-owner/admin roles
- SOC2 Type II readiness program (formalizing the audit logging, access control, and encryption groundwork already built in Phases 1/8-security into an auditable control set)
- **Formal third-party penetration test** (`08-Security.md` §10) — ahead of the first enterprise contract, not deferred alongside SOC2 itself
- Custom roles/permissions beyond the default RBAC matrix, for larger agencies with their own internal structure

**Deliverables**
- The platform can credibly sell to larger agencies and direct mid-market/enterprise customers who require SSO, audit-ready compliance posture, and a documented public API

**Dependencies**
- Phases 1-6 (this phase formalizes and hardens existing functionality rather than introducing new core product surface)

**Risks**
- SOC2 is explicitly a milestone, not a gate (per prior decision) — risk is scope creep turning this into an open-ended compliance project instead of a time-boxed readiness push
- Public API GA increases the attack surface (rate limiting, key leakage, abuse) — requires the rate-limiting and key-scoping design in `04-API-Architecture.md` to be genuinely battle-tested, not just documented

**Estimated Effort**: 8-12 weeks

---

## Phase 8 — Scale

**Features**
- Database scaling: connection pooling tuning, read replicas for agency roll-up/reporting queries, partitioning for high-volume append-only and large-payload tables — **`visitor_events`, `audit_logs`, `agent_tool_calls`, and, based on Phase 5's monitoring, likely `brain_embeddings`/`email_messages`/`meetings` sooner than the rest** (`03-Database-Architecture.md` §4)
- Dedicated-database escape hatch implemented for the first enterprise tenant that requires it (per `03-Database-Architecture.md` §6 hybrid multi-tenancy option)
- Marketplace of pre-built n8n workflow templates and integrations, contributable/configurable by agencies
- Advanced analytics/BI export (data warehouse sync for agencies wanting their own BI tooling)
- AI/enrichment/Brain cost optimization pass across all agents and workflows, informed by real per-tenant unit economics data gathered since Phase 3
- **AI Revenue Brain fine-tuning evaluation** (`11-AI-Revenue-Brain.md` §8): only pursued if retrieval-based Brain output quality has measurably plateaued below business needs on a specific task — evaluated here, not built speculatively; if justified, per-tenant adapter-style fine-tuning (not a shared base model) to keep the GDPR deletion story tractable
- Formal SLA tiers and status-page incident communication

**Deliverables**
- The platform operates reliably at meaningfully higher tenant counts and data volumes than the MVP was built for, with a validated cost model and an enterprise-grade escape hatch proven in production for at least one tenant

**Dependencies**
- Phases 1-7 (this phase is optimization and hardening of an already-complete product surface, not new product features)

**Risks**
- Premature scaling work (before real usage data justifies it) is itself a risk — this phase should be sequenced by actual bottlenecks observed in production, not spec'd out speculatively in advance
- Team-size assumption changes here: solo-founder pacing likely does not hold through this phase if tenant growth is real — this is the natural point to revisit team size, per `01-Vision.md`'s Long-Term Goals (Year 3 note on revisiting the solo-founder-paced assumption)

**Estimated Effort**: Ongoing / demand-driven, not a fixed sprint — initial hardening pass estimated at 6-8 weeks, with subsequent work paced by actual growth

---

## Summary Timeline (solo-founder pace, sequential)

| Phase | Focus | Estimated Effort |
|---|---|---|
| 1 | Foundation | 4-6 weeks |
| 2 | CRM | 6-8 weeks |
| 3 | Website Intelligence | 6-8 weeks |
| 4 | AI Agents (incl. Brain foundation + queued-execution worker) | 11-14 weeks |
| 5 | Automations (incl. Email Sync + Meeting Ingestion) | 9-11 weeks |
| 6 | Customer Portal | 5-7 weeks |
| 7 | Enterprise | 8-12 weeks |
| 8 | Scale (incl. Brain fine-tuning evaluation) | 6-8 weeks initial, then ongoing |

**Total to a full-featured, enterprise-ready platform: roughly 55-75 weeks (~13-17 months)** at strictly sequential, solo-founder-with-AI-assistance pace. Phases 1-3 (~16-22 weeks) constitute the sellable agency wedge — the actual gate to continuing into Phase 4 is `01-Vision.md`'s Year 1 wedge-validation range: **roughly 6-12 independent design-partner agencies, collectively managing roughly 30-60 client organizations, with 90-day retention meaningfully above typical early-SaaS churn, and no single agency over roughly a quarter of active organizations.** Falling short of the low end of that range by the end of Phase 3 is the trigger to revisit the agency-channel bet before investing the ~35-45 additional weeks Phases 4-8 represent — not a vague "see if it feels like it's working" judgment call.
