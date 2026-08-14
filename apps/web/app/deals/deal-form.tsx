"use client";

import { useState } from "react";
import { useActionState } from "react";
import { createDealAction, type CreateDealFormState } from "./actions";
import type { CompanyOption } from "../_shared/company-options";
import type { ContactOption } from "../_shared/contact-options";
import type { PipelineOption, PipelineStageOption } from "../_shared/pipeline-options";
import type { OwnerOption } from "../_shared/owner-option";
import styles from "../companies/companies.module.css";

const initialState: CreateDealFormState = {};

/**
 * Inline create form on /deals (locked decision — no /deals/new), same
 * Idempotency-Key discipline as ../companies/company-form.tsx.
 *
 * Pipeline/stage dependent select (Milestone 2.2E §7): choosing a
 * pipeline filters the stage <select> to only that pipeline's own active
 * stages — presentation-only client state, never the authoritative
 * check. The `key={selectedPipelineId}` on the stage <select> forces a
 * fresh mount (and therefore a fresh defaultValue) whenever the pipeline
 * changes, so a stage belonging to the PREVIOUSLY selected pipeline can
 * never remain selected in the DOM after switching pipelines. The server
 * action still passes stageId/pipelineId straight through to
 * createDealForResolvedContext -> handleCreateDeal -> packages/crm's own
 * validateStageRelationship, which independently re-verifies the stage
 * actually belongs to the submitted pipeline regardless of what the
 * client rendered — this component narrows the UI's own choices, it does
 * not (and cannot) narrow what a request could otherwise contain.
 *
 * No status input anywhere — status is fully server/domain-derived from
 * the chosen stage (Milestone 2.2B).
 */
export function DealForm({
  companyOptions,
  contactOptions,
  pipelineOptions,
  stageOptions,
  ownerOptions,
}: {
  companyOptions: CompanyOption[];
  contactOptions: ContactOption[];
  pipelineOptions: PipelineOption[];
  stageOptions: PipelineStageOption[];
  ownerOptions: OwnerOption[];
}): React.ReactElement {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [state, formAction, isPending] = useActionState(createDealAction, initialState);

  const defaultPipelineId = pipelineOptions.find((p) => p.isDefault)?.id ?? pipelineOptions[0]?.id ?? "";
  const [selectedPipelineId, setSelectedPipelineId] = useState(defaultPipelineId);
  const stagesForSelectedPipeline = stageOptions.filter((s) => s.pipelineId === selectedPipelineId);

  return (
    <form action={formAction} className={styles.section}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {state.error ? (
        <p role="alert" className={styles.formError}>
          {state.error}
        </p>
      ) : null}

      {pipelineOptions.length === 0 ? (
        <p role="alert" className={styles.formError}>
          No pipeline exists yet for this organization — a deal cannot be created until at least one pipeline with a
          stage exists.
        </p>
      ) : (
        <>
          <div className={styles.field}>
            <label htmlFor="deal-pipeline">Pipeline</label>
            <select
              id="deal-pipeline"
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
            <label htmlFor="deal-stage">Stage</label>
            <select id="deal-stage" name="stageId" disabled={isPending} key={selectedPipelineId}>
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
        </>
      )}

      <div className={styles.field}>
        <label htmlFor="deal-company">Company</label>
        <select id="deal-company" name="companyId" disabled={isPending} defaultValue="">
          <option value="">No company</option>
          {companyOptions.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="deal-contact">Primary contact</label>
        <select id="deal-contact" name="primaryContactId" disabled={isPending} defaultValue="">
          <option value="">No contact</option>
          {contactOptions.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="deal-amount">Amount</label>
        <input id="deal-amount" type="number" name="amount" min={0} step="0.01" inputMode="decimal" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="deal-currency">Currency</label>
        <input
          id="deal-currency"
          type="text"
          name="currency"
          maxLength={3}
          defaultValue="EUR"
          disabled={isPending}
          style={{ textTransform: "uppercase" }}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="deal-probability">Probability (%)</label>
        <input
          id="deal-probability"
          type="number"
          name="probability"
          min={0}
          max={100}
          step={1}
          disabled={isPending}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="deal-expected-close-date">Expected close date</label>
        <input id="deal-expected-close-date" type="date" name="expectedCloseDate" disabled={isPending} />
      </div>

      <div className={styles.field}>
        <label htmlFor="deal-owner">Owner</label>
        <select id="deal-owner" name="ownerId" disabled={isPending} defaultValue="">
          <option value="">No owner</option>
          {ownerOptions.map((owner) => (
            <option key={owner.userId} value={owner.userId}>
              {owner.label}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" className={styles.submitButton} disabled={isPending || pipelineOptions.length === 0}>
        {isPending ? "Creating…" : "Create deal"}
      </button>
    </form>
  );
}
