import { handleUpdateCompany } from "../../api/v1/companies/[id]/handlers";

/**
 * Mirrors ../create-logic.ts's split-from-actions.ts reasoning exactly.
 * Reuses handleUpdateCompany in-process (ADR-004, no network hop) — same
 * RBAC/mass-assignment/Idempotency-Key/partial-update logic the real PATCH
 * route runs.
 *
 * This edit form always displays and resubmits every field (pre-filled
 * with the company's current values), unlike the raw JSON API contract
 * which supports true per-field omission. To still honor "an untouched
 * field must not become null": an untouched field is resent with its
 * *existing* value (a no-op update, not a clear), and only a field the
 * user explicitly empties is sent as null — the two are distinguishable
 * here because the caller (company-edit-form.tsx) always passes the
 * company's current value as defaultValue, so "empty on submit" only
 * happens when the user actively cleared it.
 */

export interface UpdateCompanyFormState {
  error?: string;
  updatedId?: string;
}

function toNullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseNullableNumber(value: FormDataEntryValue | null, label: string): number | null | { error: string } {
  const str = toNullableString(value);
  if (str === null) {
    return null;
  }
  const parsed = Number(str);
  if (Number.isNaN(parsed)) {
    return { error: `${label} must be a number.` };
  }
  return parsed;
}

export async function updateCompanyForResolvedContext(
  userId: string | null,
  companyId: string,
  formData: FormData,
): Promise<UpdateCompanyFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return { error: "Missing idempotency key." };
  }

  const name = formData.get("name");
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (trimmedName === "") {
    return { error: "Name is required." };
  }

  const employeeCount = parseNullableNumber(formData.get("employeeCount"), "Employee count");
  if (employeeCount !== null && typeof employeeCount === "object") {
    return { error: employeeCount.error };
  }

  const body = {
    name: trimmedName,
    domain: toNullableString(formData.get("domain")),
    industry: toNullableString(formData.get("industry")),
    employeeCount,
    annualRevenue: toNullableString(formData.get("annualRevenue")),
    linkedinUrl: toNullableString(formData.get("linkedinUrl")),
    ownerId: toNullableString(formData.get("ownerId")),
  };

  const response = await handleUpdateCompany(userId, companyId, body, idempotencyKey);
  const data = (await response.json()) as { company?: { id: string }; error?: string };

  if (response.status === 200 && data.company) {
    return { updatedId: data.company.id };
  }
  return { error: typeof data.error === "string" ? data.error : "Failed to update the company. Please try again." };
}
