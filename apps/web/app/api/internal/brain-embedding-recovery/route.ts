import { withRequestLogging } from "../../v1/_shared/logger";
import { handleBrainEmbeddingRecovery } from "./handlers";

export const runtime = "nodejs";

// Vercel Cron Jobs always invoke via GET (Vercel's own documented
// behavior), automatically attaching `Authorization: Bearer
// $CRON_SECRET` when a CRON_SECRET env var is configured — never POST,
// matching dispatch-events/route.ts's own identical convention.
export const GET = withRequestLogging(
  "GET",
  "/api/internal/brain-embedding-recovery",
  async (request: Request): Promise<Response> => handleBrainEmbeddingRecovery(request),
);
