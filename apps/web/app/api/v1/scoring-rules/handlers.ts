import { NextResponse } from "next/server";
import { can, resolveOrganizationContextForUser, type Actor, type PermissionKey } from "@ai-revenue-os/auth";
import { listScoringRules, createScoringRule, type ScoringRuleRecord } from "@ai-revenue-os/intelligence";
import { validateCreateScoringRule, ValidationError } from "../_shared/scoring-rule-validation";
import { apiError } from "../_shared/api-error";

/** Milestone 3.4D. A new top-level resource — mirrors contacts/handlers.ts's
 * own resolveActor exactly (see its comment for the full rationale); not
 * imported cross-resource, matching this codebase's established pattern of
 * each top-level resource owning its own copy. */

interface ResolvedActor {
  userId: string;
  organizationId: string;
  roleKey: string;
}

async function resolveActor(userId: string | null, permission: PermissionKey): Promise<ResolvedActor | NextResponse> {
  if (!userId) {
    return apiError("UNAUTHENTICATED", "Unauthorized", 401);
  }
  const orgContext = await resolveOrganizationContextForUser(userId);
  const actor: Actor | null = orgContext ? { userId, ...orgContext } : null;
  if (!actor || !can(actor, permission)) {
    return apiError("FORBIDDEN", "Forbidden", 403);
  }
  return { userId, organizationId: orgContext!.organizationId, roleKey: orgContext!.roleKey };
}

function toRuleResponseBody(rule: ScoringRuleRecord): { rule: ScoringRuleRecord } {
  return { rule };
}

export async function handleListScoringRules(userId: string | null): Promise<NextResponse> {
  const actor = await resolveActor(userId, "scoring-rules:read");
  if (actor instanceof NextResponse) {
    return actor;
  }
  const rules = await listScoringRules(actor);
  return NextResponse.json({ rules });
}

export async function handleCreateScoringRule(userId: string | null, rawBody: unknown): Promise<NextResponse> {
  const actor = await resolveActor(userId, "scoring-rules:write");
  if (actor instanceof NextResponse) {
    return actor;
  }

  let input;
  try {
    input = validateCreateScoringRule(rawBody);
  } catch (err) {
    if (err instanceof ValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    throw err;
  }

  const rule = await createScoringRule(actor, { ...input, createdBy: actor.userId });
  return NextResponse.json(toRuleResponseBody(rule), { status: 201 });
}

// Re-exported for [id]/handlers.ts — shared rather than duplicated.
export { resolveActor, toRuleResponseBody };
export type { ResolvedActor };
