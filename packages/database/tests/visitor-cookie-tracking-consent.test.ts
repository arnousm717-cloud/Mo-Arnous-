import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1B prerequisite coverage for
 * check_visitor_cookie_tracking_consent() (20260820100100). Mirrors
 * tracking-site-resolver.test.ts exactly in style: real Postgres, real
 * role simulation, has_function_privilege() for the grant matrix, never
 * mocked. This function exists specifically because consent_records'
 * own RLS (org_admin-only SELECT) makes the table unreadable to the
 * role-less ingestion pathway — proven empirically during the 3.1B
 * pre-implementation audit, re-proven here as its own regression test
 * (see "existing consent_records RLS/policies remain unchanged" below).
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
}

let fx: Fixture;

async function seedOrgs(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Consent Helper Test Org A', $1) returning id",
      [`consent-helper-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Consent Helper Test Org B', $1) returning id",
      [`consent-helper-test-org-b-${randomUUID()}`],
    );
    return { orgAId: orgA.rows[0]!.id, orgBId: orgB.rows[0]!.id };
  });
}

async function insertConsent(opts: {
  organizationId: string;
  subjectType?: string;
  subjectId: string;
  consentType?: string;
  status: "granted" | "withdrawn";
  recordedAt?: string;
}): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      `insert into public.consent_records (organization_id, subject_type, subject_id, consent_type, status, recorded_at)
       values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))
       returning id`,
      [
        opts.organizationId,
        opts.subjectType ?? "visitor",
        opts.subjectId,
        opts.consentType ?? "cookie_tracking",
        opts.status,
        opts.recordedAt ?? null,
      ],
    );
    return r.rows[0]!.id;
  });
}

async function checkConsent(organizationId: string, anonymousId: string): Promise<boolean> {
  return withTenantContext({}, async (client) => {
    const r = await client.query<{ check_visitor_cookie_tracking_consent: boolean }>(
      "select public.check_visitor_cookie_tracking_consent($1, $2) as check_visitor_cookie_tracking_consent",
      [organizationId, anonymousId],
    );
    return r.rows[0]!.check_visitor_cookie_tracking_consent;
  });
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedOrgs();
});

afterEach(async () => {
  // Consent rows are org-scoped and not covered by cleanupFixtures()'
  // cascade — each test creates its own anonymous_id, so no cross-test
  // interference is possible even without per-test cleanup, but truncate
  // defensively to keep row counts small across the suite.
  await seedAsAdmin(async (client) => {
    await client.query("delete from public.consent_records where organization_id in ($1, $2)", [
      fx.orgAId,
      fx.orgBId,
    ]);
  });
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("check_visitor_cookie_tracking_consent: resolution behavior", () => {
  it("1. no matching row => false", async () => {
    const result = await checkConsent(fx.orgAId, randomUUID());
    expect(result).toBe(false);
  });

  it("2. latest status granted => true", async () => {
    const anonymousId = randomUUID();
    await insertConsent({ organizationId: fx.orgAId, subjectId: anonymousId, status: "granted" });
    const result = await checkConsent(fx.orgAId, anonymousId);
    expect(result).toBe(true);
  });

  it("3. latest status withdrawn => false", async () => {
    const anonymousId = randomUUID();
    await insertConsent({ organizationId: fx.orgAId, subjectId: anonymousId, status: "withdrawn" });
    const result = await checkConsent(fx.orgAId, anonymousId);
    expect(result).toBe(false);
  });

  it("4. grant -> withdraw -> grant => true (latest row governs, append-only history is not blindly OR'd)", async () => {
    const anonymousId = randomUUID();
    const base = Date.now();
    await insertConsent({
      organizationId: fx.orgAId,
      subjectId: anonymousId,
      status: "granted",
      recordedAt: new Date(base).toISOString(),
    });
    await insertConsent({
      organizationId: fx.orgAId,
      subjectId: anonymousId,
      status: "withdrawn",
      recordedAt: new Date(base + 1000).toISOString(),
    });
    await insertConsent({
      organizationId: fx.orgAId,
      subjectId: anonymousId,
      status: "granted",
      recordedAt: new Date(base + 2000).toISOString(),
    });
    const result = await checkConsent(fx.orgAId, anonymousId);
    expect(result).toBe(true);
  });

  it("5. deterministic same-recorded_at tie: the row with the higher id governs per ORDER BY recorded_at DESC, id DESC — proven by independently re-deriving the expected winner with the identical rule, not by assuming gen_random_uuid() ordering", async () => {
    const anonymousId = randomUUID();
    const tiedAt = new Date().toISOString();

    await insertConsent({
      organizationId: fx.orgAId,
      subjectId: anonymousId,
      status: "granted",
      recordedAt: tiedAt,
    });
    await insertConsent({
      organizationId: fx.orgAId,
      subjectId: anonymousId,
      status: "withdrawn",
      recordedAt: tiedAt,
    });

    // Independently apply the exact same ORDER BY rule the function's own
    // migration source uses, directly against the seeded rows — this is
    // what proves the tie-break RULE governs (id desc), rather than
    // merely asserting a result that happens to match a fixed assumption
    // about UUID ordering.
    const expected = await seedAsAdmin(async (client) => {
      const r = await client.query<{ status: string }>(
        `select status from public.consent_records
         where organization_id = $1 and subject_type = 'visitor' and subject_id = $2 and consent_type = 'cookie_tracking'
         order by recorded_at desc, id desc limit 1`,
        [fx.orgAId, anonymousId],
      );
      return r.rows[0]!.status;
    });
    const result = await checkConsent(fx.orgAId, anonymousId);
    expect(result).toBe(expected === "granted");
  });

  it("6. a different organization's identical anonymous_id cannot affect the result (cross-org isolation)", async () => {
    const sharedAnonymousId = randomUUID();
    await insertConsent({ organizationId: fx.orgBId, subjectId: sharedAnonymousId, status: "granted" });
    // Org A has never recorded anything for this anonymous_id.
    const result = await checkConsent(fx.orgAId, sharedAnonymousId);
    expect(result).toBe(false);
  });

  it("7. a granted non-cookie_tracking consent_type cannot cause a true result", async () => {
    const anonymousId = randomUUID();
    await insertConsent({
      organizationId: fx.orgAId,
      subjectId: anonymousId,
      consentType: "marketing_email",
      status: "granted",
    });
    const result = await checkConsent(fx.orgAId, anonymousId);
    expect(result).toBe(false);
  });

  it("8. a granted cookie_tracking consent recorded under a non-visitor subject_type cannot cause a true result", async () => {
    const contactId = randomUUID();
    await insertConsent({
      organizationId: fx.orgAId,
      subjectType: "contact",
      subjectId: contactId,
      status: "granted",
    });
    const result = await checkConsent(fx.orgAId, contactId);
    expect(result).toBe(false);
  });
});

describe("check_visitor_cookie_tracking_consent: privilege boundary", () => {
  async function asAnon<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      await client.query("set local role anon");
      return await fn(client);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  }

  it("9. PUBLIC has zero EXECUTE (inherited from the M1.7-era default-privilege hardening)", async () => {
    const granted = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        `select has_function_privilege('anon', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = 'check_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]?.x;
    });
    expect(granted).toBe(false);
  });

  it("10. anon cannot execute — rejected at the grant level, before any function logic runs", async () => {
    await expect(
      asAnon(async (client) => {
        await client.query("select public.check_visitor_cookie_tracking_consent($1, $2)", [
          fx.orgAId,
          randomUUID(),
        ]);
      }),
    ).rejects.toThrow(/permission denied for function check_visitor_cookie_tracking_consent/i);
  });

  it("11. authenticated has EXECUTE", async () => {
    const granted = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = 'check_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]?.x;
    });
    expect(granted).toBe(true);
  });
});

describe("check_visitor_cookie_tracking_consent: return shape and definition", () => {
  it("12. returns boolean only", async () => {
    const columnType = await seedAsAdmin(async (client) => {
      const r = await client.query<{ typname: string }>(
        `select t.typname
         from pg_proc p join pg_type t on t.oid = p.prorettype
         where p.proname = 'check_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]!.typname;
    });
    expect(columnType).toBe("bool");
  });

  it("13. fixed search_path is set to public", async () => {
    const config = await seedAsAdmin(async (client) => {
      const r = await client.query<{ proconfig: string[] | null }>(
        `select proconfig from pg_proc where proname = 'check_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]!.proconfig;
    });
    expect(config).toContain("search_path=public");
  });
});

describe("existing consent_records RLS/policies remain unchanged by this migration", () => {
  it("14. a role-less, org-scoped-only read still cannot see consent_records directly (the exact gap this function exists to close, still true for every OTHER caller — confirms this migration did not weaken the underlying table's own RLS)", async () => {
    const anonymousId = randomUUID();
    await insertConsent({ organizationId: fx.orgAId, subjectId: anonymousId, status: "granted" });

    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        `select id from public.consent_records where organization_id = $1 and subject_id = $2`,
        [fx.orgAId, anonymousId],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("14b. an org_admin-scoped read still sees the row exactly as before (org_admin_select policy untouched)", async () => {
    const anonymousId = randomUUID();
    await insertConsent({ organizationId: fx.orgAId, subjectId: anonymousId, status: "granted" });

    const rows = await withTenantContext({ organizationId: fx.orgAId, roleKey: "org_admin" }, async (client) => {
      const r = await client.query(
        `select id, status from public.consent_records where organization_id = $1 and subject_id = $2`,
        [fx.orgAId, anonymousId],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("granted");
  });
});
