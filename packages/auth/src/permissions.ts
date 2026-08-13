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
  | "contacts:delete";

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
 */
export const PERMISSION_MATRIX: Record<RoleKey, PermissionGrants> = {
  agency_owner: {
    "organizations:list-clients": true,
    "organizations:create-client": true,
    "agencies:read": true,
    "agencies:manage-branding": true,
    "agencies:manage-billing": true,
    "agencies:manage-domains": true,
  },
  agency_admin: {
    "organizations:list-clients": true,
    "organizations:create-client": true,
    "agencies:read": true,
    "agencies:manage-branding": true,
    "agencies:manage-domains": true,
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
  },
  org_member: {
    "organizations:read": true,
    "companies:read": true,
    "companies:create": true,
    "companies:update": true,
    "contacts:read": true,
    "contacts:create": true,
    "contacts:update": true,
  },
  org_viewer: {
    "organizations:read": true,
    "companies:read": true,
    "contacts:read": true,
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
