import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1A schema/constraint coverage (docs/13-Technical-Design-
 * Review.md "Milestone 3.1A"). Mirrors pipelines-deals-schema.test.ts /
 * activities-notes-tags-schema.test.ts exactly in style: real Postgres,
 * never mocked, org A vs org B, direct information_schema-independent
 * assertions against actual constraint-rejection behavior.
 *
 * Scope: schema only. No ingestion endpoint, no tracking script, no
 * consent-record endpoint exist yet (3.1B/C) — every fixture here is
 * constructed via direct SQL under seedAsAdmin, never through an API
 * route or domain function, since none exists yet for this milestone.
 *
 * tracking_sites/website_visitors/visitor_sessions/visitor_events all
 * cascade-delete along with their organization (organization_id ...
 * on delete cascade), so cleanupFixtures()'s existing
 * `delete from organizations` already tears these down too — no
 * dedicated cleanup needed here.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
}

let fx: Fixture;

async function seedOrgs(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Tracking Schema Test Org A', $1) returning id",
      [`tracking-schema-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Tracking Schema Test Org B', $1) returning id",
      [`tracking-schema-test-org-b-${randomUUID()}`],
    );
    return { orgAId: orgA.rows[0]!.id, orgBId: orgB.rows[0]!.id };
  });
}

async function seedTrackingSite(client: import("pg").PoolClient, organizationId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
    [organizationId, "Test Site"],
  );
  return r.rows[0]!.id;
}

async function seedVisitor(
  client: import("pg").PoolClient,
  organizationId: string,
  anonymousId: string = randomUUID(),
): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.website_visitors (organization_id, anonymous_id) values ($1, $2) returning id",
    [organizationId, anonymousId],
  );
  return r.rows[0]!.id;
}

async function seedSession(
  client: import("pg").PoolClient,
  organizationId: string,
  visitorId: string,
  trackingSiteId: string,
): Promise<string> {
  // anonymous_session_id (3.1B prerequisite patch, 20260820100000) is a
  // client-generated opaque correlation identifier at the real call
  // site — a fresh random value here is sufficient for every schema/FK
  // assertion in this file, none of which are about session-identity
  // semantics themselves.
  const r = await client.query<{ id: string }>(
    "insert into public.visitor_sessions (organization_id, visitor_id, tracking_site_id, anonymous_session_id) values ($1, $2, $3, $4) returning id",
    [organizationId, visitorId, trackingSiteId, randomUUID()],
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

describe("tracking_sites: happy path", () => {
  it("creates a tracking site for an organization", async () => {
    const id = await seedAsAdmin((client) => seedTrackingSite(client, fx.orgAId));
    expect(id).toBeTruthy();
  });

  it("supports multiple tracking sites per organization", async () => {
    const [a, b] = await seedAsAdmin(async (client) => [
      await seedTrackingSite(client, fx.orgAId),
      await seedTrackingSite(client, fx.orgAId),
    ]);
    expect(a).not.toBe(b);
  });
});

describe("website_visitors: happy path + UNIQUE (organization_id, anonymous_id)", () => {
  it("creates a visitor for an organization", async () => {
    const id = await seedAsAdmin((client) => seedVisitor(client, fx.orgAId));
    expect(id).toBeTruthy();
  });

  it("rejects a second visitor row with the same anonymous_id in the same organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const anonymousId = randomUUID();
      await seedVisitor(client, fx.orgAId, anonymousId);
      await expect(seedVisitor(client, fx.orgAId, anonymousId)).rejects.toThrow(
        /website_visitors_organization_id_anonymous_id_key|duplicate key|unique constraint/i,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("allows the same anonymous_id independently in two different organizations", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const anonymousId = randomUUID();
      const visitorA = await seedVisitor(client, fx.orgAId, anonymousId);
      const visitorB = await seedVisitor(client, fx.orgBId, anonymousId);
      expect(visitorA).not.toBe(visitorB);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("website_visitors: cross-tenant contact FK (same-org success, cross-org failure)", () => {
  it("a visitor can be identified with a contact in the same organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const contact = await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
        [fx.orgAId, "Same Org Contact"],
      );
      const r = await client.query<{ id: string }>(
        "insert into public.website_visitors (organization_id, anonymous_id, identified_contact_id) values ($1, $2, $3) returning id",
        [fx.orgAId, randomUUID(), contact.rows[0]!.id],
      );
      expect(r.rows[0]!.id).toBeTruthy();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a visitor cannot be identified with a contact belonging to a different organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const contact = await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
        [fx.orgBId, "Other Org Contact"],
      );
      await expect(
        client.query(
          "insert into public.website_visitors (organization_id, anonymous_id, identified_contact_id) values ($1, $2, $3)",
          [fx.orgAId, randomUUID(), contact.rows[0]!.id],
        ),
      ).rejects.toThrow(/website_visitors_contact_org_fk|foreign key/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("visitor_sessions: cross-tenant composite FKs (same-org success, cross-org failure)", () => {
  it("a session can reference a visitor and tracking site in the same organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const visitorId = await seedVisitor(client, fx.orgAId);
      const sessionId = await seedSession(client, fx.orgAId, visitorId, siteId);
      expect(sessionId).toBeTruthy();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a session cannot reference a visitor belonging to a different organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const otherOrgVisitorId = await seedVisitor(client, fx.orgBId);
      await expect(seedSession(client, fx.orgAId, otherOrgVisitorId, siteId)).rejects.toThrow(
        /visitor_sessions_visitor_org_fk|foreign key/i,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a session cannot reference a tracking site belonging to a different organization (the exact cross-tenant FK the 3.1A brief flagged for explicit testing)", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const otherOrgSiteId = await seedTrackingSite(client, fx.orgBId);
      const visitorId = await seedVisitor(client, fx.orgAId);
      await expect(seedSession(client, fx.orgAId, visitorId, otherOrgSiteId)).rejects.toThrow(
        /visitor_sessions_tracking_site_org_fk|foreign key/i,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("tracking_site_id is NOT NULL", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const visitorId = await seedVisitor(client, fx.orgAId);
      await expect(
        client.query(
          "insert into public.visitor_sessions (organization_id, visitor_id, anonymous_session_id) values ($1, $2, $3)",
          [fx.orgAId, visitorId, randomUUID()],
        ),
      ).rejects.toThrow(/null value in column "tracking_site_id"|not-null constraint/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("visitor_events: cross-tenant session FK (same-org success, cross-org failure) + event_type CHECK", () => {
  it("an event can attach to a session in the same organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const visitorId = await seedVisitor(client, fx.orgAId);
      const sessionId = await seedSession(client, fx.orgAId, visitorId, siteId);
      const r = await client.query<{ id: string }>(
        "insert into public.visitor_events (organization_id, session_id, event_type) values ($1, $2, 'pageview') returning id",
        [fx.orgAId, sessionId],
      );
      expect(r.rows[0]!.id).toBeTruthy();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("an event cannot attach to a session belonging to a different organization, even when its own organization_id claims otherwise", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgBId);
      const visitorId = await seedVisitor(client, fx.orgBId);
      const otherOrgSessionId = await seedSession(client, fx.orgBId, visitorId, siteId);
      await expect(
        client.query("insert into public.visitor_events (organization_id, session_id, event_type) values ($1, $2, 'pageview')", [
          fx.orgAId,
          otherOrgSessionId,
        ]),
      ).rejects.toThrow(/visitor_events_session_org_fk|foreign key/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("rejects an event_type outside pageview/form_submit/click", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const visitorId = await seedVisitor(client, fx.orgAId);
      const sessionId = await seedSession(client, fx.orgAId, visitorId, siteId);
      await expect(
        client.query("insert into public.visitor_events (organization_id, session_id, event_type) values ($1, $2, 'scroll')", [
          fx.orgAId,
          sessionId,
        ]),
      ).rejects.toThrow(/visitor_events_event_type_check|violates check constraint/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("hard-delete/cascade/restrict behavior", () => {
  it("hard-deleting a contact sets only identified_contact_id to NULL on the visitor, leaving organization_id intact", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const contact = await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
        [fx.orgAId, "About To Be Hard Deleted (Visitor FK)"],
      );
      const visitor = await client.query<{ id: string }>(
        "insert into public.website_visitors (organization_id, anonymous_id, identified_contact_id) values ($1, $2, $3) returning id",
        [fx.orgAId, randomUUID(), contact.rows[0]!.id],
      );
      await client.query("delete from public.contacts where id = $1", [contact.rows[0]!.id]);
      const after = await client.query(
        "select organization_id, identified_contact_id from public.website_visitors where id = $1",
        [visitor.rows[0]!.id],
      );
      expect(after.rows[0].identified_contact_id).toBeNull();
      expect(after.rows[0].organization_id).toBe(fx.orgAId);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a tracking site still referenced by a session cannot be hard-deleted (ON DELETE RESTRICT)", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const visitorId = await seedVisitor(client, fx.orgAId);
      await seedSession(client, fx.orgAId, visitorId, siteId);
      await expect(client.query("delete from public.tracking_sites where id = $1", [siteId])).rejects.toThrow(
        /visitor_sessions_tracking_site_org_fk|foreign key|violates/i,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("hard-deleting a visitor cascades to its sessions, and hard-deleting a session cascades to its events", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const visitorId = await seedVisitor(client, fx.orgAId);
      const sessionId = await seedSession(client, fx.orgAId, visitorId, siteId);
      const event = await client.query<{ id: string }>(
        "insert into public.visitor_events (organization_id, session_id, event_type) values ($1, $2, 'pageview') returning id",
        [fx.orgAId, sessionId],
      );

      await client.query("delete from public.website_visitors where id = $1", [visitorId]);

      const sessionAfter = await client.query("select id from public.visitor_sessions where id = $1", [sessionId]);
      expect(sessionAfter.rows).toHaveLength(0);
      const eventAfter = await client.query("select id from public.visitor_events where id = $1", [event.rows[0]!.id]);
      expect(eventAfter.rows).toHaveLength(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("deleting an organization cascades tracking_sites/website_visitors/visitor_sessions/visitor_events", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const org = await client.query<{ id: string }>(
        "insert into public.organizations (name, slug) values ($1, $2) returning id",
        ["Org Cascade Test", `org-cascade-tracking-${randomUUID()}`],
      );
      const orgId = org.rows[0]!.id;
      const siteId = await seedTrackingSite(client, orgId);
      const visitorId = await seedVisitor(client, orgId);
      const sessionId = await seedSession(client, orgId, visitorId, siteId);
      const event = await client.query<{ id: string }>(
        "insert into public.visitor_events (organization_id, session_id, event_type) values ($1, $2, 'pageview') returning id",
        [orgId, sessionId],
      );

      await client.query("delete from public.organizations where id = $1", [orgId]);

      const siteAfter = await client.query("select id from public.tracking_sites where id = $1", [siteId]);
      const visitorAfter = await client.query("select id from public.website_visitors where id = $1", [visitorId]);
      const sessionAfter = await client.query("select id from public.visitor_sessions where id = $1", [sessionId]);
      const eventAfter = await client.query("select id from public.visitor_events where id = $1", [event.rows[0]!.id]);
      expect(siteAfter.rows).toHaveLength(0);
      expect(visitorAfter.rows).toHaveLength(0);
      expect(sessionAfter.rows).toHaveLength(0);
      expect(eventAfter.rows).toHaveLength(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
