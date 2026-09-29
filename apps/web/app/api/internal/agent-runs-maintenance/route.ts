import { withRequestLogging } from "../../v1/_shared/logger";
import { handleAgentRunsMaintenance } from "./handlers";

export const runtime = "nodejs";

// Vercel Cron Jobs always invoke via GET (Vercel's own documented
// behavior), automatically attaching `Authorization: Bearer
// $CRON_SECRET` when a CRON_SECRET env var is configured — never POST,
// matching dispatch-events/route.ts and brain-embedding-recovery/
// route.ts's own identical convention.
export const GET = withRequestLogging(
  "GET",
  "/api/internal/agent-runs-maintenance",
  async (request: Request): Promise<Response> => handleAgentRunsMaintenance(request),
);
