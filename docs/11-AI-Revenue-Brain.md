# 11 — AI Revenue Brain

## 1. Concept & Purpose

Every persona in `05-AI-Agent-Architecture.md` was designed with its own scoped memory (`agent_memory`, keyed per persona + entity). That's correct for short-term working state, but it means five agents reasoning about the same contact would each rebuild their own partial picture from scratch — "isolated AI features" wearing an orchestrator as a thin coordination layer, not a genuinely unified intelligence.

The **AI Revenue Brain** is the fix: one centralized, organization-scoped intelligence layer that continuously ingests and indexes signal from every part of the platform — CRM, emails, meetings, website visitors, tasks, knowledge, conversations, customer history, revenue, support, marketing — and serves it back to every persona as shared, structured, retrievable context. Agents stop assembling their own worldview from raw tables; they query the Brain.

**Scoping decision (confirmed):** "continuously learns" means continuous retrieval-augmented context — ongoing re-indexing and re-summarization, no model weight training — as the MVP. Per-tenant fine-tuning is documented in §8 as an explicit future phase, not built now. This keeps the Brain on infrastructure the platform already has (Postgres + pgvector), rather than requiring a training/eval pipeline before any of this can ship.

## 2. Architecture Position

The Brain sits between raw data sources and the agent orchestrator — every persona's context now comes from the Brain first, with direct table access reserved for actions (writing a deal update), not for reconstructing context.

```
┌─────────────────────────────────────────────────────────────────┐
│                          Data Sources                            │
│  CRM (contacts/companies/deals/activities) · Website visitors    │
│  Email threads (inbound+outbound) · Meetings (transcripts)       │
│  Tasks · Knowledge documents · Chat/conversation messages         │
│  Revenue events · Support tickets · Marketing campaigns          │
└──────────────────────────┬────────────────────────────────────────┘
                            │  domain events (existing outbox, §5 of 02-Software-Architecture.md)
                            ▼
                 ┌────────────────────────┐
                 │   Brain Ingestion       │   (n8n workflows, §9 below —
                 │   - consent gate check  │    writes via the app's own
                 │   - DSR-in-progress     │    authenticated REST API,
                 │     check               │    using an api_keys row
                 │   - chunk + embed       │    scoped to a service role
                 │   - re-summarize entity │    (04-API-Architecture.md §3) —
                 └───────────┬─────────────┘    n8n never touches Postgres
                              ▼                  directly, here or anywhere
                 ┌────────────────────────────────────┐
                 │            Brain Storage             │
                 │  brain_entity_profiles  (structured)  │
                 │  brain_embeddings       (vector/pgvector) │
                 │  brain_knowledge_documents             │
                 │  brain_sync_state                       │
                 └───────────┬─────────────────────────┘
                              │  BrainClient (packages/brain)
                              ▼
                 ┌────────────────────────────────────┐
                 │   Queued Agent-Execution Worker       │
                 │   (02-Software-Architecture.md ADR-005) │
                 │  Sales · Marketing · Research ·      │
                 │  Scoring · Support/Chat personas      │
                 │  (each keeps thin, short-term          │
                 │   agent_memory on top of the Brain)    │
                 └────────────────────────────────────┘
```

`packages/brain` is a new package, sibling to `packages/ai-agents`, owning ingestion orchestration, storage access, and the retrieval client — `packages/ai-agents` depends on it, not the reverse. **The Brain Ingestion step is n8n calling the app's authenticated API, exactly like every other n8n workflow** — this diagram shows it as a distinct box for clarity, not because it has a different (more privileged) access path than anything else in `06-n8n-Workflow-Architecture.md`. Likewise, the Brain query a persona performs happens inside the queued worker's execution of that persona's run, not synchronously wherever "the orchestrator" is invoked — a single run's tool-call loop, including its Brain queries, is what the worker's iteration/wall-clock caps (`05-AI-Agent-Architecture.md` §7) actually bound.

## 3. Data Sources & Ingestion

| Source | Status in schema | Ingestion mechanism | Consent gate |
|---|---|---|---|
| CRM (contacts, companies, deals, activities) | Exists | Domain events (`contact.created`, `deal.stage_changed`, etc.) trigger incremental re-summarization | Covered by existing `data_processing` consent |
| Website visitors | Exists (`website_visitors`, `visitor_events`) | `visitor.identified` event triggers profile update | Gated by `cookie_tracking` consent, same as ingestion into the CRM itself (`06-n8n-Workflow-Architecture.md` §3) |
| Tasks | Exists (`activities` type=`task`) | Same as CRM | Covered by `data_processing` consent |
| Conversations / chat | Exists (`chat_messages`, `conversation_threads`) | Embedded on message creation | Covered by `data_processing` consent; portal-customer conversations gated additionally by portal terms acceptance |
| **Emails (inbound + outbound conversational)** | **New** — `email_threads`, `email_messages` (§4) | New provider integration: inbound/outbound mailbox sync (Gmail/Outlook adapter, provider-agnostic per `ADR-002`), via a new n8n Email Sync workflow | Requires an explicit, separate `email_content_processing` consent type — a higher sensitivity bar than marketing consent, since this is private correspondence content, not just send/open tracking |
| **Meetings (transcripts)** | **New** — `meetings` (§4) | New provider integration: meeting transcription (e.g., a Zoom/Meet/Fireflies-class adapter), via a new n8n Meeting Ingestion workflow | Requires explicit `meeting_recording_processing` consent recorded per meeting, ideally captured from all participants, not just the organization's own user |
| **Knowledge** (playbooks, product docs, pricing sheets) | **New** — `brain_knowledge_documents` (§4) | Direct upload by org admin, chunked/embedded on upload | Organization-owned content; no third-party personal-data consent question, but access-controlled like any other org data |
| Revenue | Exists (`revenue_events`, `deals`) | Same as CRM | Covered by `data_processing` consent |
| **Support** | **New** — `support_tickets` (§4), or existing portal `conversation_threads` where a lightweight ticket concept isn't needed yet | Same as conversations | Covered by `data_processing` consent |
| Marketing | Exists (`email_campaigns`) | Campaign performance summarized into the relevant contact/company profile | Covered by `marketing_email` consent for the underlying sends |

Ingestion is **incremental and event-driven**, not periodic full-rescans — each source has a `brain_sync_state` watermark so a re-index only processes what's new since the last successful sync.

## 4. New Schema (extends `03-Database-Architecture.md`)

### Brain storage

| Table | Key Columns | Notes |
|---|---|---|
| `brain_entity_profiles` | `id`, `organization_id`, `entity_type` (`contact`/`company`/`deal`), `entity_id`, `summary` (jsonb: `key_facts`, `engagement_level`, `sentiment`, `relationship_stage`, `open_risks`, `opportunities`), `source_refs` (jsonb array of contributing record ids), `version`, `last_computed_at` | One current row per entity |
| `brain_entity_profile_history` | `id`, `profile_id` (fk), `summary` (jsonb), `version`, `computed_at` | Append-only version history for auditability of how the Brain's view of an entity evolved (`03-Database-Architecture.md` §2.9) |
| `brain_embeddings` | `id`, `organization_id`, `source_type`, `source_id`, `entity_refs` (jsonb array `{entity_type, entity_id}`), `chunk_text`, `chunk_index`, `embedding` (`vector(1536)`, pgvector extension), `token_count`, `created_at` | Requires the `pgvector` Postgres extension enabled on the Supabase project. **Nearest-term partitioning candidate in the platform** alongside `email_messages`/`meetings`, tied to Phase 5's ingestion volume (`03-Database-Architecture.md` §4, `09-Development-Roadmap.md` Phase 5) — monitored well before the Phase 8 partitioning work itself lands |
| `brain_knowledge_documents` | `id`, `organization_id`, `title`, `source_type` (`uploaded`/`url`), `file_url`, `content_text`, `uploaded_by`, `created_at` | Chunked into `brain_embeddings` with `source_type = 'knowledge_document'` |
| `brain_sync_state` | `id`, `organization_id`, `source_type`, `external_cursor`, `last_synced_at`, `status` | Drives incremental ingestion per source, per tenant |

### New raw source tables

| Table | Key Columns | Notes |
|---|---|---|
| `email_threads` | `id`, `organization_id`, `contact_id` (fk, nullable), `subject`, `provider`, `external_thread_id`, `participants` (jsonb), `last_message_at` | Distinct from `email_campaigns`/`email_sends` (marketing sends) — this is two-way conversational email |
| `email_messages` | `id`, `thread_id` (fk), `organization_id`, `direction` (`inbound`/`outbound`), `from_address`, `to_addresses` (jsonb), `body_text`, `sent_at`, `external_message_id`, `consent_checked` (bool) | `consent_checked` is a hard gate the ingestion workflow evaluates before this row is ever embedded into `brain_embeddings` |
| `meetings` | `id`, `organization_id`, `related_to_type`, `related_to_id`, `provider`, `external_meeting_id`, `title`, `started_at`, `ended_at`, `participants` (jsonb), `transcript_text`, `recording_url`, `consent_checked` (bool) | Same consent-gate discipline as email |
| `support_tickets` | `id`, `organization_id`, `contact_id` (fk), `subject`, `status` (`open`/`pending`/`resolved`), `channel` (`portal_chat`/`email`), `created_at`, `resolved_at` | Lightweight; may fold into `conversation_threads` if a full ticketing model proves unnecessary once built |

RLS applies to every table above identically to the rest of the platform — `organization_id`-scoped policies, no exceptions for Brain tables (`03-Database-Architecture.md` §5).

## 5. Retrieval Interface

`packages/brain` exposes a single client consumed by the agent tool layer — personas never query `brain_entity_profiles`/`brain_embeddings` directly, they call tools:

| Tool | Description | Permission required | Requires human approval |
|---|---|---|---|
| `brain.get_entity_context(entity_type, entity_id)` | Returns the current structured profile summary for a contact/company/deal | Matches the underlying entity's read permission (`contacts:read`, `deals:read`, etc.) | No (read-only) |
| `brain.semantic_search(query, filters)` | Vector similarity search across embeddings, filtered by `entity_refs`/`source_type`/date range | Same as above; results are filtered post-query to the caller's permission scope (a portal customer's semantic search never surfaces internal notes or other customers' emails) | No (read-only) |
| `brain.get_relationship_timeline(entity_type, entity_id)` | Chronological cross-source view (emails + meetings + activities + deal changes) for one entity | Same | No (read-only) |

This is the same discipline already established in `05-AI-Agent-Architecture.md` §1: a tool call is checked exactly as if the calling persona's underlying user performed the equivalent read, and every tool — Brain tools included — declares its approval-gate status explicitly rather than leaving it implicit. **All three Brain tools belong in `05`'s shared tool catalog table**, matching this one exactly — `brain.get_relationship_timeline` in particular is used throughout `05`'s persona descriptions (e.g., the Sales Agent) but needs its own row there, not just here.

## 6. Continuous Learning Loop

- **Re-summarization** (`brain_entity_profiles`): triggered by domain events (new email in a thread, deal stage change, new meeting transcript) — not a blanket scheduled rebuild of every entity. A lightweight summarization call (not a full persona run) regenerates the affected entity's `summary` jsonb and increments `version`.
- **Embedding**: new content (email message, meeting transcript, chat message, knowledge document) is chunked and embedded at ingestion time, appended to `brain_embeddings` — embeddings are never regenerated for unchanged content, only added incrementally.
- **Staleness handling**: `brain_entity_profiles.last_computed_at` older than a configured threshold relative to new unprocessed source events triggers a catch-up re-summarization job, so a backlog (e.g., after a bulk CRM import) doesn't leave profiles silently stale indefinitely.
- **No model training in this phase** — every step above is retrieval/summarization against a general-purpose model (the same model router from `05-AI-Agent-Architecture.md`), not a tenant-specific trained artifact.

## 7. Relationship to Persona Memory

- **Brain = shared long-term truth.** What is known about a contact/company/deal across every source, available identically to whichever persona asks.
- **`agent_memory` (per `05-AI-Agent-Architecture.md`, now also scoped to `company` in addition to `contact`/`deal`/`organization` — a small schema addition since this document was first written, not a change in kind) = short-term working state.** What this specific persona is currently doing with that context — e.g., the Sales Agent's memory of which follow-up drafts it already proposed and were rejected, so it doesn't repeat itself. This stays persona- and run-scoped precisely because that isolation is what keeps one persona's in-progress reasoning from contaminating another's.
- A persona's context-assembly step, on every run, is now: **query the Brain for shared context → load its own `agent_memory` for short-term state → reason → act.** Neither layer replaces the other.

## 8. Fine-Tuning (Future Phase, Not Built Now)

Documented here so the door is explicitly open without committing infrastructure prematurely:

- **Trigger to revisit**: once a tenant (or the platform in aggregate) has enough volume and history that a fine-tuned model would measurably outperform retrieval-augmented prompting on a specific, measured task (e.g., email tone-matching for a specific organization's brand voice).
- **What would be required**: a training data export pipeline (drawing from `brain_embeddings`/`brain_entity_profiles` with explicit consent re-verification), a versioned model artifact store, and — critically — a GDPR-compatible deletion story, since "delete my data from a trained model" is not solvable by deleting a database row. The realistic mitigation path (documented, not built) is per-tenant LoRA-style adapters that can be discarded and retrained, rather than a single fine-tuned base model blending multiple tenants' data.
- **Not a Phase 4 concern.** This is explicitly sequenced into `09-Development-Roadmap.md` Phase 8 (Scale) at the earliest, and only if the retrieval-based Brain's measured output quality actually plateaus below what the business needs — not built speculatively ahead of that evidence.

## 9. New n8n Workflows (extends `06-n8n-Workflow-Architecture.md`)

| Workflow | Trigger | Summary |
|---|---|---|
| **Email Sync** | Scheduled (poll) or provider push webhook | Syncs new inbound/outbound messages from the connected mailbox via the email adapter, writes `email_threads`/`email_messages`, checks `email_content_processing` consent before marking `consent_checked = true`, emits `email_message.received`. Cost recorded on `workflow_runs.cost_usd` (`06-n8n-Workflow-Architecture.md` §10), since this runs on a schedule/webhook, not as an agent tool call |
| **Meeting Ingestion** | Provider webhook (transcription complete) | Retrieves transcript/recording reference from the meeting provider, writes `meetings`, checks `meeting_recording_processing` consent, emits `meeting.transcribed`. Same `workflow_runs.cost_usd` tracking as Email Sync |
| **Brain Indexing** | Any of: `contact.created`, `deal.stage_changed`, `email_message.received`, `meeting.transcribed`, `activity.completed`, `visitor.identified`, knowledge document upload | Consent-gate check → chunk + embed new content into `brain_embeddings` → trigger re-summarization of affected `brain_entity_profiles` rows |
| **Knowledge Document Ingestion** | Document uploaded via UI | Chunks and embeds an org-uploaded knowledge document, no consent gate needed (org-owned content, not third-party personal data) |

All four follow the existing cross-workflow conventions (idempotency, tenant parameterization, `workflow_runs` observability) defined in `06-n8n-Workflow-Architecture.md` §14, **including the deletion-in-progress check**: Email Sync, Meeting Ingestion, and Brain Indexing all skip ingesting *new* content about a subject with an open `data_subject_requests` deletion, not just skip sending to them — ingesting fresh personal data about someone mid-erasure runs directly against the point of the request, not merely a race condition to avoid.

## 10. Privacy & Compliance Impact (extends `08-Security.md`)

The Brain is, by construction, the single largest aggregation of personal data in the platform — it exists specifically to combine signal that was previously scattered across isolated tables. This raises the compliance bar accordingly:

- **New consent types required**: `email_content_processing` and `meeting_recording_processing`, distinct from and stricter than the existing `marketing_email`/`cookie_tracking`/`data_processing` types (`08-Security.md` §5) — ingestion workflows hard-gate on these, not just the general `data_processing` consent, since correspondence and recorded conversation content is materially more sensitive than CRM field data.
- **Deletion cascade extended**: `data_subject_requests` orchestration (`08-Security.md` §5) must now also purge/anonymize `brain_entity_profiles`, `brain_entity_profile_history`, `brain_embeddings` (all chunks referencing the subject via `entity_refs`), `email_messages`, and `meetings` involving the subject — this is a Phase 4 schema addition to the existing cascade, not deferred.
- **Retention policies extended**: `data_retention_policies` needs entries for `email_messages`, `meetings` (transcripts/recordings are often the most sensitive artifact in the entire platform and should have the shortest justified retention), and `brain_embeddings`.
- **Third-party processor agreements**: the email provider (Gmail/Outlook API) and meeting transcription provider both require Data Processing Addendums before integration, per the existing procurement gate in `08-Security.md` §5 — these are new processors, not covered by existing agreements with the enrichment/ESP providers. They're also new third-party attack surface in their own right — both fall under the dependency-scanning and vendor-security-review practices in `08-Security.md` §10, not just the compliance procurement gate.
- **Cross-tenant isolation risk is elevated, not just repeated**: because the Brain is the system that makes connections across sources, a single scoping bug here (e.g., a semantic search query missing an `organization_id` filter) has a larger blast radius than a bug in any single-source table — `brain.semantic_search` results are filtered on `organization_id` at the query level *and* re-checked at the application layer before being returned to a persona, as defense-in-depth specifically for this reason.

## 11. Rollout Sequencing (extends `09-Development-Roadmap.md`)

The Brain is not a separate phase — it's built as the foundation of **Phase 4 (AI Agents)**, using only the sources that already exist in the schema at that point (CRM, website visitors, tasks, conversations, knowledge documents uploaded manually). Email and Meeting ingestion are incremental connectors added in **Phase 5 (Automations)**, once the n8n operating pattern for external provider sync is already proven (Lead Enrichment, Email Automation). Fine-tuning (§8) is deferred to **Phase 8 (Scale)** and only pursued if retrieval-based quality plateaus.
