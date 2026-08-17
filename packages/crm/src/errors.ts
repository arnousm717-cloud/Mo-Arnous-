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

/** primaryContactId does not resolve to an active contact in the caller's
 * own organization (Milestone 2.2B). Same indistinguishability rule as
 * InvalidCompanyRelationshipError. */
export class InvalidContactRelationshipError extends CrmError {
  constructor(message: string) {
    super(message, "invalid_contact_relationship");
    this.name = "InvalidContactRelationshipError";
  }
}

/** pipelineId does not resolve to an active pipeline in the caller's own
 * organization (Milestone 2.2B). Same indistinguishability rule as
 * InvalidCompanyRelationshipError. */
export class InvalidPipelineRelationshipError extends CrmError {
  constructor(message: string) {
    super(message, "invalid_pipeline_relationship");
    this.name = "InvalidPipelineRelationshipError";
  }
}

/** stageId does not resolve to an active stage belonging to the supplied
 * pipelineId in the caller's own organization (Milestone 2.2B). One error
 * for "does not exist", "belongs to another organization", "is
 * soft-deleted", AND "belongs to a different pipeline" — mirrors the
 * database's own two-composite-FK design (deals_stage_org_fk +
 * deals_stage_pipeline_fk) at the domain layer, with a friendlier typed
 * error instead of a raw foreign-key-violation surfacing to a caller. */
export class InvalidStageRelationshipError extends CrmError {
  constructor(message: string) {
    super(message, "invalid_stage_relationship");
    this.name = "InvalidStageRelationshipError";
  }
}

/** softDeletePipeline's target is the organization's current active
 * default pipeline (Milestone 2.2B, closing 2.2A's deferred zero-default
 * gap at the domain layer). Callers must switch the default to a
 * different active pipeline via setDefaultPipeline first — this package
 * deliberately does not auto-select a replacement (no frozen design or
 * existing architecture supports inventing that selection logic). */
export class CannotDeleteDefaultPipelineError extends CrmError {
  constructor(message: string) {
    super(message, "cannot_delete_default_pipeline");
    this.name = "CannotDeleteDefaultPipelineError";
  }
}

/** dealId does not resolve to an active deal in the caller's own
 * organization (Milestone 2.3B). Same indistinguishability rule as
 * InvalidCompanyRelationshipError/InvalidContactRelationshipError —
 * completes the three-way `relatedToType`/`taggableType` polymorphic
 * target set (company/contact/deal). */
export class InvalidDealRelationshipError extends CrmError {
  constructor(message: string) {
    super(message, "invalid_deal_relationship");
    this.name = "InvalidDealRelationshipError";
  }
}

/** tagId does not resolve to an active tag in the caller's own
 * organization (Milestone 2.3B) — the non-polymorphic half of a Tagging's
 * two-sided validation. Same indistinguishability rule as every other
 * InvalidXRelationshipError. */
export class InvalidTagRelationshipError extends CrmError {
  constructor(message: string) {
    super(message, "invalid_tag_relationship");
    this.name = "InvalidTagRelationshipError";
  }
}

/** A tag create/update collided with tags_org_active_name_idx (case-
 * insensitive, organization-scoped, active tags only) — mirrors
 * DuplicateContactEmailError's role for the analogous contacts_org_
 * active_email_idx conflict (Milestone 2.3B). */
export class DuplicateTagNameError extends CrmError {
  constructor(message: string) {
    super(message, "duplicate_tag_name");
    this.name = "DuplicateTagNameError";
  }
}

/** A tagging create collided with taggings_tag_id_taggable_type_
 * taggable_id_key — the same (tag, target) pair already exists
 * (Milestone 2.3B). */
export class DuplicateTaggingError extends CrmError {
  constructor(message: string) {
    super(message, "duplicate_tagging");
    this.name = "DuplicateTaggingError";
  }
}
