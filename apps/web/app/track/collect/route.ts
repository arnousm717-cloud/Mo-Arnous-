import { withRequestLogging } from "../../api/v1/_shared/logger";
import { corsPreflightResponse } from "../_shared/cors";
import { handleCollectRequest } from "./handlers";

// Node.js runtime is already this app's default for Route Handlers (no
// `runtime: "edge"` declaration exists anywhere in apps/web) — declared
// explicitly here anyway since correctness genuinely depends on it
// (Buffer, and pg via the tenant-context/rate-limit/intelligence chain,
// are Node-only APIs), on this specific, security-relevant boundary.
export const runtime = "nodejs";

export const OPTIONS = withRequestLogging("OPTIONS", "/track/collect", (): Response => corsPreflightResponse());

export const POST = withRequestLogging(
  "POST",
  "/track/collect",
  async (request: Request): Promise<Response> => handleCollectRequest(request),
);
