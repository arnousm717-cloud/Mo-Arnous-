"use client";

import { useState } from "react";
import { useActionState } from "react";
import { updateDealAction, type UpdateDealFormState } from "./actions";
import { withResolvedOwnerFallback, type OwnerOption } from "../../_shared/owner-option";
import type { CompanyOption } from "../../_shared/company-options";
import type { ContactOption } from "../../_shared/contact-options";
import type { PipelineOption, PipelineStageOption } from "../../_shared/pipeline-options";
import styles from "../../companies/companies.module.css";

const initialState: UpdateDealFormState = {};

export interface EditableDeal {
  id: string;
  companyId: string | null;
  primaryContactId: string | null;
  pipelineId: string;
  stageId: string;
  amount: string | null;
  currency: string;
  probability: number | null;
  expectedCloseDate: string | null;
  status: string;
  ownerId: string | null;
}

/**
 * Milestone 2.2E. Same idempotency and always-resend/explicit-null
 * discipline as ../../companies/[id]/company-edit-form.tsx for scalar
 * fields (amount/currency/probability/expectedCloseDate); same
 * originalXId relationship-preservation discipline as
 * ../../contacts/[id]/contact-edit-form.tsx, extended to five
 * relationships (company/contact/owner/pipeline/stage) instead of one —
 * see ./update-logic.ts's own comment for the full rationale.
 *
 * status has NO input control anywhere in this form — it is rendered as
 * plain read-only text, never submitted, never editable. It is always
 * server/domain-derived from stageId (Milestone 2.2B); a client cannot
 * set it through this form even in principle, since there is no field
 * for it to occupy.
 *
 * Pipeline/stage dependent select (same behavior as ../deal-form.tsx's
 * own create-time version): choosing a pipeline filters the stage
 * <select> to only that pipeline's own options (which here also include
 * a synthetic "<name> (deleted)" entry when the deal's CURRENT stage
 * belongs to a since-soft-deleted stage — merged in by ../page.tsx,
 * carrying the deal's own pipelineId so it appears under the correct
 * pipeline). `key={selectedPipelineId}` forces a fresh mount so a stale
 * stage selection from a previously-selected pipeline can never survive
 * a pipeline switch.
 */
export function DealEditForm({
  deal,
  companyOptions,
  contactOptions,
  pipelineOptions,
  stageOptions,
  ownerOptions,
}: {
  deal: EditableDeal;
  companyOptions: CompanyOption[];
  contactOptions: ContactOption[];
  pipelineOptions: PipelineOption[];
  stageOptions: PipelineStageOption[];
  ownerOptions: OwnerOption[];
}): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const boundAction = updateDealAction.bind(null, deal.id);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  const [selectedPipelineId, setSelectedPipelineId] = useState(deal.pipelineId);
  const stagesForSelectedPipeline = stageOptions.filter((s) => s.pipelineId === selectedPipelineId);

  // Same reasoning as contact-edit-form.tsx's companySelectOptions /
  // ownerSelectOptions — company/contact options may be missing the
  // deal's currently-linked (now soft-deleted) target; page.tsx already
  // merges a resolved "<name> (deleted)" entry into each options array
  // when that happens, so no further fallback synthesis is needed here
  // for those two. Owner keeps using the shared, already-established
  // withResolvedOwnerFallback (get_organization_member_identities only
  // ever returns active members, so the deactivated-owner fallback is
  // computed here, exactly like every other edit form in this app).
  const ownerSelectOptions = withResolvedOwnerFallback(ownerOptions, deal.ownerId);

  return (
    <form action={formAction} className={styles.section}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {/* Lets update-logic.ts distinguish "resubmitted unchanged" from
          "genuinely reassigned" for every relationship field — only a
          genuine reassignment is re-validated; an unrelated edit must not
          fail merely because one of these targets has since become
          inactive. */}
      <input type="hidden" name="originalCompanyId" value={deal.companyId ?? ""} />
      <input type="hidden" name="originalPrimaryContactId" value={deal.primaryContactId ?? ""} />
      <input type="hidden" name="originalOwnerId" value={deal.ownerId ?? ""} />
      <input type="hidden" name="originalPipelineId" value={deal.pipelineId} />
      <input type="hidden" name="originalStageId" value={deal.stageId} />

      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      <div className={styles.field}>
        <span id="deal-status-label">Status</span>
        <p aria-labelledby="deal-status-label">{deal.status} (derived from stage — not directly editable)</p>
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-deal-pipeline">Pipeline</label>
        <select
          id="edit-deal-pipeline"
          name="pipelineId"
          disabled={isPending}
          value={selectedPipelineId}
          onChange={(e) => setSelectedPipelineId(e.target.value)}
        >
          {pipelineOptions.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>
              {pipeline.name}
              {pipeline.isDefault ? " (default)" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-deal-stage">Stage</label>
        <select
          id="edit-deal-stage"
          name="stageId"
          disabled={isPending}
          key={selectedPipelineId}
          defaultValue={selectedPipelineId === deal.pipelineId ? deal.stageId : undefined}
        >
          {stagesForSelectedPipeline.length === 0 ? (
            <option value="">No active stages in this pipeline</option>
          ) : (
            stagesForSelectedPipeline.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))
          )}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-deal-company">Company</label>
        <select id="edit-deal-company" name="companyId" defaultValue={deal.companyId ?? ""} disabled={isPending}>
          <option value="">No company</option>
          {companyOptions.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-deal-contact">Primary contact</label>
        <select
          id="edit-deal-contact"
          name="primaryContactId"
          defaultValue={deal.primaryContactId ?? ""}
          disabled={isPending}
        >
          <option value="">No contact</option>
          {contactOptions.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-deal-amount">Amount</label>
        <input
          id="edit-deal-amount"
          type="number"
          name="amount"
          min={0}
          step="0.01"
          inputMode="decimal"
          defaultValue={deal.amount ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-deal-currency">Currency</label>
        <input
          id="edit-deal-currency"
          type="text"
          name="currency"
          maxLength={3}
          defaultValue={deal.currency}
          disabled={isPending}
          style={{ textTransform: "uppercase" }}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-deal-probability">Probability (%)</label>
        <input
          id="edit-deal-probability"
          type="number"
          name="probability"
          min={0}
          max={100}
          step={1}
          defaultValue={deal.probability ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-deal-expected-close-date">Expected close date</label>
        <input
          id="edit-deal-expected-close-date"
          type="date"
          name="expectedCloseDate"
          defaultValue={deal.expectedCloseDate ?? ""}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="edit-deal-owner">Owner</label>
        <select id="edit-deal-owner" name="ownerId" defaultValue={deal.ownerId ?? ""} disabled={isPending}>
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
