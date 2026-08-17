import type { PoolClient } from "pg";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { ValidationError } from "./errors";
import { decodeCursor, resolveLimit, buildPage, type Page } from "./pagination";
import { validateRelatedToRelationship, type RelatedToType } from "./relationship-validation";
import { runInClientOrTransaction } from "./transaction";

/**
 * Activities domain logic (Milestone 2.3B, docs/13-Technical-Design-Review.md
 * "Milestone 2.3").
 *
 * Activity(type="note") is a chronological, timestamped event in the
 * activity timeline (due_at/completed_at, "this happened/is scheduled");
 * a standalone Note (notes.ts) is persistent, freely-editable CRM content
 * with its own CRUD lifecycle and no timeline semantics — these are two
 * distinct concepts by frozen 2.3 design, never merged into one.
 *
 * relatedToId is a real polymorphic reference and is DB-nullable only for
 * the GDPR contact-erasure path (packages/database's execute_contact_
 * erasure(), Milestone 2.3A) — it is always REQUIRED at ordinary
 * create-time here, enforced at this domain layer, never loosened because
 * the column happens to allow NULL. relatedToType/relatedToId are not
 * updateable in Milestone 2.3 (frozen design) — reassigning what an
 * Activity is about is out of scope, not merely unimplemented.
 */

const ACTIVITY_TYPES = ["call", "email", "meeting", "note", "task"] as const;
type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface CreateActivityInput {
  type: ActivityType;
  relatedToType: RelatedToType;
  relatedToId: string;
  subject?: string | null;
  body?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
}

/** relatedToType/relatedToId are deliberately absent — not updateable in
 * Milestone 2.3 (frozen design), not merely omitted by oversight. */
export interface UpdateActivityInput {
  type?: ActivityType;
  subject?: string | null;
  body?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
}

export interface ListActivitiesInput {
  relatedToType?: RelatedToType;
  relatedToId?: string;
  type?: ActivityType;
  createdBy?: string;
  /** true = completed_at is not null, false = completed_at is null. */
  completed?: boolean;
  cursor?: string;
  limit?: number;
}

export interface Activity {
  id: string;
  organizationId: string;
  type: ActivityType;
  relatedToType: RelatedToType;
  /** Nullable only as a GDPR contact-erasure historical state — see this
   * module's own top comment. Never null for an Activity created through
   * this domain layer's own createActivity. */
  relatedToId: string | null;
  subject: string | null;
  body: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ActivityRow {
  id: string;
  organization_id: string;
  type: string;
  related_to_type: string;
  related_to_id: string | null;
  subject: string | null;
  body: string | null;
  due_at: string | null;
  completed_at: string | null;
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const ACTIVITY_COLUMNS = `id, organization_id, type, related_to_type, related_to_id, subject, body,
   due_at, completed_at, created_by, deleted_at, created_at, updated_at`;

function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: row.type as ActivityType,
    relatedToType: row.related_to_type as RelatedToType,
    relatedToId: row.related_to_id,
    subject: row.subject,
    body: row.body,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    createdBy: row.created_by,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateActivityType(value: unknown): ActivityType {
  if (typeof value !== "string" || !(ACTIVITY_TYPES as readonly string[]).includes(value)) {
    throw new ValidationError(`type must be one of ${ACTIVITY_TYPES.join(", ")}`);
  }
  return value as ActivityType;
}

const RELATED_TO_TYPES: readonly RelatedToType[] = ["company", "contact", "deal"];

function validateRelatedToType(value: unknown): RelatedToType {
  if (typeof value !== "string" || !RELATED_TO_TYPES.includes(value as RelatedToType)) {
    throw new ValidationError(`relatedToType must be one of ${RELATED_TO_TYPES.join(", ")}`);
  }
  return value as RelatedToType;
}

/** relatedToId is required at ordinary create-time despite DB nullability
 * — see this module's own top comment. */
function validateRelatedToId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("relatedToId is required");
  }
  return value;
}

export async function createActivity(
  ctx: RequestContext & { organizationId: string },
  input: CreateActivityInput,
  existingClient?: PoolClient,
): Promise<Activity> {
  const type = validateActivityType(input.type);
  const relatedToType = validateRelatedToType(input.relatedToType);
  const relatedToId = validateRelatedToId(input.relatedToId);
  const subject = input.subject ?? null;
  const body = input.body ?? null;
  const dueAt = input.dueAt ?? null;
  const completedAt = input.completedAt ?? null;
  // createdBy is always the authenticated caller from trusted request
  // context — never read from `input`, matching organizationId's own
  // discipline (companies.ts/contacts.ts precedent): a caller cannot
  // attribute an Activity to a different user by supplying one in the
  // request body.
  const createdBy = ctx.userId ?? null;

  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    await validateRelatedToRelationship(client, ctx.organizationId, relatedToType, relatedToId);

    const r = await client.query<ActivityRow>(
      `insert into public.activities
         (organization_id, type, related_to_type, related_to_id, subject, body, due_at, completed_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning ${ACTIVITY_COLUMNS}`,
      [ctx.organizationId, type, relatedToType, relatedToId, subject, body, dueAt, completedAt, createdBy],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error("activities insert returned no row — this should be unreachable.");
    }
    return toActivity(row);
  });
}

/**
 * Excludes soft-deleted rows only — never excludes/rejects a row whose
 * related_to_id is NULL from a completed GDPR contact erasure. That is a
 * legitimate historical database state, not a corrupted or invalid record
 * (this module's own top comment); a caller reading this row back must see
 * it exactly as stored, including relatedToId: null, never a repaired,
 * fabricated, or placeholder value.
 */
export async function getActivityById(
  ctx: RequestContext & { organizationId: string },
  id: string,
): Promise<Activity | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<ActivityRow>(
      `select ${ACTIVITY_COLUMNS} from public.activities
       where id = $1 and organization_id = $2 and deleted_at is null`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toActivity(row) : null;
  });
}

export async function listActivities(
  ctx: RequestContext & { organizationId: string },
  input: ListActivitiesInput = {},
): Promise<Page<Activity>> {
  const limit = resolveLimit(input.limit);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;
  if (input.type !== undefined) {
    validateActivityType(input.type);
  }
  if (input.relatedToType !== undefined) {
    validateRelatedToType(input.relatedToType);
  }

  return withTenantContext(ctx, async (client) => {
    const conditions = ["organization_id = $1", "deleted_at is null"];
    const values: unknown[] = [ctx.organizationId];

    if (input.relatedToType !== undefined) {
      values.push(input.relatedToType);
      conditions.push(`related_to_type = $${values.length}`);
    }
    if (input.relatedToId !== undefined) {
      values.push(input.relatedToId);
      conditions.push(`related_to_id = $${values.length}`);
    }
    if (input.type !== undefined) {
      values.push(input.type);
      conditions.push(`type = $${values.length}`);
    }
    if (input.createdBy !== undefined) {
      values.push(input.createdBy);
      conditions.push(`created_by = $${values.length}`);
    }
    if (input.completed !== undefined) {
      conditions.push(input.completed ? "completed_at is not null" : "completed_at is null");
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);

    const r = await client.query<ActivityRow>(
      `select ${ACTIVITY_COLUMNS} from public.activities
       where ${conditions.join(" and ")}
       order by created_at desc, id desc
       limit $${values.length}`,
      values,
    );
    return buildPage(r.rows, limit, toActivity);
  });
}

/**
 * Partial update. Only type/subject/body/dueAt/completedAt are mutable
 * (frozen 2.3 design — relatedToType/relatedToId are structurally absent
 * from UpdateActivityInput, so there is nothing here that could
 * re-validate or reject a historical relationship, including a
 * GDPR-erased or since-soft-deleted one). Cannot target an already
 * soft-deleted row. Returns null for nonexistent/cross-org/already-deleted.
 */
export async function updateActivity(
  ctx: RequestContext & { organizationId: string },
  id: string,
  input: UpdateActivityInput,
  existingClient?: PoolClient,
): Promise<Activity | null> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const has = (key: keyof UpdateActivityInput) => Object.prototype.hasOwnProperty.call(input, key);
    const sets: string[] = [];
    const values: unknown[] = [];

    if (has("type")) {
      values.push(validateActivityType(input.type));
      sets.push(`type = $${values.length}`);
    }
    if (has("subject")) {
      values.push(input.subject ?? null);
      sets.push(`subject = $${values.length}`);
    }
    if (has("body")) {
      values.push(input.body ?? null);
      sets.push(`body = $${values.length}`);
    }
    if (has("dueAt")) {
      values.push(input.dueAt ?? null);
      sets.push(`due_at = $${values.length}`);
    }
    if (has("completedAt")) {
      values.push(input.completedAt ?? null);
      sets.push(`completed_at = $${values.length}`);
    }

    if (sets.length === 0) {
      const current = await client.query<ActivityRow>(
        `select ${ACTIVITY_COLUMNS} from public.activities
         where id = $1 and organization_id = $2 and deleted_at is null`,
        [id, ctx.organizationId],
      );
      const row = current.rows[0];
      return row ? toActivity(row) : null;
    }

    values.push(id, ctx.organizationId);
    const r = await client.query<ActivityRow>(
      `update public.activities set ${sets.join(", ")}
       where id = $${values.length - 1} and organization_id = $${values.length} and deleted_at is null
       returning ${ACTIVITY_COLUMNS}`,
      values,
    );
    const row = r.rows[0];
    return row ? toActivity(row) : null;
  });
}

/** deleted_at = now(). Never a physical DELETE — matches every other CRM
 * entity's ordinary deletion semantics. Returns null for nonexistent/
 * cross-org/already-deleted. */
export async function softDeleteActivity(
  ctx: RequestContext & { organizationId: string },
  id: string,
): Promise<Activity | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<ActivityRow>(
      `update public.activities set deleted_at = now()
       where id = $1 and organization_id = $2 and deleted_at is null
       returning ${ACTIVITY_COLUMNS}`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toActivity(row) : null;
  });
}
