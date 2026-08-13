import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser, type Actor, type PermissionKey } from "@ai-revenue-os/auth";
import {
  createCompany,
  listCompanies,
  ValidationError,
  InvalidOwnerError,
  type Company,
  type CreateCompanyInput,
} from "@ai-revenue-os/crm";
import { withIdempotency } from "../_shared/idempotency";

/**
 * Milestone 2.1F-B. Mirrors the existing organizations/data-subject-requests
 * handler pattern exactly: takes an already-resolved userId (never reads
 * cookies itself — see organizations/handlers.ts's own comment for why),
 * resolves org context + RBAC here, delegates to packages/crm for
 * everything domain-shaped. organizationId is never read from the request
 * — only from resolveOrganizationContextForUser's server-resolved result.
 */

interface ResolvedActor {
  userId: string;
  organizationId: string;
  roleKey: string;
}

/**
 * Auth + org resolution + RBAC, in that order — the same short-circuit
 * shape every existing handler already uses (`!orgContext || !can(...)`).
 * A pure agency actor (no org-scoped membership) resolves orgContext to
 * null here and is rejected identically to "no permission" — 403, not a
 * distinct error, matching the existing precedent (organizations/handlers.ts).
 */
async function resolveActor(
  userId: string | null,
  permission: PermissionKey,
): Promise<ResolvedActor | NextResponse> {
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const orgContext = await resolveOrganizationContextForUser(userId);
  const actor: Actor | null = orgContext ? { userId, ...orgContext } : null;
  if (!actor || !can(actor, permission)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { userId, organizationId: orgContext!.organizationId, roleKey: orgContext!.roleKey };
}

/** instanceof-checks against packages/crm's typed errors — never fragile
 * message-substring matching. Returns null for anything unexpected, which
 * the caller must let propagate (never swallow into a persisted 500). */
function mapCrmError(err: unknown): { status: number; body: unknown } | null {
  if (err instanceof ValidationError || err instanceof InvalidOwnerError) {
    return { status: 400, body: { error: err.message } };
  }
  return null;
}

interface CompanyRequestBody {
  name?: unknown;
  domain?: unknown;
  industry?: unknown;
  employeeCount?: unknown;
  annualRevenue?: unknown;
  linkedinUrl?: unknown;
  ownerId?: unknown;
}

/** Mass-assignment protection: only these seven fields are ever read from
 * the body. id/organizationId/organization_id/deletedAt/createdAt/
 * updatedAt/enrichmentStatus have no corresponding extraction here at
 * all — there is no code path for them to reach packages/crm, not just a
 * runtime check that happens to reject them. */
function extractCreateInput(rawBody: unknown): CreateCompanyInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as CompanyRequestBody;
  // exactOptionalPropertyTypes forbids assigning `undefined` to an optional
  // property explicitly — each field must be entirely omitted when absent
  // from the body, not present-with-undefined-value (matches the
  // conditional-spread pattern packages/auth/src/request-context.ts
  // already established for the same constraint).
  return {
    name: body.name as string,
    ...(body.domain !== undefined ? { domain: body.domain as string | null } : {}),
    ...(body.industry !== undefined ? { industry: body.industry as string | null } : {}),
    ...(body.employeeCount !== undefined ? { employeeCount: body.employeeCount as number | null } : {}),
    ...(body.annualRevenue !== undefined
      ? { annualRevenue: body.annualRevenue as number | string | null }
      : {}),
    ...(body.linkedinUrl !== undefined ? { linkedinUrl: body.linkedinUrl as string | null } : {}),
    ...(body.ownerId !== undefined ? { ownerId: body.ownerId as string | null } : {}),
  };
}

function toCompanyResponseBody(company: Company): { company: Company } {
  return { company };
}

export async function handleListCompanies(userId: string | null, url: URL): Promise<NextResponse> {
  const actor = await resolveActor(userId, "companies:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const ownerId = url.searchParams.get("ownerId");

  try {
    const page = await listCompanies(actor, {
      ...(cursor !== null ? { cursor } : {}),
      ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
      ...(ownerId !== null ? { ownerId } : {}),
    });
    return NextResponse.json({ companies: page.items, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to list companies" }, { status: 500 });
  }
}

export async function handleCreateCompany(
  userId: string | null,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "companies:create");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractCreateInput(rawBody);

  if (!idempotencyKey) {
    try {
      const company = await createCompany(actor, input);
      return NextResponse.json(toCompanyResponseBody(company), { status: 201 });
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return NextResponse.json({ error: "Failed to create company" }, { status: 500 });
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "POST", route: "/api/v1/companies", body: input },
      async (client) => {
        try {
          const company = await createCompany(actor, input, client);
          return { status: 201, body: toCompanyResponseBody(company) };
        } catch (err) {
          const mapped = mapCrmError(err);
          if (mapped) {
            return mapped;
          }
          throw err; // unexpected — roll back the whole idempotency transaction
        }
      },
    );

    if (outcome.kind === "conflict") {
      return NextResponse.json({ error: "Idempotency-Key already used with a different request" }, { status: 409 });
    }
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch {
    // The idempotency transaction rolled back (an unexpected failure inside
    // the callback, or in the reservation machinery itself) — never forward
    // raw error detail to the client.
    return NextResponse.json({ error: "Failed to create company" }, { status: 500 });
  }
}

// Re-exported for [id]/handlers.ts — shared with this file's own handlers
// rather than duplicated, matching CLAUDE.md's "no duplicate logic" rule.
export { resolveActor, mapCrmError, toCompanyResponseBody };
export type { ResolvedActor };
