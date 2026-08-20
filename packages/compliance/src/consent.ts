import type { PoolClient } from "pg";
import { runInClientOrTransaction } from "@ai-revenue-os/database";

/**
 * Staff-recorded consent (docs/04-API-Architecture.md §2's "Consent"
 * resource — the staff-action call site, distinct from the unauthenticated
 * visitor cookie-banner call site, which doesn't exist yet since the
 * tracking ingestion endpoint is Phase 3). Brain-related consent types
 * (email_content_processing/meeting_recording_processing) are out of M1.6
 * scope, same as the Brain itself (Phase 4) — not included in the type
 * union below.
 */

export type ConsentSubjectType = "contact" | "visitor" | "portal_user";
export type ConsentType = "marketing_email" | "cookie_tracking" | "data_processing";
export type ConsentStatus = "granted" | "withdrawn";

export interface RecordConsentInput {
  subjectType: ConsentSubjectType;
  subjectId: string;
  consentType: ConsentType;
  status: ConsentStatus;
  source?: string;
  ipAddress?: string;
}

export interface ConsentRecord {
  id: string;
  status: ConsentStatus;
  recordedAt: string;
}

interface ConsentRecordRow {
  id: string;
  status: string;
  recorded_at: string;
}

/**
 * ctx.roleKey must be the caller's own server-resolved role (never
 * hardcoded here) — consent_records' RLS policy checks the caller's role
 * key directly (no SECURITY DEFINER function mediates this insert, unlike
 * the erasure functions), so an inaccurate roleKey would either wrongly
 * deny a legitimate caller or, far worse, wrongly grant a lower-privilege
 * caller RLS-level write access. The caller (the
 * Route Handler) is expected to have already checked
 * can(actor, "consent:record") before reaching this function — that check
 * and this one are independent layers, same as everywhere else in this
 * codebase (docs/08-Security.md §2).
 *
 * Writes consent_records and its audit_logs entry inside one transaction —
 * synchronous and transactionally aligned with the action being logged
 * (M1.6 constraint #9). Milestone 2.5B: accepts an optional existingClient
 * so the Idempotency-Key reservation, this mutation, and the reservation's
 * own completion can share one outer transaction (see
 * runInClientOrTransaction) — omitted, behavior is byte-for-byte unchanged
 * from before 2.5B (opens its own withTenantContext transaction).
 */
export async function recordConsent(
  ctx: { userId: string; organizationId: string; roleKey: string },
  input: RecordConsentInput,
  existingClient?: PoolClient,
): Promise<ConsentRecord> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const inserted = await client.query<ConsentRecordRow>(
      `insert into public.consent_records
         (organization_id, subject_type, subject_id, consent_type, status, source, ip_address)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, status, recorded_at`,
      [
        ctx.organizationId,
        input.subjectType,
        input.subjectId,
        input.consentType,
        input.status,
        input.source ?? null,
        input.ipAddress ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("consent_records insert returned no row — this should be unreachable.");
    }

    await client.query(
      `insert into public.audit_logs
         (organization_id, actor_user_id, action, resource_type, resource_id, after)
       values ($1, $2, 'consent.recorded', 'consent_record', $3, $4)`,
      [
        ctx.organizationId,
        ctx.userId,
        row.id,
        JSON.stringify({
          subject_type: input.subjectType,
          subject_id: input.subjectId,
          consent_type: input.consentType,
          status: input.status,
        }),
      ],
    );

    return { id: row.id, status: row.status as ConsentStatus, recordedAt: row.recorded_at };
  });
}
