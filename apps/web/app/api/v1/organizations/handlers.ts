import { NextResponse } from "next/server";
import { can, resolveAgencyContextForUser, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { apiError } from "../_shared/api-error";
import {
  createClientOrganizationForAgency,
  getOrganizationById,
  listOrganizationsForAgency,
  type OrganizationSummary,
} from "@ai-revenue-os/tenancy";

const MAX_NAME_LENGTH = 200;

/**
 * Kept out of route.ts deliberately — Next.js's App Router generates its
 * own type check on route.ts that only permits recognized exports
 * (GET/POST/etc. plus a small fixed set of special names), so any other
 * export fails the build. Splitting the actual logic out here also means
 * it takes a resolved userId rather than reading cookies itself —
 * getAuthenticatedUser() depends on next/headers' cookies(), which requires
 * an active Next.js request context a test process doesn't have (the same
 * constraint documented on exchangeAuthCode/refreshSession in
 * packages/auth/src/middleware.ts). "Who is calling" (thin, already covered
 * by other real-session tests) stays separate from "what happens for this
 * caller" (the actual logic under test here), which is what makes this
 * directly testable with a real userId instead of needing a running dev
 * server.
 */

/**
 * agency_owner/agency_admin get their agency's client organizations (via
 * the agency_rollup_organizations view — never a broadened base-table
 * query); an ordinary org-level user gets their own single organization;
 * an authenticated user with neither gets an empty list, not an error
 * (same "route to onboarding, not an error page" philosophy
 * get_my_membership_context() already established). Agency/organization
 * context is resolved entirely server-side (docs/03-Database-Architecture.md
 * §5) — nothing here reads a client-supplied agency or organization id as
 * authorization for what to return.
 */
export async function handleGetOrganizations(userId: string | null): Promise<NextResponse> {
  if (!userId) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }

  // Agency context takes precedence when present — an agency_owner/admin
  // who also happens to hold an organization-level membership somewhere
  // still expects this endpoint to show their client roster, not a single
  // unrelated org.
  const agencyContext = await resolveAgencyContextForUser(userId);
  if (agencyContext) {
    const organizations = await listOrganizationsForAgency({ userId, ...agencyContext });
    return NextResponse.json({ organizations });
  }

  const orgContext = await resolveOrganizationContextForUser(userId);
  if (orgContext) {
    const organization = await getOrganizationById({ userId, organizationId: orgContext.organizationId });
    const organizations: OrganizationSummary[] = organization ? [organization] : [];
    return NextResponse.json({ organizations });
  }

  return NextResponse.json({ organizations: [] satisfies OrganizationSummary[] });
}

// Re-exported for backward compatibility with existing imports/tests — the
// implementation itself now lives in _shared/same-origin.ts (M1.6), shared
// across every mutating v1 route instead of duplicated per route.
export { isSameOrigin } from "../_shared/same-origin";

interface CreateOrganizationBody {
  name?: unknown;
}

/**
 * Only agency_owner/agency_admin may create a client organization, and
 * only under their own agency — agencyId comes exclusively from
 * resolveAgencyContextForUser (server-resolved from the caller's real
 * membership row), never from the request body, so there is nothing in the
 * payload a client could supply to target a different agency. The role
 * check itself goes through can() (M1.5's RBAC facade) rather than an
 * inline role-string comparison — see permission key
 * "organizations:create-client" in packages/auth/src/permissions.ts.
 * create_client_organization_for_agency() (M1.4 backend checkpoint)
 * re-verifies this same authorization independently as defense-in-depth —
 * this route's own check is not the only gate.
 */
export async function handleCreateOrganization(
  userId: string | null,
  rawBody: unknown,
): Promise<NextResponse> {
  if (!userId) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }

  const agencyContext = await resolveAgencyContextForUser(userId);
  // The explicit `!agencyContext` here is redundant with can()'s own null
  // handling at runtime (can(null, ...) already denies) — it's here purely
  // so TypeScript narrows agencyContext to non-null for the code below;
  // can() itself doesn't narrow, being just a boolean-returning function.
  if (!agencyContext || !can({ userId, ...agencyContext }, "organizations:create-client")) {
    return apiError("FORBIDDEN", "Forbidden", 403);
  }

  const body = rawBody as CreateOrganizationBody;
  const name = body?.name;
  if (typeof name !== "string" || !name.trim()) {
    return apiError("VALIDATION_ERROR", "name is required", 400);
  }
  const trimmedName = name.trim();
  if (trimmedName.length > MAX_NAME_LENGTH) {
    return apiError("VALIDATION_ERROR", `name must be ${MAX_NAME_LENGTH} characters or fewer`, 400);
  }

  try {
    const result = await createClientOrganizationForAgency(userId, agencyContext.agencyId, trimmedName);
    return NextResponse.json(
      { organization: { id: result.organizationId, name: trimmedName, slug: result.slug } },
      { status: 201 },
    );
  } catch {
    // Never forward raw DB/driver error text to the client — it's an
    // internal implementation detail, not a user-facing API contract, and
    // could leak schema/constraint details over time as the codebase
    // evolves. Slug collisions are already retried transparently inside
    // createClientOrganizationForAgency; reaching this catch means either
    // that retry was exhausted (astronomically unlikely) or some other
    // unexpected failure occurred — both are a clean 500 from the caller's
    // point of view, with detail available server-side via the platform's
    // own request logging, not in the response body.
    return apiError("INTERNAL_ERROR", "Failed to create organization", 500);
  }
}
