# 02 — Software Architecture

## 1. High-Level Architecture

AI Revenue OS is a **modular monolith** (Next.js App Router) backed by **Supabase** (Postgres, Auth, Storage, Edge Functions, Realtime), with **n8n** as a dedicated automation/integration service handling everything that talks to an external provider. AI reasoning (Claude, OpenAI) is invoked from an internal agent orchestration layer inside the monolith.

Rationale: a solo-founder-paced team cannot operate the operational overhead of microservices (service discovery, distributed tracing, N deployment pipelines). A modular monolith with strict internal package boundaries (see `packages/*`) gives most of microservices' maintainability benefit — clear ownership, independent testability, replaceable modules — without the ops tax. The one deliberate service boundary we do take is n8n, because provider-facing automation genuinely benefits from a visual, non-redeploy-required workflow layer, and isolating it is what makes the platform provider-agnostic (see §6, ADR-002).

```
┌───────────────────────────────────────────────────────────────────┐
│                            Vercel (Edge + Node runtimes)           │
│  Next.js App (apps/web)                                            │
│   ├─ Tenant product UI            (organization-scoped)            │
│   ├─ Agency admin console         (agency-scoped, cross-org roll-up)│
│   ├─ Customer portal              (portal_users auth scope)        │
│   ├─ Public REST API              /api/v1/*  ◄── n8n calls this,    │
│   ├─ Webhook receivers            /api/v1/webhooks/*   as just      │
│   └─ AI Agent Orchestrator        packages/ai-agents   another      │
└───────────────┬──────────────────────────────────┬─── caller ───────┘
                 │                                  │        ▲
                 ▼                                  ▼        │
┌─────────────────────────────────┐   ┌───────────────────────────────┐
│            Supabase             │   │              n8n              │
│  Postgres (RLS enforced,        │   │  Enrichment provider calls     │
│    pgvector enabled)            │   │  Email sync + sequencing      │
│  Auth (staff + portal scopes)   │   │  Meeting ingestion             │
│  Storage (docs, avatars, exports)│   │  LinkedIn automation (isolated)│
│  Edge Functions (cron, triggers)│   │  Cross-tool sync (Slack, cal.) │
│  Realtime (live CRM sync)       │   │  Brain indexing · Reporting     │
└─────────────────────────────────┘   └───────────────────────────────┘
        (no direct edge to n8n — see note below)
                 ▲
                 │
┌─────────────────────────────────┐
│   External AI Providers         │
│   Claude (primary reasoning)    │
│   OpenAI (secondary / fallback) │
└─────────────────────────────────┘
```

**n8n never talks to Postgres directly.** Every arrow between n8n and tenant data routes through the Next.js app's own authenticated REST API (`04-API-Architecture.md` §8), using an `api_keys` row scoped to a `service` role, issued per workflow (`04-API-Architecture.md` §3) — the exact same credential primitive a third-party integrator uses, not a separate mechanism. This is deliberate and load-bearing: it's what keeps RLS, the RBAC facade, and the consent-gating logic in `06-n8n-Workflow-Architecture.md` from being bypassable by anything that can reach the automation layer. An earlier version of this diagram showed n8n with a direct edge into Supabase — that was a documentation defect, not a design decision; if you're implementing from this doc, there is no code path where n8n holds Postgres credentials.

The AI Revenue Brain (`11-AI-Revenue-Brain.md`) is a package-level component, not a new service — it lives in `packages/brain`, storing its structured profiles and vector embeddings in the same Supabase Postgres instance (via the `pgvector` extension), and is populated by the same API-mediated n8n ingestion pattern as everything else provider-facing. It does not introduce a new deployment target.

## 2. System Architecture

- **Compute**: Vercel for the Next.js app (edge for static/marketing paths, Node serverless functions for API routes and Route Handlers that need Supabase service-role access).
- **Data**: Single Supabase Postgres project per environment (dev/staging/prod), EU region, RLS enforced on every tenant-scoped table. **Connection pooling (Supavisor, Supabase's built-in pooler) is a Phase 1 requirement, not a later optimization** — serverless functions opening unpooled connections against Postgres's connection cap is one of the most common production failure modes in a Next.js + Supabase stack, and it appears the first time concurrent traffic hits the app, not "at scale."
- **Scheduled jobs**: driven by `pg_cron` (or an external scheduler) invoking Supabase Edge Functions — Edge Functions are not natively cron-triggered on their own, something worth being precise about since the rest of the doc set depends on scheduled jobs (retention purges, digest emails, Brain staleness catch-up).
- **Automation**: Single shared n8n instance (self-hosted, e.g. on Railway/Fly/Render — decided at infra time), multi-tenant via parameterized workflows, not one instance per tenant, communicating with tenant data exclusively through the app's REST API (§1).
- **Async/background work**: Supabase Edge Functions for scheduled jobs and Postgres-triggered outbox writes for event-driven fan-out into n8n (§5).
- **Object storage**: Supabase Storage for proposal PDFs, uploaded documents, brand assets (logos).
- **Environments**: Vercel preview deployments per PR point at a dedicated staging Supabase project, never at production data — worth stating explicitly since it's an easy default to get wrong.

## 3. Application Architecture

Layered structure inside `apps/web`:

```
UI Layer (React Server/Client Components, shadcn/ui)
   │
Application Layer (Route Handlers, Server Actions — orchestrate use cases)
   │
Domain Layer (packages/crm, packages/intelligence, packages/revenue,
              packages/tenancy, packages/automation, packages/ai-agents,
              packages/brain, packages/compliance, packages/auth — pure
              business logic, framework-agnostic where possible)
   │
Data Access Layer (packages/database — typed Supabase client, RLS-aware queries)
   │
Supabase (Postgres / Auth / Storage) + n8n (via the app's own REST API, §1)
```

Rule: UI components never query Supabase directly for tenant data — they call Server Actions/Route Handlers, which call domain-layer functions, which call the data access layer. This keeps RLS as defense-in-depth rather than the *only* authorization check, and keeps business logic testable independent of Next.js. **This diagram's package list is authoritative and matches §4's table exactly** — an earlier version of this document referenced "CRM" and "Intelligence" as domain-layer concepts without either having a corresponding package, which meant the platform's largest share of business logic (deal-stage rules, scoring orchestration, pipeline validation) had no defined home and would have defaulted to living directly inside Server Actions, quietly violating this same rule.

## 4. Modular Architecture

Each `packages/*` module owns one bounded context and exposes a narrow public interface (an `index.ts` barrel); internal files are not imported directly across package boundaries.

| Package | Bounded context | Depends on |
|---|---|---|
| `database` | Schema, migrations, generated types, RLS policies | — |
| `config` | Shared eslint/tsconfig/tailwind config, no runtime code | — |
| `auth` | Identity, sessions, RBAC/permission matrix, portal session auth | `database` |
| `tenancy` | Agency→organization hierarchy rules, membership/invitation lifecycle, brand-theme inheritance and validation, custom-domain verification | `database`, `auth` |
| `compliance` | Consent, deletion/export orchestration, audit logging, retention | `database`, `auth` |
| `ui` | Design system components, theme tokens | — |
| `crm` | Companies/contacts/deals/pipeline business rules — stage transitions, deal validation, activity logic | `database`, `auth` |
| `intelligence` | Visitor identification logic, enrichment orchestration, lead-scoring engine (rules-based + agent-assisted blending) | `database`, `crm` |
| `revenue` | Proposal generation rules, revenue event aggregation, subscription/billing orchestration; also serves the read-only proposal/document access the Customer Portal needs | `database`, `crm` |
| `automation` | Workflow-enablement rules, campaign orchestration and suppression-list logic, onboarding provisioning — the domain rules that decide *what* happens, distinct from `integrations`' adapters that decide *how* to reach a provider | `database`, `crm`, `integrations` |
| `integrations` | Provider-agnostic interfaces (`EmailProvider`, `EnrichmentProvider`, `SocialAutomationProvider`, `CalendarProvider`) + n8n-facing API client | `database` |
| `brain` | AI Revenue Brain: ingestion orchestration, structured entity profiles, vector embeddings, retrieval client (`11-AI-Revenue-Brain.md`) | `database`, `auth` |
| `ai-agents` | Orchestrator, personas, tool layer, model router | `database`, `auth`, `crm`, `intelligence`, `integrations`, `brain` |

`apps/web` composes these packages; it contains no domain logic of its own beyond request/response glue and UI. **This table is the single source of truth for package boundaries** — `10-CLAUDE.md`'s folder conventions and `03-Database-Architecture.md`'s domain groupings should be read as describing the same boundaries from a different angle, not as independent lists that can drift from this one. The Customer Portal deliberately has no package of its own: its auth/session concerns live in `auth`, and its data access (proposals, documents) is served by `revenue` filtered to the portal caller's scope — thin enough that a dedicated package would violate `10-CLAUDE.md`'s own rule against creating one for a handful of concerns better homed elsewhere.

## 5. Event-Driven Architecture

Not every interaction needs to be synchronous request/response. Domain events drive cross-module reactions without tightly coupling modules to each other:

- **Emission**: the domain-state write and the outbox row write happen inside the same Postgres transaction (a single database function/RPC call, not two separate round-trips from application code) — this is what makes "at-least-once delivery tied to the same transaction that made the state change" actually true rather than aspirational. A naive dual-write from application code (write the domain row, then separately write the outbox row) does not have this guarantee and is explicitly not how this is implemented.
- **Schema**: every outbox row carries `event_type`, `event_version`, `organization_id`, `payload`, `created_at`, `processed_at`. The version field exists so a payload shape can change later without requiring every consumer (in-process subscribers and every n8n workflow) to update in lockstep.
- **Dispatch**: a Supabase Edge Function polls/consumes the outbox and fans events out to (a) n8n via the app's own signed-webhook-triggered API call, for anything provider-facing, and (b) in-process subscribers, for anything internal (e.g., recalculating a lead score when a new `contact_enrichment` row lands). The dispatcher marks `processed_at` only after successful fan-out and is itself idempotent on `(event_id, consumer)` pairs, so a crash between fan-out and marking-processed results in at most a harmless redelivery, not silent loss or unbounded duplication.
- **Why outbox, not direct pub/sub**: guarantees delivery tied to the same transaction that made the state change, without introducing a message broker (Kafka/SQS) that a solo-founder team doesn't need at this stage. This is revisited only if event volume or delivery-latency requirements outgrow polling.

Representative events: `contact.created`, `deal.stage_changed`, `visitor.identified`, `lead_score.recalculated`, `consent.withdrawn`, `data_subject_request.created`, `proposal.sent`, `agent_run.completed`.

**M1.7 implementation note**: the `(event_id, consumer)` idempotency this section already prescribed is realized as a real table, `event_deliveries` (`03-Database-Architecture.md` §2.10) — `events.processed_at` alone cannot express it once more than one consumer exists, since it's a single global flag, not a per-consumer one. Dispatch in M1.7 is an **in-process TS function** (`packages/database`'s `dispatchPendingEvents()`), called directly rather than by a scheduled Supabase Edge Function — the Edge Function/cron wiring described above is not yet built, and n8n fan-out is still Phase 3, per `12-Implementation-Milestones.md`'s M1.7 scope. At-least-once delivery is real, not exactly-once: a crash between a consumer's side effect succeeding and its `event_deliveries` row committing causes a redelivery on the next dispatch call, re-invoking that consumer — `event_deliveries` prevents double-*counting* once a delivery is recorded, it cannot make an arbitrary external side effect exactly-once across that specific crash window. Any consumer with a non-transactional external effect (an API call, an email send) must be idempotent on its own terms.

## 6. Technology Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Frontend framework | Next.js (App Router) | Server Components reduce client bundle for data-heavy dashboards; one framework for marketing site, product, and API routes |
| Language | TypeScript everywhere (app, packages, Edge Functions) | End-to-end type safety from DB (generated types) to UI |
| Database | Supabase Postgres | Managed Postgres + Auth + Storage + Realtime in one platform; native RLS fits the shared-schema multi-tenancy model directly |
| Vector storage | `pgvector` extension on the same Supabase Postgres instance | Powers the AI Revenue Brain's semantic search (`11-AI-Revenue-Brain.md`) without a separate vector database service. **Revisit trigger, not a permanent assumption**: HNSW index maintenance cost on a shared transactional instance grows with embedding volume (email/meeting ingestion from Phase 5 onward is the likely first pressure point) — if CRM query latency measurably degrades, the escape hatch is a dedicated vector store or a read replica carrying the `brain_embeddings` table, not re-architecting the Brain itself |
| UI components | shadcn/ui + Tailwind | Owns the component code (no black-box library), themeable via CSS variables — required for white-label |
| Automation | n8n (self-hosted) | Visual workflow authoring for anything provider-facing keeps the app provider-agnostic (ADR-002) and lets non-engineers adjust workflows later; communicates with tenant data only through the app's own API (§1) |
| AI providers | Claude (primary reasoning/agentic tool-use), OpenAI (fallback/specific tasks) | Abstracted behind a model router (`packages/ai-agents`) — never hardcoded to one vendor at the call site |
| Agent execution runtime | Queued/async execution (not inline serverless request/response) for any agent run involving more than one sequential tool call | A single Research Agent run doing multiple enrichment lookups plus a model call can plausibly exceed a serverless function's execution-time limit on day one, with a single tenant — this is a Phase 4 correctness requirement, not a later scaling concern; ships with the first agent persona, not retrofitted after a production incident |
| Observability | Structured logging (redacting secret/PII-shaped fields per `10-CLAUDE.md` §8) + an error-tracking service (e.g., Sentry) from Phase 1 | Retrofitting instrumentation onto an already-built app is materially more expensive than building it in from the start; this was previously undecided in this document, which is itself a gap for a "complete architecture" |
| Email inbox sync provider | Gmail/Outlook API, behind the `EmailProvider`-adjacent adapter interface (provisional — confirmed at Phase 5 implementation time) | Required by the AI Revenue Brain's Email Sync workflow (`11-AI-Revenue-Brain.md` §3, §9); named here so the canonical technology list doesn't omit a dependency introduced in a later document |
| Meeting transcription provider | A Zoom/Google Meet/Fireflies-class adapter (provisional — confirmed at Phase 5 implementation time) | Required by the AI Revenue Brain's Meeting Ingestion workflow; same rationale as above |
| Hosting | Vercel (app), Supabase Cloud (data), self-hosted n8n | Minimizes ops surface for a solo founder; all three have managed scaling paths |
| Payments | Stripe | Handles the platform's own agency/org billing. **Note**: if outcome-based pricing tied to agent-attributed revenue (floated as a future direction in `01-Vision.md`) is pursued, this requires Stripe's metered/usage-based billing APIs and an internal attribution-tracking mechanism — nontrivial additional scope, not a simple configuration change, and should be scoped explicitly before committing to that pricing model |

## 7. Design Patterns

- **Repository pattern** in `packages/database` — all queries go through typed repository functions, never raw Supabase client calls scattered through the app.
- **Adapter pattern** in `packages/integrations` — every external provider (email sender, enrichment API, LinkedIn, calendar, and the newly-named email-sync/meeting-transcription providers) implements a shared interface; concrete adapters are swappable without touching call sites.
- **Strategy pattern** in the lead scoring engine (`packages/intelligence`) — scoring rules are pluggable strategies (`RuleBasedScorer`, `AgentAssistedScorer`) selected per organization.
- **Orchestrator pattern** in `packages/ai-agents` — a single orchestrator routes to persona strategies rather than each persona owning its own dispatch logic.
- **Gateway pattern** in `packages/brain` — the `BrainClient` is the single entry point for context retrieval (`brain.get_entity_context`, `brain.semantic_search`); no caller queries `brain_entity_profiles`/`brain_embeddings` directly, mirroring the same discipline the RBAC facade applies to permissions.
- **Unit-of-Work pattern** for domain writes paired with outbox events (§5) — the domain-state change and its corresponding outbox row are committed as a single unit via one database function, never as two independent application-level writes. This is what makes the outbox pattern's atomicity guarantee real rather than assumed.
- **Outbox pattern** for domain events (see §5).
- **Facade pattern** for RBAC — application code calls a single `can(user, action, resource)` facade; the underlying permission matrix can be restructured without changing call sites.

## 8. Scalability Strategy

- **Horizontal**: Vercel serverless functions scale automatically per request; no in-process state that would prevent horizontal scaling.
- **Database**: Supabase Postgres scales vertically first, pooled via Supavisor from Phase 1 (§2, not deferred); read replicas introduced when agency roll-up reporting queries start contending with transactional CRM writes — not needed at MVP scale.
- **Multi-tenancy at scale**: shared-schema RLS scales to thousands of tenants on a single Postgres instance; the hybrid escape hatch (dedicated DB for a large enterprise tenant) is documented as a future option (`03-Database-Architecture.md` §6), not built until a real tenant needs it.
- **n8n**: workflows are stateless per-execution and parameterized by tenant, so scaling is a matter of increasing n8n worker concurrency, not re-architecting per tenant.
- **Agent execution correctness, not just scale**: as stated in §6, agent runs involving multiple sequential tool calls use queued/async execution from the first persona shipped — this is a day-one correctness requirement (avoiding mid-chain truncation against serverless time limits), and only becomes additionally a *scaling* concern once concurrent run volume grows. Conflating the two previously led this document to defer a correctness fix as if it were a scale optimization.
- **AI cost/latency at scale**: agent tool calls and enrichment lookups are cached/deduped at the company/contact level (not per-view).
- **Vector search at scale**: see the pgvector revisit-trigger in §6 — this is named here explicitly because embedding volume growth (Phase 5's email/meeting ingestion) is a more concrete, nearer-term scaling pressure than most of the rest of this section.
- **Caching**: Next.js data cache / Supabase Edge caching for read-heavy, low-personalization views (e.g., public marketing pages); tenant dashboards are not aggressively cached given RLS and personalization requirements.
- **Verification, not just affordance**: this section describes architectural headroom, not proof it holds — a lightweight load-testing pass against the connection-pooling and agent-execution assumptions above is worth doing before the first real batch of design-partner agencies onboards (Phase 2-3), not deferred until an incident forces it.

## Related ADRs (to be logged in `docs/adr/` as decisions are finalized)

- ADR-001: Modular monolith over microservices
- ADR-002: n8n as the provider-facing automation boundary, mediated exclusively through the app's own API (no direct database access)
- ADR-003: Shared-schema RLS over schema/database-per-tenant
- ADR-004: Direct Postgres data access over PostgREST for internal app queries — PostgREST has no visibility into the `app.current_org` session variable the tenant-context mechanism depends on (`docs/adr/ADR-004-direct-postgres-data-access.md`)
- ADR-005: Agency-level membership model — extending `memberships` with nullable `organization_id`/`agency_id` and an exactly-one-scope CHECK constraint, over a fake "home organization" or a parallel `agency_memberships` table (`docs/adr/ADR-005-agency-level-membership-model.md`)
- ADR-006: pgvector on the primary Postgres instance over a dedicated vector database, with a named revisit trigger
- ADR-007: Event schema versioning policy for the outbox
