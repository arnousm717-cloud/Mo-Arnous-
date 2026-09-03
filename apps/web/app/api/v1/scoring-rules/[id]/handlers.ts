import { NextResponse } from "next/server";
import { updateScoringRule } from "@ai-revenue-os/intelligence";
import { resolveActor, toRuleResponseBody } from "../handlers";
import { validateScoringRulePatch, ValidationError } from "../../_shared/scoring-rule-validation";
import { apiError } from "../../_shared/api-error";
import { isValidUuid } from "../../_shared/uuid";

/** Milestone 3.4D. Mirrors contacts/[id]/handlers.ts's own division of
 * responsibility — this file re-uses scoring-rules/handlers.ts's exported
 * resolveActor rather than duplicating it. */

export async function handleUpdateScoringRule(userId: string | null, id: string, rawBody: unknown): Promise<NextResponse> {
  const actor = await resolveActor(userId, "scoring-rules:write");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(id)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  let patch;
  try {
    patch = validateScoringRulePatch(rawBody);
  } catch (err) {
    if (err instanceof ValidationError) {
      return apiError("VALIDATION_ERROR", err.message, 400);
    }
    throw err;
  }

  const rule = await updateScoringRule(actor, id, patch);
  if (!rule) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  return NextResponse.json(toRuleResponseBody(rule));
}
