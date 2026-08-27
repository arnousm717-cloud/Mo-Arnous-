import type { PoolClient } from "pg";
import { runInClientOrTransaction, type RequestContext } from "@ai-revenue-os/database";

/**
 * Session resolve/create (Milestone 3.1B). Session identity is a
 * client-generated opaque UUID (anonymousSessionId, 3.1D generates it)
 * — never tenant authority, never used to resolve organization or
 * tracking site, and never a substitute for the composite FKs below,
 * which still apply to every insert regardless of this value. The real
 * primary key remains id, server-generated, exactly as every other
 * table in this schema.
 */

export interface VisitorSession {
  id: string;
  organizationId: string;
  visitorId: string;
  trackingSiteId: string;
  anonymousSessionId: string;
  startedAt: string;
  endedAt: string | null;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  landingPage: string | null;
  deviceType: string | null;
}

interface VisitorSessionRow {
  id: string;
  organization_id: string;
  visitor_id: string;
  tracking_site_id: string;
  anonymous_session_id: string;
  started_at: string;
  ended_at: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  landing_page: string | null;
  device_type: string | null;
}

function mapSessionRow(row: VisitorSessionRow): VisitorSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    visitorId: row.visitor_id,
    trackingSiteId: row.tracking_site_id,
    anonymousSessionId: row.anonymous_session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    referrer: row.referrer,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    landingPage: row.landing_page,
    deviceType: row.device_type,
  };
}

export interface ResolveOrCreateVisitorSessionInput {
  trackingSiteId: string;
  visitorId: string;
  anonymousSessionId: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  landingPage?: string;
  deviceType?: string;
}

/**
 * Atomic upsert on the approved UNIQUE(organization_id, tracking_site_id,
 * visitor_id, anonymous_session_id) constraint — race-safe by
 * Postgres's own ON CONFLICT guarantee. `DO UPDATE SET id =
 * visitor_sessions.id` is a deliberate, standard Postgres idiom: it
 * makes RETURNING fire on the conflict path too (unlike DO NOTHING,
 * which returns zero rows on conflict), while touching no actual data —
 * referrer/utm_source/utm_medium/utm_campaign/landing_page/device_type
 * are never overwritten on a repeat call for the same 4-tuple. Verified
 * empirically before writing
 * this function: visitor_sessions has zero triggers, and a live
 * conflict-path round trip confirmed every session-start attribution
 * column survives byte-for-byte unchanged. ended_at is never referenced
 * here — remains untouched/null, matching the approved scope (no
 * timeout/expiration logic in 3.1B).
 */
export async function resolveOrCreateVisitorSession(
  ctx: RequestContext & { organizationId: string },
  input: ResolveOrCreateVisitorSessionInput,
  existingClient?: PoolClient,
): Promise<VisitorSession> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const r = await client.query<VisitorSessionRow>(
      `insert into public.visitor_sessions
         (organization_id, tracking_site_id, visitor_id, anonymous_session_id, referrer, utm_source, utm_medium, utm_campaign, landing_page, device_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (organization_id, tracking_site_id, visitor_id, anonymous_session_id)
       do update set id = visitor_sessions.id
       returning id, organization_id, visitor_id, tracking_site_id, anonymous_session_id, started_at, ended_at, referrer, utm_source, utm_medium, utm_campaign, landing_page, device_type`,
      [
        ctx.organizationId,
        input.trackingSiteId,
        input.visitorId,
        input.anonymousSessionId,
        input.referrer ?? null,
        input.utmSource ?? null,
        input.utmMedium ?? null,
        input.utmCampaign ?? null,
        input.landingPage ?? null,
        input.deviceType ?? null,
      ],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error("visitor_sessions upsert returned no row — this should be unreachable.");
    }
    return mapSessionRow(row);
  });
}
