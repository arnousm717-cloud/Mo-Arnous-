import { withRequestLogging } from "../_shared/logger";

export const GET = withRequestLogging("GET", "/api/v1/health", (): Response => {
  return Response.json({ status: "ok", service: "ai-revenue-os-web" });
});
