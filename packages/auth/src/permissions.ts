/**
 * RBAC facade (M1.5, docs/08-Security.md §3, docs/02-Software-Architecture.md
 * §7's "Facade pattern for RBAC"). Pure, synchronous, code-defined,
 * deny-by-default — no I/O, no database call, no dependency on Next.js or
 * any request lifecycle, so the exact same function is reusable from a
 * future agent tool-execution worker (per the M1.5 TDR's Phase 4 reuse
 * note) as from a Route Handler or Server Action.
 *
 * `roles.permission_set` (jsonb, seeded since M1.2) is a GENERATED MIRROR
 * of PERMISSION_MATRIX below, never a second hand-maintained copy — this
 * file is the single source of truth. See the seed migration's own
 * comment: "not derived from this jsonb column alone; it is a readable
 * reference, not the sole enforcement point."
 *
 * Scope is resolved by which permission key is checked, not a separate
 * parameter: `organizations:*` keys are only ever granted to org-scoped
 * roles, `agencies:*` keys only to agency-scoped roles. An Actor carries
 * exactly one roleKey at a time, scoped to whichever context
 * (resolveOrganizationContextForUser or resolveAgencyContextForUser) the
 * caller resolved before constructing it — can() never resolves context
 * itself, it only judges an already-resolved one.
 */

export type PermissionKey =
  | "organizations:read"
  | "organizations:list-clients"
  | "organizations:create-client"
  | "organizations:manage-billing"
  | "organizations:manage-users"
  | "organizations:manage-settings"
  | "agencies:read"
  | "agencies:manage-branding"
  | "agencies:manage-billing"
  | "agencies:manage-domains"
  | "consent:record"
  | "tracking:manage-identity-keys"
  | "data-subject-requests:create"
  | "data-subject-requests:read"
  | "data-subject-requests:execute"
  | "companies:read"
  | "companies:create"
  | "companies:update"
  | "companies:delete"
  | "contacts:read"
  | "contacts:create"
  | "contacts:update"
  | "contacts:delete"
  | "deals:read"
  | "deals:create"
  | "deals:update"
  | "deals:delete"
  | "pipelines:read"
  | "pipelines:create"
  | "pipelines:update"
  | "pipelines:delete"
  | "activities:read"
  | "activities:create"
  | "activities:update"
  | "activities:delete"
  | "notes:read"
  | "notes:create"
  | "notes:update"
  | "notes:delete"
  | "tags:read"
  | "tags:create"
  | "tags:update"
  | "tags:delete"
  | "companies:agency-rollup-read"
  | "contacts:agency-rollup-read"
  | "deals:agency-rollup-read"
  | "pipelines:agency-rollup-read"
  | "scoring-rules:read"
  | "scoring-rules:write";

export interface Actor {
  userId: string;
  roleKey: string;
  organizationId?: string;
  agencyId?: string;
}

/**
 * When supplied, can() additionally verifies the resource belongs to the
 * actor's own scope — redundant with what RLS also enforces, deliberately
 * (docs/08-Security.md §2: "neither layer alone is trusted as sufficient").
 * Omitted entirely means "check against the actor's own current scope."
 */
export interface ResourceContext {
  organizationId?: string;
  agencyId?: string;
}

type RoleKey = "agency_owner" | "agency_admin" | "org_admin" | "org_member" | "org_viewer" | "portal_customer";

type PermissionGrants = Partial<Record<PermissionKey, true>>;

/**
 * The real permission matrix (M1.5's own stated deliverable, extended in
 * Milestone 2.1E for the 8 companies:* and contacts:* keys). Absence of a key
 * is the deny; there is no explicit `false` anywhere in this object
 * because there doesn't need to be one — can() treats "not present" and
 * "present as false" identically.
 *
 * agencies:manage-billing is agency_owner only — a deliberate decision,
 * not an oversight (docs/08 §3 already stated "no billing/plan changes"
 * for agency_admin; M1.5 makes that enforced, not just documented).
 * organizations:manage-billing is the distinct, org-scoped counterpart —
 * a standalone organization's own org_admin manages that org's own
 * billing; agency-scoped roles never receive it under this key, because
 * their billing authority (when they have any) is agencies:manage-billing
 * instead. The two keys are intentionally never granted to the same role.
 *
 * companies:* and contacts:* (Milestone 2.1E, docs/13 "Milestone 2.1"
 * Detailed design): agency_owner/agency_admin deliberately get none of
 * these eight, even though they otherwise hold broad agency-wide grants
 * elsewhere in this table — an agency-scoped Actor carries agencyId, not
 * organizationId, and there is no agency_rollup_companies/
 * agency_rollup_contacts view yet (docs/10-CLAUDE.md §2: agency cross-org
 * access only through named roll-up views, never a direct grant). An
 * agency staffer who separately holds an actual org-scoped membership in
 * a client org already gets CRM access through that org-scoped role's own
 * Actor — no new mechanism needed for that case.
 * companies:delete/contacts:delete authorize ONLY the ordinary
 * UPDATE deleted_at = now() soft-delete packages/crm exposes — never
 * physical DELETE, never GDPR hard erasure. That remains governed
 * exclusively by data-subject-requests:execute, a wholly separate
 * permission checked by a wholly separate route; the two are never
 * coupled here or anywhere else.
 *
 * deals:* and pipelines:* (Milestone 2.2C, docs/13 "Milestone 2.2" frozen
 * decision 2): two DISTINCT resource key sets, deliberately never folded
 * into one deals:* umbrella — a pipeline is structural configuration
 * (who can reshape the sales process) while a deal is working data (who
 * can work deals within whatever process already exists), and the
 * frozen matrix intentionally grants them differently: org_member can
 * create/update deals but only READ pipelines, never reshape pipeline
 * structure. No wildcard/catch-all permission of either family exists.
 * pipelines:delete authorizes ONLY the ordinary soft-delete
 * packages/crm's softDeletePipeline exposes (itself already rejecting
 * deletion of the organization's active default, 2.2B) — same
 * soft-delete-only discipline as companies:delete/contacts:delete.
 *
 * pipeline_stages has NO permission keys of its own — deliberately no
 * pipeline_stages:* set exists. Stage operations authorize under their
 * PARENT pipeline's own keys instead (design intent carried into 2.2D's
 * future API routes): list/get a stage => pipelines:read; create a stage
 * => pipelines:create; update a stage (including the classification
 * change that cascades deals.status, 2.2B) => pipelines:update;
 * soft-delete a stage => pipelines:delete. A stage has no independent
 * existence or authorization story apart from the pipeline that owns it.
 *
 * agency_owner/agency_admin/portal_customer get NONE of these 12 keys —
 * same structural reason already established for companies:* and
 * contacts:* above (no agency_rollup_deals/agency_rollup_pipelines view exists yet;
 * an agency-scoped Actor carries agencyId, not organizationId). Agency
 * roll-up access to Deals/Pipelines remains explicitly out of scope for
 * this milestone (docs/13 Milestone 2.2C).
 *
 * activities:*, notes:*, tags:* (Milestone 2.3C, docs/13 "Milestone 2.3"
 * frozen decision): org_admin gets all 12; org_member gets read/create/
 * update on all three but no delete (mirrors companies:* and contacts:*'s
 * own no-delete-for-org_member pattern exactly); org_viewer gets read only.
 * agency_owner/agency_admin/portal_customer get NONE of these 12 keys —
 * same structural reason as every other CRM resource so far (no
 * agency_rollup_activities/agency_rollup_notes/agency_rollup_tags view
 * exists, and an agency-scoped Actor carries agencyId, not
 * organizationId).
 *
 * taggings has NO permission keys of its own — deliberately no
 * taggings:* set exists, mirroring pipeline_stages' own precedent exactly
 * (a relationship/child row authorizes under its owning resource's keys,
 * never its own family). A future Taggings API route (2.3D) authorizes
 * under tags:* instead: list/get a tagging => tags:read; create a
 * tagging => tags:create; delete a tagging => tags:delete. There is no
 * "update a tagging" case — Taggings have no update operation at any
 * layer (2.3A schema, 2.3B domain layer) — so tags:update is never
 * consulted for a tagging route.
 *
 * companies:agency-rollup-read / contacts:agency-rollup-read /
 * deals:agency-rollup-read / pipelines:agency-rollup-read (Milestone
 * 2.4B, docs/13 "Milestone 2.4" frozen decision): the application-layer
 * defense-in-depth counterpart to the four agency_rollup_* database views
 * (Milestone 2.4A) — these keys do NOT replace or weaken the database
 * security boundary those views already enforce (security_invoker=false,
 * current_agency()/current_role_key() in their own WHERE clause,
 * SELECT-only grants); can() is checked in addition to that, never
 * instead of it. Deliberately four separate read-only keys, not one
 * generic "agency:rollup-read" — matches this file's own established
 * one-key-per-resource-family convention (never a wildcard/catch-all
 * permission) and keeps the door open for a future role to receive
 * roll-up visibility into only some resources, without a redesign.
 * Granted ONLY to agency_owner/agency_admin — no org-scoped role
 * (org_admin/org_member/org_viewer) receives any of these four, since an
 * org-scoped Actor carries organizationId, not agencyId, and could never
 * legitimately resolve current_agency() in the first place; granting the
 * key would be meaningless permission-matrix noise, not a real capability.
 * portal_customer gets none either. No create/update/delete variant
 * exists for any of the four — the roll-up views themselves are
 * structurally read-only (2.4A: no INSERT/UPDATE/DELETE grant exists on
 * any of them), so a write-shaped permission key would authorize an
 * operation with no corresponding code path, which this codebase never
 * does.
 */
export const PERMISSION_MATRIX: Record<RoleKey, PermissionGrants> = {
  agency_owner: {
    "organizations:list-clients": true,
    "organizations:create-client": true,
    "agencies:read": true,
    "agencies:manage-branding": true,
    "agencies:manage-billing": true,
    "agencies:manage-domains": true,
    "companies:agency-rollup-read": true,
    "contacts:agency-rollup-read": true,
    "deals:agency-rollup-read": true,
    "pipelines:agency-rollup-read": true,
  },
  agency_admin: {
    "organizations:list-clients": true,
    "organizations:create-client": true,
    "agencies:read": true,
    "agencies:manage-branding": true,
    "agencies:manage-domains": true,
    "companies:agency-rollup-read": true,
    "contacts:agency-rollup-read": true,
    "deals:agency-rollup-read": true,
    "pipelines:agency-rollup-read": true,
  },
  org_admin: {
    "organizations:read": true,
    "organizations:manage-billing": true,
    "organizations:manage-users": true,
    "organizations:manage-settings": true,
    // M1.6, Decision F: org_admin-only. agency_owner/agency_admin get none
    // of these three — agency-facing compliance workflows are explicitly
    // deferred until scoped separately.
    "consent:record": true,
    // Milestone 3.2B, same reasoning as consent:record immediately
    // above: org_admin-only, no agency-scoped role gets it — managing
    // which Ed25519 public keys can assert a visitor's identity is a
    // security-sensitive, per-organization decision.
    "tracking:manage-identity-keys": true,
    "data-subject-requests:create": true,
    "data-subject-requests:read": true,
    "data-subject-requests:execute": true,
    "companies:read": true,
    "companies:create": true,
    "companies:update": true,
    "companies:delete": true,
    "contacts:read": true,
    "contacts:create": true,
    "contacts:update": true,
    "contacts:delete": true,
    "deals:read": true,
    "deals:create": true,
    "deals:update": true,
    "deals:delete": true,
    "pipelines:read": true,
    "pipelines:create": true,
    "pipelines:update": true,
    "pipelines:delete": true,
    "activities:read": true,
    "activities:create": true,
    "activities:update": true,
    "activities:delete": true,
    "notes:read": true,
    "notes:create": true,
    "notes:update": true,
    "notes:delete": true,
    "tags:read": true,
    "tags:create": true,
    "tags:update": true,
    "tags:delete": true,
    // Milestone 3.4D, same reasoning as tracking:manage-identity-keys and
    // consent:record above: org_admin-only, no agency-scoped role gets
    // it -- configuring the criteria that qualify a lead is a
    // security/business-sensitive, per-organization decision (rule
    // criteria influence which real people get prioritized for outreach).
    "scoring-rules:read": true,
    "scoring-rules:write": true,
  },
  org_member: {
    "organizations:read": true,
    "companies:read": true,
    "companies:create": true,
    "companies:update": true,
    "contacts:read": true,
    "contacts:create": true,
    "contacts:update": true,
    "deals:read": true,
    "deals:create": true,
    "deals:update": true,
    "pipelines:read": true,
    "activities:read": true,
    "activities:create": true,
    "activities:update": true,
    "notes:read": true,
    "notes:create": true,
    "notes:update": true,
    "tags:read": true,
    "tags:create": true,
    "tags:update": true,
  },
  org_viewer: {
    "organizations:read": true,
    "companies:read": true,
    "contacts:read": true,
    "deals:read": true,
    "pipelines:read": true,
    "activities:read": true,
    "notes:read": true,
    "tags:read": true,
  },
  portal_customer: {},
};

function isKnownRole(roleKey: string): roleKey is RoleKey {
  return Object.prototype.hasOwnProperty.call(PERMISSION_MATRIX, roleKey);
}

/**
 * The single RBAC decision point (docs/02 §7). Never throws; always
 * returns a plain boolean the caller uses to decide the HTTP/redirect
 * response. Deny-by-default at every branch: null actor, unrecognized
 * role, ungranted action, or a resource that doesn't match the actor's
 * own scope all resolve to false — there is no fail-open path.
 */
export function can(actor: Actor | null, action: PermissionKey, resource?: ResourceContext): boolean {
  if (!actor) {
    return false;
  }

  if (!isKnownRole(actor.roleKey)) {
    return false;
  }

  const grants = PERMISSION_MATRIX[actor.roleKey];
  if (grants[action] !== true) {
    return false;
  }

  if (resource) {
    if (resource.organizationId !== undefined && resource.organizationId !== actor.organizationId) {
      return false;
    }
    if (resource.agencyId !== undefined && resource.agencyId !== actor.agencyId) {
      return false;
    }
  }

  return true;
}
