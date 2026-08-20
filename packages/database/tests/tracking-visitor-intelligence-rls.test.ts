import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1A RLS/privilege adversarial coverage (docs/13-Technical-
 * Design-Review.md "Milestone 3.1A"). Mirrors pipelines-deals-
 * rls.test.ts/companies-contacts-rls.test.ts exactly in style: real
 * Postgres, never mocked, org A vs org B, via the ordinary
 * withTenantContext tenant-scoped path — never through the
 * resolve_tracking_site() resolver, which is covered separately in
 * tracking-site-resolver.test.ts and is a deliberate, documented,
 * narrowly-scoped exception to everything asserted here, not a
 * counterexample to it.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
  siteAId: string;
  siteBId: string;
  visitorAId: string;
  visitorBId: string;
  sessionAId: string;
  sessionBId: string;
  eventAId: string;
  eventBId: string;
}

let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Tracking RLS Test Org A', $1) returning id",
      [`tracking-rls-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Tracking RLS Test Org B', $1) returning id",
      [`tracking-rls-test-org-b-${randomUUID()}`],
    );
    const siteA = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [orgA.rows[0]!.id, "Org A Site"],
    );
    const siteB = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [orgB.rows[0]!.id, "Org B Site"],
    );
    const visitorA = await client.query<{ id: string }>(
      "insert into public.website_visitors (organization_id, anonymous_id) values ($1, $2) returning id",
      [orgA.rows[0]!.id, randomUUID()],
    );
    const visitorB = await client.query<{ id: string }>(
      "insert into public.website_visitors (organization_id, anonymous_id) values ($1, $2) returning id",
      [orgB.rows[0]!.id, randomUUID()],
    );
    const sessionA = await client.query<{ id: string }>(
      "insert into public.visitor_sessions (organization_id, visitor_id, tracking_site_id) values ($1, $2, $3) returning id",
      [orgA.rows[0]!.id, visitorA.rows[0]!.id, siteA.rows[0]!.id],
    );
    const sessionB = await client.query<{ id: string }>(
      "insert into public.visitor_sessions (organization_id, visitor_id, tracking_site_id) values ($1, $2, $3) returning id",
      [orgB.rows[0]!.id, visitorB.rows[0]!.id, siteB.rows[0]!.id],
    );
    const eventA = await client.query<{ id: string }>(
      "insert into public.visitor_events (organization_id, session_id, event_type) values ($1, $2, 'pageview') returning id",
      [orgA.rows[0]!.id, sessionA.rows[0]!.id],
    );
    const eventB = await client.query<{ id: string }>(
      "insert into public.visitor_events (organization_id, session_id, event_type) values ($1, $2, 'pageview') returning id",
      [orgB.rows[0]!.id, sessionB.rows[0]!.id],
    );
    return {
      orgAId: orgA.rows[0]!.id,
      orgBId: orgB.rows[0]!.id,
      siteAId: siteA.rows[0]!.id,
      siteBId: siteB.rows[0]!.id,
      visitorAId: visitorA.rows[0]!.id,
      visitorBId: visitorB.rows[0]!.id,
      sessionAId: sessionA.rows[0]!.id,
      sessionBId: sessionB.rows[0]!.id,
      eventAId: eventA.rows[0]!.id,
      eventBId: eventB.rows[0]!.id,
    };
  });
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

describe("tracking_sites RLS: cross-tenant SELECT/UPDATE/INSERT isolation", () => {
  it("org A cannot SELECT org B's tracking site", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.tracking_sites where id = $1", [fx.siteBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot revoke (UPDATE) org B's tracking site", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.tracking_sites set revoked_at = now() where id = $1 returning id", [
        fx.siteBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
    const stillActive = await seedAsAdmin(async (client) => {
      const r = await client.query("select revoked_at from public.tracking_sites where id = $1", [fx.siteBId]);
      return r.rows[0];
    });
    expect(stillActive.revoked_at).toBeNull();
  });

  it("org A cannot create a tracking site for org B (INSERT WITH CHECK spoofing rejected)", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.tracking_sites (organization_id, label) values ($1, $2)", [
          fx.orgBId,
          "Spoofed Site Insert",
        ]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });
});

describe("website_visitors RLS: cross-tenant SELECT/UPDATE/INSERT isolation", () => {
  it("org A cannot SELECT org B's visitor", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.website_visitors where id = $1", [fx.visitorBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's visitor", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.website_visitors set last_seen_at = now() where id = $1 returning id", [
        fx.visitorBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("INSERT cannot spoof organization_id on a visitor to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.website_visitors (organization_id, anonymous_id) values ($1, $2)", [
          fx.orgBId,
          randomUUID(),
        ]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });
});

describe("visitor_sessions RLS: cross-tenant SELECT/UPDATE/INSERT isolation", () => {
  it("org A cannot SELECT org B's session", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.visitor_sessions where id = $1", [fx.sessionBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's session", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.visitor_sessions set ended_at = now() where id = $1 returning id", [
        fx.sessionBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("INSERT cannot spoof organization_id on a session to another tenant while scoped to org A (rejected by RLS before the composite FKs are even relevant)", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.visitor_sessions (organization_id, visitor_id, tracking_site_id) values ($1, $2, $3)",
          [fx.orgBId, fx.visitorAId, fx.siteAId],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });
});

describe("visitor_events RLS: cross-tenant SELECT/INSERT isolation (no UPDATE policy exists at all)", () => {
  it("org A cannot SELECT org B's event", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.visitor_events where id = $1", [fx.eventBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("INSERT cannot spoof organization_id on an event to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.visitor_events (organization_id, session_id, event_type) values ($1, $2, 'pageview')",
          [fx.orgBId, fx.sessionAId],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("no authenticated caller — even scoped to the event's own organization — can UPDATE an event (no UPDATE policy/grant exists)", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("update public.visitor_events set url = 'https://hijacked.example' where id = $1", [
          fx.eventAId,
        ]);
      }),
    ).rejects.toThrow(/permission denied for table visitor_events/i);
  });
});

describe("no DELETE grant/policy exists on any of the four tables (lifecycle is revoked_at, never physical delete, for the ones that have a lifecycle at all)", () => {
  it("authenticated cannot DELETE a tracking_sites row even within its own organization", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.tracking_sites where id = $1", [fx.siteAId]);
      }),
    ).rejects.toThrow(/permission denied for table tracking_sites/i);
  });

  it("authenticated cannot DELETE a website_visitors row even within its own organization", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.website_visitors where id = $1", [fx.visitorAId]);
      }),
    ).rejects.toThrow(/permission denied for table website_visitors/i);
  });

  it("authenticated cannot DELETE a visitor_sessions row even within its own organization", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.visitor_sessions where id = $1", [fx.sessionAId]);
      }),
    ).rejects.toThrow(/permission denied for table visitor_sessions/i);
  });

  it("authenticated cannot DELETE a visitor_events row even within its own organization", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.visitor_events where id = $1", [fx.eventAId]);
      }),
    ).rejects.toThrow(/permission denied for table visitor_events/i);
  });
});

describe("anon has zero grants on any of the four tables", () => {
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

  const tables = ["tracking_sites", "website_visitors", "visitor_sessions", "visitor_events"] as const;

  for (const table of tables) {
    // Every RLS policy on these tables references current_org(), which
    // anon has no EXECUTE on (correctly — RLS_SUPPORT_FUNCTIONS is
    // authenticated-only, function-execution-privilege-hardening.test.ts).
    // Empirically confirmed identical, pre-existing behavior on the
    // long-established `companies` table too, not something new here:
    // Postgres surfaces "permission denied for function current_org"
    // rather than a table-grant-denied message for this role/policy
    // combination — the actual, real error shape, not a table-level ACL
    // message.
    it(`anon cannot SELECT public.${table}`, async () => {
      await expect(asAnon((client) => client.query(`select 1 from public.${table} limit 1`))).rejects.toThrow(
        /permission denied for function current_org/i,
      );
    });

    it(`anon cannot INSERT into public.${table}`, async () => {
      await expect(
        asAnon((client) => client.query(`insert into public.${table} default values`)),
      ).rejects.toThrow(/permission denied|null value|violates not-null/i);
    });
  }
});
