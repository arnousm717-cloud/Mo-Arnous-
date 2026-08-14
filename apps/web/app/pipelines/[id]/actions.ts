"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthenticatedUser } from "@ai-revenue-os/auth";
import { updatePipelineForResolvedContext, type UpdatePipelineFormState } from "./update-logic";
import { setDefaultPipelineForResolvedContext, type SetDefaultPipelineFormState } from "./set-default-logic";
import { deletePipelineForResolvedContext, type DeletePipelineFormState } from "./delete-logic";
import { createStageForResolvedContext, type CreateStageFormState } from "./create-stage-logic";
import { updateStageForResolvedContext, type UpdateStageFormState } from "./update-stage-logic";
import { deleteStageForResolvedContext, type DeleteStageFormState } from "./delete-stage-logic";

export type {
  UpdatePipelineFormState,
  SetDefaultPipelineFormState,
  DeletePipelineFormState,
  CreateStageFormState,
  UpdateStageFormState,
  DeleteStageFormState,
};

export async function updatePipelineAction(
  pipelineId: string,
  _prevState: UpdatePipelineFormState,
  formData: FormData,
): Promise<UpdatePipelineFormState> {
  const user = await getAuthenticatedUser();
  const result = await updatePipelineForResolvedContext(user?.id ?? null, pipelineId, formData);
  if (result.updatedId) {
    redirect(`/pipelines/${result.updatedId}`);
  }
  return result;
}

// Stays on the same page (no redirect) — setting the default doesn't
// change which pipeline is being viewed, only its own isDefault flag.
export async function setDefaultPipelineAction(
  pipelineId: string,
  _prevState: SetDefaultPipelineFormState,
  _formData: FormData,
): Promise<SetDefaultPipelineFormState> {
  const user = await getAuthenticatedUser();
  const result = await setDefaultPipelineForResolvedContext(user?.id ?? null, pipelineId);
  if (result.updatedId) {
    revalidatePath(`/pipelines/${pipelineId}`);
  }
  return result;
}

export async function deletePipelineAction(
  pipelineId: string,
  _prevState: DeletePipelineFormState,
  _formData: FormData,
): Promise<DeletePipelineFormState> {
  const user = await getAuthenticatedUser();
  const result = await deletePipelineForResolvedContext(user?.id ?? null, pipelineId);
  if (result.deleted) {
    redirect("/pipelines");
  }
  return result;
}

export async function createStageAction(
  pipelineId: string,
  _prevState: CreateStageFormState,
  formData: FormData,
): Promise<CreateStageFormState> {
  const user = await getAuthenticatedUser();
  const result = await createStageForResolvedContext(user?.id ?? null, pipelineId, formData);
  if (result.createdId) {
    revalidatePath(`/pipelines/${pipelineId}`);
  }
  return result;
}

export async function updateStageAction(
  pipelineId: string,
  stageId: string,
  _prevState: UpdateStageFormState,
  formData: FormData,
): Promise<UpdateStageFormState> {
  const user = await getAuthenticatedUser();
  const result = await updateStageForResolvedContext(user?.id ?? null, pipelineId, stageId, formData);
  if (result.updatedId) {
    revalidatePath(`/pipelines/${pipelineId}`);
  }
  return result;
}

export async function deleteStageAction(
  pipelineId: string,
  stageId: string,
  _prevState: DeleteStageFormState,
  _formData: FormData,
): Promise<DeleteStageFormState> {
  const user = await getAuthenticatedUser();
  const result = await deleteStageForResolvedContext(user?.id ?? null, pipelineId, stageId);
  if (result.deleted) {
    revalidatePath(`/pipelines/${pipelineId}`);
  }
  return result;
}
