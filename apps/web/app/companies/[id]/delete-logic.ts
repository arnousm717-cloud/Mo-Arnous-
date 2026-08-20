import { handleDeleteCompany } from "../../api/v1/companies/[id]/handlers";

/**
 * Reuses handleDeleteCompany in-process (ADR-004) — the same
 * companies:delete RBAC check and softDeleteCompany() call the real
 * DELETE route runs. No hard-delete path, no packages/compliance import,
 * no DSR/erasure call anywhere in this file or its dependency — this is
 * the ordinary, recoverable soft-delete only.
 */

export interface DeleteCompanyFormState {
  error?: string;
  deleted?: boolean;
}

export async function deleteCompanyForResolvedContext(
  userId: string | null,
  companyId: string,
): Promise<DeleteCompanyFormState> {
  const response = await handleDeleteCompany(userId, companyId);
  if (response.status === 200) {
    return { deleted: true };
  }
  const data = (await response.json()) as { error?: { code: string; message: string; request_id: string } };
  return { error: typeof data.error === "object" && data.error !== null ? data.error.message : "Failed to remove the company. Please try again." };
}
