import type { RelatedToType } from "@ai-revenue-os/crm";

/**
 * Milestone 2.3E. The exact three frozen CRM record types this shared
 * implementation supports — deliberately re-exported (not widened) from
 * packages/crm's own RelatedToType, since that is the single source of
 * truth for which types the domain/API layers actually accept. No
 * abstraction beyond these three is introduced (explicit instruction:
 * "do not over-generalize beyond these three frozen types").
 */
export type CrmRecordType = RelatedToType;

export interface ResolvedCrmActor {
  userId: string;
  organizationId: string;
  roleKey: string;
}
