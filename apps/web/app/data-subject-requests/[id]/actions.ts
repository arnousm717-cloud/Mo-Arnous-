"use server";

import { revalidatePath } from "next/cache";
import { resolveRequestContext } from "@ai-revenue-os/auth";
import {
  executeErasureForResolvedActor,
  previewErasureForResolvedActor,
  type ExecuteErasureState,
  type PreviewErasureState,
} from "./erasure-logic";

export type { ExecuteErasureState, PreviewErasureState };

async function resolveActor() {
  const context = await resolveRequestContext();
  if (!context?.roleKey) return null;
  return {
    userId: context.userId,
    ...(context.organizationId ? { organizationId: context.organizationId } : {}),
    ...(context.agencyId ? { agencyId: context.agencyId } : {}),
    roleKey: context.roleKey,
  };
}

// Signature is (dsrId, prevState, formData) specifically so the client
// component can bind dsrId via .bind(null, dsrId) and hand the resulting
// (prevState, formData) => state function straight to useActionState —
// the standard React/Next.js pattern for passing an extra fixed argument
// to a Server Action driving useActionState.

export async function previewErasureAction(
  dsrId: string,
  _prevState: PreviewErasureState,
  _formData: FormData,
): Promise<PreviewErasureState> {
  const actor = await resolveActor();
  return previewErasureForResolvedActor(actor, dsrId);
}

export async function executeErasureAction(
  dsrId: string,
  _prevState: ExecuteErasureState,
  _formData: FormData,
): Promise<ExecuteErasureState> {
  const actor = await resolveActor();
  const result = await executeErasureForResolvedActor(actor, dsrId);
  if (result.result) {
    revalidatePath(`/data-subject-requests/${dsrId}`);
  }
  return result;
}
