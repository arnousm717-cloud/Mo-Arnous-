/**
 * Domain error model (Milestone 2.1D). No HTTP status codes anywhere in
 * this package — 2.1F's route handlers instanceof-check these and decide
 * the response. Mirrors packages/auth's AuthError shape (message + a
 * stable, machine-readable code), split into distinct subclasses so a
 * caller can instanceof-check instead of string-comparing a code.
 */

export class CrmError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

/** Field-level validation failures: empty company name, invalid
 * lifecycle_stage, the contact identity invariant, malformed pagination
 * input. */
export class ValidationError extends CrmError {
  constructor(message: string) {
    super(message, "validation_error");
    this.name = "ValidationError";
  }
}

/** A contact create/update collided with the active-email uniqueness
 * constraint (organization-scoped, case-insensitive, active contacts
 * only) — 2.1F maps this to 409. */
export class DuplicateContactEmailError extends CrmError {
  constructor(message: string) {
    super(message, "duplicate_contact_email");
    this.name = "DuplicateContactEmailError";
  }
}

/** companyId does not resolve to an active company in the caller's own
 * organization. Deliberately the same error for "does not exist",
 * "belongs to another organization", and "is soft-deleted" — these must
 * stay indistinguishable at this boundary (Milestone 2.1D decision). */
export class InvalidCompanyRelationshipError extends CrmError {
  constructor(message: string) {
    super(message, "invalid_company_relationship");
    this.name = "InvalidCompanyRelationshipError";
  }
}

/** ownerId does not resolve to a user with an active membership in the
 * caller's own organization. Deliberately the same error for "does not
 * exist", "belongs to another organization", and "membership not
 * active" — these must stay indistinguishable at this boundary. */
export class InvalidOwnerError extends CrmError {
  constructor(message: string) {
    super(message, "invalid_owner");
    this.name = "InvalidOwnerError";
  }
}
