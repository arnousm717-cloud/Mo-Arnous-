/**
 * Milestone 3.4D — strict request-shape validation for scoring-rule
 * writes. Mirrors enrichment-validation.ts's own style: a fixed allowed-
 * field set, one error type for every rejection reason, rich per-field
 * shape checks performed here in TypeScript (never delegated to the
 * database's own CHECK constraints alone, which are a coarse backstop,
 * not the primary gate — packages/database's own scoring_rules migration
 * comment states this explicitly).
 *
 * This is the enforcement point for "strictly allowlisted {field,
 * operator, value}, never an executable expression" (Milestone 3.4
 * Implementation Authorization): `field` and `operator` are each checked
 * against a fixed, closed set; `value`'s expected shape is derived from
 * `field`'s own declared type, never accepted as arbitrary JSON.
 */

const MAX_NAME_LENGTH = 200;
const MIN_WEIGHT = -100;
const MAX_WEIGHT = 100;

type FieldType = "string" | "number" | "boolean";

const FIELD_TYPES: Record<string, FieldType> = {
  "company.industry": "string",
  "contact.job_title": "string",
  "contact.lifecycle_stage": "string",
  "company.employee_count": "number",
  "company.annual_revenue": "number",
  "engagement.pageviews_30d": "number",
  "engagement.form_submits_30d": "number",
  "engagement.sessions_30d": "number",
  "engagement.last_seen_days_ago": "number",
  "contact.enrichment_completed": "boolean",
  "company.enrichment_completed": "boolean",
};

const OPERATORS_BY_TYPE: Record<FieldType, ReadonlySet<string>> = {
  string: new Set(["eq", "neq", "in", "contains", "exists"]),
  number: new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in", "exists"]),
  boolean: new Set(["eq", "neq", "exists"]),
};

const SCORING_RULE_ALLOWED_FIELDS: ReadonlySet<string> = new Set(["name", "field", "operator", "value", "weight", "isActive"]);

export class ValidationError extends Error {}

export interface ValidatedScoringRule {
  name: string;
  field: string;
  operator: string;
  value: unknown;
  weight: number;
  isActive?: boolean;
}

function validateValueShape(fieldType: FieldType, operator: string, value: unknown): void {
  if (operator === "exists") {
    return; // value is ignored for `exists`; any shape (including absent) is fine.
  }
  if (operator === "in") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new ValidationError("value must be a non-empty array when operator is 'in'");
    }
    for (const item of value) {
      if (typeof item !== fieldType) {
        throw new ValidationError(`value entries must all be of type ${fieldType} for this field`);
      }
    }
    return;
  }
  if (typeof value !== fieldType) {
    throw new ValidationError(`value must be of type ${fieldType} for this field`);
  }
}

/**
 * Validates a POST (create) body. All fields required except `isActive`
 * (defaults to true at the database layer if omitted).
 */
export function validateCreateScoringRule(body: unknown): ValidatedScoringRule {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!SCORING_RULE_ALLOWED_FIELDS.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  if (typeof raw.name !== "string" || raw.name.trim().length === 0 || raw.name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(`name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
  }
  if (typeof raw.field !== "string" || !Object.prototype.hasOwnProperty.call(FIELD_TYPES, raw.field)) {
    throw new ValidationError("field must be one of the recognized allowlisted field names");
  }
  const fieldType = FIELD_TYPES[raw.field]!;
  if (typeof raw.operator !== "string" || !OPERATORS_BY_TYPE[fieldType].has(raw.operator)) {
    throw new ValidationError(`operator must be one of the recognized values for a ${fieldType} field`);
  }
  validateValueShape(fieldType, raw.operator, raw.value);
  if (typeof raw.weight !== "number" || !Number.isInteger(raw.weight) || raw.weight < MIN_WEIGHT || raw.weight > MAX_WEIGHT) {
    throw new ValidationError(`weight must be an integer between ${MIN_WEIGHT} and ${MAX_WEIGHT}`);
  }
  if (raw.isActive !== undefined && typeof raw.isActive !== "boolean") {
    throw new ValidationError("isActive must be a boolean when present");
  }

  const result: ValidatedScoringRule = {
    name: raw.name.trim(),
    field: raw.field,
    operator: raw.operator,
    value: raw.operator === "exists" ? null : raw.value,
    weight: raw.weight,
  };
  if (typeof raw.isActive === "boolean") result.isActive = raw.isActive;
  return result;
}

export interface ValidatedScoringRulePatch {
  name?: string;
  field?: string;
  operator?: string;
  value?: unknown;
  weight?: number;
  isActive?: boolean;
}

/**
 * Validates a PATCH body. Every field is optional (partial update), but
 * field/operator/value are validated TOGETHER when any of the three is
 * present — a rule can never end up in a stored state where operator
 * doesn't match field's type, so a partial update touching just one of
 * these three is rejected rather than silently accepted (the caller must
 * resend all three together in that case).
 */
export function validateScoringRulePatch(body: unknown): ValidatedScoringRulePatch {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!SCORING_RULE_ALLOWED_FIELDS.has(key)) {
      throw new ValidationError(`unknown field: ${key}`);
    }
  }

  const touchesConditionShape = raw.field !== undefined || raw.operator !== undefined || raw.value !== undefined;
  if (touchesConditionShape && (raw.field === undefined || raw.operator === undefined)) {
    throw new ValidationError("field and operator must both be supplied together when changing a rule's condition");
  }

  const result: ValidatedScoringRulePatch = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim().length === 0 || raw.name.length > MAX_NAME_LENGTH) {
      throw new ValidationError(`name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`);
    }
    result.name = raw.name.trim();
  }

  if (touchesConditionShape) {
    if (typeof raw.field !== "string" || !Object.prototype.hasOwnProperty.call(FIELD_TYPES, raw.field)) {
      throw new ValidationError("field must be one of the recognized allowlisted field names");
    }
    const fieldType = FIELD_TYPES[raw.field]!;
    if (typeof raw.operator !== "string" || !OPERATORS_BY_TYPE[fieldType].has(raw.operator)) {
      throw new ValidationError(`operator must be one of the recognized values for a ${fieldType} field`);
    }
    validateValueShape(fieldType, raw.operator, raw.value);
    result.field = raw.field;
    result.operator = raw.operator;
    result.value = raw.operator === "exists" ? null : raw.value;
  }

  if (raw.weight !== undefined) {
    if (typeof raw.weight !== "number" || !Number.isInteger(raw.weight) || raw.weight < MIN_WEIGHT || raw.weight > MAX_WEIGHT) {
      throw new ValidationError(`weight must be an integer between ${MIN_WEIGHT} and ${MAX_WEIGHT}`);
    }
    result.weight = raw.weight;
  }

  if (raw.isActive !== undefined) {
    if (typeof raw.isActive !== "boolean") {
      throw new ValidationError("isActive must be a boolean when present");
    }
    result.isActive = raw.isActive;
  }

  if (Object.keys(result).length === 0) {
    throw new ValidationError("at least one field must be supplied");
  }

  return result;
}
