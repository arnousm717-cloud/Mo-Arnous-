import type { PoolClient } from "pg";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { ValidationError } from "./errors";
import { decodeCursor, resolveLimit, buildPage, type Page } from "./pagination";
import { validateRelatedToRelationship, type RelatedToType } from "./relationship-validation";
import { runInClientOrTransaction } from "./transaction";

/**
 * Notes domain logic (Milestone 2.3B, docs/13-Technical-Design-Review.md
 * "Milestone 2.3"). A standalone Note is persistent, freely-editable CRM
 * content with its own CRUD lifecycle — distinct from an
 * Activity(type="note"), a chronological timeline event (activities.ts's
 * own top comment has the full distinction, not repeated here).
 *
 * relatedToId and body are both DB-nullable only for the GDPR contact-
 * erasure path (packages/database's execute_contact_erasure(), Milestone
 * 2.3A) — both are always REQUIRED at ordinary create-time here, enforced
 * at this domain layer, never loosened because the columns happen to
 * allow NULL. relatedToType/relatedToId are not updateable in Milestone
 * 2.3 (frozen design).
 */

const WHITESPACE_ONLY = /^\s*$/;
const RELATED_TO_TYPES: readonly RelatedToType[] = ["company", "contact", "deal"];

export interface CreateNoteInput {
  relatedToType: RelatedToType;
  relatedToId: string;
  body: string;
}

/** relatedToType/relatedToId are deliberately absent — not updateable in
 * Milestone 2.3 (frozen design). */
export interface UpdateNoteInput {
  body: string;
}

export interface ListNotesInput {
  relatedToType?: RelatedToType;
  relatedToId?: string;
  cursor?: string;
  limit?: number;
}

export interface Note {
  id: string;
  organizationId: string;
  relatedToType: RelatedToType;
  /** Nullable only as a GDPR contact-erasure historical state. Never null
   * for a Note created through this domain layer's own createNote. */
  relatedToId: string | null;
  /** Nullable only as a GDPR contact-erasure historical state. Never null
   * for a Note created through this domain layer's own createNote. */
  body: string | null;
  createdBy: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NoteRow {
  id: string;
  organization_id: string;
  related_to_type: string;
  related_to_id: string | null;
  body: string | null;
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const NOTE_COLUMNS = `id, organization_id, related_to_type, related_to_id, body, created_by,
   deleted_at, created_at, updated_at`;

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    organizationId: row.organization_id,
    relatedToType: row.related_to_type as RelatedToType,
    relatedToId: row.related_to_id,
    body: row.body,
    createdBy: row.created_by,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

/** body is required and must contain at least one non-whitespace
 * character, at both create and update — despite DB nullability, which
 * exists solely for the GDPR erasure path, never as a looser create/update
 * rule (this module's own top comment). */
function validateBody(value: unknown): string {
  if (typeof value !== "string" || WHITESPACE_ONLY.test(value)) {
    throw new ValidationError("body is required and must contain a non-whitespace value");
  }
  return value;
}

export async function createNote(
  ctx: RequestContext & { organizationId: string },
  input: CreateNoteInput,
  existingClient?: PoolClient,
): Promise<Note> {
  const relatedToType = validateRelatedToType(input.relatedToType);
  const relatedToId = validateRelatedToId(input.relatedToId);
  const body = validateBody(input.body);
  // createdBy is always the authenticated caller from trusted request
  // context — never read from `input` (matches activities.ts's own
  // discipline).
  const createdBy = ctx.userId ?? null;

  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    await validateRelatedToRelationship(client, ctx.organizationId, relatedToType, relatedToId);

    const r = await client.query<NoteRow>(
      `insert into public.notes (organization_id, related_to_type, related_to_id, body, created_by)
       values ($1, $2, $3, $4, $5)
       returning ${NOTE_COLUMNS}`,
      [ctx.organizationId, relatedToType, relatedToId, body, createdBy],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error("notes insert returned no row — this should be unreachable.");
    }
    return toNote(row);
  });
}

/**
 * Excludes soft-deleted rows only — never excludes/rejects a row produced
 * by a completed GDPR contact erasure (related_to_id NULL, body NULL).
 * That is a legitimate historical database state, read back exactly as
 * stored (activities.ts's getActivityById carries the identical rule and
 * rationale, not repeated here).
 */
export async function getNoteById(ctx: RequestContext & { organizationId: string }, id: string): Promise<Note | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<NoteRow>(
      `select ${NOTE_COLUMNS} from public.notes
       where id = $1 and organization_id = $2 and deleted_at is null`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toNote(row) : null;
  });
}

export async function listNotes(
  ctx: RequestContext & { organizationId: string },
  input: ListNotesInput = {},
): Promise<Page<Note>> {
  const limit = resolveLimit(input.limit);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;
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
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);

    const r = await client.query<NoteRow>(
      `select ${NOTE_COLUMNS} from public.notes
       where ${conditions.join(" and ")}
       order by created_at desc, id desc
       limit $${values.length}`,
      values,
    );
    return buildPage(r.rows, limit, toNote);
  });
}

/**
 * Partial update. Only body is mutable (frozen 2.3 design —
 * relatedToType/relatedToId are structurally absent from
 * UpdateNoteInput). body must remain non-empty after trim validation.
 * Cannot target an already soft-deleted row. Returns null for
 * nonexistent/cross-org/already-deleted.
 */
export async function updateNote(
  ctx: RequestContext & { organizationId: string },
  id: string,
  input: UpdateNoteInput,
  existingClient?: PoolClient,
): Promise<Note | null> {
  const body = validateBody(input.body);
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const r = await client.query<NoteRow>(
      `update public.notes set body = $1
       where id = $2 and organization_id = $3 and deleted_at is null
       returning ${NOTE_COLUMNS}`,
      [body, id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toNote(row) : null;
  });
}

/** deleted_at = now(). Never a physical DELETE. Returns null for
 * nonexistent/cross-org/already-deleted. */
export async function softDeleteNote(ctx: RequestContext & { organizationId: string }, id: string): Promise<Note | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<NoteRow>(
      `update public.notes set deleted_at = now()
       where id = $1 and organization_id = $2 and deleted_at is null
       returning ${NOTE_COLUMNS}`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toNote(row) : null;
  });
}
