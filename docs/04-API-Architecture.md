# 04 — API Architecture

## 1. Design Principles

- REST over Next.js Route Handlers, resource-oriented, versioned from day one (`/api/v1/...`) — a breaking change ships as `/api/v2` alongside `v1`, never an in-place break.
- Every endpoint is tenant-scoped by default; there is no endpoint that returns data across organizations without going through the explicit agency-rollup path (see `03-Database-Architecture.md` §5).
- The API is provider-agnostic at the boundary: internal endpoints never leak which external provider (email sender, enrichment API) fulfilled a request.
- JSON in, JSON out. `snake_case` field names to match the database layer directly (no case-translation layer to maintain) — an accepted tradeoff, not a free one: this couples the public wire format to internal schema naming, so an internal rename that must not break external callers needs a deliberate compatibility shim at the route-handler level, not a global find-and-replace.
- **Error responses use one consistent envelope** across every endpoint: `{ "error": { "code": "resource_not_found", "message": "human-readable, safe to display", "request_id": "..." } }`. `code` is a stable, documented machine-readable string (never a raw exception message); `request_id` correlates a client-reported issue to server-side logs/traces.
- **Idempotency keys are supported on every mutating request** (`POST`/`PATCH`), via an `Idempotency-Key` header. A retried request with the same key against the same endpoint returns the original result rather than creating a duplicate — this is what makes a client's network retry safe, and its absence would otherwise mean a flaky connection can silently duplicate a deal or contact.
- **Pagination is cursor-based** on every list endpoint (`?cursor=...&limit=...`, default `limit=25`, max `100`), ordered by `created_at` descending unless a resource states otherwise. Offset pagination is not used, to avoid the well-known page-drift problem under concurrent writes.

## 2. Resource Map

| Resource | Path | Auth scope | Notes |
|---|---|---|---|
| Organizations | `/api/v1/organizations` | Staff (agency-scoped list; single-org detail for org-level callers) | |
| Memberships | `/api/v1/organizations/{org_id}/memberships` | Staff | Invite/manage users |
| API Keys | `/api/v1/api-keys` | Staff (`org_admin`+) | Issue, list, revoke scoped keys for the calling organization — the endpoint backing `03-Database-Architecture.md` §2.1's `api_keys` table; keys are never returned again in plaintext after creation |
| Webhook Subscriptions | `/api/v1/webhook-subscriptions` | Staff (`org_admin`+) | Register/manage outbound webhook endpoints — backs `03`'s `webhook_subscriptions` table (see §7 below) |
| Companies | `/api/v1/companies` | Staff | |
| Contacts | `/api/v1/contacts` | Staff | |
| Deals | `/api/v1/deals` | Staff | |
| Pipelines | `/api/v1/pipelines`, `/api/v1/pipelines/{id}/stages` | Staff | |
| Activities | `/api/v1/activities` | Staff | |
| Visitor Tracking Ingestion | `POST https://track.<platform-domain>/v1/collect` | **Public, unauthenticated** | A deliberately separate, minimal endpoint outside `/api/v1/*` — no session, no API key, CORS-open from any origin (it's called from a customer's own website), aggressively rate-limited per `anonymous_id`/IP rather than per tenant, and consent-checked before any event is persisted (`06-n8n-Workflow-Architecture.md` §3). Kept structurally separate from the authenticated API precisely because it has an opposite security profile — anyone on the internet can call it |
| Visitors | `/api/v1/visitors` | Staff | Read-only in this namespace; ingestion happens exclusively via the endpoint above, never here |
| Lead Scores | `/api/v1/contacts/{contact_id}/lead-scores` | Staff | Historized — returns the series, `?latest=true` for current |
| Agents | `/api/v1/agents`, `/api/v1/agents/{key}/runs` | Staff | Trigger and inspect agent runs |
| Workflows | `/api/v1/workflows`, `/api/v1/workflows/{id}/runs` | Staff | Tenant-visible pointer to n8n-backed automation |
| Proposals | `/api/v1/proposals` | Staff (full); **Portal** (read-only, own-organization proposals only, via `/api/v1/portal/proposals`) | Portal namespace is a distinct route tree, not a permission flag on the staff route — see §4 |
| Portal Documents | `/api/v1/portal/documents` | Portal only | |
| Revenue | `/api/v1/revenue/summary`, `/api/v1/revenue/events` | Staff | Backs the Revenue Dashboard |
| Consent | `/api/v1/consent` (authenticated, staff-recorded) vs. consent flags accepted inline by the tracking ingestion endpoint above (unauthenticated) | Mixed — see note | Recording a contact's consent via staff action and a visitor accepting a cookie banner are different auth contexts for conceptually the same data; they are two different call sites writing to the same `consent_records` table, not one shared endpoint |
| Data Subject Requests | `/api/v1/data-subject-requests`, `/api/v1/data-subject-requests/{id}/preview`, `/api/v1/data-subject-requests/{id}/execute` | Staff | GDPR access/export/delete requests. **`POST .../preview` (dry-run, never mutates) then `POST .../execute` (irreversible, re-validates independently of any prior preview) is the only path that triggers the hard-delete cascade in `03-Database-Architecture.md`'s deletion model** — a dedicated verb pair (M1.6 Decision D), not a `DELETE` on the resource itself, specifically so an irreversible action is never one accidental verb away from the read/write pattern every other resource uses. See §2.2 |
| Webhooks (inbound) | `/api/v1/webhooks/n8n`, `/api/v1/webhooks/email`, `/api/v1/webhooks/linkedin`, `/api/v1/webhooks/stripe` | Signed provider secret | Signed, provider-specific receivers |

Standard verbs apply per resource: `GET` (list/detail), `POST` (create), `PATCH` (partial update), `DELETE`. No resource uses `PUT` — partial updates only, to avoid accidental full-object overwrites. **`DELETE` on an ordinary CRM resource (`contacts`, `companies`, `deals`, `proposals`) is the recoverable soft-delete described in `03-Database-Architecture.md`'s deletion model — it does not, by itself, satisfy a GDPR erasure obligation.** That is only ever fulfilled via the dedicated `POST /api/v1/data-subject-requests/{id}/preview` then `POST .../execute` pair (§2.2), not `DELETE` on the resource — a deliberate deviation from this section's own verb convention, made explicitly in M1.6 (Decision D) because a single `DELETE` call reads as symmetric with every other resource's recoverable soft-delete, which an irreversible cross-cascade hard-delete is not. This distinction is stated explicitly here because conflating the two is one of the most common real-world compliance mistakes in CRM-shaped APIs.

### 2.2 `/api/v1/consent`, `/api/v1/data-subject-requests` — implemented contract (M1.6)

- **`POST /api/v1/consent`** — session auth, `org_admin` only (`08-Security.md` §3.1). Body: `subjectType` (`contact`/`visitor`/`portal_user`), `subjectId`, `consentType` (`marketing_email`/`cookie_tracking`/`data_processing`), `status` (`granted`/`withdrawn`), optional `source`. `201` with `{ consent: { id, status, recordedAt } }`. `organization_id` comes exclusively from the caller's server-resolved context.
- **`POST /api/v1/data-subject-requests`** — session auth, `org_admin` only. Body: `subjectType` (`contact`/`visitor`/`portal_user`/`user`), `subjectId`, `requestType` (`access`/`export`/`delete`). `201` with `{ dataSubjectRequest }` on success. `400` if `requestType` isn't `delete` — `access`/`export` are schema-valid but have no fulfillment logic in M1.6.
- **`GET /api/v1/data-subject-requests/{id}`** — session auth, `org_admin` only, scoped to the caller's own organization via RLS (a cross-org id returns `404`, not `403`, to avoid confirming the row's existence to a caller who can't see it).
- **`POST /api/v1/data-subject-requests/{id}/preview`** — dry-run, never mutates. `200` with `{ preview: { canProceed, blockerReason, targetUserId, membershipCount, affectedOrganizationIds } }`. A `false` `canProceed` (e.g. the target is the sole `org_admin` of an organization) is still a `200` — it's a successful preview reporting a blocker, not a failed request.
- **`POST /api/v1/data-subject-requests/{id}/execute`** — irreversible. Independently re-validates authorization and the sole-`org_admin` blocker; never trusts a prior `preview` call. `200` with `{ result: { targetUserId, membershipsRemoved, completedAt } }` on success; `409` if blocked or already completed, `400` if the request's `subjectType`/`requestType` combination has no fulfillment logic.

### 2.1 `/api/v1/organizations` — implemented contract (M1.4)

The first resource actually built beyond the health check, so its real contract is recorded here rather than left to match the general table above by assumption.

- **`GET /api/v1/organizations`** — session auth only (no API-key path yet). Response shape is always `{ organizations: [...] }`, never a bare array, so the envelope can carry pagination/metadata later without a breaking change. What's returned depends entirely on server-resolved context, never a query parameter:
  - `agency_owner`/`agency_admin` → every client organization under their agency, via the `agency_rollup_organizations` view (`03-Database-Architecture.md` §5) — never a broadened query against the base `organizations` table.
  - An ordinary org-level user → their own single organization, as a one-item array.
  - An authenticated user with neither (no membership at all yet) → `{ organizations: [] }`, not an error — same "route to onboarding" philosophy as `get_my_membership_context()`.
  - No authenticated session at all → `401`.
  - A user holding both an agency-level and an organization-level membership gets the agency view — agency context takes precedence when present.
- **`POST /api/v1/organizations`** — creates a client organization under the caller's own agency. `201` with `{ organization: { id, name, slug } }` on success.
  - `403` if the caller isn't an active `agency_owner`/`agency_admin` of some agency — includes ordinary org-level users and unauthenticated-but-somehow-past-401 edge cases alike.
  - `agency_id` is **never** read from the request body — it comes exclusively from the caller's server-resolved agency membership. A body field named `agencyId` is silently ignored; it cannot be used to target a different agency (verified by test).
  - `400` for a missing/empty/non-string `name`, or a `name` over 200 characters. `400` for a malformed JSON body.
  - Slug collisions are handled transparently server-side (the same generate-and-retry-on-conflict pattern as individual-user org signup) — a client never sees a slug conflict; two organizations may share the same `name`, they just get distinct auto-generated slugs.
  - `500` (generic, no internal detail) only if organization creation fails for a reason other than the above — e.g. the slug-retry budget is exhausted, astronomically unlikely in practice.
  - A same-origin check on the `Origin` header (when present) returns `403` for a cross-origin `POST`, as defense-in-depth alongside the session cookie's own `sameSite: "lax"` default.

## 3. Authentication

Three distinct authentication paths:

1. **First-party session auth (product UI)**: Supabase Auth JWT, issued on login, carrying the user's identity. The *active organization* the request should be resolved against is determined per-request by the API middleware (`03-Database-Architecture.md` §5) — not baked into the JWT as a static claim — specifically so that an agency user switching between client organizations takes effect immediately, without a token reissue.
2. **API key auth (external integrations, and n8n)**: scoped keys (`arev_live_...` / `arev_test_...` prefix for environment clarity), passed as `Authorization: Bearer <key>`, backed by the `api_keys` table (`03-Database-Architecture.md` §2.1). Keys are hashed at rest, scoped to a single organization, and revocable individually via `/api/v1/api-keys`. **n8n uses this same mechanism** — every workflow is issued an `api_keys` row scoped to a `service` role/flag distinguishing it from a customer-issued key for monitoring/audit purposes, rather than a separate, undocumented credential type. This is a deliberate simplification: one credential primitive, one issuance/revocation path, one place RLS's tenant-context resolution has to reason about.
3. **Portal auth (customer portal)**: a **separate, magic-link-based flow** issuing a JWT scoped only to `portal_users` permissions. Enforcement is structural, not just a permission check: portal JWTs are only accepted by the `/api/v1/portal/*` route tree (§2); every other route rejects a portal-scoped token at the authentication layer before any authorization check even runs, so there is no code path where a portal session reaches an internal CRM/agent endpoint by a missed permission check.

## 4. Authorization

- Every request resolves to `(user_or_key, organization_id, role)` before touching a resource handler.
- Authorization is enforced at two layers: application-layer `can(actor, action, resource)` checks (see `02-Software-Architecture.md` §7, RBAC facade) as the primary gate, with Postgres RLS as defense-in-depth beneath it.
- Agency-level endpoints (`/api/v1/organizations` list, roll-up reads) require `agency_owner`/`agency_admin` and route through the explicit roll-up views — never a general bypass flag.
- API keys carry their own scoped permission set (e.g., a key can be issued read-only, or scoped to only `contacts` + `deals`) independent of the issuing user's own role, so an agency can hand a narrow key to a client's tool without over-granting.
- Portal-reachable resources are a separate route tree (`/api/v1/portal/*`, §2), not a permission flag layered onto the staff API — this is a structural choice, not just a policy one, precisely so "is this endpoint portal-safe" is answerable by looking at the URL, not by auditing every permission check.

## 5. API Versioning

- URL-path versioning (`/api/v1/...`) — chosen over header-based versioning for discoverability and simpler debugging/curl-ability for external integrators.
- A version is supported for a minimum of 12 months after the next version ships; deprecation is announced via a `Deprecation` and `Sunset` response header before removal, never a silent break.
- Additive changes (new optional fields, new endpoints) do not bump the version. Breaking changes (removed fields, changed semantics, changed auth) require a new version.

## 6. Rate Limiting

- Enforced per tenant (`organization_id` or API key), not globally — one tenant's enrichment-heavy usage must never degrade another tenant's experience.
- Default tier (**directional, to be set from real load-testing, not treated as validated**): on the order of several hundred requests/minute per organization for read endpoints, an order of magnitude lower for write/mutation endpoints, configurable per plan.
- The visitor tracking ingestion endpoint (§2) is rate-limited per `anonymous_id`/source IP, not per tenant, and separately from the rest of this section — its traffic profile (public, spiky, potentially abusive) has nothing in common with authenticated tenant API calls.
- Webhook receivers are rate-limited per source provider signature, not per tenant, since inbound webhook volume is provider-driven.
- `429` responses carry `Retry-After` and `X-RateLimit-Remaining` headers; clients are expected to back off, not retry immediately.
- Agent-triggered API calls (an agent calling internal tools, which route through this same API) are subject to a separate, stricter budget to contain runaway agent loops from a prompt/tool-call bug (`05-AI-Agent-Architecture.md` §7).

## 7. Webhooks

**Inbound** (`/api/v1/webhooks/*`):
- Every inbound webhook is signature-verified against the provider's signing secret before processing (HMAC comparison, constant-time).
- Processing is idempotent — a dedupe table keyed on `(provider, provider_event_id)` (`webhook_events_seen`, `03-Database-Architecture.md` §2.10) prevents double-processing of retried deliveries.
- **Providers call these endpoints directly** — a bounce/open notification, a LinkedIn task result, an enrichment completion all land on `/api/v1/webhooks/*` from the provider itself, not via n8n. n8n is never a webhook target for third-party providers; the app's job is to verify, dedupe, persist the result, and emit an internal domain event, which n8n then reacts to like any other event-driven workflow (see `02-Software-Architecture.md` §5, `06-n8n-Workflow-Architecture.md` §14).

**Outbound** (tenant-configurable, managed via `/api/v1/webhook-subscriptions`, §2):
- Agencies/organizations register their own webhook endpoints (backed by the `webhook_subscriptions` table, `03-Database-Architecture.md` §2.10) to receive domain events (`deal.stage_changed`, `proposal.accepted`, `lead_score.recalculated`).
- Delivery is signed (HMAC with the per-subscription `signing_secret_encrypted`) so receivers can verify authenticity.
- Retried with exponential backoff on failure; a webhook endpoint failing repeatedly is auto-disabled (`disabled_at` set) and surfaced to the tenant admin, not retried indefinitely.

**Ordinary mutations, not just webhooks**: the `Idempotency-Key` support stated in §1 applies to every `POST`/`PATCH` on the authenticated API, not only to webhook delivery — a duplicate `POST /api/v1/deals` from a client-side retry is exactly as much a correctness risk as a duplicate webhook delivery, and is protected the same way.

## 8. Integration Architecture

- The REST API and the webhook layer together are the **only** way external systems — including n8n itself — touch tenant data. n8n does not have direct Postgres access; it calls the same authenticated API surface a third-party integrator would, using an `api_keys` row scoped to a `service` role (§3) issued per workflow, resolved through the same request-scoped tenant-context mechanism as any other caller (`03-Database-Architecture.md` §5).
- This symmetry (n8n as "just another API consumer," using the same credential primitive as anyone else) is what keeps the provider-agnostic promise real: replacing n8n itself with a different automation engine in the future would not require redesigning the data access layer, the credential model, or the authorization path.
- Third-party integrations an agency wants to build (e.g., syncing to their own BI tool) use the same scoped API keys described in §3, issued via `/api/v1/api-keys` — there is no "internal-only" API surface with weaker auth than what's offered externally.
