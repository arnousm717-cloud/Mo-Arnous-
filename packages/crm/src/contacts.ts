import type { PoolClient } from "pg";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { ValidationError, DuplicateContactEmailError, InvalidCompanyRelationshipError } from "./errors";
import { decodeCursor, resolveLimit, buildPage, type Page } from "./pagination";
import { validateOwner } from "./owner-validation";

/**
 * Contacts domain logic (Milestone 2.1D, docs/13-Technical-Design-Review.md
 * "Milestone 2.1" Detailed design + the 2.1D approved decisions).
 */

const WHITESPACE_ONLY = /^\s*$/;
const LIFECYCLE_STAGES = ["lead", "prospect", "customer", "inactive"] as const;

const CONTACT_EMAIL_UNIQUE_VIOLATION_CODE = "23505";
// The unique partial index backing active-email uniqueness
// (packages/database/supabase/migrations/20260812120000...), not a
// separately-named table CONSTRAINT — Postgres still reports it via the
// error's `constraint` field, identical to how a named CONSTRAINT would.
const CONTACT_EMAIL_UNIQUE_INDEX = "contacts_org_active_email_idx";

export interface CreateContactInput {
  companyId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  linkedinUrl?: string | null;
  lifecycleStage?: string | null;
  ownerId?: string | null;
}

export interface UpdateContactInput {
  companyId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  linkedinUrl?: string | null;
  lifecycleStage?: string | null;
  ownerId?: string | null;
}

export interface ListContactsInput {
  companyId?: string;
  ownerId?: string;
  lifecycleStage?: string;
  cursor?: string;
  limit?: number;
}

export interface Contact {
  id: string;
  organizationId: string;
  companyId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  linkedinUrl: string | null;
  lifecycleStage: string | null;
  ownerId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ContactRow {
  id: string;
  organization_id: string;
  company_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  lifecycle_stage: string | null;
  owner_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const CONTACT_COLUMNS = `id, organization_id, company_id, first_name, last_name, email, phone, job_title,
   linkedin_url, lifecycle_stage, owner_id, deleted_at, created_at, updated_at`;

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    jobTitle: row.job_title,
    linkedinUrl: row.linkedin_url,
    lifecycleStage: row.lifecycle_stage,
    ownerId: row.owner_id,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hasContent(value: string | null | undefined): boolean {
  return typeof value === "string" && !WHITESPACE_ONLY.test(value);
}

/** Mirrors the database's own contacts_identity_required CHECK exactly
 * (same non-whitespace test) — at least one of firstName/lastName/email
 * must contain a non-whitespace value. The DB CHECK remains the final
 * structural protection; this is the domain-layer copy of the same rule,
 * not a looser substitute. */
function validateContactIdentity(firstName: string | null, lastName: string | null, email: string | null): void {
  if (!hasContent(firstName) && !hasContent(lastName) && !hasContent(email)) {
    throw new ValidationError("at least one of firstName, lastName, or email must contain a non-whitespace value");
  }
}

function validateLifecycleStage(value: string | null): void {
  if (value === null) {
    return;
  }
  if (!(LIFECYCLE_STAGES as readonly string[]).includes(value)) {
    throw new ValidationError(`lifecycleStage must be one of ${LIFECYCLE_STAGES.join(", ")}, or null`);
  }
}

/**
 * companyId is valid only if null, or if it references a company that
 * (a) exists, (b) belongs to this organization, and (c) is not
 * soft-deleted. All three failure modes collapse to the same
 * InvalidCompanyRelationshipError (2.1D decision 3) — deliberately
 * indistinguishable, so a caller can't use this to probe for another
 * organization's company or a deleted one. Does not weaken the database's
 * own composite FK, which remains the structural guarantee regardless.
 */
async function validateCompanyRelationship(client: PoolClient, organizationId: string, companyId: string | null): Promise<void> {
  if (companyId === null) {
    return;
  }
  const r = await client.query(
    `select 1 from public.companies
     where id = $1 and organization_id = $2 and deleted_at is null
     limit 1`,
    [companyId, organizationId],
  );
  if (r.rows.length === 0) {
    throw new InvalidCompanyRelationshipError("companyId must reference an active company in this organization");
  }
}

function isDuplicateContactEmailError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === CONTACT_EMAIL_UNIQUE_VIOLATION_CODE && e.constraint === CONTACT_EMAIL_UNIQUE_INDEX;
}

export async function createContact(ctx: RequestContext & { organizationId: string }, input: CreateContactInput): Promise<Contact> {
  const firstName = input.firstName ?? null;
  const lastName = input.lastName ?? null;
  const email = input.email ?? null;
  const companyId = input.companyId ?? null;
  const ownerId = input.ownerId ?? null;

  validateContactIdentity(firstName, lastName, email);
  validateLifecycleStage(input.lifecycleStage ?? null);

  return withTenantContext(ctx, async (client) => {
    await validateCompanyRelationship(client, ctx.organizationId, companyId);
    await validateOwner(client, ctx.organizationId, ownerId);

    try {
      const r = await client.query<ContactRow>(
        `insert into public.contacts
           (organization_id, company_id, first_name, last_name, email, phone, job_title, linkedin_url, lifecycle_stage, owner_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning ${CONTACT_COLUMNS}`,
        [
          ctx.organizationId,
          companyId,
          firstName,
          lastName,
          email,
          input.phone ?? null,
          input.jobTitle ?? null,
          input.linkedinUrl ?? null,
          input.lifecycleStage ?? null,
          ownerId,
        ],
      );
      const row = r.rows[0];
      if (!row) {
        throw new Error("contacts insert returned no row — this should be unreachable.");
      }
      return toContact(row);
    } catch (err) {
      if (isDuplicateContactEmailError(err)) {
        throw new DuplicateContactEmailError("a contact with this email already exists in this organization");
      }
      throw err;
    }
  });
}

/** Excludes soft-deleted rows. Returns null identically for nonexistent,
 * cross-org, and soft-deleted. */
export async function getContactById(ctx: RequestContext & { organizationId: string }, id: string): Promise<Contact | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<ContactRow>(
      `select ${CONTACT_COLUMNS} from public.contacts
       where id = $1 and organization_id = $2 and deleted_at is null`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toContact(row) : null;
  });
}

export async function listContacts(
  ctx: RequestContext & { organizationId: string },
  input: ListContactsInput = {},
): Promise<Page<Contact>> {
  const limit = resolveLimit(input.limit);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;
  if (input.lifecycleStage !== undefined) {
    validateLifecycleStage(input.lifecycleStage);
  }

  return withTenantContext(ctx, async (client) => {
    const conditions = ["organization_id = $1", "deleted_at is null"];
    const values: unknown[] = [ctx.organizationId];

    if (input.companyId !== undefined) {
      values.push(input.companyId);
      conditions.push(`company_id = $${values.length}`);
    }
    if (input.ownerId !== undefined) {
      values.push(input.ownerId);
      conditions.push(`owner_id = $${values.length}`);
    }
    if (input.lifecycleStage !== undefined) {
      values.push(input.lifecycleStage);
      conditions.push(`lifecycle_stage = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);

    const r = await client.query<ContactRow>(
      `select ${CONTACT_COLUMNS} from public.contacts
       where ${conditions.join(" and ")}
       order by created_at desc, id desc
       limit $${values.length}`,
      values,
    );
    return buildPage(r.rows, limit, toContact);
  });
}

/**
 * Partial update. Validates the FINAL resulting identity state (not just
 * the supplied patch) — fetches the current row inside the same
 * transaction, merges patch fields over it, and rejects if the merged
 * result would leave firstName/lastName/email all empty (e.g. an existing
 * contact with only email populated cannot have email nulled out).
 * Cannot target an already soft-deleted row. Returns null for
 * nonexistent/cross-org/already-deleted.
 */
export async function updateContact(
  ctx: RequestContext & { organizationId: string },
  id: string,
  input: UpdateContactInput,
): Promise<Contact | null> {
  return withTenantContext(ctx, async (client) => {
    const current = await client.query<ContactRow>(
      `select ${CONTACT_COLUMNS} from public.contacts
       where id = $1 and organization_id = $2 and deleted_at is null`,
      [id, ctx.organizationId],
    );
    const currentRow = current.rows[0];
    if (!currentRow) {
      return null;
    }

    const has = (key: keyof UpdateContactInput) => Object.prototype.hasOwnProperty.call(input, key);

    const finalFirstName = has("firstName") ? (input.firstName ?? null) : currentRow.first_name;
    const finalLastName = has("lastName") ? (input.lastName ?? null) : currentRow.last_name;
    const finalEmail = has("email") ? (input.email ?? null) : currentRow.email;
    validateContactIdentity(finalFirstName, finalLastName, finalEmail);

    if (has("lifecycleStage")) {
      validateLifecycleStage(input.lifecycleStage ?? null);
    }

    const sets: string[] = [];
    const values: unknown[] = [];

    if (has("companyId")) {
      const companyId = input.companyId ?? null;
      await validateCompanyRelationship(client, ctx.organizationId, companyId);
      values.push(companyId);
      sets.push(`company_id = $${values.length}`);
    }
    if (has("firstName")) {
      values.push(finalFirstName);
      sets.push(`first_name = $${values.length}`);
    }
    if (has("lastName")) {
      values.push(finalLastName);
      sets.push(`last_name = $${values.length}`);
    }
    if (has("email")) {
      values.push(finalEmail);
      sets.push(`email = $${values.length}`);
    }
    if (has("phone")) {
      values.push(input.phone ?? null);
      sets.push(`phone = $${values.length}`);
    }
    if (has("jobTitle")) {
      values.push(input.jobTitle ?? null);
      sets.push(`job_title = $${values.length}`);
    }
    if (has("linkedinUrl")) {
      values.push(input.linkedinUrl ?? null);
      sets.push(`linkedin_url = $${values.length}`);
    }
    if (has("lifecycleStage")) {
      values.push(input.lifecycleStage ?? null);
      sets.push(`lifecycle_stage = $${values.length}`);
    }
    if (has("ownerId")) {
      const ownerId = input.ownerId ?? null;
      await validateOwner(client, ctx.organizationId, ownerId);
      values.push(ownerId);
      sets.push(`owner_id = $${values.length}`);
    }

    if (sets.length === 0) {
      return toContact(currentRow);
    }

    values.push(id, ctx.organizationId);
    try {
      const r = await client.query<ContactRow>(
        `update public.contacts set ${sets.join(", ")}
         where id = $${values.length - 1} and organization_id = $${values.length} and deleted_at is null
         returning ${CONTACT_COLUMNS}`,
        values,
      );
      const row = r.rows[0];
      return row ? toContact(row) : null;
    } catch (err) {
      if (isDuplicateContactEmailError(err)) {
        throw new DuplicateContactEmailError("a contact with this email already exists in this organization");
      }
      throw err;
    }
  });
}

/** deleted_at = now(). Preserves company_id unchanged (soft-deleting a
 * contact never touches its own relationship fields) and never affects
 * any other row — soft-deleting a company (companies.ts) is what leaves
 * dependent contacts' company_id intact by design (no cascade, no FK
 * change); this function is the symmetric contact-side operation. */
export async function softDeleteContact(ctx: RequestContext & { organizationId: string }, id: string): Promise<Contact | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<ContactRow>(
      `update public.contacts set deleted_at = now()
       where id = $1 and organization_id = $2 and deleted_at is null
       returning ${CONTACT_COLUMNS}`,
      [id, ctx.organizationId],
    );
    const row = r.rows[0];
    return row ? toContact(row) : null;
  });
}
