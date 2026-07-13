# 05 — AI Agent Architecture

## 1. Shared Architecture

All agents run through a single **orchestrator** (`packages/ai-agents`), not as five bespoke integrations. The orchestrator owns: routing a trigger to the correct persona, loading shared context from the **AI Revenue Brain** plus that persona's own scoped short-term memory, executing its tool calls under RBAC, persisting the run (`agent_runs`, `agent_tool_calls`), and emitting a domain event on completion.

**Execution model — queued, not inline.** A trigger does not execute an agent run synchronously within the request that fired it. The orchestrator enqueues an `agent_runs` row (`status = queued`); a dedicated worker process picks it up, executes the tool-call loop, and updates status as it progresses (`02-Software-Architecture.md` §6, ADR-005). This is a correctness requirement, not a scaling optimization: a single Research Agent run doing several sequential tool calls plus a model call can plausibly exceed a serverless function's execution-time limit on day one, with a single tenant — running the loop in a worker rather than inline avoids a silent mid-chain kill that a request-scoped timeout can't recover gracefully from.

```
Trigger (user action, schedule, domain event)
   │
Orchestrator (enqueues, does not execute inline)
   │
   ▼
Worker (dequeues agent_runs, owns the tool-call loop)
   ├─ resolves organization_id + acting persona
   ├─ loads agent_definition (system_prompt, model_provider, model_name)
   ├─ composes the platform safety preamble + the persona's system_prompt (see below)
   ├─ queries the AI Revenue Brain for shared long-term context
   │     (brain.get_entity_context / brain.semantic_search — see 11-AI-Revenue-Brain.md)
   ├─ loads persona-scoped agent_memory (short-term working state)
   ├─ invokes model via Model Router (Claude primary, OpenAI fallback)
   ├─ executes any requested tool calls (RBAC-checked, approval-gated per tool, logged)
   ├─ persists agent_runs / agent_tool_calls (status, total_tokens, total_cost_usd, cost_usd per call)
   └─ emits domain event (agent_run.completed / .failed)
```

**Model routing**: abstracted behind a single interface so no persona hardcodes a vendor. Default: Claude for agentic/tool-use-heavy reasoning (Sales, Research, Scoring), with OpenAI available as a configured fallback. "Degraded" is a defined trigger, not a vague state: an elevated error rate or p95 latency for the primary provider over a rolling window (e.g., the last N requests or last 5 minutes, whichever the ops runbook specifies), monitored centrally rather than decided per-call — routing config itself lives in `agent_definitions.model_provider`, not in code.

**Prompt composition — tenant customization has a floor it can't go below.** `agent_definitions.system_prompt` is the tenant-customizable *voice and context* layer (brand tone, organization-specific instructions). It is never the entire prompt sent to the model: at invocation time, the worker prepends a **non-overridable platform safety preamble** — the anti-hallucination instruction, the confidence-tiering requirement, and the reminder that consequential tools operate in propose-only mode unless explicitly confirmed — composed server-side and not exposed as editable text. An organization can change how a persona sounds; it cannot use prompt customization to strip the trust guarantees this platform is built on (`01-Vision.md` Core Value #6).

**Memory — two layers, not one**: this platform previously gave each persona only its own isolated memory. That's now split deliberately in two:
- **Shared long-term context** lives in the **AI Revenue Brain** (`11-AI-Revenue-Brain.md`) — one continuously-updated view per contact/company/deal, built from every source (CRM, email, meetings, website visitors, tasks, knowledge, conversations, revenue, support, marketing), identical regardless of which persona asks. This is what makes the five personas below behave as one intelligent system instead of five isolated features.
- **Short-term working memory** (`agent_memory`) stays persona- and scope-specific, strictly `organization_id`-scoped, structured `jsonb` updated after each run — it tracks only what *this persona* is currently doing (e.g., which drafts it already proposed and were rejected), so one persona's in-progress reasoning never contaminates another's. **`agent_memory` is included in the GDPR deletion cascade** (`03-Database-Architecture.md` §2.8) — when a data subject request is fulfilled, any persona's memory scoped to the erased contact/deal is purged as part of that same cascade, not left behind as an orphaned reference.

Every persona's workflow below now begins with a Brain query, then falls back to its own `agent_memory` for run-specific state — the individual "Memory" line in each persona's section reflects this two-layer model.

**Tool layer**: a shared catalog of internal function-calling tools, each tagged with the RBAC permission it requires **and whether it requires human approval to take effect**. A tool call an agent makes is checked exactly as if a human user performed the equivalent action — an agent has no standing permission beyond what the triggering user/organization already grants. For tools marked `requires_human_approval: true`, the call itself never commits a change directly: it writes a proposed-change object (surfaced via the `AISurfaceCard` UI pattern, `07-UI-UX-System.md` §5) that a separate, human-only action must confirm before the underlying write happens. This is a property of the tool definition, not a prompt instruction the model is asked to honor voluntarily — the distinction that was previously only stated in persona prose is now mechanically enforced at the tool-execution layer.

Shared tool catalog (subset used by multiple personas):

| Tool | Permission required | Requires human approval | Description |
|---|---|---|---|
| `brain.get_entity_context` | matches underlying entity's read permission | No (read-only) | Returns the AI Revenue Brain's current structured profile for a contact/company/deal (`11-AI-Revenue-Brain.md` §5) |
| `brain.semantic_search` | matches underlying entity's read permission, results filtered to caller scope | No (read-only) | Vector similarity search across all ingested content (emails, meetings, chat, knowledge docs) |
| `brain.get_relationship_timeline` | matches underlying entity's read permission | No (read-only) | Chronological cross-source view (emails + meetings + activities + deal changes) for one entity (`11-AI-Revenue-Brain.md` §5) |
| `crm.get_contact` | `contacts:read` | No (read-only) | Read CRM contact records |
| `crm.update_contact` | `contacts:write` | No — routine field updates (e.g., enrichment-derived fields) apply directly; reserved for non-consequential updates only | Update CRM contact records |
| `crm.get_deal` | `deals:read` | No (read-only) | Read deal state |
| `crm.propose_deal_stage_change` | `deals:write` | **Yes** | Writes a proposed stage change visible to the deal owner as a `pending_review` `AISurfaceCard`; the deal's actual `stage_id` is only updated by a separate, human-triggered confirm action — replaces the previous ambiguous `crm.update_deal_stage`, which was described in prose as "proposal only" without a mechanism to enforce it |
| `enrichment.lookup_company` / `enrichment.lookup_contact` | `enrichment:read` | No (read-only, though it triggers a paid provider call — cost-tracked, see §8) | Triggers the provider-agnostic enrichment adapter (via n8n) |
| `email.draft` | `email:draft` | No (produces a draft, not a send) | Drafts an email/message, always persisted as `pending_review` |
| `email.send` | `email:send` | **Yes** | A separate, stricter grant from drafting; never invoked by a persona directly — only by the human action that confirms a draft |
| `calendar.propose_meeting` | `calendar:write` | **Yes** | Proposes times; booking requires explicit confirmation |
| `scoring.recompute` | `scoring:write` | No — see Scoring Agent's own sanity-bound guard below, which is a different, narrower safety mechanism than a full approval gate | Triggers a new `lead_scores` row |
| `proposal.generate_draft` | `proposals:write` | No (produces a draft, not a sent proposal) | Generates a draft proposal from deal data |

## 2. Sales Agent

- **Purpose**: draft follow-ups, prepare for upcoming meetings, and recommend next actions on open deals — accelerating rep response time without auto-sending anything customer-facing unsupervised.
- **Inputs**: triggering event (`deal.stage_changed`, `activity.due_soon`, or explicit user request "draft a follow-up"), the deal's Brain entity profile (cross-source: CRM state, email thread history, meeting transcripts, engagement signals — not just the CRM row), recent activity history.
- **Outputs**: a drafted email/message (never auto-sent — status `pending_review`), a structured "recommended next action" object (`{action, reasoning, confidence}`), optionally a proposed deal stage change (via `crm.propose_deal_stage_change`, never a direct write).
- **Prompt strategy**: the persona's `system_prompt` (composed with the non-overridable platform safety preamble, §1) constrains tone to the organization's configured brand voice (`brand_themes`-adjacent config) and requires the model to cite which CRM/Brain fields informed its recommendation (traceability, not just a plausible-sounding draft).
- **Memory**: queries the AI Revenue Brain (`brain.get_entity_context`, `brain.get_relationship_timeline`) for the deal/contact's full cross-source history first; `agent_memory` scoped to `deal_id` layers on top, tracking only this persona's own prior recommendations, so the agent doesn't repeat a suggestion already rejected by the rep.
- **Tools**: `brain.get_entity_context`, `brain.get_relationship_timeline`, `crm.get_contact`, `crm.get_deal`, `crm.propose_deal_stage_change` (approval-gated), `email.draft`, `calendar.propose_meeting` (approval-gated).
- **Workflow**: trigger → enqueued run → worker loads deal context + memory → draft via model → tool calls for any data gaps → persist draft as `pending_review` → notify assigned rep → rep approves/edits/discards → outcome recorded back into `agent_memory`.
- **Error handling**: if required CRM context is missing (e.g., no primary contact), the agent returns a `needs_input` status rather than fabricating detail; tool call failures (e.g., enrichment timeout) degrade gracefully to a draft with an explicit "data unavailable" note rather than blocking the whole run.
- **Monitoring**: acceptance rate of drafts (accepted/edited/discarded) tracked per organization as the primary quality signal, stored per-run in `agent_runs`; flagged for prompt review if acceptance rate drops below a threshold.

## 3. Marketing Agent

- **Purpose**: draft campaign content and audience segment suggestions for email/marketing workflows — content generation, not autonomous campaign execution.
- **Inputs**: campaign brief (goal, target segment, tone), relevant company/contact segment data, prior campaign performance (`email_campaigns`, `email_sends` aggregates).
- **Outputs**: draft subject lines + body copy (multiple variants for review), suggested audience segment (`scoring_rules`-compatible filter), never a scheduled send without explicit user action.
- **Prompt strategy**: brand voice consistency (shared with Sales Agent's brand config) and an explicit prohibition on fabricating statistics, case studies, or customer quotes not present in the organization's own data — enforced by the non-overridable safety preamble (§1), not solely by persona-specific instruction.
- **Memory**: queries the Brain (`brain.semantic_search`) to check which content angles/themes have already been used recently across the organization's knowledge/marketing history, avoiding repetitive campaigns; `agent_memory` scoped to `organization_id` layers its own run-to-run notes on top.
- **Tools**: `brain.semantic_search`, `crm.get_contact` (segment preview), `enrichment.lookup_company` (for account-based campaign targeting), `email.draft`.
- **Workflow**: brief received → segment/context loaded → draft variants generated → persisted as `email_campaigns` in `draft` status → marketer reviews/edits/schedules.
- **Error handling**: if the requested segment resolves to zero or a suspiciously small contact count, the agent surfaces this rather than silently drafting content for an empty audience.
- **Monitoring**: variant selection rate (which draft humans actually pick/edit vs. discard entirely) tracked to tune prompt style per organization over time.

## 4. Research Agent

- **Purpose**: synthesize enrichment data and public signals — now widened to the full Brain profile (emails, meetings, past deals, support history) — into a readable account/contact brief. This persona is, in effect, the primary *writer* of `brain_entity_profiles.summary`, not just a reader of it.
- **Inputs**: `company_id`/`contact_id`, the entity's current Brain profile and semantic search results across its embedded sources, existing enrichment records, explicit research question if provided ("are they a good fit for our mid-market plan?").
- **Outputs**: a structured brief (`{summary, fit_signals, risk_signals, suggested_talking_points}`) attached to the company/contact record and written back into `brain_entity_profiles` as the new profile version.
- **Prompt strategy**: explicitly instructed to distinguish confirmed data (from enrichment payloads and sourced Brain content) from inference ("likely," "based on company size, probably") — outputs are labeled by confidence tier, not presented as uniformly certain.
- **Memory**: reads the current `brain_entity_profiles` version to avoid re-deriving the same brief repeatedly; only regenerates when new source signal has landed since `last_computed_at` (`11-AI-Revenue-Brain.md` §6) — this persona is the mechanism behind the Brain's re-summarization step, not a separate memory consumer.
- **Tools**: `brain.get_entity_context`, `brain.semantic_search`, `enrichment.lookup_company`, `enrichment.lookup_contact`, `crm.get_deal` (for deal-specific research context).
- **Workflow**: triggered by a new deal creation, a rep's explicit request, new enrichment data, or a Brain Indexing event (`meeting.transcribed`, `email_message.received`) → checks for an existing, still-fresh brief → generates/updates brief → writes the new `brain_entity_profiles` version → emits `research.brief_updated` event (consumable by the Sales Agent for its own next draft).
- **Error handling**: if enrichment data for a company is sparse/unavailable, the agent returns an explicitly partial brief flagged `low_confidence` rather than padding the response with generic industry statements.
- **Monitoring**: enrichment-provider cost per brief generated is tracked via `agent_tool_calls.cost_usd` — a recurring unit-economics concern across this platform, also tracked at the roadmap level (`09-Development-Roadmap.md` Phase 3's cost-model validation checkpoint); staleness (briefs older than N days) flagged for refresh.

## 5. Scoring Agent

- **Purpose**: augment the deterministic rules-based lead scorer (`scoring_rules`) with qualitative judgment the rules can't express — e.g., reading a contact's role/seniority/recent activity pattern holistically rather than as isolated point values.
- **Inputs**: contact record, the contact's Brain entity profile (engagement level/sentiment already synthesized across sources), recent activity/engagement history, current rules-based score from `scoring_rules` evaluation.
- **Outputs**: an adjustment recommendation to the rules-based score (`{suggested_delta, reasoning}`), never a silent override — the final `lead_scores` row records both the rules-based component and the agent's adjustment separately for auditability.
- **Prompt strategy**: instructed to reason only from the specific fields provided in the Brain profile and activity history, explicitly forbidden from inventing engagement signals not present there — this agent's output feeds a number sales reps act on, so hallucinated justification is a direct product-trust risk.
- **Memory**: reads the contact's Brain entity profile for cross-source engagement signal; `agent_memory` scoped to `contact_id` tracks this persona's own prior scoring adjustments to detect and flag drift/inconsistency in its own reasoning over time.
- **Tools**: `brain.get_entity_context`, `crm.get_contact`, `scoring.recompute` (writes the final blended score — not approval-gated, because the output is a scoring signal visible to the rep with full breakdown, not a customer-facing or deal-committing action; see the sanity-bound guard below as the narrower safety mechanism that applies here instead).
- **Workflow**: triggered on new enrichment data, significant activity (e.g., pricing page visit), or scheduled recompute → loads rules-based score → agent proposes adjustment + reasoning → blended score written to `lead_scores` with full breakdown → no human approval gate by default, but the breakdown is always visible to the rep.
- **Error handling**: if the agent's proposed delta exceeds a configured sanity bound (e.g., ±20 points), the run is flagged for review rather than auto-applied — guards against a single bad reasoning chain swinging a score wildly.
- **Monitoring**: correlation tracked between agent-adjusted scores and actual deal outcomes (win/loss) per organization, to validate the adjustment is actually predictive over time, not just plausible-sounding.

## 6. Support/Chat Agent

- **Purpose**: the customer- and rep-facing AI Chat surface — answers questions over the organization's own CRM/portal data (not a general-purpose chatbot).
- **Inputs**: user's natural-language question, conversation thread history, the querying user's role/permission scope (portal customer vs. internal rep changes what data is answerable).
- **Outputs**: a conversational response, optionally with tool-call-derived data (e.g., "here's the status of your proposal"), always scoped to what the querying identity is authorized to see.
- **Prompt strategy**: system prompt is dynamically assembled per caller type — a portal customer's system prompt explicitly excludes any instruction or tool that could surface another customer's data or internal-only fields (deal margins, internal notes); this is enforced by which tools are even offered to the model, not by asking it nicely not to overreach.
- **Memory**: may query the Brain (`brain.get_entity_context`, `brain.semantic_search`) for the relevant contact/deal/company, filtered to the caller's permission scope at the query level (`11-AI-Revenue-Brain.md` §10) — a portal customer's queries never retrieve another customer's data or internal-only fields even via semantic search. `agent_memory` scoped to `conversation_threads` holds full thread history within a session; no persistent cross-session memory of a portal customer's private queries beyond what's needed for support continuity, consistent with data minimization.
- **Tools**: `brain.get_entity_context` and `brain.semantic_search` (permission-filtered), plus read-only tools matching the caller's role (`crm.get_contact`, `crm.get_deal` for internal reps; `proposal.get_status`, `portal_documents.list` for portal customers) — write tools are not exposed to this persona at all. **In a portal context, these tools are implemented to call exclusively through the `/api/v1/portal/*` route tree** (`04-API-Architecture.md` §2, §4), reinforcing the structural (not just permission-based) separation between portal and internal API surfaces at the tool-execution layer too.
- **Workflow**: message received → thread loaded → role-appropriate tool set resolved → model responds, calling tools as needed → response persisted to `chat_messages` → surfaced in the UI.
- **Error handling**: if a question requires data outside the caller's permission scope, the agent responds with an explicit "I can't share that" rather than a tool-call attempt that would fail silently or a fabricated answer.
- **Monitoring**: deflection rate (support questions resolved without human escalation) and a sampled human review process for portal-facing answers, given this persona is the one most likely to be seen directly by end customers.

## 7. Cross-Cutting Error Handling

- **Model/provider failure**: automatic fallback to the secondary provider configured in `agent_definitions` once the primary is flagged degraded (§1's defined trigger); if both fail, the run is marked `failed` with the triggering event preserved and requeued with backoff, not silently dropped.
- **Tool call failure**: distinguished from model failure — a tool timeout/error is surfaced to the model as a tool result (`{error: "..."}"`) so it can reason about degraded data rather than the whole run crashing.
- **Runaway loops**: every `agent_run` has a hard cap on tool-call iterations and wall-clock time, **enforced by the worker process executing the run** (§1) — not by a serverless request's own timeout, which would kill the run mid-chain with no chance to mark it `failed` cleanly. Exceeding the cap terminates the run as `failed` with reason `max_iterations_exceeded`, recorded in `agent_runs`, never left running indefinitely.
- **Unsafe output**: any persona capable of drafting customer-facing content passes through a lightweight policy check (no fabricated claims/stats, no PII leakage across tenants) before being marked `pending_review` — this is a code-level check, not solely relying on the prompt.
- **Approval-gate bypass attempts**: if a model attempts to invoke a `requires_human_approval: true` tool as if it were a direct write (e.g., malformed tool call, or a compromised/adversarial prompt), the tool executor rejects the call outright rather than downgrading it to a soft warning — the approval gate is enforced at the tool-definition level (§1), so there is no code path where this fails open.

## 8. Monitoring

- Every `agent_run` and `agent_tool_call` is persisted (see `03-Database-Architecture.md` §2.4), including `agent_runs.total_tokens`/`total_cost_usd` and `agent_tool_calls.cost_usd` — this is the baseline observability layer, queryable without a separate APM tool for MVP, and it's what actually backs the cost/monitoring claims in this section rather than describing them schema-agnostically.
- Per-organization dashboards (Phase 4+) surface: run volume, success/failure rate, average latency, acceptance rate of drafted content, and cost (tokens + tool-call provider cost) per agent persona.
- Alerting thresholds (failure rate spike, cost spike per tenant, unusually high tool-call iteration counts) are configured per persona, since a "normal" profile differs meaningfully between, e.g., the Scoring Agent (frequent, cheap, automatic) and the Marketing Agent (infrequent, more expensive, always human-reviewed).
- Brain query volume/cost (`brain.get_entity_context`, `brain.semantic_search` calls) is tracked per persona and per tenant via the same `agent_tool_calls.cost_usd` column — since every persona now queries the Brain on nearly every run, this is a meaningful line item in unit-economics tracking, not a rounding error.
- Approval-gate metrics — how often a `requires_human_approval` tool's proposed change is confirmed vs. discarded — are tracked as a distinct signal from ordinary draft-acceptance rate, since they represent a different (higher-stakes) class of agent output.
