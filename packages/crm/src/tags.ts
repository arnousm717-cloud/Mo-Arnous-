import type { PoolClient } from "pg";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { ValidationError, DuplicateTagNameError, DuplicateTaggingError } from "./errors";
import { decodeCursor, resolveLimit, buildPage, type Page } from "./pagination";
import { validateRelatedToRelationship, validateTagRelationship, type RelatedToType } from "./relationship-validation";
import { runInClientOrTransaction } from "./transaction";

/**
 * Tags and Taggings domain logic (Milestone 2.3B, docs/13-Technical-
 * Design-Review.md "Milestone 2.3"). Taggings live in this module rather
 * than a separate file — a Tagging has no independent lifecycle of its
 * own (it is always created/removed in the context of a Tag being
 * attached to or detached from something), matching the frozen 2.3
 * design's framing of Taggings as part of Tags domain management, not a
 * fifth standalone CRM entity.
 *
 * Taggings are a deliberate exception to this package's soft-delete
 * convention: no updatedAt, no deletedAt, always a physical DELETE
 * (frozen 2.3 design, mirrored from the taggings table itself — see
 * 20260817090000_create_activities_notes_tags_schema.sql's own comment).
 * There is no updateTagging — a tagging is created or removed, never
 * modified in place.
 */

const WHITESPACE_ONLY = /^\s*$/;
const TAG_NAME_UNIQUE_VIOLATION_CODE = "23505";
const TAG_NAME_UNIQUE_INDEX = "tags_org_active_name_idx";
const TAGGING_UNIQUE_VIOLATION_CODE = "23505";
const TAGGING_UNIQUE_CONSTRAINT = "taggings_tag_id_taggable_type_taggable_id_key";
const TAGGABLE_TYPES: readonly RelatedToType[] = ["company", "contact", "deal"];

export interface CreateTagInput {
  name: string;
  color?: string | null;
}

export interface UpdateTagInput {
  name?: string;
  color?: string | null;
}

export interface ListTagsInput {
  cursor?: string;
  limit?: number;
}

export interface Tag {
  id: string;
  organizationId: string;
  name: string;
  color: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TagRow {
  id: string;
  organization_id: string;
  name: string;
  color: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const TAG_COLUMNS = `id, organization_id, name, color, deleted_at, created_at, updated_at`;

function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    color: row.color,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** name is required and must contain at least one non-whitespace
 * character. color is deliberately unvalidated free-form text — no
 * design-token/hex-color system exists in this project's CRM tagging
 * (matches the tags table's own comment; packages/tenancy's hex-color
 * validator (contrast.ts) is a different bounded context — brand-theme
 * accessibility contrast — not a precedent for a free-form tag color). */
function validateName(value: unknown): string {
  if (typeof value !== "string" || WHITESPACE_ONLY.test(value)) {
    throw new ValidationError("name is required and must contain a non-whitespace value");
  }
  return value;
}

function isDuplicateTagNameError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === TAG_NAME_UNIQUE_VIOLATION_CODE && e.constraint === TAG_NAME_UNIQUE_INDEX;
}

export async function createTag(
  ctx: RequestContext & { organizationId: string },
  input: CreateTagInput,
  existingClient?: PoolClient,
): Promise<Tag> {
  const name = validateName(input.name);
  const color = input.color ?? null;

  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    try {
      const r = await client.query<TagRow>(
        `insert into public.tags (organization_id, name, color)
         values ($1, $2, $3)
         returning ${TAG_COLUMNS}`,
        [ctx.organizationId, name, color],
      );
      const row = r.rows[0];
      if (!row) {
        throw new Error("tags insert returned no row — this should be unreachable.");
      }
      return toTag(row);
    } catch (err) {
      if (isDuplicateTagNameError(err)) {
        throw new DuplicateTagNameError("a tag with this name already exists in this organization");
      }
      throw err;
    }
  });
}

/** Excludes soft-deleted rows. Returns null identically for nonexistent,
 * cross-org, and soft-deleted. */
export async function getTagById(ctx: RequestContext & { organizationId: string }, id: string): Promise<Tag | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<TagRow>(
      `select ${TAG_COLUMNS} from public.tags
       where id = $1 and organization_id = $2 and deleted_at is null`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toTag(row) : null;
  });
}

/** Minimal lookup/list behavior — a tag selector/picker needs a
 * name-ordered-enough listable set, not a full-featured search. Follows
 * the established cursor-pagination precedent (created_at DESC, id DESC)
 * rather than inventing a name-sorted variant no other resource has. */
export async function listTags(
  ctx: RequestContext & { organizationId: string },
  input: ListTagsInput = {},
): Promise<Page<Tag>> {
  const limit = resolveLimit(input.limit);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;

  return withTenantContext(ctx, async (client) => {
    const conditions = ["organization_id = $1", "deleted_at is null"];
    const values: unknown[] = [ctx.organizationId];

    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);

    const r = await client.query<TagRow>(
      `select ${TAG_COLUMNS} from public.tags
       where ${conditions.join(" and ")}
       order by created_at desc, id desc
       limit $${values.length}`,
      values,
    );
    return buildPage(r.rows, limit, toTag);
  });
}

/** Partial update: name and/or color. Cannot target an already
 * soft-deleted row. Returns null for nonexistent/cross-org/already-deleted. */
export async function updateTag(
  ctx: RequestContext & { organizationId: string },
  id: string,
  input: UpdateTagInput,
  existingClient?: PoolClient,
): Promise<Tag | null> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const has = (key: keyof UpdateTagInput) => Object.prototype.hasOwnProperty.call(input, key);
    const sets: string[] = [];
    const values: unknown[] = [];

    if (has("name")) {
      values.push(validateName(input.name));
      sets.push(`name = $${values.length}`);
    }
    if (has("color")) {
      values.push(input.color ?? null);
      sets.push(`color = $${values.length}`);
    }

    if (sets.length === 0) {
      const current = await client.query<TagRow>(
        `select ${TAG_COLUMNS} from public.tags
         where id = $1 and organization_id = $2 and deleted_at is null`,
        [id, ctx.organizationId],
      );
      const row = current.rows[0];
      return row ? toTag(row) : null;
    }

    values.push(id, ctx.organizationId);
    try {
      const r = await client.query<TagRow>(
        `update public.tags set ${sets.join(", ")}
         where id = $${values.length - 1} and organization_id = $${values.length} and deleted_at is null
         returning ${TAG_COLUMNS}`,
        values,
      );
      const row = r.rows[0];
      return row ? toTag(row) : null;
    } catch (err) {
      if (isDuplicateTagNameError(err)) {
        throw new DuplicateTagNameError("a tag with this name already exists in this organization");
      }
      throw err;
    }
  });
}

/** deleted_at = now(). Never a physical DELETE. Returns null for
 * nonexistent/cross-org/already-deleted. Taggings referencing this tag
 * are left exactly as-is — a soft-deleted tag simply becomes unavailable
 * for NEW taggings (validateTagRelationship excludes it); existing
 * taggings are not retroactively removed by this operation. */
export async function softDeleteTag(ctx: RequestContext & { organizationId: string }, id: string): Promise<Tag | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<TagRow>(
      `update public.tags set deleted_at = now()
       where id = $1 and organization_id = $2 and deleted_at is null
       returning ${TAG_COLUMNS}`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toTag(row) : null;
  });
}

// ============================================================
// Taggings
// ============================================================

export interface CreateTaggingInput {
  tagId: string;
  taggableType: RelatedToType;
  taggableId: string;
}

export interface ListTaggingsInput {
  tagId?: string;
  taggableType?: RelatedToType;
  taggableId?: string;
  cursor?: string;
  limit?: number;
}

/** No deletedAt, no updatedAt — a tagging is a relationship row, not a
 * standalone historical CRM record (frozen 2.3 design, mirrors the
 * taggings table itself exactly). */
export interface Tagging {
  id: string;
  organizationId: string;
  tagId: string;
  taggableType: RelatedToType;
  taggableId: string;
  createdAt: string;
}

interface TaggingRow {
  id: string;
  organization_id: string;
  tag_id: string;
  taggable_type: string;
  taggable_id: string;
  created_at: string;
}

const TAGGING_COLUMNS = `id, organization_id, tag_id, taggable_type, taggable_id, created_at`;

function toTagging(row: TaggingRow): Tagging {
  return {
    id: row.id,
    organizationId: row.organization_id,
    tagId: row.tag_id,
    taggableType: row.taggable_type as RelatedToType,
    taggableId: row.taggable_id,
    createdAt: row.created_at,
  };
}

function validateTaggableType(value: unknown): RelatedToType {
  if (typeof value !== "string" || !TAGGABLE_TYPES.includes(value as RelatedToType)) {
    throw new ValidationError(`taggableType must be one of ${TAGGABLE_TYPES.join(", ")}`);
  }
  return value as RelatedToType;
}

function validateTagId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("tagId is required");
  }
  return value;
}

function validateTaggableId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("taggableId is required");
  }
  return value;
}

function isDuplicateTaggingError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === TAGGING_UNIQUE_VIOLATION_CODE && e.constraint === TAGGING_UNIQUE_CONSTRAINT;
}

/**
 * Validates BOTH sides before insert: the tag itself (exists, active,
 * same organization) and the polymorphic target (exists, active, same
 * organization) — a Tagging is meaningless, and a same-org DB-bypass
 * risk, if either side is wrong. Never dynamically interpolates a table
 * name; validateRelatedToRelationship dispatches via a fixed switch over
 * exactly company/contact/deal.
 */
export async function createTagging(
  ctx: RequestContext & { organizationId: string },
  input: CreateTaggingInput,
  existingClient?: PoolClient,
): Promise<Tagging> {
  const tagId = validateTagId(input.tagId);
  const taggableType = validateTaggableType(input.taggableType);
  const taggableId = validateTaggableId(input.taggableId);

  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    await validateTagRelationship(client, ctx.organizationId, tagId);
    await validateRelatedToRelationship(client, ctx.organizationId, taggableType, taggableId);

    try {
      const r = await client.query<TaggingRow>(
        `insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id)
         values ($1, $2, $3, $4)
         returning ${TAGGING_COLUMNS}`,
        [ctx.organizationId, tagId, taggableType, taggableId],
      );
      const row = r.rows[0];
      if (!row) {
        throw new Error("taggings insert returned no row — this should be unreachable.");
      }
      return toTagging(row);
    } catch (err) {
      if (isDuplicateTaggingError(err)) {
        throw new DuplicateTaggingError("this tag is already attached to this target");
      }
      throw err;
    }
  });
}

export async function listTaggings(
  ctx: RequestContext & { organizationId: string },
  input: ListTaggingsInput = {},
): Promise<Page<Tagging>> {
  const limit = resolveLimit(input.limit);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;
  if (input.taggableType !== undefined) {
    validateTaggableType(input.taggableType);
  }

  return withTenantContext(ctx, async (client) => {
    const conditions = ["organization_id = $1"];
    const values: unknown[] = [ctx.organizationId];

    if (input.tagId !== undefined) {
      values.push(input.tagId);
      conditions.push(`tag_id = $${values.length}`);
    }
    if (input.taggableType !== undefined) {
      values.push(input.taggableType);
      conditions.push(`taggable_type = $${values.length}`);
    }
    if (input.taggableId !== undefined) {
      values.push(input.taggableId);
      conditions.push(`taggable_id = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);

    const r = await client.query<TaggingRow>(
      `select ${TAGGING_COLUMNS} from public.taggings
       where ${conditions.join(" and ")}
       order by created_at desc, id desc
       limit $${values.length}`,
      values,
    );
    return buildPage(r.rows, limit, toTagging);
  });
}

/** Always a physical DELETE, tenant-scoped — never a soft-delete (frozen
 * 2.3 design, matches the taggings table's own DELETE grant/RLS policy
 * exactly). There is no updateTagging. Returns null for nonexistent/
 * cross-org. */
export async function deleteTagging(ctx: RequestContext & { organizationId: string }, id: string): Promise<Tagging | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<TaggingRow>(
      `delete from public.taggings
       where id = $1 and organization_id = $2
       returning ${TAGGING_COLUMNS}`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toTagging(row) : null;
  });
}
