import type { PoolClient } from "pg";
import { runInClientOrTransaction, type RequestContext } from "@ai-revenue-os/database";

/**
 * Visitor resolve/create (Milestone 3.1B). No identification logic here
 * at all — identifiedContactId is never referenced in the INSERT column
 * list below, so it is structurally NULL for every row this function
 * creates, not merely left unpopulated by convention. Matching to a
 * real contact is Milestone 3.2's own, separate responsibility.
 */

export interface WebsiteVisitor {
  id: string;
  organizationId: string;
  anonymousId: string;
  identifiedContactId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface WebsiteVisitorRow {
  id: string;
  organization_id: string;
  anonymous_id: string;
  identified_contact_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function mapVisitorRow(row: WebsiteVisitorRow): WebsiteVisitor {
  return {
    id: row.id,
    organizationId: row.organization_id,
    anonymousId: row.anonymous_id,
    identifiedContactId: row.identified_contact_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Atomic upsert on the existing UNIQUE(organization_id, anonymous_id)
 * constraint (3.1A) — one statement, race-safe by Postgres's own
 * ON CONFLICT guarantee, not a check-then-insert race. first_seen_at is
 * never referenced in the DO UPDATE clause — immutable after creation.
 * last_seen_at updates on every successful call, including for an
 * already-existing visitor. The same anonymous_id independently resolves
 * per organization via that same constraint — never cross-tenant.
 */
export async function resolveOrCreateVisitor(
  ctx: RequestContext & { organizationId: string },
  anonymousId: string,
  existingClient?: PoolClient,
): Promise<WebsiteVisitor> {
  return runInClientOrTransaction(ctx, existingClient, async (client) => {
    const r = await client.query<WebsiteVisitorRow>(
      `insert into public.website_visitors (organization_id, anonymous_id)
       values ($1, $2)
       on conflict (organization_id, anonymous_id)
       do update set last_seen_at = now()
       returning id, organization_id, anonymous_id, identified_contact_id, first_seen_at, last_seen_at`,
      [ctx.organizationId, anonymousId],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error("website_visitors upsert returned no row — this should be unreachable.");
    }
    return mapVisitorRow(row);
  });
}
