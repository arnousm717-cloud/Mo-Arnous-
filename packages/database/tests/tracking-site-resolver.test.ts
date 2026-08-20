import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1A adversarial coverage for resolve_tracking_site() — the
 * one function in this schema with no auth.uid() caller-identity guard
 * (3.1 architecture decision report Section 13, this function's own
 * migration comment, 20260820090200). Mirrors function-execution-
 * privilege-hardening.test.ts exactly in style for the privilege-boundary
 * assertions: real Postgres, real role simulation (anon/authenticated),
 * has_function_privilege() for the grant matrix, never mocked.
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
      "insert into public.organizations (name, slug) values ('Resolver Test Org A', $1) returning id",
      [`resolver-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Resolver Test Org B', $1) returning id",
      [`resolver-test-org-b-${randomUUID()}`],
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

/** Runs as the raw `anon` Postgres role directly, always rolled back — mirrors
 * function-execution-privilege-hardening.test.ts's own asAnon helper. */
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

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedFixture();
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("resolve_tracking_site: resolution behavior", () => {
  it("a valid, active tracking-site id resolves to exactly its own organization_id", async () => {
    const rows = await withTenantContext({}, async (client) => {
      const r = await client.query<{ organization_id: string }>("select * from public.resolve_tracking_site($1)", [
        fx.activeSiteAId,
      ]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.organization_id).toBe(fx.orgAId);
  });

  it("resolves the correct, distinct organization_id for a different organization's site — no cross-tenant leakage", async () => {
    const rows = await withTenantContext({}, async (client) => {
      const r = await client.query<{ organization_id: string }>("select * from public.resolve_tracking_site($1)", [
        fx.activeSiteBId,
      ]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.organization_id).toBe(fx.orgBId);
  });

  it("a revoked tracking-site id resolves nothing", async () => {
    const rows = await withTenantContext({}, async (client) => {
      const r = await client.query("select * from public.resolve_tracking_site($1)", [fx.revokedSiteId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("a syntactically valid but nonexistent UUID resolves nothing — indistinguishable from a revoked id (same empty-result shape, matching this platform's cross-org/nonexistent-indistinguishable doctrine)", async () => {
    const rows = await withTenantContext({}, async (client) => {
      const r = await client.query("select * from public.resolve_tracking_site($1)", [randomUUID()]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("returns organization_id only — no label, created_by, created_at, or revoked_at leak through", async () => {
    const rows = await withTenantContext({}, async (client) => {
      const r = await client.query("select * from public.resolve_tracking_site($1)", [fx.activeSiteAId]);
      return r.fields.map((f) => f.name);
    });
    expect(rows).toEqual(["organization_id"]);
  });

  it("does not require any tenant context to already be set — this is the whole point of the function (bootstraps organization_id, not the reverse)", async () => {
    // withTenantContext({}) sets no app.current_org at all, exactly the
    // pre-tenant-bootstrap state the ingestion flow will actually call
    // this in (3.1 architecture decision report Section 3).
    const rows = await withTenantContext({}, async (client) => {
      const orgSetting = await client.query("select current_setting('app.current_org', true) as v");
      // Never set in this transaction (withTenantContext({}) supplies no
      // organizationId) — current_setting(..., true) returns SQL NULL for
      // an unset custom GUC in this session, not an empty string; either
      // way, current_org() itself (nullif(..., '')::uuid) treats both as
      // "no tenant context," which is the actual invariant under test.
      expect(orgSetting.rows[0]!.v).toBeFalsy();
      const r = await client.query("select * from public.resolve_tracking_site($1)", [fx.activeSiteAId]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });
});

describe("resolve_tracking_site: malformed input — documented DB-layer behavior, not a DB-layer fix", () => {
  it("a non-UUID-shaped string is rejected by Postgres itself at the type-cast boundary, before the function body ever runs — this is NOT caught or normalized inside the function, and must be validated at the application layer before this function is ever called (3.1C's own future isValidUuid-style guard, mirroring Milestone 2.3D/2.5C's existing precedent — not invented here)", async () => {
    await expect(
      withTenantContext({}, async (client) => {
        await client.query("select * from public.resolve_tracking_site($1)", ["not-a-uuid"]);
      }),
    ).rejects.toThrow(/invalid input syntax for type uuid/i);
  });
});

describe("resolve_tracking_site: privilege boundary", () => {
  it("PUBLIC has zero EXECUTE on resolve_tracking_site (inherited from the M1.7-era default-privilege hardening, no explicit revoke needed)", async () => {
    const granted = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        `select has_function_privilege('anon', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = 'resolve_tracking_site'`,
      );
      return r.rows[0]?.x;
    });
    // has_function_privilege for the PUBLIC pseudo-role is implicitly
    // covered by checking a role with no explicit grant (anon below) —
    // this assertion is the direct anon-specific check; a role with
    // literally zero grants of its own (no direct grant, no PUBLIC grant)
    // must resolve false here.
    expect(granted).toBe(false);
  });

  it("anon cannot execute resolve_tracking_site — rejected at the grant level, before any function logic runs", async () => {
    await expect(
      asAnon(async (client) => {
        await client.query("select * from public.resolve_tracking_site($1)", [fx.activeSiteAId]);
      }),
    ).rejects.toThrow(/permission denied for function resolve_tracking_site/i);
  });

  it("authenticated (the only backend role this application ever uses for any request, per tenant-context.ts) has EXECUTE on resolve_tracking_site", async () => {
    const granted = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = 'resolve_tracking_site'`,
      );
      return r.rows[0]?.x;
    });
    expect(granted).toBe(true);
  });

  it("authenticated can actually call resolve_tracking_site without a permission error, using no other context than the tracking-site identifier itself", async () => {
    await expect(
      withTenantContext({}, async (client) => {
        await client.query("select * from public.resolve_tracking_site($1)", [fx.activeSiteAId]);
      }),
    ).resolves.not.toThrow();
  });
});
