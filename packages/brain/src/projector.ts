import type { Contact, Company, Deal } from "@ai-revenue-os/crm";
import type { CanonicalContactProfile, CanonicalCompanyProfile, CanonicalDealProfile, CanonicalProfile } from "./types";

/**
 * Milestone 4.1 Phase 2 (Detailed Design §H, Final Design Challenge §A/§B).
 * Pure, deterministic projection functions — no I/O, no database, no
 * network, no LLM/model call. Given the same source row and isDeleted
 * flag, always produces byte-identical canonical output.
 *
 * `isDeleted` is supplied by the caller (packages/brain/src/ingestion.ts),
 * never derived here from the row's own deletedAt — a plain getXById read
 * structurally never returns a row with deletedAt !== null (Final Design
 * Challenge §B), so deriving isDeleted from the row itself would make the
 * tombstone contract unreachable. The caller decides isDeleted from the
 * triggering event type (`.deleted` vs `.created`/`.updated`) and which
 * read path (getXById vs getXByIdIncludingDeleted) it used.
 */

export function projectContactProfile(contact: Contact, isDeleted: boolean): CanonicalContactProfile {
  return {
    profileVersion: 1,
    entityType: "contact",
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    jobTitle: contact.jobTitle,
    linkedinUrl: contact.linkedinUrl,
    lifecycleStage: contact.lifecycleStage,
    companyId: contact.companyId,
    ownerId: contact.ownerId,
    isDeleted,
  };
}

export function projectCompanyProfile(company: Company, isDeleted: boolean): CanonicalCompanyProfile {
  return {
    profileVersion: 1,
    entityType: "company",
    name: company.name,
    domain: company.domain,
    industry: company.industry,
    employeeCount: company.employeeCount,
    annualRevenue: company.annualRevenue,
    linkedinUrl: company.linkedinUrl,
    enrichmentStatus: company.enrichmentStatus,
    ownerId: company.ownerId,
    isDeleted,
  };
}

export function projectDealProfile(deal: Deal, isDeleted: boolean): CanonicalDealProfile {
  return {
    profileVersion: 1,
    entityType: "deal",
    companyId: deal.companyId,
    primaryContactId: deal.primaryContactId,
    pipelineId: deal.pipelineId,
    stageId: deal.stageId,
    amount: deal.amount,
    currency: deal.currency,
    probability: deal.probability,
    expectedCloseDate: deal.expectedCloseDate,
    status: deal.status,
    ownerId: deal.ownerId,
    isDeleted,
  };
}

/**
 * Deterministic serialized form, suitable for equality comparison
 * (packages/brain/src/repository.ts's own history-write gate) — used both
 * for a freshly-projected profile AND for a profile read back from
 * `brain_entity_profiles.profile` (a `jsonb` column). Postgres's `jsonb`
 * storage does not preserve the original key insertion order (unlike
 * `json`), so comparing `JSON.stringify(freshlyBuiltObject)` directly
 * against `JSON.stringify(objectAsReturnedByNodePostgres)` would produce
 * false "content changed" positives purely from key reordering, on every
 * single reconciliation. This function avoids that entirely by always
 * reconstructing a NEW object literal with an explicit, hardcoded key
 * order before stringifying — regardless of the input object's own key
 * order — so two calls with semantically identical content always produce
 * byte-identical output.
 */
export function canonicalizeProfile(profile: CanonicalProfile): string {
  switch (profile.entityType) {
    case "contact":
      return JSON.stringify({
        profileVersion: profile.profileVersion,
        entityType: profile.entityType,
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        phone: profile.phone,
        jobTitle: profile.jobTitle,
        linkedinUrl: profile.linkedinUrl,
        lifecycleStage: profile.lifecycleStage,
        companyId: profile.companyId,
        ownerId: profile.ownerId,
        isDeleted: profile.isDeleted,
      });
    case "company":
      return JSON.stringify({
        profileVersion: profile.profileVersion,
        entityType: profile.entityType,
        name: profile.name,
        domain: profile.domain,
        industry: profile.industry,
        employeeCount: profile.employeeCount,
        annualRevenue: profile.annualRevenue,
        linkedinUrl: profile.linkedinUrl,
        enrichmentStatus: profile.enrichmentStatus,
        ownerId: profile.ownerId,
        isDeleted: profile.isDeleted,
      });
    case "deal":
      return JSON.stringify({
        profileVersion: profile.profileVersion,
        entityType: profile.entityType,
        companyId: profile.companyId,
        primaryContactId: profile.primaryContactId,
        pipelineId: profile.pipelineId,
        stageId: profile.stageId,
        amount: profile.amount,
        currency: profile.currency,
        probability: profile.probability,
        expectedCloseDate: profile.expectedCloseDate,
        status: profile.status,
        ownerId: profile.ownerId,
        isDeleted: profile.isDeleted,
      });
  }
}
