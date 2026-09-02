import type { NextRequest } from "next/server";
import { withRequestLogging } from "../../../_shared/logger";
import { handleRecordContactEnrichment } from "./handlers";

// Node.js runtime — correctness depends on it (pg via the tenant-context
// chain), same reasoning as every other route in this API that touches
// Postgres.
export const runtime = "nodejs";

export const POST = withRequestLogging(
  "POST",
  "/api/v1/contacts/[id]/enrichment",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleRecordContactEnrichment(request, id);
  },
);
