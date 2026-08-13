"use client";

import { useState } from "react";
import { useActionState } from "react";
import { createCompanyAction, type CreateCompanyFormState } from "./actions";
import type { OwnerOption } from "./owner-options";
import styles from "./companies.module.css";

const initialState: CreateCompanyFormState = {};

/**
 * Inline create form on /companies (locked decision — no /companies/new).
 * The Idempotency-Key is generated once per mounted form instance
 * (crypto.randomUUID(), stable across re-renders/retries of this same
 * instance) and passed as a plain hidden field into the Server Action,
 * which forwards it straight into handleCreateCompany exactly as the
 * Idempotency-Key HTTP header would be — same 2.1F-A reservation/replay
 * guarantee, no second idempotency mechanism. A genuinely new create
 * action gets a new key for free: React remounts this component (and
 * therefore re-runs the useState initializer) after the Server Action's
 * redirect() navigates away from /companies on success.
 */
export function CompanyForm({ ownerOptions }: { ownerOptions: OwnerOption[] }): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [state, formAction, isPending] = useActionState(createCompanyAction, initialState);

  return (
    <form action={formAction} className={styles.section}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor="company-name">Name</label>
        <input id="company-name" type="text" name="name" required disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="company-domain">Domain</label>
        <input id="company-domain" type="text" name="domain" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="company-industry">Industry</label>
        <input id="company-industry" type="text" name="industry" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="company-employee-count">Employee count</label>
        <input id="company-employee-count" type="number" name="employeeCount" min={0} disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="company-annual-revenue">Annual revenue</label>
        <input id="company-annual-revenue" type="text" name="annualRevenue" inputMode="decimal" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="company-linkedin-url">LinkedIn URL</label>
        <input id="company-linkedin-url" type="url" name="linkedinUrl" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="company-owner">Owner</label>
        <select id="company-owner" name="ownerId" disabled={isPending} defaultValue="">
          <option value="">No owner</option>
          {ownerOptions.map((owner) => (
            <option key={owner.userId} value={owner.userId}>
              {owner.userId}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" className={styles.submitButton} disabled={isPending}>
        {isPending ? "Creating…" : "Create company"}
      </button>
    </form>
  );
}
