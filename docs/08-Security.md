# 08 — Security

## 1. Authentication

- **Staff/product users**: Supabase Auth (email/password + OAuth providers as configured), session JWTs short-lived with refresh rotation. Email confirmation is required before a session is usable — `create_organization_with_owner()` grants `org_admin` at signup time, so an unconfirmed address must never be enough to act with that role (M1.3, config-as-code in `packages/database/supabase/config.toml`'s `[auth.email]`). Password policy: minimum 8 characters, must include lower+upper+digit (`minimum_password_length`/`password_requirements` in the same file) — a deliberate, reviewed value, not the CLI's weaker default. MFA (TOTP) available at the organization level, required for `agency_owner`/`agency_admin` roles once available (Phase 8 enterprise hardening; not an MVP blocker per the SOC2 deferral).
- **Portal users**: separate magic-link authentication flow, issuing a JWT scoped exclusively to portal permissions — structurally unable to authenticate into the internal product, not merely permission-gated (`04-API-Architecture.md` §3).
- **API keys**: hashed at rest (never stored or logged in plaintext), prefixed by environment (`arev_live_`/`arev_test_`) for operator clarity, individually revocable, scoped to one organization and an explicit permission subset.
- **Service-to-service (n8n → API)**: n8n uses the same `api_keys` mechanism as any external integrator, scoped to a `service` role and issued per workflow (`04-API-Architecture.md` §3) — one credential primitive across every caller type, not a separate, undocumented mechanism.
- **Brute-force protection**: login attempts are rate-limited per account and per source IP, with progressive backoff and an account-lockout threshold after repeated failures — a standard control that applies independently of the API-level rate limiting in `04-API-Architecture.md` §6, which governs authenticated request volume, not login attempts themselves.

## 2. Authorization

Three pillars, not two:

- **RBAC** (§3) and **Postgres RLS** as defense-in-depth beneath the application-layer `can(actor, action, resource)` facade (`02-Software-Architecture.md` §7, `03-Database-Architecture.md` §5) — neither layer alone is trusted as sufficient; a bug in one is caught by the other.
- **Tenant context resolution**: `organization_id` is never accepted as a client-supplied parameter. Concretely, every request — JWT session, API key, or n8n service credential alike — resolves to an authorized organization via a single request-scoped Postgres session setting, populated once by API middleware at the start of each request (`03-Database-Architecture.md` §5). This is what prevents tenant-spoofing, and it's also what makes an agency user's context switch between client organizations take effect immediately, rather than waiting on a stale JWT claim.
- **RLS policies require base table grants to actually take effect**: a table with RLS enabled but no `GRANT` for the `authenticated`/`anon` roles fails closed with a permission error rather than an RLS denial — verified during M1.2's isolation testing, not assumed (ADR-003). Both layers — grant and policy — are required together; neither alone is the enforcement mechanism.
- **Agent approval gating**: a third, AI-specific authorization pillar alongside RBAC and RLS. Tools an AI agent can call are tagged `requires_human_approval: true/false` (`05-AI-Agent-Architecture.md` §1); for `true` tools (a proposed deal-stage change, a proposed meeting time, sending an email), the tool call never commits the underlying write directly — it produces a proposal object that only a separate, human-only action can confirm. This is enforced at the tool-execution layer, not by prompting the model to ask first, and it exists specifically so an agent's standing permission grant (RBAC) is never sufficient on its own to take a consequential action without a human in the loop.
- Agency cross-org access is implemented only through explicit, named `agency_rollup_*` views — never a generic bypass flag checked ad hoc in application code (`03-Database-Architecture.md` §5).

## 3. RBAC

| Role | Scope | Representative permissions |
|---|---|---|
| `agency_owner` | Agency-wide | Full control: billing, branding, all client orgs, user management |
| `agency_admin` | Agency-wide | Manage client orgs and branding; no billing/plan changes |
| `org_admin` | Single organization | Full control within their org: CRM, agents, automations, users |
| `org_member` | Single organization | CRM read/write per assignment; cannot manage users, billing, or org settings |
| `org_viewer` | Single organization | Read-only across CRM/reports; no write actions |
| `portal_customer` | Own portal scope only | Proposal/document/status visibility, scoped chat — no CRM access whatsoever |

- Permission checks are resource + action pairs (`contacts:read`, `contacts:write`, `deals:write`, `proposals:send`, `agents:trigger`, `settings:billing`), not coarse role checks scattered through the codebase — the RBAC facade (`can(actor, action, resource)`) is the single place this matrix is evaluated.
- AI agents carry no standing permission beyond what the triggering user/organization context already grants — a tool call an agent makes is checked identically to the equivalent human action (`05-AI-Agent-Architecture.md` §1), **and consequential tools additionally require the human-approval gate described in §2** — RBAC scoping and approval gating are independent controls, both required where applicable, not substitutes for each other.
- API keys carry their own scoped permission subset independent of the issuing user's role, so a key can be handed to a third party without over-granting.

## 4. Encryption

- **In transit**: TLS everywhere (Vercel, Supabase, n8n instance, all provider calls) — no unencrypted internal traffic, including app-to-n8n webhook calls.
- **At rest**: Supabase-managed encryption at the storage layer for the full database and Storage buckets, plus **column-level encryption** (pgsodium/pgcrypto) for the highest-sensitivity fields specifically: `integration_connections.credentials_encrypted`, `api_keys.key_hash`, any stored OAuth tokens, and — with the AI Revenue Brain — `meetings.transcript_text`/`recording_url` and `email_messages.body_text`, given these are raw correspondence/recording content rather than structured CRM fields. These remain encrypted even from a database dump or a compromised read-replica — not just relying on disk-level encryption.
- **Secrets management**: all provider API keys, signing secrets, and service credentials live in Vercel/Supabase environment secret stores — never committed to the repository, never present in client-side bundles, never logged in plaintext (structured logging redacts known secret-shaped fields).
- **Key rotation**: encryption keys and provider credentials are rotatable without a schema change or downtime — `integration_connections` supports re-encryption in place, keyed by a versioned key reference.

## 5. GDPR

- **Consent management**: `consent_records` is append-only (a withdrawal is a new row, never an update to the prior grant), covering `marketing_email`, `cookie_tracking`, `data_processing`, and — as of the AI Revenue Brain (`11-AI-Revenue-Brain.md`) — `email_content_processing` and `meeting_recording_processing` as distinct, stricter consent types, all tracked independently. A contact can withdraw marketing consent while data processing for CRM purposes continues under legitimate interest, or withdraw email/meeting content processing specifically while still being a normal CRM contact — the Brain's ingestion workflows (`06-n8n-Workflow-Architecture.md` §10-13) hard-gate on these per-source consent types, not a single blanket flag.
- **Data Subject Access/Export/Deletion Requests — hard deletion, never the ordinary soft-delete**: `data_subject_requests` drives an orchestrated job that cascades across every domain holding personal data — CRM (contacts, activities, notes), Intelligence (visitor records, enrichment, scores), AI (agent memory, chat messages, conversation threads), Automation (email sends, LinkedIn task records) — with a 30-day SLA timer and audit trail of completion. **This is categorically distinct from the `deleted_at` soft-delete used for ordinary, recoverable, user-initiated deletion elsewhere in the platform** (`03-Database-Architecture.md`'s deletion model): a completed deletion request always performs actual hard deletion of the row, or irreversible anonymization of personal-data columns where the row must survive for referential/audit reasons. A `deleted_at` timestamp on a contact does not, by itself, satisfy an erasure obligation — the data is still physically present. **The AI Revenue Brain extends this cascade further**, since it is the platform's single largest aggregation of personal data by design: a deletion request must also purge/anonymize `brain_entity_profiles`, `brain_entity_profile_history`, every `brain_embeddings` chunk referencing the subject via `entity_refs`, `email_messages`, and `meetings` involving the subject (`11-AI-Revenue-Brain.md` §10). This cascade is a Phase 1 primitive (`09-Development-Roadmap.md`) extended in Phase 4 as the Brain ships — not a script retrofitted onto live data later.
- **Data minimization**: enrichment and visitor-tracking data is stored only as long as `data_retention_policies` specifies per data type; the Support/Chat Agent explicitly avoids persisting cross-session memory of portal customer queries beyond support continuity needs (`05-AI-Agent-Architecture.md` §6). Meeting transcripts/recordings — likely the most sensitive artifact in the entire platform — get the shortest justified retention period of any data type, reviewed explicitly rather than defaulting to the platform's general retention window.
- **Data residency**: Supabase project hosted in an EU region given the EU customer base — avoids cross-border transfer complications for the majority of expected personal data.
- **Processor agreements**: every third-party processor touching personal data (email provider, enrichment provider, AI model providers, and — new with the Brain — the email inbox sync provider and meeting transcription provider) must have a Data Processing Addendum in place before integration; this is a procurement gate, not just an engineering concern, tracked in `docs/adr/` or a dedicated vendor register as the vendor list solidifies.
- **Right to rectification**: standard CRM edit flows satisfy this for contact-controlled data; portal users get a self-service profile edit as part of the Customer Portal (Phase 6).
- **Aggregation risk**: because the Brain's entire purpose is connecting signal across sources, a single tenant-scoping bug in its retrieval path (e.g., a semantic search missing an `organization_id` filter) has a larger blast radius than an equivalent bug anywhere else in the platform. `brain.semantic_search` results are filtered by `organization_id` at the query level *and* re-checked at the application layer before being returned to any persona — explicit defense-in-depth for this specific risk (`11-AI-Revenue-Brain.md` §10).

## 6. Audit Logs

- `audit_logs` is append-only — no `updated_at`/`deleted_at`, entries are never mutated after creation, satisfying both security-audit and GDPR accountability requirements simultaneously.
- Logged actions include: authentication events (login, MFA challenge, API key creation/revocation), permission changes (role/membership changes), all `data_subject_requests` lifecycle transitions, agency roll-up view access, **agent approval-gate resolutions (a proposed action confirmed or discarded, and by whom)**, and any write action tagged as sensitive (deal amount changes, proposal sends, consent withdrawals).
- Each entry captures actor, action, resource type/id, before/after state (jsonb), IP address, and timestamp — sufficient to reconstruct "who did what, when, and what changed" without needing to correlate across multiple systems.
- Audit logs are themselves tenant-scoped (`organization_id`) for tenant-visible history (e.g., an org admin reviewing their own team's activity) but also queryable at the platform level for security investigations, via a separate, explicitly-audited platform-operator access path.

## 7. Secrets Management

- Environment secrets (API keys, DB service-role credentials, signing secrets) stored in Vercel Environment Variables and Supabase Vault — scoped per environment (dev/staging/prod), never shared across environments.
- No secret is ever committed to the repository; `.env.example` documents required variable names with placeholder values only.
- CI/CD pipelines inject secrets at build/deploy time from the platform's secret store, not from repository configuration files.
- Access to production secrets is limited to the minimum set of people/systems that require it; as the team grows beyond the solo-founder phase, this becomes a formally reviewed access list rather than implicit trust.

## 8. Backup Strategy

- **Database**: Supabase automated daily backups with point-in-time recovery (PITR) enabled once on a plan that supports it — target RPO (recovery point objective) of under 24 hours at MVP, tightening to PITR-level (minutes) as the platform carries paying-customer data.
- **Storage** (proposal PDFs, uploaded documents, brand assets): replicated per Supabase Storage's underlying durability guarantees; critical generated artifacts (sent proposals) are also referenced by immutable URL so a regenerate-on-demand path exists independent of backup restore.
- **Workflow definitions**: n8n workflow JSON exports are version-controlled in the monorepo (`workflows/`), so the automation layer itself is recoverable from git independent of the running n8n instance's own state.
- **Backup verification**: periodic restore drills (initially manual, automated once release cadence justifies it) to confirm backups are actually restorable, not just "backups exist."

## 9. Disaster Recovery

- **Defined tiers**: full regional Supabase/Vercel outage (low likelihood, vendor-managed failover) vs. data corruption/accidental deletion (higher likelihood, requires our own runbook) vs. n8n instance failure (automation-only outage, core CRM remains available since n8n is not on the read/write critical path for core CRM data).
- **In-flight agent runs**: because agent execution is queued/worker-based, not inline (`02-Software-Architecture.md` ADR-005), an `agent_runs` row's state (`queued`/`running`, plus its `agent_tool_calls` history) is durably persisted in Postgres, not held only in an ephemeral process — a worker crash or restart resumes or cleanly re-queues an in-flight run from its last persisted state rather than losing it silently.
- **RTO/RPO targets** (MVP-stage, revisited as the customer base grows): RTO (recovery time objective) of a few hours for a full platform outage; RPO aligned to the backup cadence in §8.
- **Runbooks**: documented recovery steps for the most likely failure modes (accidental tenant data deletion via `data_subject_requests` misconfiguration, n8n instance crash, provider API outage cascading into stuck `workflow_runs`) — maintained in `docs/runbooks/` as they're written, not left as tribal knowledge. First one written: `docs/runbooks/auth-users-reconciliation.md` (M1.3) — detection/remediation if `auth.users` and `public.users` ever diverge, though the sync trigger's atomicity and the FK's `on delete cascade` make this structurally unlikely outside manual DB intervention.
- **Graceful degradation**: because n8n is architecturally isolated (`02-Software-Architecture.md`), an n8n outage degrades to "automation/enrichment/email paused" rather than taking down core CRM read/write functionality — this isolation is itself a DR strategy, not just a modularity choice.
- **Incident communication**: tenant-facing status communication (in-app banner + status page, introduced once customer count justifies the overhead) so agencies can inform their own end clients during an incident rather than being blindsided.

## 10. Vulnerability Management

- **Dependency scanning**: automated dependency/supply-chain vulnerability scanning (e.g., Dependabot or equivalent) runs in CI from Phase 1 — cheap to set up early, expensive to retrofit onto an already-large dependency tree later.
- **Disclosure policy**: a lightweight, published vulnerability disclosure policy (a security contact and a stated response-time commitment) exists from the point the platform has its first real external users — not deferred to enterprise-readiness, since a disclosure channel costs little to stand up and its absence is itself a bad signal to a security-conscious prospect.
- **Penetration testing**: a formal third-party penetration test is a Phase 7 (Enterprise) milestone, ahead of the first enterprise contract or SOC2 readiness push — consistent with SOC2 itself being a stated future milestone, not an MVP blocker, but named here explicitly so it isn't lost track of.
