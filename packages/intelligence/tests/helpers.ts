import { randomUUID } from "node:crypto";
import { Pool } from "pg";

// Same well-known local Supabase CLI default connection string used
// across every package's test suite — never valid against a real project.
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const adminPool = new Pool({ connectionString: LOCAL_DB_URL });

/** Real, committed transaction — for fixture setup, mirroring
 * packages/crm/tests/helpers.ts's own seedAsAdmin exactly. */
export async function seedAsAdmin<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** Creates a real organization only — no membership/auth.users row.
 * Every packages/intelligence function is role-less by design (the
 * ingestion pathway has no staff user, no membership), so unlike
 * packages/crm's createOrgWithActiveMember, no auth identity is needed
 * for any test in this suite. */
export async function createOrg(): Promise<string> {
  return seedAsAdmin(async (client) => {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      ["Intelligence Test Org", `intelligence-test-org-${randomUUID()}`],
    );
    return org.rows[0]!.id;
  });
}

export interface CreateTrackingSiteOptions {
  revoked?: boolean;
}

/** Creates a real tracking_sites row — packages/intelligence never
 * creates these itself (that's a future staff-facing concern, out of
 * 3.1B's scope), so every test that needs one seeds it directly. */
export async function createTrackingSite(organizationId: string, opts: CreateTrackingSiteOptions = {}): Promise<string> {
  return seedAsAdmin(async (client) => {
    const site = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, revoked_at) values ($1, $2) returning id",
      [organizationId, opts.revoked ? new Date().toISOString() : null],
    );
    return site.rows[0]!.id;
  });
}

/** Records a real consent_records row directly — packages/intelligence
 * never writes to this table itself (only reads via the narrow
 * check_visitor_cookie_tracking_consent() function), so every test that
 * needs a particular consent state seeds it directly, exactly as the
 * 3.1B database-prerequisite test suite already does. */
export async function recordConsent(opts: {
  organizationId: string;
  anonymousId: string;
  status: "granted" | "withdrawn";
  recordedAt?: string;
}): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query(
      `insert into public.consent_records (organization_id, subject_type, subject_id, consent_type, status, recorded_at)
       values ($1, 'visitor', $2, 'cookie_tracking', $3, coalesce($4::timestamptz, now()))`,
      [opts.organizationId, opts.anonymousId, opts.status, opts.recordedAt ?? null],
    );
  });
}

/** Grants cookie_tracking consent for a fresh, random anonymous_id and
 * returns it — the common case for tests that don't care about the
 * consent-check itself, only about what happens once it's granted. */
export async function grantedAnonymousId(organizationId: string): Promise<string> {
  const anonymousId = randomUUID();
  await recordConsent({ organizationId, anonymousId, status: "granted" });
  return anonymousId;
}
