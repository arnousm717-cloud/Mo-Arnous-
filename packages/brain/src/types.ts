/**
 * Milestone 4.1 Phase 2 canonical entity-profile shapes (Detailed Design
 * §H, amended by the Final Design Challenge §E.2). Deterministic, pure
 * data — no LLM/model call anywhere in this package. Every field is
 * sourced only from packages/crm's own exported Contact/Company/Deal
 * types. Fixed key set, explicit nulls (never an omitted key) — see
 * projector.ts's canonicalizeProfile for why the serialization itself
 * always reconstructs this exact key order regardless of how the object
 * was built or round-tripped through jsonb.
 *
 * Deliberately excludes: id, organizationId (redundant with the owning
 * brain_entity_profiles row's own context) and createdAt/updatedAt (row
 * metadata, not entity content — updatedAt specifically is used as the
 * repository layer's freshness/computed_at token, never duplicated inside
 * the profile JSON itself).
 */

export type EntityType = "contact" | "company" | "deal";

export interface CanonicalContactProfile {
  profileVersion: 1;
  entityType: "contact";
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  linkedinUrl: string | null;
  lifecycleStage: string | null;
  companyId: string | null;
  ownerId: string | null;
  isDeleted: boolean;
}

export interface CanonicalCompanyProfile {
  profileVersion: 1;
  entityType: "company";
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  /** Numeric-as-string, matching Company.annualRevenue's own round-tripping (node-postgres returns `numeric` as a string to avoid float precision loss). */
  annualRevenue: string | null;
  linkedinUrl: string | null;
  enrichmentStatus: string | null;
  ownerId: string | null;
  isDeleted: boolean;
}

export interface CanonicalDealProfile {
  profileVersion: 1;
  entityType: "deal";
  companyId: string | null;
  primaryContactId: string | null;
  pipelineId: string;
  stageId: string;
  /** Numeric-as-string, matching Deal.amount's own round-tripping. */
  amount: string | null;
  currency: string;
  probability: number | null;
  expectedCloseDate: string | null;
  status: "open" | "won" | "lost";
  ownerId: string | null;
  isDeleted: boolean;
}

export type CanonicalProfile = CanonicalContactProfile | CanonicalCompanyProfile | CanonicalDealProfile;
