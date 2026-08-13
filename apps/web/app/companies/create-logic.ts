import { handleCreateCompany } from "../api/v1/companies/handlers";

/**
 * Kept out of actions.ts ("use server") deliberately — same reasoning as
 * apps/web/app/agency/create-client-org-logic.ts: every export of a "use
 * server" file becomes an independently callable RPC endpoint, so a
 * function that trusts an already-authenticated userId must not live
 * there. Reuses the existing 2.1F-B/2.1F-A handler in-process (ADR-004:
 * no network hop, no browser fetch to /api/v1/*) — resolveActor, can(),
 * mass-assignment allowlisting, and Idempotency-Key reservation/replay
 * are all the real, unduplicated 2.1F logic, not a second copy of it.
 */

export interface CreateCompanyFormState {
  error?: string;
  createdId?: string;
}

function trimmedOrUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * FormData has no types — every value is a string or File — so this is
 * where the one genuinely-needed coercion (numeric fields) happens, not a
 * second copy of packages/crm's own validation. An invalid number is
 * rejected here with a plain, safe message before handleCreateCompany
 * (and therefore any database round trip) is ever reached; every other
 * rule (identity, owner/company relationship, etc. — not applicable to
 * companies) remains exclusively packages/crm's.
 */
function parseOptionalNumber(value: FormDataEntryValue | null, label: string): number | undefined | { error: string } {
  const raw = trimmedOrUndefined(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    return { error: `${label} must be a number.` };
  }
  return parsed;
}

export async function createCompanyForResolvedContext(
  userId: string | null,
  formData: FormData,
): Promise<CreateCompanyFormState> {
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    // Not user-facing in practice (the form always renders the hidden
    // field itself) — a safety net against a malformed/forged submission,
    // not a real expected path.
    return { error: "Missing idempotency key." };
  }

  const employeeCount = parseOptionalNumber(formData.get("employeeCount"), "Employee count");
  if (employeeCount && typeof employeeCount === "object") {
    return { error: employeeCount.error };
  }

  const name = formData.get("name");
  const body: Record<string, unknown> = {
    name: typeof name === "string" ? name.trim() : "",
  };
  const domain = trimmedOrUndefined(formData.get("domain"));
  if (domain !== undefined) body.domain = domain;
  const industry = trimmedOrUndefined(formData.get("industry"));
  if (industry !== undefined) body.industry = industry;
  if (employeeCount !== undefined) body.employeeCount = employeeCount;
  const annualRevenue = trimmedOrUndefined(formData.get("annualRevenue"));
  if (annualRevenue !== undefined) body.annualRevenue = annualRevenue;
  const linkedinUrl = trimmedOrUndefined(formData.get("linkedinUrl"));
  if (linkedinUrl !== undefined) body.linkedinUrl = linkedinUrl;
  const ownerId = trimmedOrUndefined(formData.get("ownerId"));
  if (ownerId !== undefined) body.ownerId = ownerId;

  const response = await handleCreateCompany(userId, body, idempotencyKey);
  const data = (await response.json()) as { company?: { id: string }; error?: string };

  if (response.status === 201 && data.company) {
    return { createdId: data.company.id };
  }
  return { error: typeof data.error === "string" ? data.error : "Failed to create the company. Please try again." };
}
