"use client";

import { useState } from "react";
import { useActionState } from "react";
import { updateContactAction, type UpdateContactFormState } from "./actions";
import { withResolvedOwnerFallback, type OwnerOption } from "../../_shared/owner-option";
import type { CompanyOption } from "../../_shared/company-options";
import styles from "../../companies/companies.module.css";

const initialState: UpdateContactFormState = {};
const LIFECYCLE_STAGES = ["lead", "prospect", "customer", "inactive"] as const;

export interface EditableContact {
  id: string;
  companyId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  linkedinUrl: string | null;
  lifecycleStage: string | null;
  ownerId: string | null;
}

/**
 * Same idempotency and always-resend/explicit-null discipline as
 * ../../companies/[id]/company-edit-form.tsx — see its own comment for
 * the full rationale, not repeated here.
 */
export function ContactEditForm({
  contact,
  companyOptions,
  ownerOptions,
}: {
  contact: EditableContact;
  companyOptions: CompanyOption[];
  ownerOptions: OwnerOption[];
}): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const boundAction = updateContactAction.bind(null, contact.id);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  // A contact's linked company may have been soft-deleted since it was
  // linked — listActiveCompanyOptions (like listCompanies/getCompanyById)
  // deliberately excludes soft-deleted companies, so it would be absent
  // from companyOptions. Without this fallback, the <select> would fall
  // back to its first option ("No company") and an unrelated resubmit
  // would silently clear the contact's real, still-stored companyId —
  // exactly the data loss the locked "must not lose its stored companyId"
  // requirement forbids. Only the id is available (no name can be read
  // for a soft-deleted company through any existing primitive), so it is
  // shown as-is, consistent with the accepted owner-display limitation.
  const companySelectOptions =
    contact.companyId && !companyOptions.some((c) => c.id === contact.companyId)
      ? [...companyOptions, { id: contact.companyId, name: contact.companyId }]
      : companyOptions;

  // Same reasoning as companySelectOptions above, for the owner
  // relationship: get_organization_member_identities only ever returns
  // active members, so a since-deactivated owner needs the same
  // preserved-selection fallback (see ../../_shared/owner-options.ts).
  const ownerSelectOptions = withResolvedOwnerFallback(ownerOptions, contact.ownerId);

  return (
    <form action={formAction} className={styles.section}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {/* Lets update-logic.ts distinguish "companyId resubmitted unchanged"
          from "companyId genuinely reassigned" — only a genuine
          reassignment should be re-validated as pointing to an active
          company; an unrelated edit must not fail merely because the
          contact's already-linked company has since been soft-deleted. */}
      <input type="hidden" name="originalCompanyId" value={contact.companyId ?? ""} />

      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <div className={styles.field}>
        <label htmlFor="edit-contact-first-name">First name</label>
        <input
          id="edit-contact-first-name"
          type="text"
          name="firstName"
          defaultValue={contact.firstName ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-contact-last-name">Last name</label>
        <input
          id="edit-contact-last-name"
          type="text"
          name="lastName"
          defaultValue={contact.lastName ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-contact-email">Email</label>
        <input id="edit-contact-email" type="email" name="email" defaultValue={contact.email ?? ""} disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-contact-phone">Phone</label>
        <input id="edit-contact-phone" type="tel" name="phone" defaultValue={contact.phone ?? ""} disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-contact-job-title">Job title</label>
        <input
          id="edit-contact-job-title"
          type="text"
          name="jobTitle"
          defaultValue={contact.jobTitle ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-contact-linkedin-url">LinkedIn URL</label>
        <input
          id="edit-contact-linkedin-url"
          type="url"
          name="linkedinUrl"
          defaultValue={contact.linkedinUrl ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-contact-lifecycle-stage">Lifecycle stage</label>
        <select
          id="edit-contact-lifecycle-stage"
          name="lifecycleStage"
          defaultValue={contact.lifecycleStage ?? ""}
          disabled={isPending}
        >
          <option value="">None</option>
          {LIFECYCLE_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {stage}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-contact-company">Company</label>
        <select id="edit-contact-company" name="companyId" defaultValue={contact.companyId ?? ""} disabled={isPending}>
          <option value="">No company</option>
          {companySelectOptions.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-contact-owner">Owner</label>
        <select id="edit-contact-owner" name="ownerId" defaultValue={contact.ownerId ?? ""} disabled={isPending}>
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
