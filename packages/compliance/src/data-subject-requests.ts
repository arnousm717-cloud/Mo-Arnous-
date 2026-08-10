import { withTenantContext } from "@ai-revenue-os/database";

/**
 * Data Subject Request filing/read lifecycle + the preview/execute erasure
 * flow (M1.6, docs/08-Security.md §5, Decisions A/D). M1.6 scope: only
 * subject_type='user' erasure is executable — access/export and the other
 * three subject types are schema-ready (docs/03 §2.8) but have no
 * fulfillment logic here, deliberately (approved M1.6 plan constraint #11:
 * do not over-generalize beyond users/memberships).
 */

export type DsrSubjectType = "contact" | "visitor" | "portal_user" | "user";
export type DsrRequestType = "access" | "export" | "delete";
export type DsrStatus = "pending" | "in_progress" | "completed";

export interface FileDataSubjectRequestInput {
  subjectType: DsrSubjectType;
  subjectId: string;
  requestType: DsrRequestType;
}

export interface DataSubjectRequest {
  id: string;
  organizationId: string;
  subjectType: DsrSubjectType;
  subjectId: string;
  requestType: DsrRequestType;
  status: DsrStatus;
  requestedAt: string;
  dueAt: string;
  completedAt: string | null;
  handledBy: string | null;
}

interface DataSubjectRequestRow {
  id: string;
  organization_id: string;
  subject_type: DsrSubjectType;
  subject_id: string;
  request_type: DsrRequestType;
  status: DsrStatus;
  requested_at: string;
  due_at: string;
  completed_at: string | null;
  handled_by: string | null;
}

function toDataSubjectRequest(row: DataSubjectRequestRow): DataSubjectRequest {
  return {
    id: row.id,
    organizationId: row.organization_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    requestType: row.request_type,
    status: row.status,
    requestedAt: row.requested_at,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    handledBy: row.handled_by,
  };
}

/**
 * Only request_type='delete' has any fulfillment logic in M1.6 — the row
 * can still be filed for 'access'/'export' (the schema doesn't forbid it),
 * but callers attempting to file one are rejected here with a clear error
 * rather than left to discover, only at execution time, that nothing will
 * ever process it. Filing itself and its audit entry happen inside one
 * withTenantContext transaction (M1.6 constraint #9).
 */
export async function fileDataSubjectRequest(
  ctx: { userId: string; organizationId: string; roleKey: string },
  input: FileDataSubjectRequestInput,
): Promise<DataSubjectRequest> {
  if (input.requestType !== "delete") {
    throw new Error(
      `request_type '${input.requestType}' has no fulfillment logic in M1.6 — only 'delete' is supported.`,
    );
  }

  return withTenantContext(ctx, async (client) => {
    const inserted = await client.query<DataSubjectRequestRow>(
      `insert into public.data_subject_requests (organization_id, subject_type, subject_id, request_type)
       values ($1, $2, $3, $4)
       returning id, organization_id, subject_type, subject_id, request_type, status, requested_at, due_at, completed_at, handled_by`,
      [ctx.organizationId, input.subjectType, input.subjectId, input.requestType],
    );
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("data_subject_requests insert returned no row — this should be unreachable.");
    }

    await client.query(
      `insert into public.audit_logs
         (organization_id, actor_user_id, action, resource_type, resource_id, after)
       values ($1, $2, 'data_subject_request.created', 'data_subject_request', $3, $4)`,
      [
        ctx.organizationId,
        ctx.userId,
        row.id,
        JSON.stringify({
          subject_type: row.subject_type,
          subject_id: row.subject_id,
          request_type: row.request_type,
          due_at: row.due_at,
        }),
      ],
    );

    return toDataSubjectRequest(row);
  });
}

export async function getDataSubjectRequestById(
  ctx: { userId: string; organizationId: string; roleKey: string },
  id: string,
): Promise<DataSubjectRequest | null> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<DataSubjectRequestRow>(
      `select id, organization_id, subject_type, subject_id, request_type, status, requested_at, due_at, completed_at, handled_by
       from public.data_subject_requests where id = $1`,
      [id],
    );
    const row = r.rows[0];
    return row ? toDataSubjectRequest(row) : null;
  });
}

export interface ErasurePreview {
  canProceed: boolean;
  blockerReason: string | null;
  targetUserId: string;
  membershipCount: number;
  affectedOrganizationIds: string[];
}

interface ErasurePreviewRow {
  can_proceed: boolean;
  blocker_reason: string | null;
  target_user_id: string;
  membership_count: number;
  affected_organization_ids: string[] | null;
}

/**
 * Dry-run (M1.6 Decision D) — delegates entirely to preview_user_erasure()
 * (SECURITY DEFINER), which never mutates data_subject_requests, users, or
 * memberships. A true canProceed here is advisory only; executeUserErasure
 * below re-validates from scratch and does not trust this result.
 */
export async function previewUserErasure(
  ctx: { userId: string },
  dsrId: string,
): Promise<ErasurePreview> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<ErasurePreviewRow>("select * from public.preview_user_erasure($1, $2)", [
      dsrId,
      ctx.userId,
    ]);
    const row = r.rows[0];
    if (!row) {
      throw new Error("preview_user_erasure returned no row — this should be unreachable.");
    }
    return {
      canProceed: row.can_proceed,
      blockerReason: row.blocker_reason,
      targetUserId: row.target_user_id,
      membershipCount: row.membership_count,
      affectedOrganizationIds: row.affected_organization_ids ?? [],
    };
  });
}

export interface ErasureResult {
  targetUserId: string;
  membershipsRemoved: number;
  completedAt: string;
}

interface ErasureResultRow {
  target_user_id: string;
  memberships_removed: number;
  completed_at: string;
}

/**
 * Irreversible. Delegates entirely to execute_user_erasure() (SECURITY
 * DEFINER), which independently re-validates authorization and the
 * sole-org_admin blocker, performs the hard delete, and writes the audit
 * entry — all inside that function's own single transaction. This wrapper
 * adds no logic of its own precisely so there is no app-layer path that
 * could diverge from what the database actually enforces.
 */
export async function executeUserErasure(
  ctx: { userId: string },
  dsrId: string,
): Promise<ErasureResult> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<ErasureResultRow>("select * from public.execute_user_erasure($1, $2)", [
      dsrId,
      ctx.userId,
    ]);
    const row = r.rows[0];
    if (!row) {
      throw new Error("execute_user_erasure returned no row — this should be unreachable.");
    }
    return {
      targetUserId: row.target_user_id,
      membershipsRemoved: row.memberships_removed,
      completedAt: row.completed_at,
    };
  });
}

/**
 * Reads the data_subject_request_breaches view (M1.6 Decision E) —
 * overdue, not-yet-completed requests for the caller's own organization.
 * No notification channel consumes this yet, deliberately.
 */
export async function listOverdueDataSubjectRequests(
  ctx: { userId: string; organizationId: string; roleKey: string },
): Promise<DataSubjectRequest[]> {
  return withTenantContext(ctx, async (client) => {
    const r = await client.query<DataSubjectRequestRow>(
      `select id, organization_id, subject_type, subject_id, request_type, status, requested_at, due_at, completed_at, handled_by
       from public.data_subject_request_breaches
       order by due_at asc`,
    );
    return r.rows.map(toDataSubjectRequest);
  });
}
