import { can } from "@ai-revenue-os/auth";
import { executeUserErasure, previewUserErasure, type ErasurePreview, type ErasureResult } from "@ai-revenue-os/compliance";

/**
 * Kept out of actions.ts ("use server") deliberately — same reasoning as
 * ../file-dsr-logic.ts and apps/web/app/agency/create-client-org-logic.ts:
 * trusts an already-resolved actor, so it must not be independently
 * client-invokable as an RPC endpoint.
 */

export interface PreviewErasureState {
  error?: string;
  preview?: ErasurePreview;
}

export interface ExecuteErasureState {
  error?: string;
  result?: ErasureResult;
}

export async function previewErasureForResolvedActor(
  actor: { userId: string; organizationId?: string; agencyId?: string; roleKey: string } | null,
  dsrId: string,
): Promise<PreviewErasureState> {
  if (!actor || !can(actor, "data-subject-requests:execute")) {
    return { error: "You do not have permission to preview this request." };
  }
  try {
    const preview = await previewUserErasure({ userId: actor.userId }, dsrId);
    return { preview };
  } catch {
    return { error: "Failed to preview this request." };
  }
}

export async function executeErasureForResolvedActor(
  actor: { userId: string; organizationId?: string; agencyId?: string; roleKey: string } | null,
  dsrId: string,
): Promise<ExecuteErasureState> {
  if (!actor || !can(actor, "data-subject-requests:execute")) {
    return { error: "You do not have permission to execute this request." };
  }
  try {
    const result = await executeUserErasure({ userId: actor.userId }, dsrId);
    return { result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to execute this request." };
  }
}
