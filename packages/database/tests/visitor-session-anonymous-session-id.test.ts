import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1B prerequisite coverage for the anonymous_session_id
 * schema patch (20260820100000_add_anonymous_session_id_to_visitor_
 * sessions.sql) — an additive follow-up to the 3.1A schema, never an
 * edit to 20260820090000. Mirrors tracking-visitor-intelligence-
 * schema.test.ts exactly in style: real Postgres, direct SQL under
 * seedAsAdmin, never through an application layer that doesn't exist yet.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
}

let fx: Fixture;

async function seedOrgs(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Session Patch Test Org A', $1) returning id",
      [`session-patch-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Session Patch Test Org B', $1) returning id",
      [`session-patch-test-org-b-${randomUUID()}`],
    );
    return { orgAId: orgA.rows[0]!.id, orgBId: orgB.rows[0]!.id };
  });
}

async function seedTrackingSite(client: import("pg").PoolClient, organizationId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.tracking_sites (organization_id) values ($1) returning id",
    [organizationId],
  );
  return r.rows[0]!.id;
}

async function seedVisitor(client: import("pg").PoolClient, organizationId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.website_visitors (organization_id, anonymous_id) values ($1, $2) returning id",
    [organizationId, randomUUID()],
  );
  return r.rows[0]!.id;
}

async function seedSession(
  client: import("pg").PoolClient,
  organizationId: string,
  visitorId: string,
  trackingSiteId: string,
  anonymousSessionId: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.visitor_sessions (organization_id, visitor_id, tracking_site_id, anonymous_session_id) values ($1, $2, $3, $4) returning id",
    [organizationId, visitorId, trackingSiteId, anonymousSessionId],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedOrgs();
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("visitor_sessions.anonymous_session_id: column shape", () => {
  it("15. exists as a uuid, NOT NULL column", async () => {
    const col = await seedAsAdmin(async (client) => {
      const r = await client.query<{ data_type: string; is_nullable: string }>(
        `select data_type, is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = 'visitor_sessions' and column_name = 'anonymous_session_id'`,
      );
      return r.rows[0];
    });
    expect(col).toBeDefined();
    expect(col!.data_type).toBe("uuid");
    expect(col!.is_nullable).toBe("NO");
  });

  it("cannot insert a session without anonymous_session_id", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const visitorId = await seedVisitor(client, fx.orgAId);
      await expect(
        client.query("insert into public.visitor_sessions (organization_id, visitor_id, tracking_site_id) values ($1, $2, $3)", [
          fx.orgAId,
          visitorId,
          siteId,
        ]),
      ).rejects.toThrow(/null value in column "anonymous_session_id"|not-null constraint/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("visitor_sessions_org_site_visitor_session_key: race-safety uniqueness scope", () => {
  it("16. the uniqueness constraint exists with exactly the approved four-column scope", async () => {
    const con = await seedAsAdmin(async (client) => {
      const r = await client.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = 'public.visitor_sessions'::regclass and conname = 'visitor_sessions_org_site_visitor_session_key'`,
      );
      return r.rows[0]?.def;
    });
    expect(con).toBe("UNIQUE (organization_id, tracking_site_id, visitor_id, anonymous_session_id)");
  });

  it("17. the same anonymous_session_id may exist independently for another organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const sessionKey = randomUUID();
      const siteA = await seedTrackingSite(client, fx.orgAId);
      const visitorA = await seedVisitor(client, fx.orgAId);
      const siteB = await seedTrackingSite(client, fx.orgBId);
      const visitorB = await seedVisitor(client, fx.orgBId);
      const sessionAId = await seedSession(client, fx.orgAId, visitorA, siteA, sessionKey);
      const sessionBId = await seedSession(client, fx.orgBId, visitorB, siteB, sessionKey);
      expect(sessionAId).not.toBe(sessionBId);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("18. the same anonymous_session_id may exist independently for another visitor within the same org/site", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const sessionKey = randomUUID();
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const visitor1 = await seedVisitor(client, fx.orgAId);
      const visitor2 = await seedVisitor(client, fx.orgAId);
      const session1 = await seedSession(client, fx.orgAId, visitor1, siteId, sessionKey);
      const session2 = await seedSession(client, fx.orgAId, visitor2, siteId, sessionKey);
      expect(session1).not.toBe(session2);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("19. the same anonymous_session_id may exist independently for another tracking site within the same org/visitor", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const sessionKey = randomUUID();
      const site1 = await seedTrackingSite(client, fx.orgAId);
      const site2 = await seedTrackingSite(client, fx.orgAId);
      const visitorId = await seedVisitor(client, fx.orgAId);
      const session1 = await seedSession(client, fx.orgAId, visitorId, site1, sessionKey);
      const session2 = await seedSession(client, fx.orgAId, visitorId, site2, sessionKey);
      expect(session1).not.toBe(session2);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("20. an exact duplicate within the same org/site/visitor/session-id scope is rejected", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const sessionKey = randomUUID();
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const visitorId = await seedVisitor(client, fx.orgAId);
      await seedSession(client, fx.orgAId, visitorId, siteId, sessionKey);
      await expect(seedSession(client, fx.orgAId, visitorId, siteId, sessionKey)).rejects.toThrow(
        /visitor_sessions_org_site_visitor_session_key|duplicate key|unique constraint/i,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("existing 3.1A invariants remain intact after this patch", () => {
  it("21. composite tenant-safety FKs (visitor_org_fk, tracking_site_org_fk) still reject cross-org references", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteA = await seedTrackingSite(client, fx.orgAId);
      const visitorB = await seedVisitor(client, fx.orgBId);
      await client.query("savepoint sp");
      await expect(
        client.query(
          "insert into public.visitor_sessions (organization_id, visitor_id, tracking_site_id, anonymous_session_id) values ($1, $2, $3, $4)",
          [fx.orgAId, visitorB, siteA, randomUUID()],
        ),
      ).rejects.toThrow(/visitor_sessions_visitor_org_fk|foreign key/i);
      await client.query("rollback to savepoint sp");

      const siteB = await seedTrackingSite(client, fx.orgBId);
      const visitorA = await seedVisitor(client, fx.orgAId);
      await expect(
        client.query(
          "insert into public.visitor_sessions (organization_id, visitor_id, tracking_site_id, anonymous_session_id) values ($1, $2, $3, $4)",
          [fx.orgAId, visitorA, siteB, randomUUID()],
        ),
      ).rejects.toThrow(/visitor_sessions_tracking_site_org_fk|foreign key/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("22. RLS remains enabled with the same organization-scoped policies, and grants are unchanged by this patch", async () => {
    const rls = await seedAsAdmin(async (client) => {
      const r = await client.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where relname = 'visitor_sessions'`,
      );
      return r.rows[0]?.relrowsecurity;
    });
    expect(rls).toBe(true);

    const policies = await seedAsAdmin(async (client) => {
      const r = await client.query<{ policyname: string; cmd: string }>(
        `select policyname, cmd from pg_policies where tablename = 'visitor_sessions' order by policyname`,
      );
      return r.rows;
    });
    expect(policies).toEqual([
      { policyname: "visitor_sessions_insert_own", cmd: "INSERT" },
      { policyname: "visitor_sessions_select_own", cmd: "SELECT" },
      { policyname: "visitor_sessions_update_own", cmd: "UPDATE" },
    ]);

    const grants = await seedAsAdmin(async (client) => {
      const r = await client.query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'visitor_sessions' and grantee in ('anon', 'authenticated')
         order by grantee, privilege_type`,
      );
      return r.rows;
    });
    expect(grants).toEqual([
      { grantee: "authenticated", privilege_type: "INSERT" },
      { grantee: "authenticated", privilege_type: "SELECT" },
      { grantee: "authenticated", privilege_type: "UPDATE" },
    ]);
  });
});
