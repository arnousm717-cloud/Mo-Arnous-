import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";
import { checkCookieTrackingConsent } from "./consent";
import { resolveOrCreateVisitor, type WebsiteVisitor } from "./visitors";
import { resolveOrCreateVisitorSession, type VisitorSession } from "./sessions";
import { appendVisitorEvent, type EventType, type VisitorEvent } from "./events";

export interface IngestTrackingEventInput {
  trackingSiteId: string;
  anonymousId: string;
  anonymousSessionId: string;
  eventType: EventType;
  url?: string;
  metadata?: Record<string, unknown>;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  landingPage?: string;
  deviceType?: string;
}

export type IngestResult =
  | { accepted: false; reason: "consent_not_granted" | "tracking_site_revoked" }
  | { accepted: true; visitor: WebsiteVisitor; session: VisitorSession; event: VisitorEvent };

interface TrackingSiteCheckRow {
  id: string;
}

/**
 * The one atomic ingestion operation (Milestone 3.1B). Runs entirely
 * inside a single withTenantContext transaction — every sub-step
 * receives the same PoolClient via existingClient, so a failure at any
 * point after writes begin rolls the whole thing back (website_visitors,
 * visitor_sessions, visitor_events together, never a partial result).
 *
 * Deliberately does NOT call resolve_tracking_site() itself — that
 * pre-tenant credential resolution is 3.1C's own boundary responsibility
 * and requires organizationId to not yet be known. By the time this
 * function runs, organizationId/trackingSiteId are already trusted,
 * resolved values — this function's own tracking-site re-check (step 1
 * below) exists solely to close the TOCTOU window between that earlier
 * resolution and this write, never to perform resolution.
 *
 * Consent-absent/withdrawn and a revoked/missing/wrong-org tracking site
 * are expected, routine control-flow outcomes for a public tracking
 * beacon — returned as data (IngestResult's false branch), never thrown
 * — mirroring packages/compliance's previewUserErasure/
 * previewContactErasure precedent for an anticipated "cannot proceed"
 * result. Both rejection reasons are deliberately indistinguishable
 * between their own sub-cases (a missing, wrong-org, and revoked
 * tracking site all produce the identical "tracking_site_revoked"
 * result; a never-recorded and a withdrawn consent both produce the
 * identical "consent_not_granted" result) — matching this platform's
 * established cross-org/nonexistent-indistinguishable doctrine.
 */
export async function ingestTrackingEvent(
  ctx: RequestContext & { organizationId: string },
  input: IngestTrackingEventInput,
): Promise<IngestResult> {
  return withTenantContext(ctx, async (client) => {
    // Step 1: re-check the tracking site inside this tenant-scoped
    // transaction — TOCTOU defense against revocation happening between
    // 3.1C's earlier resolve_tracking_site() call and this write.
    const siteCheck = await client.query<TrackingSiteCheckRow>(
      `select id from public.tracking_sites
       where id = $1 and organization_id = $2 and revoked_at is null`,
      [input.trackingSiteId, ctx.organizationId],
    );
    if (siteCheck.rows.length === 0) {
      return { accepted: false, reason: "tracking_site_revoked" };
    }

    // Step 2: consent check — the only access path to consent_records
    // this package ever uses.
    const consentGranted = await checkCookieTrackingConsent(ctx, input.anonymousId, client);
    if (!consentGranted) {
      return { accepted: false, reason: "consent_not_granted" };
    }

    // Step 3-5: resolve/create visitor, resolve/create session, append
    // event — all on the same client, same transaction.
    const visitor = await resolveOrCreateVisitor(ctx, input.anonymousId, client);
    const session = await resolveOrCreateVisitorSession(
      ctx,
      {
        trackingSiteId: input.trackingSiteId,
        visitorId: visitor.id,
        anonymousSessionId: input.anonymousSessionId,
        ...(input.referrer !== undefined ? { referrer: input.referrer } : {}),
        ...(input.utmSource !== undefined ? { utmSource: input.utmSource } : {}),
        ...(input.utmMedium !== undefined ? { utmMedium: input.utmMedium } : {}),
        ...(input.utmCampaign !== undefined ? { utmCampaign: input.utmCampaign } : {}),
        ...(input.landingPage !== undefined ? { landingPage: input.landingPage } : {}),
        ...(input.deviceType !== undefined ? { deviceType: input.deviceType } : {}),
      },
      client,
    );
    const event = await appendVisitorEvent(
      ctx,
      {
        sessionId: session.id,
        eventType: input.eventType,
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
      client,
    );

    return { accepted: true, visitor, session, event };
  });
}
