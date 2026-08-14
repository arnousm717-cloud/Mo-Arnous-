"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { moveDealToStageForResolvedContext, type MoveDealFormState } from "./move-logic";

export type { MoveDealFormState };

/**
 * Stays on the board (no redirect) — a successful move revalidates
 * /deals/board so the moved card re-renders under its new stage column
 * on next navigation/refresh, the same revalidatePath discipline already
 * used by ../../pipelines/[id]/actions.ts.
 */
export async function moveDealToStageAction(
  dealId: string,
  _prevState: MoveDealFormState,
  formData: FormData,
): Promise<MoveDealFormState> {
  const user = await getAuthenticatedUser();
  const result = await moveDealToStageForResolvedContext(user?.id ?? null, dealId, formData);
  if (result.movedId) {
    revalidatePath("/deals/board");
  }
  return result;
}
