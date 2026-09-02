import { withRequestLogging } from "../../v1/_shared/logger";
import { handleDispatchEvents } from "./handlers";

export const runtime = "nodejs";

// Vercel Cron Jobs always invoke via GET (Vercel's own documented
// behavior), automatically attaching `Authorization: Bearer
// $CRON_SECRET` when a CRON_SECRET env var is configured — never POST.
export const GET = withRequestLogging("GET", "/api/internal/dispatch-events", async (request: Request): Promise<Response> =>
  handleDispatchEvents(request),
);
