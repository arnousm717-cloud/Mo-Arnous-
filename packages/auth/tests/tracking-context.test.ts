import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@ai-revenue-os/database";
import { resolveOrganizationContextForTrackingSite } from "../src/tracking-context";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1C-B coverage for resolveOrganizationContextForTrackingSite()
 * — a thin wrapper around the already-proven public.resolve_tracking_site()
 * (20260820090200), so this file does not re-prove that function's own
 * boundary/privilege behavior (fully owned by
 * packages/database/tests/tracking-site-resolver.test.ts's 11 tests) — only
 * that the wrapper itself correctly passes through and shapes the result.
 *
 * Reuses getPool()/closePool() (already exported from
 * @ai-revenue-os/database, already a dependency of this package) as the
 * admin-equivalent fixture-seeding connection — in this test environment
 * DATABASE_URL is the raw local postgres superuser connection string (same
 * value every other package's own tests use), so a raw client obtained
 * from getPool() bypasses RLS exactly like seedAsAdmin does elsewhere,
 * without requiring a redundant, package-local pg dependency.
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
  const client = await getPool().connect();
  try {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Auth Tracking Context Org A', $1) returning id",
      [`auth-tracking-context-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Auth Tracking Context Org B', $1) returning id",
      [`auth-tracking-context-org-b-${randomUUID()}`],
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
  } finally {
    client.release();
  }
}

async function cleanupFixture(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("delete from public.organizations where id = any($1::uuid[])", [[fx.orgAId, fx.orgBId]]);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  fx = await seedFixture();
});

afterAll(async () => {
  await cleanupFixture();
  await closePool();
});

describe("resolveOrganizationContextForTrackingSite: resolution behavior", () => {
  it("1. an active site resolves (non-null result)", async () => {
    const result = await resolveOrganizationContextForTrackingSite(fx.activeSiteAId);
    expect(result).not.toBeNull();
  });

  it("2. the returned trackingSiteId is exactly the supplied site key", async () => {
    const result = await resolveOrganizationContextForTrackingSite(fx.activeSiteAId);
    expect(result?.trackingSiteId).toBe(fx.activeSiteAId);
  });

  it("3. the returned organizationId is exactly the site's own owning organization", async () => {
    const result = await resolveOrganizationContextForTrackingSite(fx.activeSiteAId);
    expect(result?.organizationId).toBe(fx.orgAId);
  });

  it("4. a revoked site resolves to null", async () => {
    const result = await resolveOrganizationContextForTrackingSite(fx.revokedSiteId);
    expect(result).toBeNull();
  });

  it("5. a syntactically valid but nonexistent site key resolves to null", async () => {
    const result = await resolveOrganizationContextForTrackingSite(randomUUID());
    expect(result).toBeNull();
  });

  it("6. revoked and nonexistent produce the identical (null) result — indistinguishable, matching resolve_tracking_site()'s own doctrine", async () => {
    const revoked = await resolveOrganizationContextForTrackingSite(fx.revokedSiteId);
    const nonexistent = await resolveOrganizationContextForTrackingSite(randomUUID());
    expect(revoked).toEqual(nonexistent);
    expect(revoked).toBeNull();
  });

  it("7. a second organization's site resolves to its own distinct organizationId — no cross-tenant leakage", async () => {
    const resultA = await resolveOrganizationContextForTrackingSite(fx.activeSiteAId);
    const resultB = await resolveOrganizationContextForTrackingSite(fx.activeSiteBId);
    expect(resultA?.organizationId).toBe(fx.orgAId);
    expect(resultB?.organizationId).toBe(fx.orgBId);
    expect(resultA?.organizationId).not.toBe(resultB?.organizationId);
  });

  it("8. resolution succeeds with no pre-existing organization context of any kind — this is the bootstrap step, not the reverse", async () => {
    // No prior call in this test sets any tenant context at all; each test
    // in this file calls the wrapper cold, exactly as 3.1C-C's own
    // pre-tenant-bootstrap ingestion flow will.
    await expect(resolveOrganizationContextForTrackingSite(fx.activeSiteAId)).resolves.not.toBeNull();
  });
});

describe("resolveOrganizationContextForTrackingSite: structural contract", () => {
  it("9. no organizationId (or any second) parameter exists — exactly one declared parameter", () => {
    expect(resolveOrganizationContextForTrackingSite.length).toBe(1);

    // Wrapped in a never-invoked function: only the *type checker* needs to
    // see this call — JS silently ignores an extra runtime argument, so
    // actually invoking it would fire a real, untracked lookup, which is
    // not what this purely-structural test is about.
    function neverInvoked() {
      // @ts-expect-error — a second argument is a compile-time error, not
      // merely ignored: if a future change ever added an organizationId
      // parameter here, this line would stop being a type error and
      // `tsc --noEmit` would fail on the now-unused @ts-expect-error
      // directive, catching the regression before it ships.
      return resolveOrganizationContextForTrackingSite(fx.activeSiteAId, fx.orgAId);
    }
    expect(typeof neverInvoked).toBe("function");
  });
});
