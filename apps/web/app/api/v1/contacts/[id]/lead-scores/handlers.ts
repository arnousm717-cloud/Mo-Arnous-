import { NextResponse } from "next/server";
import { getContactById } from "@ai-revenue-os/crm";
import { getLatestLeadScore, listLeadScoreHistory, decodeLeadScoreHistoryCursor } from "@ai-revenue-os/intelligence";
import { resolveActor } from "../../handlers";
import { apiError } from "../../../_shared/api-error";
import { isValidUuid } from "../../../_shared/uuid";

/**
 * Milestone 3.4D — GET /api/v1/contacts/{id}/lead-scores. Session auth,
 * reuses the existing contacts:read permission (a lead score is
 * conceptually contact-derived data, not a new resource class needing
 * its own permission). `?latest=true` returns just the single most
 * recent score (`{ score: {...} | null }`); omitted, returns the full
 * cursor-paginated historized list (`{ scores: [...], nextCursor }`) —
 * matches this API's existing cursor-only pagination convention
 * (docs/04-API-Architecture.md §1), never offset.
 */
export async function handleGetContactLeadScores(userId: string | null, contactId: string, url: URL): Promise<NextResponse> {
  const actor = await resolveActor(userId, "contacts:read");
  if (actor instanceof NextResponse) {
    return actor;
  }
  if (!isValidUuid(contactId)) {
    return apiError("NOT_FOUND", "Not found", 404);
  }
  const contact = await getContactById(actor, contactId);
  if (!contact) {
    return apiError("NOT_FOUND", "Not found", 404);
  }

  if (url.searchParams.get("latest") === "true") {
    const score = await getLatestLeadScore(actor, contactId);
    return NextResponse.json({ score });
  }

  const cursorParam = url.searchParams.get("cursor");
  let cursor;
  if (cursorParam) {
    cursor = decodeLeadScoreHistoryCursor(cursorParam);
    if (!cursor) {
      return apiError("VALIDATION_ERROR", "cursor is invalid", 400);
    }
  }

  const limitParam = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return apiError("VALIDATION_ERROR", "limit must be a positive integer no greater than 100", 400);
    }
    limit = parsed;
  }

  const page = await listLeadScoreHistory(actor, contactId, {
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  return NextResponse.json({ scores: page.items, nextCursor: page.nextCursor });
}
