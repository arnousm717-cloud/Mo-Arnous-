"use client";

import { useState } from "react";
import { useActionState } from "react";
import { createContactAction, type CreateContactFormState } from "./actions";
import type { OwnerOption } from "../_shared/owner-option";
import type { CompanyOption } from "./company-options";
import styles from "../companies/companies.module.css";

const initialState: CreateContactFormState = {};
const LIFECYCLE_STAGES = ["lead", "prospect", "customer", "inactive"] as const;

/**
 * Inline create form on /contacts (locked decision — no /contacts/new).
 * Same Idempotency-Key discipline as ../companies/company-form.tsx: one
 * key per mounted form instance, stable across retries, replaced only on
 * remount (after the Server Action's redirect() on success).
 *
 * The identity invariant (at least one of firstName/lastName/email) is
 * not enforced here as a security rule — this hint text is UX only;
 * packages/crm's own ValidationError remains authoritative and is
 * surfaced via state.error if violated.
 */
export function ContactForm({
  companyOptions,
  ownerOptions,
}: {
  companyOptions: CompanyOption[];
  ownerOptions: OwnerOption[];
}): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [state, formAction, isPending] = useActionState(createContactAction, initialState);

  return (
    <form action={formAction} className={styles.section}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <p>Provide at least one of first name, last name, or email.</p>

      <div className={styles.field}>
        <label htmlFor="contact-first-name">First name</label>
        <input id="contact-first-name" type="text" name="firstName" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="contact-last-name">Last name</label>
        <input id="contact-last-name" type="text" name="lastName" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="contact-email">Email</label>
        <input id="contact-email" type="email" name="email" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="contact-phone">Phone</label>
        <input id="contact-phone" type="tel" name="phone" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="contact-job-title">Job title</label>
        <input id="contact-job-title" type="text" name="jobTitle" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="contact-linkedin-url">LinkedIn URL</label>
        <input id="contact-linkedin-url" type="url" name="linkedinUrl" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="contact-lifecycle-stage">Lifecycle stage</label>
        <select id="contact-lifecycle-stage" name="lifecycleStage" disabled={isPending} defaultValue="">
          <option value="">None</option>
          {LIFECYCLE_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {stage}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="contact-company">Company</label>
        <select id="contact-company" name="companyId" disabled={isPending} defaultValue="">
          <option value="">No company</option>
          {companyOptions.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="contact-owner">Owner</label>
        <select id="contact-owner" name="ownerId" disabled={isPending} defaultValue="">
          <option value="">No owner</option>
          {ownerOptions.map((owner) => (
            <option key={owner.userId} value={owner.userId}>
              {owner.label}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" className={styles.submitButton} disabled={isPending}>
        {isPending ? "Creating…" : "Create contact"}
      </button>
    </form>
  );
}
