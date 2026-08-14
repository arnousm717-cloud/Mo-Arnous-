import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser, type Actor, type PermissionKey } from "@ai-revenue-os/auth";
import {
  createDeal,
  listDeals,
  ValidationError,
  InvalidOwnerError,
  InvalidCompanyRelationshipError,
  InvalidContactRelationshipError,
  InvalidPipelineRelationshipError,
  InvalidStageRelationshipError,
  type Deal,
  type CreateDealInput,
} from "@ai-revenue-os/crm";
import { withIdempotency } from "../_shared/idempotency";

/**
 * Milestone 2.2D. Mirrors companies/handlers.ts and contacts/handlers.ts
 * exactly — see their own comments for the full rationale, not repeated
 * here. organizationId is never read from the request; only from
 * resolveOrganizationContextForUser's server-resolved result.
 */

interface ResolvedActor {
  userId: string;
  organizationId: string;
  roleKey: string;
}

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

/**
 * instanceof-checks against packages/crm's typed errors — never fragile
 * message-substring matching. Every relationship-validation error here
 * (owner/company/contact/pipeline/stage) maps to 400 — these are all body
 * fields on a deal (never a URL path resource identifier the way a
 * pipeline's own :id is for the Pipelines API), so an invalid relationship
 * is treated as bad request input, exactly like InvalidCompanyRelationshipError
 * already is for Contacts. Returns null for anything unexpected.
 */
function mapCrmError(err: unknown): { status: number; body: unknown } | null {
  if (
    err instanceof ValidationError ||
    err instanceof InvalidOwnerError ||
    err instanceof InvalidCompanyRelationshipError ||
    err instanceof InvalidContactRelationshipError ||
    err instanceof InvalidPipelineRelationshipError ||
    err instanceof InvalidStageRelationshipError
  ) {
    return { status: 400, body: { error: err.message } };
  }
  return null;
}

interface DealRequestBody {
  companyId?: unknown;
  primaryContactId?: unknown;
  pipelineId?: unknown;
  stageId?: unknown;
  amount?: unknown;
  currency?: unknown;
  probability?: unknown;
  expectedCloseDate?: unknown;
  ownerId?: unknown;
}

/**
 * Mass-assignment protection: only these nine fields are ever read from
 * the body. id/organizationId/organization_id/status/deletedAt/
 * deleted_at/createdAt/created_at/updatedAt/updated_at have no
 * corresponding extraction here at all — there is no code path for them
 * to reach packages/crm, not just a runtime check that happens to reject
 * them. status in particular is never read from the body under ANY key —
 * this is what makes "status remains domain-derived" structural, not a
 * convention someone has to remember (Milestone 2.2B).
 */
function extractCreateInput(rawBody: unknown): CreateDealInput {
  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as DealRequestBody;
  return {
    pipelineId: body.pipelineId as string,
    stageId: body.stageId as string,
    ...(body.companyId !== undefined ? { companyId: body.companyId as string | null } : {}),
    ...(body.primaryContactId !== undefined ? { primaryContactId: body.primaryContactId as string | null } : {}),
    ...(body.amount !== undefined ? { amount: body.amount as number | string | null } : {}),
    ...(body.currency !== undefined ? { currency: body.currency as string } : {}),
    ...(body.probability !== undefined ? { probability: body.probability as number | null } : {}),
    ...(body.expectedCloseDate !== undefined ? { expectedCloseDate: body.expectedCloseDate as string | null } : {}),
    ...(body.ownerId !== undefined ? { ownerId: body.ownerId as string | null } : {}),
  };
}

function toDealResponseBody(deal: Deal): { deal: Deal } {
  return { deal };
}

const DEAL_STATUSES = ["open", "won", "lost"];

export async function handleListDeals(userId: string | null, url: URL): Promise<NextResponse> {
  const actor = await resolveActor(userId, "deals:read");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const pipelineId = url.searchParams.get("pipelineId");
  const stageId = url.searchParams.get("stageId");
  const ownerId = url.searchParams.get("ownerId");
  const companyId = url.searchParams.get("companyId");
  const status = url.searchParams.get("status");

  if (status !== null && !DEAL_STATUSES.includes(status)) {
    return NextResponse.json({ error: `status must be one of ${DEAL_STATUSES.join(", ")}` }, { status: 400 });
  }

  try {
    const page = await listDeals(actor, {
      ...(cursor !== null ? { cursor } : {}),
      ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
      ...(pipelineId !== null ? { pipelineId } : {}),
      ...(stageId !== null ? { stageId } : {}),
      ...(ownerId !== null ? { ownerId } : {}),
      ...(companyId !== null ? { companyId } : {}),
      ...(status !== null ? { status: status as "open" | "won" | "lost" } : {}),
    });
    return NextResponse.json({ deals: page.items, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to list deals" }, { status: 500 });
  }
}

export async function handleCreateDeal(
  userId: string | null,
  rawBody: unknown,
  idempotencyKey: string | null,
): Promise<NextResponse> {
  const actor = await resolveActor(userId, "deals:create");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const input = extractCreateInput(rawBody);

  if (!idempotencyKey) {
    try {
      const deal = await createDeal(actor, input);
      return NextResponse.json(toDealResponseBody(deal), { status: 201 });
    } catch (err) {
      const mapped = mapCrmError(err);
      if (mapped) {
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
      return NextResponse.json({ error: "Failed to create deal" }, { status: 500 });
    }
  }

  try {
    const outcome = await withIdempotency(
      actor,
      { rawIdempotencyKey: idempotencyKey, method: "POST", route: "/api/v1/deals", body: input },
      async (client) => {
        try {
          const deal = await createDeal(actor, input, client);
          return { status: 201, body: toDealResponseBody(deal) };
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
    return NextResponse.json({ error: "Failed to create deal" }, { status: 500 });
  }
}

// Re-exported for [id]/handlers.ts — shared with this file's own handlers
// rather than duplicated, matching CLAUDE.md's "no duplicate logic" rule.
export { resolveActor, mapCrmError, toDealResponseBody };
export type { ResolvedActor };
