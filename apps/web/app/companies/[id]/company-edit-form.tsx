"use client";

import { useState } from "react";
import { useActionState } from "react";
import { updateCompanyAction, type UpdateCompanyFormState } from "./actions";
import { withResolvedOwnerFallback, type OwnerOption } from "../../_shared/owner-option";
import styles from "../companies.module.css";

const initialState: UpdateCompanyFormState = {};

export interface EditableCompany {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  annualRevenue: string | null;
  linkedinUrl: string | null;
  ownerId: string | null;
}

/**
 * Same Idempotency-Key discipline as ../company-form.tsx: one key per
 * mounted form instance, stable across retries, replaced only when this
 * component remounts (a fresh page load after a successful save
 * redirects back to the detail page, per the locked "redirect/re-render"
 * success behavior).
 *
 * Every field is always shown pre-filled with the company's current
 * value and always resubmitted — an untouched field round-trips its
 * existing value (a no-op update), never becomes null; only a field the
 * user actively clears becomes null (see ../[id]/update-logic.ts).
 */
export function CompanyEditForm({
  company,
  ownerOptions,
}: {
  company: EditableCompany;
  ownerOptions: OwnerOption[];
}): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const boundAction = updateCompanyAction.bind(null, company.id);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  // The currently-assigned owner may no longer hold an active membership
  // (get_organization_member_identities only ever returns active
  // members) — without this fallback, a <select> whose defaultValue
  // matches no <option> silently renders (and, on submit, silently
  // sends) its first option's value instead, clearing a still-real
  // owner assignment as a side effect of an unrelated field edit.
  const ownerSelectOptions = withResolvedOwnerFallback(ownerOptions, company.ownerId);

  return (
    <form action={formAction} className={styles.section}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor="edit-company-name">Name</label>
        <input id="edit-company-name" type="text" name="name" required defaultValue={company.name} disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-company-domain">Domain</label>
        <input
          id="edit-company-domain"
          type="text"
          name="domain"
          defaultValue={company.domain ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-company-industry">Industry</label>
        <input
          id="edit-company-industry"
          type="text"
          name="industry"
          defaultValue={company.industry ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-company-employee-count">Employee count</label>
        <input
          id="edit-company-employee-count"
          type="number"
          name="employeeCount"
          min={0}
          defaultValue={company.employeeCount ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-company-annual-revenue">Annual revenue</label>
        <input
          id="edit-company-annual-revenue"
          type="text"
          name="annualRevenue"
          inputMode="decimal"
          defaultValue={company.annualRevenue ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-company-linkedin-url">LinkedIn URL</label>
        <input
          id="edit-company-linkedin-url"
          type="url"
          name="linkedinUrl"
          defaultValue={company.linkedinUrl ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-company-owner">Owner</label>
        <select id="edit-company-owner" name="ownerId" defaultValue={company.ownerId ?? ""} disabled={isPending}>
          <option value="">No owner</option>
          {ownerSelectOptions.map((owner) => (
            <option key={owner.userId} value={owner.userId}>
              {owner.label}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" className={styles.submitButton} disabled={isPending}>
        {isPending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
