# 06 — n8n Workflow Architecture

## 1. Operating Model

- One shared, self-hosted n8n instance serves all tenants. Every workflow is parameterized by `organization_id` (and `agency_id` where relevant) — there is no per-tenant workflow duplication.
- n8n has **no direct Postgres access**. It reads/writes tenant data exclusively through the platform's own authenticated REST API (`04-API-Architecture.md` §8), using an `api_keys` row scoped to a `service` role, issued per workflow (`04-API-Architecture.md` §3) — the same credential primitive any external integrator uses, not a separate undocumented mechanism. This is what keeps the core platform provider-agnostic: n8n is treated as just another API consumer, not a privileged internal system.
- Every workflow run is tracked in `workflow_runs` (status, timestamps, error, `cost_usd`) so a tenant-visible "automation history" exists without needing to expose the n8n UI itself to tenants. **`cost_usd` matters here specifically because several workflows (Lead Enrichment, Email Sync, Meeting Ingestion) can be triggered directly — by a UI action or a schedule, not only by an agent** — provider cost incurred that way has no `agent_tool_calls` row to live in, so `workflow_runs` carries its own cost field to keep unit-economics tracking complete regardless of trigger path.
- Credentials for third-party providers (email sender, enrichment API, LinkedIn) are stored encrypted in `integration_connections` and injected into the workflow at execution time — never hardcoded into a workflow definition, so credentials can be rotated without editing workflows.
- Workflow definitions are exported as JSON and version-controlled under `workflows/` in the monorepo — n8n's UI is the authoring tool, git is the source of truth.
- **Deletion-in-progress check**: before any workflow executes a send or write action targeting a specific contact/company (an email send, a LinkedIn task, an automation rule action), it checks for an open `data_subject_requests` deletion in progress for that subject and skips the action if one exists — closing the narrow race condition between an in-flight automated action and an erasure request that was otherwise unaddressed.

## 2. Workflow: Lead Enrichment

- **Current state note (Milestone 3.3, AI Revenue OS side shipped; the n8n workflow itself remains a later sub-phase)**: as of Milestone 3.3, everything on the AI Revenue OS side of this workflow is real — the trigger, the schema, and the write-back endpoint — but the actual n8n workflow (the provider call, its authoring/JSON) is **not yet built**, per the accepted architecture's own explicit deferral (provider selection and provider-specific integration are a later n8n workflow-authoring sub-phase). Concretely, today: the **real, firing trigger is `visitor.identified`** (Milestone 3.2), not `contact.created`/`company.created` — neither of those events is emitted by any domain code in this repository yet, so they remain the eventual, not-yet-wired alternate triggers this section originally described. The dispatcher (`GET /api/internal/dispatch-events`, Vercel Cron every minute, `04-API-Architecture.md` §2.8) posts `{eventId, organizationId, entityType: "contact", entityId}` to an operator-configured webhook URL — `eventId` is the source event's own id, stable across every retry, meant for whatever consumes it (this workflow, once built) to deduplicate a redelivered trigger. The write-back endpoints (`POST /api/v1/contacts/{id}/enrichment`, `.../companies/{id}/enrichment`, API-key auth, `enrichment:write` scope) are live and exactly match the "`POST` result back" step below. No `enrichment.completed` event is emitted by the write-back path — that remains aspirational, not built. The retry/backoff and cache-check steps below describe **intended in-workflow (n8n-side) behavior**, not yet authored; the AI Revenue OS side's own retry model is the dispatcher's lease-based at-least-once redelivery (`03-Database-Architecture.md` §2.10), a different layer from whatever retry policy the eventual n8n workflow itself implements.
- **Milestone 3.4 note**: the same dispatcher tick that drains this workflow's `lead_enrichment` consumer also drains a second, independent consumer (`lead_scoring`) registered on the identical `visitor.identified` event — but lead scoring itself involves **no n8n workflow of any kind**, ever, by design (deterministic, rules-based, internal-only computation, `04-API-Architecture.md` §2.9). A successful enrichment write-back separately triggers its own recalculation, with a durable, cron-driven recovery sweep for a failed attempt — none of it n8n-mediated. Named here only because it shares this workflow's own dispatcher/event, not because a "Lead Scoring workflow" exists or is planned in this catalog.
- **Trigger (eventual, once `contact.created`/`company.created` are wired)**: `contact.created` or `company.created` domain event (webhook from the app); also runnable on-demand from the UI or from the Research Agent's `enrichment.lookup_company`/`lookup_contact` tool calls.
- **Steps**: receive `{organization_id, contact_id or company_id}` → check `contact_enrichment`/`company_enrichment` cache via API (skip if `expires_at` in the future, to control provider cost) → call the configured enrichment provider adapter → normalize provider payload → `POST` result back to `/api/v1/.../enrichment` → emit `enrichment.completed` event.
- **Error handling**: provider timeout/error → retry with backoff (max 3 attempts) → on final failure, mark `workflow_runs.status = failed` and leave existing (possibly stale) enrichment data untouched rather than overwriting it with a partial result.
- **Cost tracking**: when triggered by an agent, provider cost is recorded on the triggering `agent_tool_calls.cost_usd` row (`05-AI-Agent-Architecture.md` §8); when triggered directly (UI or schedule), it's recorded on `workflow_runs.cost_usd` instead — one of these two is always populated, so cost is never invisible regardless of trigger path.
- **Notes**: this workflow is what the Research Agent's `enrichment.lookup_company`/`lookup_contact` tools trigger indirectly — the agent calls the API, the API triggers this workflow if cached data is stale.

## 3. Workflow: Website Visitor Intelligence

- **Current state note (Milestone 3.1, shipped)**: as of Milestone 3.1, event ingestion is **direct and synchronous**, not n8n-mediated — `POST /track/collect` (`04-API-Architecture.md` §2, same-origin `apps/web` route, not a separate `track.<platform-domain>` subdomain) writes straight into `website_visitors`/`visitor_sessions`/`visitor_events` via `packages/intelligence`'s `ingestTrackingEvent`, inside one atomic transaction, with no n8n involvement anywhere in that path (Milestone 3.1's Approved Architecture, Decision B — `docs/13-Technical-Design-Review.md`). Consent is checked before ingestion inside that same transaction, not before "queuing" anything. The rest of this section (§3) describes the **eventual, not-yet-built** identification workflow (matching a visitor to a known contact, IP-to-company reverse lookup, `visitor.identified`) — that remains Milestone 3.2/3.3 scope, unbuilt as of Milestone 3.1's close.
- **Trigger (eventual state, once identification ships)**: `visitor_events` rows written by the direct ingestion path above, picked up by this workflow on a schedule or via a domain event, once an n8n-mediated identification step actually exists.
- **Steps**: resolve or create `website_visitors`/`visitor_sessions` record via the app's authenticated API (using the workflow's `service`-role `api_keys` credential, per §1) → attempt identification (matching known contact by form-submitted email, or IP-to-company reverse lookup via enrichment provider) → if identified, link `identified_contact_id` and emit `visitor.identified` → append `visitor_events` row.
- **Error handling**: malformed/spam events (bot traffic heuristics) are dropped at the ingestion step, not processed as a failed workflow run — this keeps `workflow_runs` meaningful rather than full of expected noise.
- **Compliance note**: this workflow only processes events for visitors where cookie/tracking consent (`consent_records`) has been granted per the organization's configured consent requirement — the ingestion endpoint checks consent status before persisting any event, per the current-state note above.

## 4. Workflow: CRM Automation

- **Trigger**: `deal.stage_changed`, `activity.completed`, or scheduled (e.g., "deal stale for 14 days") events.
- **Steps**: evaluate organization-configured automation rules (e.g., "when deal enters Negotiation, create a follow-up task" or "when deal stale > 14 days, notify owner") → perform the configured action via API (`activities.create`, `notifications.send`).
- **Error handling**: a single rule failing does not block evaluation of other rules in the same run — each rule executes as an independent branch with its own error capture.
- **Notes**: this is the general-purpose "if this, then that" automation layer tenants configure themselves via the in-product workflow builder (Phase 5) — distinct from the AI agents, which reason rather than follow fixed rules, and therefore doesn't need the `requires_human_approval` tool-gating machinery from `05-AI-Agent-Architecture.md` §1: a tenant-authored deterministic rule already *is* the human's prior authorization for the action it takes.

## 5. Workflow: Email Automation

- **Trigger**: `email_campaigns` scheduled send time reached, or sequence step due.
- **Steps**: resolve audience segment → for each contact, check consent (`consent_records.consent_type = marketing_email`), suppression list, and no in-progress deletion request (§1) before sending → call the configured `EmailProvider` adapter → record `email_sends` row with `provider_message_id` and `consent_verified = true` (`03-Database-Architecture.md` §2.5 — the audit field added specifically to give this workflow the same consent-auditability `email_messages`/`meetings` already have) → subsequent provider webhooks (delivered/opened/clicked/bounced/complained) update the same row via `/api/v1/webhooks/email`.
- **Error handling**: bounce/complaint webhooks automatically add the contact to a suppression list checked by all future sends from this workflow — this is enforced in the workflow, not left to manual list hygiene.
- **Notes**: deliverability-sensitive; provider adapter is swappable (ADR-002) so the platform is never locked into one ESP's pricing or deliverability reputation.

## 6. Workflow: LinkedIn Workflow

- **Trigger**: explicit user-scheduled task (`linkedin_automation_tasks` row created via UI) — never auto-triggered by another agent or workflow, given the ToS/account-risk profile. This is a structurally different, but equally rigorous, form of human-gating than the `requires_human_approval` tool mechanism in `05-AI-Agent-Architecture.md` §1: there, an agent proposes and a human confirms; here, a human schedules the action directly and no agent is in the loop at all.
- **Steps**: check organization has this feature explicitly enabled (feature flag) → check task pacing limits (rate-limited well below typical detection thresholds, configurable but defaulting conservatively) → check no in-progress deletion request for the target contact (§1) → execute via the configured `SocialAutomationProvider` adapter (a licensed/compliant third-party layer, not direct scraping) → record result and any `risk_flag` signal back to `linkedin_automation_tasks`.
- **Error handling**: any provider-reported risk signal (rate-limit warning, account restriction notice) immediately pauses all queued tasks for that organization and surfaces a prominent in-app warning — this workflow fails safe, not silently retries into further risk.
- **Notes**: this is the most isolated workflow in the platform by design (`09-Development-Roadmap.md` Phase 5 risk note) — it can be disabled entirely for an organization or removed from the platform without touching any other workflow or core app code.

## 7. Workflow: Proposal Workflow

- **Trigger**: `proposal.generate_draft` request (from UI or the Sales Agent's `proposal.generate_draft` tool call, never approval-gated since it only produces a draft — `05-AI-Agent-Architecture.md` §1) or an explicit, separate "send proposal" action.
- **Steps**: gather deal + line item data via API → render proposal (PDF generation) → store in Supabase Storage → **on send** (always a distinct, human-triggered step — never automatically chained from draft generation, regardless of whether the draft originated from a person or an agent) → deliver via configured `EmailProvider` with a tracked view link → provider/view-tracking webhooks update `proposals.status` (`sent` → `viewed` → `accepted`/`declined`) → emit `proposal.accepted`/`proposal.declined` events (which can, in turn, trigger CRM automation — e.g., auto-move deal to Closed-Won).
- **Error handling**: PDF rendering failure retries once, then surfaces the failure to the creating user directly rather than silently leaving a `draft` proposal stuck.

## 8. Workflow: Customer Onboarding

- **Trigger**: new `organizations` row created (agency onboards a new client) or new `portal_users` invited.
- **Steps**: provision default `pipelines`/`pipeline_stages` and `scoring_rules` from the agency's template configuration → apply the agency's `brand_themes` to the new organization by default → send welcome email (org admin) or portal invite email (portal user) via `EmailProvider` → create an onboarding checklist record surfaced in the product.
- **Error handling**: partial provisioning failure (e.g., default pipeline created but welcome email failed) does not roll back the successful steps — each step is independently retryable, tracked so the agency admin can see exactly what's outstanding rather than facing an opaque "onboarding failed."
- **Notes**: this workflow is what makes the agency white-label motion operationally real — an agency should be able to onboard a new client org in minutes without engineering involvement.

## 9. Workflow: Reporting Workflow

- **Trigger**: scheduled (daily/weekly/monthly per organization preference).
- **Steps**: aggregate `revenue_events`, `deals`, `agent_runs` (including `total_cost_usd`, for tenants who want AI cost visibility alongside revenue metrics), `email_sends` for the period via API → render a summary (in-app dashboard data refresh + optional emailed digest) → for agencies, additionally aggregate across their client organizations via the explicit `agency_rollup_*` views (never a blanket cross-org query).
- **Error handling**: a failure aggregating one organization's data does not block other organizations' reports in the same scheduled run — each tenant's report is an independent branch.
- **Notes**: this is also the natural home for scheduled `data_retention_policies` purge jobs to be triggered from, keeping all scheduled/batch operations in one predictable workflow category rather than scattered across ad hoc cron jobs.

## 10. Workflow: Email Sync (AI Revenue Brain source)

- **Trigger**: scheduled poll or provider push webhook from the connected mailbox (Gmail/Outlook adapter).
- **Steps**: fetch new inbound/outbound messages since `brain_sync_state.external_cursor` → write `email_threads`/`email_messages` via API → check `email_content_processing` consent for the associated contact before setting `consent_checked = true` → emit `email_message.received`.
- **Error handling**: a message that fails the consent check is persisted with `consent_checked = false` and excluded from Brain ingestion entirely — it is not silently dropped from `email_messages` (needed for the thread to render coherently in the UI), only from the Brain indexing pipeline.
- **Cost tracking**: recorded on `workflow_runs.cost_usd` (§1), since this workflow runs on a schedule/webhook, not as an agent tool call.
- **Notes**: full design context in `11-AI-Revenue-Brain.md` §3, §9. This is a new provider integration (not previously in scope) and follows the same provider-agnostic adapter pattern as every other external connector (`ADR-002`).

## 11. Workflow: Meeting Ingestion (AI Revenue Brain source)

- **Trigger**: provider webhook fired when a meeting transcription/recording is ready (transcription provider adapter).
- **Steps**: retrieve transcript/recording reference → write `meetings` via API → check `meeting_recording_processing` consent (ideally recorded for all participants, not just the organization's own user) before setting `consent_checked = true` → emit `meeting.transcribed`.
- **Error handling**: same consent-gate discipline as Email Sync — a meeting without recorded consent is stored for the org's own reference but excluded from Brain ingestion.
- **Notes**: full design context in `11-AI-Revenue-Brain.md` §3, §9.

## 12. Workflow: Brain Indexing

- **Trigger**: any of `contact.created`, `deal.stage_changed`, `email_message.received`, `meeting.transcribed`, `activity.completed`, `visitor.identified`, or a knowledge document upload.
- **Steps**: consent-gate check (skip ingestion if the source content failed its consent check) → chunk and embed new content into `brain_embeddings` → trigger re-summarization of the affected `brain_entity_profiles` row (invokes the Research Agent's summarization path, `05-AI-Agent-Architecture.md` §4) → update `brain_sync_state`.
- **Error handling**: embedding-provider failure retries with backoff; a persistent failure leaves the prior profile version intact rather than publishing a partial/corrupt summary.
- **Notes**: this is the workflow that makes the Brain "continuous" — full design in `11-AI-Revenue-Brain.md` §6, §9.

## 13. Workflow: Knowledge Document Ingestion

- **Trigger**: a knowledge document (playbook, product doc, pricing sheet) uploaded via the UI.
- **Steps**: chunk document content → embed into `brain_embeddings` with `source_type = 'knowledge_document'` → no consent gate required (organization-owned content, not third-party personal data).
- **Error handling**: unsupported file formats or extraction failures surface directly to the uploading user rather than failing silently in the background.

## 14. Cross-Workflow Conventions

- **Idempotency**: every workflow accepts an idempotency key (or derives one from the triggering event ID) so retried webhook deliveries or duplicate triggers never double-process. **This is distinct from inbound provider-webhook deduplication**, which happens one layer up, at the app's own `/api/v1/webhooks/*` receivers via the `webhook_events_seen` table (`04-API-Architecture.md` §7) — providers call the app directly, not n8n; n8n picks up resulting work through the domain event the app emits after persisting the webhook payload, same as any other event-driven workflow in this document.
- **Tenant parameterization**: every workflow's first step resolves `organization_id` from the trigger payload and fetches that tenant's specific configuration (rules, credentials, feature flags) — no workflow logic branches on which tenant it is via hardcoded IDs.
- **Deletion-in-progress check**: any workflow about to send, message, or otherwise act on a specific contact/company checks for an open `data_subject_requests` deletion first (§1) — this is a cross-cutting convention, not repeated per-workflow above except where it changes a workflow's step order meaningfully (Email Automation, LinkedIn).
- **Observability**: every workflow run writes to `workflow_runs` (status, timestamps, error, `cost_usd`); failures beyond a configured threshold per workflow type raise an alert (see `05-AI-Agent-Architecture.md` §8 for the equivalent on the agent side — the two systems share the same monitoring philosophy).
- **Feature flags**: workflows tied to higher-risk or premium features (LinkedIn, advanced reporting) are gated by an `is_enabled` check on the tenant's `workflow_refs` row, checked at the start of every run, not just at trigger registration time.
