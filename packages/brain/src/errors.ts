/**
 * Domain error model (Milestone 4.1 Phase 2), mirroring packages/crm's own
 * shape (message + a stable, machine-readable code) so a caller can
 * instanceof-check instead of string-comparing a code.
 */

export class BrainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

/** An emitted event's own payload did not carry the entity id this
 * package's ingestion consumers require — should be unreachable in
 * practice (every emit_<entity>_event function always populates it), a
 * defensive guard against a malformed/forged event, never a normal outcome. */
export class MalformedEventPayloadError extends BrainError {
  constructor(message: string) {
    super(message, "malformed_event_payload");
    this.name = "MalformedEventPayloadError";
  }
}
