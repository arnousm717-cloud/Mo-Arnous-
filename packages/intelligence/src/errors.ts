/**
 * Domain error model (Milestone 3.1B). Mirrors packages/crm's CrmError
 * shape exactly (message + a stable, machine-readable code) — no HTTP
 * status codes, no ApiErrorCode, no NextResponse anywhere in this
 * package. A future 3.1C route handler instanceof-checks these and
 * decides the response, exactly as apps/web already does for every
 * CrmError subclass.
 *
 * Consent-absent and tracking-site-revoked are deliberately NOT
 * exceptions here — those are expected, routine control-flow outcomes
 * for a public tracking beacon, represented by IngestResult's
 * discriminated union instead (see ingest.ts), mirroring
 * packages/compliance's own previewUserErasure/previewContactErasure
 * precedent (an expected "cannot proceed" outcome returned as data, not
 * thrown).
 */

export class IntelligenceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

/** eventType is not one of pageview/form_submit/click — rejected before
 * the database's own CHECK constraint would otherwise surface it. */
export class InvalidEventTypeError extends IntelligenceError {
  constructor(message: string) {
    super(message, "invalid_event_type");
    this.name = "InvalidEventTypeError";
  }
}

/** sessionId does not resolve to a visitor_session in the caller's own
 * organization — surfaces the visitor_events_session_org_fk violation as
 * a typed error instead of a raw foreign-key error, mirroring
 * packages/crm's InvalidXRelationshipError family exactly. */
export class InvalidSessionRelationshipError extends IntelligenceError {
  constructor(message: string) {
    super(message, "invalid_session_relationship");
    this.name = "InvalidSessionRelationshipError";
  }
}
