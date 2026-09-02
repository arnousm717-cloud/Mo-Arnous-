export { checkCookieTrackingConsent } from "./consent";
export { resolveOrCreateVisitor, type WebsiteVisitor } from "./visitors";
export {
  resolveOrCreateVisitorSession,
  type VisitorSession,
  type ResolveOrCreateVisitorSessionInput,
} from "./sessions";
export {
  appendVisitorEvent,
  type VisitorEvent,
  type EventType,
  type AppendVisitorEventInput,
} from "./events";
export { ingestTrackingEvent, type IngestTrackingEventInput, type IngestResult } from "./ingest";
export {
  identifyVisitor,
  unlinkVisitorIdentityOnWithdrawal,
  type IdentifyVisitorInput,
  type IdentifyResult,
  type IdentifyRejectionReason,
} from "./identify";
export { IntelligenceError, InvalidEventTypeError, InvalidSessionRelationshipError } from "./errors";
export {
  recordEnrichmentResult,
  recordWorkflowRunStarted,
  recordWorkflowRunTriggerFailed,
  DEFAULT_ENRICHMENT_TTL_DAYS,
  type EnrichmentEntityType,
  type EnrichmentErrorClassification,
  type RecordEnrichmentResultInput,
  type RecordEnrichmentResultOutcome,
} from "./enrichment";
