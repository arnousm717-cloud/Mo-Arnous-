import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closePool, withTenantContext } from "@ai-revenue-os/database";
import { recordVisitorCookieTrackingConsent } from "../src";
import { adminPool, seedAsAdmin } from "./helpers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1C-B coverage for recordVisitorCookieTrackingConsent() — a
 * thin wrapper around the already-proven
 * public.record_visitor_cookie_tracking_consent() (20260820110300), so
 * this file does not re-prove that function's own field-fixed-value/
 * security/privilege behavior (fully owned by
 * packages/database/tests/visitor-cookie-tracking-consent-write.test.ts's
 * 23 tests) — only that the wrapper itself correctly passes through,
 * shapes the result, and honors existingClient.
 */

interface Fixture {
  orgAId: string;
  activeSiteAId: string;
  revokedSiteId: string;
}

let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Tracking Consent Wrapper Org A', $1) returning id",
      [`tracking-consent-wrapper-org-a-${randomUUID()}`],
    );
    const activeSiteA = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [orgA.rows[0]!.id, "Org A Active Site"],
    );
    const revokedSite = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label, revoked_at) values ($1, $2, now()) returning id",
      [orgA.rows[0]!.id, "Org A Revoked Site"],
    );
    return {
      orgAId: orgA.rows[0]!.id,
      activeSiteAId: activeSiteA.rows[0]!.id,
      revokedSiteId: revokedSite.rows[0]!.id,
    };
  });
}

async function consentRowCount(anonymousId: string): Promise<number> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ n: number }>(
      "select count(*)::int as n from public.consent_records where subject_id = $1",
      [anonymousId],
    );
    return r.rows[0]!.n;
  });
}

beforeAll(async () => {
  fx = await seedFixture();
});

afterEach(async () => {
  await seedAsAdmin(async (client) => {
    await client.query("delete from public.consent_records where organization_id = $1", [fx.orgAId]);
  });
});

afterAll(async () => {
  await seedAsAdmin(async (client) => {
    await client.query("delete from public.organizations where id = $1", [fx.orgAId]);
  });
  await adminPool.end();
  await closePool();
});

describe("recordVisitorCookieTrackingConsent: write behavior", () => {
  it("1. a grant returns true", async () => {
    const result = await recordVisitorCookieTrackingConsent(fx.activeSiteAId, randomUUID(), "granted");
    expect(result).toBe(true);
  });

  it("2. a withdrawal returns true", async () => {
    const result = await recordVisitorCookieTrackingConsent(fx.activeSiteAId, randomUUID(), "withdrawn");
    expect(result).toBe(true);
  });

  it("3. grant -> withdrawal -> grant remains append-only (three rows, not one updated row)", async () => {
    const anonymousId = randomUUID();
    await recordVisitorCookieTrackingConsent(fx.activeSiteAId, anonymousId, "granted");
    await recordVisitorCookieTrackingConsent(fx.activeSiteAId, anonymousId, "withdrawn");
    await recordVisitorCookieTrackingConsent(fx.activeSiteAId, anonymousId, "granted");
    expect(await consentRowCount(anonymousId)).toBe(3);
  });

  it("4. a revoked site returns false", async () => {
    const result = await recordVisitorCookieTrackingConsent(fx.revokedSiteId, randomUUID(), "granted");
    expect(result).toBe(false);
  });

  it("5. a nonexistent site returns false", async () => {
    const result = await recordVisitorCookieTrackingConsent(randomUUID(), randomUUID(), "granted");
    expect(result).toBe(false);
  });

  it("6. both false cases (revoked, nonexistent) write zero rows", async () => {
    const anonymousIdRevoked = randomUUID();
    const anonymousIdNonexistent = randomUUID();
    await recordVisitorCookieTrackingConsent(fx.revokedSiteId, anonymousIdRevoked, "granted");
    await recordVisitorCookieTrackingConsent(randomUUID(), anonymousIdNonexistent, "granted");
    expect(await consentRowCount(anonymousIdRevoked)).toBe(0);
    expect(await consentRowCount(anonymousIdNonexistent)).toBe(0);
  });
});

describe("recordVisitorCookieTrackingConsent: structural contract", () => {
  it("7. status is structurally limited to granted/withdrawn at the type level, and the DB's own defense-in-depth guard still rejects an invalid value that reaches it anyway", async () => {
    const invalidStatus = "maybe";
    await expect(
      // @ts-expect-error — "maybe" is not a TrackingConsentStatus; this must
      // remain a compile-time error, not merely a runtime-rejected value. If
      // TrackingConsentStatus were ever widened to a plain string, this line
      // would stop being a type error and tsc --noEmit would fail on the
      // now-unused directive above, catching the regression. Awaited (not
      // fire-and-forget) so the DB's own rejection is properly observed
      // rather than surfacing as an unhandled rejection.
      recordVisitorCookieTrackingConsent(fx.activeSiteAId, randomUUID(), invalidStatus),
    ).rejects.toThrow(/p_status must be granted or withdrawn/i);
  });

  it("10. no organizationId/userId/roleKey/IP parameter exists — exactly four declared parameters (siteKey, anonymousId, status, existingClient?)", () => {
    // TypeScript's `?` optional-parameter marker has no runtime effect on
    // emitted JS (unlike a `= default` value) — the compiled function still
    // has four ordinary parameters, so Function.length reports 4. This is
    // the wrapper's own complete parameter surface; the fifth-argument
    // ts-expect-error below is what proves nothing beyond it exists.
    expect(recordVisitorCookieTrackingConsent.length).toBe(4);

    // Wrapped in a never-invoked function: only the *type checker* needs to
    // see this call — actually executing it would fire a real, untracked
    // write (JS silently ignores the extra runtime argument), which is not
    // what this purely-structural test is about.
    function neverInvoked() {
      // @ts-expect-error — a fifth argument (an organizationId-shaped value)
      // is a compile-time error: no such parameter exists on this function.
      return recordVisitorCookieTrackingConsent(fx.activeSiteAId, randomUUID(), "granted", undefined, fx.orgAId);
    }
    expect(typeof neverInvoked).toBe("function");
  });

  it("11. the wrapper's only DB write primitive is record_visitor_cookie_tracking_consent() — never a direct insert into consent_records", () => {
    const source = readFileSync(path.join(__dirname, "../src/tracking-consent.ts"), "utf8");
    expect(source).toContain("select public.record_visitor_cookie_tracking_consent($1, $2, $3)");
    expect(source.toLowerCase()).not.toContain("insert into public.consent_records");
  });
});

describe("recordVisitorCookieTrackingConsent: existingClient transaction participation", () => {
  it("8. existingClient participates in the caller's transaction — a write made through it persists once the OUTER transaction commits", async () => {
    // Deliberately does not read back via the same `client` mid-transaction:
    // that connection runs as `authenticated` with no app.current_org/role
    // set (ctx is always {} for this pathway), and consent_records' own RLS
    // (org_admin-only SELECT) would block even a real, uncommitted row from
    // that same session — proven as its own regression case by
    // visitor-cookie-tracking-consent.test.ts's test 14. Participation is
    // proven the same way transaction-participation.test.ts proves it
    // elsewhere in this package: by commit persisting the write (this test)
    // and by rollback undoing it (test 9 below) — neither is possible
    // unless the write genuinely ran on the supplied client's own
    // transaction, not a separate internally-opened one.
    const anonymousId = randomUUID();
    const result = await withTenantContext({}, async (client) => {
      return recordVisitorCookieTrackingConsent(fx.activeSiteAId, anonymousId, "granted", client);
    });
    expect(result).toBe(true);
    expect(await consentRowCount(anonymousId)).toBe(1);
  });

  it("9. a caller rollback removes the consent write entirely", async () => {
    const anonymousId = randomUUID();
    const marker = new Error("deliberate rollback marker — 3.1C-B existingClient rollback test");
    await expect(
      withTenantContext({}, async (client) => {
        const result = await recordVisitorCookieTrackingConsent(fx.activeSiteAId, anonymousId, "granted", client);
        expect(result).toBe(true);
        throw marker;
      }),
    ).rejects.toBe(marker);

    // withTenantContext rolls back on any thrown error — a separate,
    // RLS-bypassing connection confirms nothing survived the rollback.
    expect(await consentRowCount(anonymousId)).toBe(0);
  });

  it("omitting existingClient behaves exactly as before — opens and commits its own transaction", async () => {
    const anonymousId = randomUUID();
    const result = await recordVisitorCookieTrackingConsent(fx.activeSiteAId, anonymousId, "granted");
    expect(result).toBe(true);
    expect(await consentRowCount(anonymousId)).toBe(1);
  });
});
