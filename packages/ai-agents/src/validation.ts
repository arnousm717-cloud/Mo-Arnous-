import type { EntityType } from "@ai-revenue-os/brain";
import { AgentRunValidationError } from "./errors";
import type { AgentRunReference } from "./types";

/**
 * Milestone 4.2 (Architectural Correction) — the SINGLE authoritative
 * boundary for `agent_runs.input`'s "references/IDs only, never copied
 * CRM content" contract (the Step 1 migration's own binding column
 * comment). A POSITIVE allowlist, not a negative/heuristic denylist: if
 * a field or value was not explicitly defined here as a reference, it
 * cannot be constructed by this module at all, so `enqueueAgentRun`
 * (repository.ts) has no way to persist anything else — this is what
 * makes the contract structural rather than best-effort.
 *
 * Called from `enqueueAgentRun` itself, so ANY caller of that exported
 * function — a future Staff route once one exists, or any other
 * trusted in-process caller in the meantime (no HTTP route exists in
 * M4.2, see `repository.ts`'s own header comment) — is bound by the
 * exact same rule, not a second, possibly drifted copy of it.
 *
 * This module validates REFERENCE SHAPE only, never `agent_key` —
 * identifier-format and supported-persona validation for `agent_key`
 * are both explicitly out of scope here and in `enqueueAgentRun`; see
 * that function's own header comment for why.
 *
 * Reuses `packages/brain`'s own already-accepted `EntityType` ("contact"
 * | "company" | "deal") and its `entityType`/`entityId` field-naming
 * convention exactly (`packages/brain/src/{types,embeddings,repository,
 * backfill}.ts`) rather than inventing a new reference shape — the same
 * three entity types `docs/05-AI-Agent-Architecture.md`'s own persona
 * input descriptions already use (Research: `company_id`/`contact_id`;
 * Sales: deal-scoped; Scoring: `contact_id`).
 */

const ENTITY_TYPES: readonly EntityType[] = ["contact", "company", "deal"];

/** No repo precedent for "how many entities can one agent run touch" —
 * a deliberately small, conservative bound. An agent run is a bounded
 * unit of work, not a bulk operation; 10 comfortably covers every
 * persona input shape docs/05 describes (each cites at most one or two
 * entity ids), with headroom, while remaining far short of "arbitrary
 * huge array." */
const MAX_REFERENCES = 10;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string" && (ENTITY_TYPES as readonly string[]).includes(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and returns a clean `AgentRunReference[]`, or throws
 * `AgentRunValidationError` with a safe, non-leaking message.
 *
 * Contract (frozen, Milestone 4.2 Step 3 Correction):
 *   - top-level `references` is OPTIONAL; omitted means `[]` (an agent
 *     run may legitimately have zero entity references — docs/05's own
 *     Marketing Agent operates on an audience segment/campaign brief,
 *     not a single company/contact/deal id, so requiring at least one
 *     reference would be inventing a constraint the architecture itself
 *     doesn't support for every persona).
 *   - when present, must be an array of 0..MAX_REFERENCES objects.
 *   - each object has EXACTLY two keys: `entityType` (one of "contact"/
 *     "company"/"deal") and `entityId` (a syntactically valid UUID) — any
 *     other key present is rejected outright, never stripped.
 *   - duplicate references (same entityType+entityId more than once) are
 *     PERMITTED and persisted verbatim — deduplicating would be a silent
 *     mutation of caller input, and a redundant reference is superfluous,
 *     not unsafe.
 *   - existence of the referenced row is deliberately NOT checked here
 *     (no DB lookup) — matching the Step 1 migration's own explicit
 *     design ("No structured entity FK exists on this table
 *     (deliberately — that is M4.3/agent_tool_calls' own concern once
 *     real tool execution exists)"); this module only enforces SHAPE.
 */
export function validateAgentRunReferences(rawReferences: unknown): AgentRunReference[] {
  if (rawReferences === undefined) {
    return [];
  }
  if (!Array.isArray(rawReferences)) {
    throw new AgentRunValidationError("references must be an array");
  }
  if (rawReferences.length > MAX_REFERENCES) {
    throw new AgentRunValidationError(`references must not contain more than ${MAX_REFERENCES} entries`);
  }

  return rawReferences.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new AgentRunValidationError(`references[${index}] must be an object`);
    }
    const keys = Object.keys(raw);
    const unknownKey = keys.find((key) => key !== "entityType" && key !== "entityId");
    if (unknownKey !== undefined) {
      throw new AgentRunValidationError(`references[${index}] has an unknown field: ${unknownKey}`);
    }
    if (!isEntityType(raw.entityType)) {
      throw new AgentRunValidationError(`references[${index}].entityType must be one of: ${ENTITY_TYPES.join(", ")}`);
    }
    if (!isUuid(raw.entityId)) {
      throw new AgentRunValidationError(`references[${index}].entityId must be a valid UUID`);
    }
    return { entityType: raw.entityType, entityId: raw.entityId };
  });
}
