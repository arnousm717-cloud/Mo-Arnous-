export {
  type EntityType,
  type CanonicalProfile,
  type CanonicalContactProfile,
  type CanonicalCompanyProfile,
  type CanonicalDealProfile,
} from "./types";
export { projectContactProfile, projectCompanyProfile, projectDealProfile, canonicalizeProfile } from "./projector";
export {
  upsertEntityProfile,
  claimBrainProjectionRun,
  completeBrainProjectionRun,
  getSyncState,
  upsertSyncState,
  BRAIN_PROJECTION_WORKFLOW_KEY,
  type UpsertEntityProfileInput,
  type UpsertEntityProfileResult,
  type SyncStateCursor,
} from "./repository";
export {
  createBrainProjectionConsumer,
  contactProjectionConsumer,
  companyProjectionConsumer,
  dealProjectionConsumer,
  EVENT_TYPES_BY_ENTITY,
  type ReconcileOutcome,
} from "./ingestion";
export { bootstrapBrainForOrganization, type BackfillReport } from "./backfill";
export { BrainError, MalformedEventPayloadError } from "./errors";
