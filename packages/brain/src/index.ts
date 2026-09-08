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
export { bootstrapBrainForOrganization, findProfilesNeedingEmbedding, type BackfillReport, type EmbeddingBackfillReport } from "./backfill";
export { BrainError, MalformedEventPayloadError } from "./errors";
export {
  upsertEntityEmbedding,
  computeContentHash,
  isValidEmbeddingVector,
  EMBEDDING_DIMENSION,
  type EmbeddingWriteBackInput,
  type EmbeddingWriteBackResult,
} from "./embeddings";
export {
  searchEntityProfilesByEmbedding,
  resolveSearchLimit,
  isZeroNormVector,
  SearchValidationError,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  type SearchEntityProfilesInput,
  type EntityProfileSearchResult,
} from "./search";
