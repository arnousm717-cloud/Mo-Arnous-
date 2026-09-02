import type { NextRequest } from "next/server";
import { withRequestLogging } from "../../../_shared/logger";
import { handleRecordCompanyEnrichment } from "./handlers";

export const runtime = "nodejs";

export const POST = withRequestLogging(
  "POST",
  "/api/v1/companies/[id]/enrichment",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return handleRecordCompanyEnrichment(request, id);
  },
);
