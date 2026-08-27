import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1C-A coverage for record_visitor_cookie_tracking_consent()
 * (20260820110300) — the visitor's own, narrow write path for cookie-
 * tracking consent, deliberately unlike packages/compliance's staff-only
 * recordConsent(). Mirrors tracking-site-resolver.test.ts's own style for
 * site fixtures and visitor-cookie-tracking-consent.test.ts's own style
 * for consent assertions. Real Postgres, never mocked.
 *
 * This function WRITES, and several tests need to inspect the actual
 * persisted consent_records row afterward — consent_records' own RLS
 * (org_admin-only SELECT) means that read must go through seedAsAdmin
 * (bypasses RLS), which requires a real commit; see
 * asAuthenticatedCommitted below (mirrors tracking-rate-limit.test.ts's
 * own helper of the same name and rationale exactly).
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
  activeSiteAId: string;
  activeSiteBId: string;
  revokedSiteId: string;
}

let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Consent Write Test Org A', $1) returning id",
      [`consent-write-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Consent Write Test Org B', $1) returning id",
      [`consent-write-test-org-b-${randomUUID()}`],
    );
    const activeSiteA = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [orgA.rows[0]!.id, "Org A Active Site"],
    );
    const activeSiteB = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [orgB.rows[0]!.id, "Org B Active Site"],
    );
    const revokedSite = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label, revoked_at) values ($1, $2, now()) returning id",
      [orgA.rows[0]!.id, "Org A Revoked Site"],
    );
    return {
      orgAId: orgA.rows[0]!.id,
      orgBId: orgB.rows[0]!.id,
      activeSiteAId: activeSiteA.rows[0]!.id,
      activeSiteBId: activeSiteB.rows[0]!.id,
      revokedSiteId: revokedSite.rows[0]!.id,
    };
  });
}

/** Runs as `authenticated` (the only role with EXECUTE) and genuinely
 * commits, so the resulting consent_records row (if any) can be read back
 * afterward via seedAsAdmin — a plain `authenticated` read would be
 * blocked by consent_records' own org_admin-only SELECT policy regardless
 * of commit state (proven by visitor-cookie-tracking-consent.test.ts's
 * own test 14), so verification always goes through seedAsAdmin, which
 * requires the row to actually be committed first. */
async function asAuthenticatedCommitted<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Runs as the raw `anon` Postgres role directly, always rolled back. */
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

async function recordConsentWrite(siteKey: string, anonymousId: string, status: string): Promise<boolean> {
  return asAuthenticatedCommitted(async (client) => {
    const r = await client.query<{ record_visitor_cookie_tracking_consent: boolean }>(
      "select public.record_visitor_cookie_tracking_consent($1, $2, $3) as record_visitor_cookie_tracking_consent",
      [siteKey, anonymousId, status],
    );
    return r.rows[0]!.record_visitor_cookie_tracking_consent;
  });
}

interface ConsentRow {
  organization_id: string;
  subject_type: string;
  subject_id: string;
  consent_type: string;
  status: string;
  source: string | null;
  ip_address: string | null;
  recorded_at: string;
}

async function getConsentRows(organizationId: string, anonymousId: string): Promise<ConsentRow[]> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<ConsentRow>(
      `select organization_id, subject_type, subject_id, consent_type, status, source, ip_address, recorded_at
       from public.consent_records
       where organization_id = $1 and subject_id = $2
       order by recorded_at asc, id asc`,
      [organizationId, anonymousId],
    );
    return r.rows;
  });
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedFixture();
});

afterEach(async () => {
  // consent_records rows are org-scoped and not covered by
  // cleanupFixtures()' cascade — mirrors
  // visitor-cookie-tracking-consent.test.ts's own afterEach exactly.
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

describe("record_visitor_cookie_tracking_consent: write behavior", () => {
  it("1. a valid active site + status granted returns true and writes exactly one row", async () => {
    const anonymousId = randomUUID();
    const result = await recordConsentWrite(fx.activeSiteAId, anonymousId, "granted");
    expect(result).toBe(true);
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("granted");
  });

  it("2. a valid active site + status withdrawn returns true and writes exactly one row with status withdrawn", async () => {
    const anonymousId = randomUUID();
    const result = await recordConsentWrite(fx.activeSiteAId, anonymousId, "withdrawn");
    expect(result).toBe(true);
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("withdrawn");
  });

  it("3. organization_id is resolved correctly to the site's own owning org, not any other", async () => {
    const anonymousId = randomUUID();
    await recordConsentWrite(fx.activeSiteAId, anonymousId, "granted");
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.organization_id).toBe(fx.orgAId);
  });

  it("4. a revoked site key returns false and writes zero rows", async () => {
    const anonymousId = randomUUID();
    const result = await recordConsentWrite(fx.revokedSiteId, anonymousId, "granted");
    expect(result).toBe(false);
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows).toEqual([]);
  });

  it("5. a syntactically valid but nonexistent site key returns false and writes zero rows — indistinguishable from a revoked site", async () => {
    const anonymousId = randomUUID();
    const result = await recordConsentWrite(randomUUID(), anonymousId, "granted");
    expect(result).toBe(false);
    // No organization to scope the read to (site never resolved) — assert
    // via a global count for this anonymous_id across every org instead.
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.consent_records where subject_id = $1", [anonymousId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("6. an invalid status value raises an exception and writes zero rows", async () => {
    const anonymousId = randomUUID();
    await expect(recordConsentWrite(fx.activeSiteAId, anonymousId, "revoked")).rejects.toThrow(
      /p_status must be granted or withdrawn/i,
    );
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows).toEqual([]);
  });

  it("7. append-only: granted then withdrawn for the same anonymous_id produces two distinct rows, never one updated row", async () => {
    const anonymousId = randomUUID();
    await recordConsentWrite(fx.activeSiteAId, anonymousId, "granted");
    await recordConsentWrite(fx.activeSiteAId, anonymousId, "withdrawn");
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe("granted");
    expect(rows[1]!.status).toBe("withdrawn");
  });

  it("8. the inserted row has subject_type = 'visitor'", async () => {
    const anonymousId = randomUUID();
    await recordConsentWrite(fx.activeSiteAId, anonymousId, "granted");
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows[0]!.subject_type).toBe("visitor");
  });

  it("9. the inserted row has consent_type = 'cookie_tracking'", async () => {
    const anonymousId = randomUUID();
    await recordConsentWrite(fx.activeSiteAId, anonymousId, "granted");
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows[0]!.consent_type).toBe("cookie_tracking");
  });

  it("10. the inserted row has source = 'tracking_script'", async () => {
    const anonymousId = randomUUID();
    await recordConsentWrite(fx.activeSiteAId, anonymousId, "granted");
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows[0]!.source).toBe("tracking_script");
  });

  it("11. the inserted row has ip_address IS NULL — no IP parameter exists on this function at all", async () => {
    const anonymousId = randomUUID();
    await recordConsentWrite(fx.activeSiteAId, anonymousId, "granted");
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows[0]!.ip_address).toBeNull();
  });

  it("12. the inserted row's subject_id exactly equals p_anonymous_id", async () => {
    const anonymousId = randomUUID();
    await recordConsentWrite(fx.activeSiteAId, anonymousId, "granted");
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    expect(rows[0]!.subject_id).toBe(anonymousId);
  });

  it("13. the inserted row's recorded_at is set to (approximately) now — server-computed, never caller-suppliable", async () => {
    const anonymousId = randomUUID();
    const before = Date.now();
    await recordConsentWrite(fx.activeSiteAId, anonymousId, "granted");
    const after = Date.now();
    const rows = await getConsentRows(fx.orgAId, anonymousId);
    const recordedAtMs = new Date(rows[0]!.recorded_at).getTime();
    expect(recordedAtMs).toBeGreaterThanOrEqual(before - 5000);
    expect(recordedAtMs).toBeLessThanOrEqual(after + 5000);
  });

  it("14. two different sites belonging to different orgs each write correctly scoped rows to their own organization_id — no cross-contamination", async () => {
    const anonymousIdA = randomUUID();
    const anonymousIdB = randomUUID();
    await recordConsentWrite(fx.activeSiteAId, anonymousIdA, "granted");
    await recordConsentWrite(fx.activeSiteBId, anonymousIdB, "granted");

    const rowsA = await getConsentRows(fx.orgAId, anonymousIdA);
    const rowsB = await getConsentRows(fx.orgBId, anonymousIdB);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]!.organization_id).toBe(fx.orgAId);
    expect(rowsB[0]!.organization_id).toBe(fx.orgBId);
  });

  it("15. org A's site key cannot be used to write a consent row for org B — the written row's organization_id always matches the resolving site's actual owning org", async () => {
    const anonymousId = randomUUID();
    await recordConsentWrite(fx.activeSiteAId, anonymousId, "granted");
    const rowsUnderOrgB = await getConsentRows(fx.orgBId, anonymousId);
    expect(rowsUnderOrgB).toEqual([]);
    const rowsUnderOrgA = await getConsentRows(fx.orgAId, anonymousId);
    expect(rowsUnderOrgA).toHaveLength(1);
  });

  it("16. the function's return type is boolean only — no other metadata is ever returned", async () => {
    const typname = await seedAsAdmin(async (client) => {
      const r = await client.query<{ typname: string }>(
        `select t.typname
         from pg_proc p join pg_type t on t.oid = p.prorettype
         where p.proname = 'record_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]!.typname;
    });
    expect(typname).toBe("bool");
  });
});

describe("record_visitor_cookie_tracking_consent: privilege & structural boundary", () => {
  it("17. PUBLIC/anon has zero EXECUTE (inherited from the M1.7-era default-privilege hardening, no explicit revoke needed)", async () => {
    const granted = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        `select has_function_privilege('anon', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = 'record_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]?.x;
    });
    expect(granted).toBe(false);
  });

  it("18. authenticated has EXECUTE", async () => {
    const granted = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = 'record_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]?.x;
    });
    expect(granted).toBe(true);
  });

  it("19. anon cannot execute — rejected at the grant level, before any function logic runs", async () => {
    await expect(
      asAnon(async (client) => {
        await client.query("select public.record_visitor_cookie_tracking_consent($1, $2, $3)", [
          fx.activeSiteAId,
          randomUUID(),
          "granted",
        ]);
      }),
    ).rejects.toThrow(/permission denied for function record_visitor_cookie_tracking_consent/i);
  });

  it("20. exactly three parameters exist — p_site_key uuid, p_anonymous_id uuid, p_status text — no organization_id/ip/userId/roleKey parameter exists at all", async () => {
    const args = await seedAsAdmin(async (client) => {
      const r = await client.query<{ args: string }>(
        `select pg_get_function_arguments(p.oid) as args
         from pg_proc p where p.proname = 'record_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]!.args;
    });
    expect(args).toBe("p_site_key uuid, p_anonymous_id uuid, p_status text");
    expect(args).not.toMatch(/organization/i);
    expect(args).not.toMatch(/ip_address|p_ip/i);
    expect(args).not.toMatch(/user_id|p_user/i);
    expect(args).not.toMatch(/role_key|p_role/i);
  });

  it("21. search_path is fixed to public", async () => {
    const config = await seedAsAdmin(async (client) => {
      const r = await client.query<{ proconfig: string[] | null }>(
        `select proconfig from pg_proc where proname = 'record_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]!.proconfig;
    });
    expect(config).toContain("search_path=public");
  });

  it("22. the function is SECURITY DEFINER", async () => {
    const secdef = await seedAsAdmin(async (client) => {
      const r = await client.query<{ prosecdef: boolean }>(
        `select prosecdef from pg_proc where proname = 'record_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]!.prosecdef;
    });
    expect(secdef).toBe(true);
  });

  it("23. service_role has no explicit EXECUTE grant on this function", async () => {
    const granted = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        `select has_function_privilege('service_role', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = 'record_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]?.x;
    });
    expect(granted).toBe(false);

    const acl = await seedAsAdmin(async (client) => {
      const r = await client.query<{ proacl: string | null }>(
        `select proacl::text as proacl from pg_proc where proname = 'record_visitor_cookie_tracking_consent'`,
      );
      return r.rows[0]?.proacl ?? "";
    });
    expect(acl).not.toContain("service_role=X");
  });
});
