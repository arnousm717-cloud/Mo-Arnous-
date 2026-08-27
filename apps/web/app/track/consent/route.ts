import { withRequestLogging } from "../../api/v1/_shared/logger";
import { corsPreflightResponse } from "../_shared/cors";
import { handleConsentRequest } from "./handlers";

// See collect/route.ts for why this is declared explicitly even though
// it already matches this app's Route Handler default.
export const runtime = "nodejs";

export const OPTIONS = withRequestLogging("OPTIONS", "/track/consent", (): Response => corsPreflightResponse());

export const POST = withRequestLogging(
  "POST",
  "/track/consent",
  async (request: Request): Promise<Response> => handleConsentRequest(request),
);
