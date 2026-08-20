export { getPool, closePool } from "./pool";
export { withTenantContext, runInClientOrTransaction, type RequestContext } from "./tenant-context";
export {
  dispatchPendingEvents,
  type DomainEvent,
  type EventConsumer,
  type DispatchSummary,
} from "./events";
export {
  verifyEnvironmentTarget,
  extractSupabaseAuthProjectRef,
  extractDatabaseProjectRef,
  EXPECTED_STAGING_PROJECT_REF,
  type DeploymentContext,
  type EnvironmentTargetInputs,
  type EnvironmentTargetResult,
} from "./environment-target";
export {
  classifyMigrationSql,
  type DestructiveCategory,
  type DestructiveFinding,
  type ClassificationResult,
} from "./migration-safety";
