import { withRequestLogging } from "../../api/v1/_shared/logger";
import { corsPreflightResponse } from "../_shared/cors";
import { handleIdentifyRequest } from "./handlers";

// Node.js runtime, same reasoning as collect/consent's own identical
// comment: correctness genuinely depends on it (packages/auth's Ed25519
// verification via node:crypto, plus pg via the tenant-context chain,
// are both Node-only APIs).
export const runtime = "nodejs";

export const OPTIONS = withRequestLogging("OPTIONS", "/track/identify", (): Response => corsPreflightResponse());

export const POST = withRequestLogging(
  "POST",
  "/track/identify",
  async (request: Request): Promise<Response> => handleIdentifyRequest(request),
);
