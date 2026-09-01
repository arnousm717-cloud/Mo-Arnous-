import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";
// The REAL, committing withTenantContext (packages/database/src/
// tenant-context.ts) -- distinct from this file's own local ./helpers
// version, which always rolls back by design. Used only in the
// emit_visitor_identified_event() describe block below, where the
// SECURITY DEFINER function's write must actually persist so a
// separate, subsequent seedAsAdmin connection can observe it -- the
// `authenticated` role itself has zero grants on public.events (M1.7),
// so the transaction that ran the function cannot read the result back
// on its own client.
import { withTenantContext as withCommittingTenantContext } from "../src/tenant-context";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.2A schema/constraint coverage (Milestone 3.2 Design
 * Resolution Report §G, post-Phase-0 Ed25519 amendment). Mirrors
 * tracking-visitor-intelligence-schema.test.ts exactly in style: real
 * Postgres, never mocked, org A vs org B, direct assertions against
 * actual constraint-rejection behavior.
 *
 * Scope: schema only. No signing-key verification, no /track/identify
 * endpoint, no domain layer exist yet (3.2B/C/D) — every fixture here is
 * constructed via direct SQL under seedAsAdmin, never through a domain
 * function.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
}

let fx: Fixture;

async function seedOrgs(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Visitor ID Schema Test Org A', $1) returning id",
      [`visitor-id-schema-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Visitor ID Schema Test Org B', $1) returning id",
      [`visitor-id-schema-test-org-b-${randomUUID()}`],
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

async function seedVisitor(client: import("pg").PoolClient, organizationId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.website_visitors (organization_id, anonymous_id) values ($1, $2) returning id",
    [organizationId, randomUUID()],
  );
  return r.rows[0]!.id;
}

async function seedContact(client: import("pg").PoolClient, organizationId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
    [organizationId, "Test Contact"],
  );
  return r.rows[0]!.id;
}

const VALID_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEASpKFqutX5agC2Jy9IwJFNxyVUIcuZNL0vtDK6//zRrw=\n-----END PUBLIC KEY-----\n";

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedOrgs();
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("website_visitors.identification_suppressed_at", () => {
  it("defaults to null and can be set", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const visitorId = await seedVisitor(client, fx.orgAId);
      const before = await client.query("select identification_suppressed_at from public.website_visitors where id = $1", [
        visitorId,
      ]);
      expect(before.rows[0].identification_suppressed_at).toBeNull();
      await client.query("update public.website_visitors set identification_suppressed_at = now() where id = $1", [
        visitorId,
      ]);
      const after = await client.query("select identification_suppressed_at from public.website_visitors where id = $1", [
        visitorId,
      ]);
      expect(after.rows[0].identification_suppressed_at).not.toBeNull();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("visitor_identifications: composite tenant-safe FKs", () => {
  it("accepts a row with a visitor and contact in the same organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const visitorId = await seedVisitor(client, fx.orgAId);
      const contactId = await seedContact(client, fx.orgAId);
      const r = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, contact_id, event_type, token_jti)
         values ($1, $2, $3, 'identified', $4) returning id`,
        [fx.orgAId, visitorId, contactId, randomUUID()],
      );
      expect(r.rows[0]!.id).toBeTruthy();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("rejects a visitor belonging to a different organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const otherOrgVisitorId = await seedVisitor(client, fx.orgBId);
      await expect(
        client.query(
          `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
           values ($1, $2, 'identified', $3)`,
          [fx.orgAId, otherOrgVisitorId, randomUUID()],
        ),
      ).rejects.toThrow(/visitor_identifications_visitor_org_fk|foreign key/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("rejects a contact belonging to a different organization, even when the visitor is in the caller's own org", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const visitorId = await seedVisitor(client, fx.orgAId);
      const otherOrgContactId = await seedContact(client, fx.orgBId);
      await expect(
        client.query(
          `insert into public.visitor_identifications (organization_id, website_visitor_id, contact_id, event_type, token_jti)
           values ($1, $2, $3, 'identified', $4)`,
          [fx.orgAId, visitorId, otherOrgContactId, randomUUID()],
        ),
      ).rejects.toThrow(/visitor_identifications_contact_org_fk|foreign key/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("allows a null contact_id (unlink/reject events)", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const visitorId = await seedVisitor(client, fx.orgAId);
      const r = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
         values ($1, $2, 'unlinked_withdrawal', $3) returning id`,
        [fx.orgAId, visitorId, randomUUID()],
      );
      expect(r.rows[0]!.id).toBeTruthy();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("visitor_identifications: event_type CHECK constraint", () => {
  it.each(["identified", "unlinked_withdrawal", "unlinked_erasure", "rejected_conflict"])(
    "accepts event_type=%s",
    async (eventType) => {
      const client = await adminPool.connect();
      try {
        await client.query("begin");
        const visitorId = await seedVisitor(client, fx.orgAId);
        const r = await client.query<{ id: string }>(
          `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
           values ($1, $2, $3, $4) returning id`,
          [fx.orgAId, visitorId, eventType, randomUUID()],
        );
        expect(r.rows[0]!.id).toBeTruthy();
      } finally {
        await client.query("rollback");
        client.release();
      }
    },
  );

  it("rejects an event_type outside the accepted vocabulary", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const visitorId = await seedVisitor(client, fx.orgAId);
      await expect(
        client.query(
          `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
           values ($1, $2, 'bogus_event', $3)`,
          [fx.orgAId, visitorId, randomUUID()],
        ),
      ).rejects.toThrow(/visitor_identifications_event_type_check|violates check constraint/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("visitor_identifications: token_jti replay uniqueness, tenant-scoped", () => {
  it("rejects a second row with the same jti in the same organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const visitorId = await seedVisitor(client, fx.orgAId);
      const jti = randomUUID();
      await client.query(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
         values ($1, $2, 'identified', $3)`,
        [fx.orgAId, visitorId, jti],
      );
      await expect(
        client.query(
          `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
           values ($1, $2, 'identified', $3)`,
          [fx.orgAId, visitorId, jti],
        ),
      ).rejects.toThrow(/visitor_identifications_org_jti_key|duplicate key|unique constraint/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("allows the same jti independently in two different organizations (deliberately not a global constraint — see migration comment)", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const jti = randomUUID();
      const visitorA = await seedVisitor(client, fx.orgAId);
      const visitorB = await seedVisitor(client, fx.orgBId);
      const a = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
         values ($1, $2, 'identified', $3) returning id`,
        [fx.orgAId, visitorA, jti],
      );
      const b = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
         values ($1, $2, 'identified', $3) returning id`,
        [fx.orgBId, visitorB, jti],
      );
      expect(a.rows[0]!.id).not.toBe(b.rows[0]!.id);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("visitor_identifications: hard-delete cascade/set-null behavior", () => {
  it("hard-deleting the visitor cascades its identification rows", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const visitorId = await seedVisitor(client, fx.orgAId);
      const row = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
         values ($1, $2, 'identified', $3) returning id`,
        [fx.orgAId, visitorId, randomUUID()],
      );
      await client.query("delete from public.website_visitors where id = $1", [visitorId]);
      const after = await client.query("select id from public.visitor_identifications where id = $1", [row.rows[0]!.id]);
      expect(after.rows).toHaveLength(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("hard-deleting the contact sets only contact_id to NULL, leaving the audit row (and organization_id) intact", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const visitorId = await seedVisitor(client, fx.orgAId);
      const contactId = await seedContact(client, fx.orgAId);
      const row = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, contact_id, event_type, token_jti)
         values ($1, $2, $3, 'identified', $4) returning id`,
        [fx.orgAId, visitorId, contactId, randomUUID()],
      );
      await client.query("delete from public.contacts where id = $1", [contactId]);
      const after = await client.query("select organization_id, contact_id from public.visitor_identifications where id = $1", [
        row.rows[0]!.id,
      ]);
      expect(after.rows[0].contact_id).toBeNull();
      expect(after.rows[0].organization_id).toBe(fx.orgAId);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("visitor_identifications: RLS and grants (staff-readable, never staff-writable)", () => {
  it("authenticated, org A, can select its own organization's rows", async () => {
    const visitorId = await seedAsAdmin((client) => seedVisitor(client, fx.orgAId));
    const rowId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
         values ($1, $2, 'identified', $3) returning id`,
        [fx.orgAId, visitorId, randomUUID()],
      );
      return r.rows[0]!.id;
    });
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.visitor_identifications where id = $1", [rowId]);
      expect(r.rows).toHaveLength(1);
    });
  });

  it("authenticated, org B, cannot see org A's rows (RLS)", async () => {
    const visitorId = await seedAsAdmin((client) => seedVisitor(client, fx.orgAId));
    const rowId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
         values ($1, $2, 'identified', $3) returning id`,
        [fx.orgAId, visitorId, randomUUID()],
      );
      return r.rows[0]!.id;
    });
    await withTenantContext({ organizationId: fx.orgBId }, async (client) => {
      const r = await client.query("select id from public.visitor_identifications where id = $1", [rowId]);
      expect(r.rows).toHaveLength(0);
    });
  });

  it("authenticated CAN insert into its own organization (ordinary RLS-scoped write, matching how identifyVisitor is actually orchestrated in TypeScript, not via a SECURITY DEFINER function)", async () => {
    const visitorId = await seedAsAdmin((client) => seedVisitor(client, fx.orgAId));
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
         values ($1, $2, 'identified', $3) returning id`,
        [fx.orgAId, visitorId, randomUUID()],
      );
      expect(r.rows[0]!.id).toBeTruthy();
    });
  });

  it("authenticated, org B, cannot INSERT a row claiming org A's organization_id (RLS WITH CHECK)", async () => {
    const visitorId = await seedAsAdmin((client) => seedVisitor(client, fx.orgAId));
    await withTenantContext({ organizationId: fx.orgBId }, async (client) => {
      await expect(
        client.query(
          `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
           values ($1, $2, 'identified', $3)`,
          [fx.orgAId, visitorId, randomUUID()],
        ),
      ).rejects.toThrow(/new row violates row-level security policy|permission denied/i);
    });
  });

  it("authenticated cannot UPDATE (append-only, no grant)", async () => {
    const visitorId = await seedAsAdmin((client) => seedVisitor(client, fx.orgAId));
    const rowId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
         values ($1, $2, 'identified', $3) returning id`,
        [fx.orgAId, visitorId, randomUUID()],
      );
      return r.rows[0]!.id;
    });
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await expect(
        client.query("update public.visitor_identifications set event_type = 'unlinked_withdrawal' where id = $1", [rowId]),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("authenticated cannot DELETE (append-only, no grant)", async () => {
    const visitorId = await seedAsAdmin((client) => seedVisitor(client, fx.orgAId));
    const rowId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        `insert into public.visitor_identifications (organization_id, website_visitor_id, event_type, token_jti)
         values ($1, $2, 'identified', $3) returning id`,
        [fx.orgAId, visitorId, randomUUID()],
      );
      return r.rows[0]!.id;
    });
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await expect(client.query("delete from public.visitor_identifications where id = $1", [rowId])).rejects.toThrow(
        /permission denied/i,
      );
    });
  });
});

describe("tracking_site_public_keys: composite tenant-safe FK", () => {
  it("accepts a key for a tracking site in the same organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const r = await client.query<{ id: string }>(
        "insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem) values ($1, $2, $3) returning id",
        [fx.orgAId, siteId, VALID_PEM],
      );
      expect(r.rows[0]!.id).toBeTruthy();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("rejects a tracking site belonging to a different organization", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const otherOrgSiteId = await seedTrackingSite(client, fx.orgBId);
      await expect(
        client.query(
          "insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem) values ($1, $2, $3)",
          [fx.orgAId, otherOrgSiteId, VALID_PEM],
        ),
      ).rejects.toThrow(/tracking_site_public_keys_site_org_fk|foreign key/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("a tracking site still referenced by a registered key cannot be hard-deleted (ON DELETE RESTRICT)", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      await client.query(
        "insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem) values ($1, $2, $3)",
        [fx.orgAId, siteId, VALID_PEM],
      );
      await expect(client.query("delete from public.tracking_sites where id = $1", [siteId])).rejects.toThrow(
        /tracking_site_public_keys_site_org_fk|foreign key|violates/i,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("tracking_site_public_keys: public_key_pem length bound", () => {
  it("rejects an empty value", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      await expect(
        client.query(
          "insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem) values ($1, $2, '')",
          [fx.orgAId, siteId],
        ),
      ).rejects.toThrow(/tracking_site_public_keys_pem_length|violates check constraint/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("rejects a value over 500 characters", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      await expect(
        client.query(
          "insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem) values ($1, $2, $3)",
          [fx.orgAId, siteId, "x".repeat(501)],
        ),
      ).rejects.toThrow(/tracking_site_public_keys_pem_length|violates check constraint/i);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("accepts a value at exactly 500 characters", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const siteId = await seedTrackingSite(client, fx.orgAId);
      const r = await client.query<{ id: string }>(
        "insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem) values ($1, $2, $3) returning id",
        [fx.orgAId, siteId, "x".repeat(500)],
      );
      expect(r.rows[0]!.id).toBeTruthy();
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("tracking_site_public_keys: RLS and grants (ordinary staff-managed, org-scoped)", () => {
  it("authenticated, org A, can select/insert/update its own organization's keys", async () => {
    const siteId = await seedAsAdmin((client) => seedTrackingSite(client, fx.orgAId));
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        "insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem) values ($1, $2, $3) returning id",
        [fx.orgAId, siteId, VALID_PEM],
      );
      const rowId = inserted.rows[0]!.id;
      const selected = await client.query("select id from public.tracking_site_public_keys where id = $1", [rowId]);
      expect(selected.rows).toHaveLength(1);
      await client.query("update public.tracking_site_public_keys set revoked_at = now() where id = $1", [rowId]);
      const revoked = await client.query("select revoked_at from public.tracking_site_public_keys where id = $1", [rowId]);
      expect(revoked.rows[0].revoked_at).not.toBeNull();
    });
  });

  it("authenticated, org B, cannot see org A's keys (RLS)", async () => {
    const siteId = await seedAsAdmin((client) => seedTrackingSite(client, fx.orgAId));
    const rowId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem) values ($1, $2, $3) returning id",
        [fx.orgAId, siteId, VALID_PEM],
      );
      return r.rows[0]!.id;
    });
    await withTenantContext({ organizationId: fx.orgBId }, async (client) => {
      const r = await client.query("select id from public.tracking_site_public_keys where id = $1", [rowId]);
      expect(r.rows).toHaveLength(0);
    });
  });

  it("authenticated, org B, cannot INSERT a key claiming org A's organization_id (RLS WITH CHECK)", async () => {
    const otherOrgSiteId = await seedAsAdmin((client) => seedTrackingSite(client, fx.orgAId));
    await withTenantContext({ organizationId: fx.orgBId }, async (client) => {
      await expect(
        client.query(
          "insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem) values ($1, $2, $3)",
          [fx.orgAId, otherOrgSiteId, VALID_PEM],
        ),
      ).rejects.toThrow(/new row violates row-level security policy|permission denied/i);
    });
  });

  it("authenticated cannot DELETE (no grant — revocation is an UPDATE setting revoked_at)", async () => {
    const siteId = await seedAsAdmin((client) => seedTrackingSite(client, fx.orgAId));
    const rowId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.tracking_site_public_keys (organization_id, tracking_site_id, public_key_pem) values ($1, $2, $3) returning id",
        [fx.orgAId, siteId, VALID_PEM],
      );
      return r.rows[0]!.id;
    });
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await expect(client.query("delete from public.tracking_site_public_keys where id = $1", [rowId])).rejects.toThrow(
        /permission denied/i,
      );
    });
  });
});

describe("emit_visitor_identified_event(): hostile direct-invocation hardening (Milestone 3.2 Final Implementation Acceptance Audit remediation)", () => {
  async function seedIdentifiedVisitor(organizationId: string): Promise<{ visitorId: string; contactId: string }> {
    return seedAsAdmin(async (client) => {
      const contact = await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id",
        [organizationId, "Identified Contact"],
      );
      const visitor = await client.query<{ id: string }>(
        "insert into public.website_visitors (organization_id, anonymous_id, identified_contact_id) values ($1, $2, $3) returning id",
        [organizationId, randomUUID(), contact.rows[0]!.id],
      );
      return { visitorId: visitor.rows[0]!.id, contactId: contact.rows[0]!.id };
    });
  }

  async function eventCountFor(organizationId: string, websiteVisitorId: string): Promise<number> {
    return seedAsAdmin(async (client) => {
      const r = await client.query<{ count: string }>(
        `select count(*)::text as count from public.events
         where organization_id = $1 and event_type = 'visitor.identified' and payload->>'website_visitor_id' = $2`,
        [organizationId, websiteVisitorId],
      );
      return Number(r.rows[0]!.count);
    });
  }

  // Every hostile case below is invoked through the REAL, committing
  // withTenantContext (withCommittingTenantContext, imported from
  // ../src/tenant-context -- not this file's own local ./helpers
  // version, which always rolls back by design and is otherwise used
  // throughout this file for pure RLS-assertion tests). Committing
  // matters here specifically because `authenticated` has zero grants
  // on public.events (M1.7's own zero-grant design) -- the transaction
  // that invoked the SECURITY DEFINER function cannot read `events`
  // back on its own connection, so verification must happen from a
  // separate, subsequent seedAsAdmin (postgres-role) connection, which
  // only sees committed data.
  //
  // Invoked as `authenticated`, the real role every request in this
  // monolith connects as (M1.7's own established threat model) -- never
  // adminPool for the function call itself -- since the finding is
  // specifically that ANY authenticated-role caller could invoke this
  // SECURITY DEFINER function directly, not merely that identifyVisitor's
  // own call site was wrong.

  it("correct, currently-linked visitor/contact pair -> event is inserted", async () => {
    const { visitorId, contactId } = await seedIdentifiedVisitor(fx.orgAId);
    await withCommittingTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await client.query("select public.emit_visitor_identified_event($1, $2)", [visitorId, contactId]);
    });
    expect(await eventCountFor(fx.orgAId, visitorId)).toBe(1);
  });

  it("nonexistent visitor -> no event, no exception", async () => {
    const fakeVisitorId = randomUUID();
    const { contactId } = await seedIdentifiedVisitor(fx.orgAId);
    await withCommittingTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await expect(
        client.query("select public.emit_visitor_identified_event($1, $2)", [fakeVisitorId, contactId]),
      ).resolves.toBeDefined();
    });
    expect(await eventCountFor(fx.orgAId, fakeVisitorId)).toBe(0);
  });

  it("nonexistent contact -> no event, no exception", async () => {
    const { visitorId } = await seedIdentifiedVisitor(fx.orgAId);
    const fakeContactId = randomUUID();
    await withCommittingTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await expect(
        client.query("select public.emit_visitor_identified_event($1, $2)", [visitorId, fakeContactId]),
      ).resolves.toBeDefined();
    });
    expect(await eventCountFor(fx.orgAId, visitorId)).toBe(0);
  });

  it("cross-tenant: visitor from org A + contact from org B -> no event, no exception (cannot forge a foreign-org event this way)", async () => {
    const { visitorId } = await seedIdentifiedVisitor(fx.orgAId);
    const { contactId: orgBContactId } = await seedIdentifiedVisitor(fx.orgBId);
    // Attacker connects with ITS OWN org's tenant context (org B) and
    // tries to attribute org A's visitor to org B's own contact.
    await withCommittingTenantContext({ organizationId: fx.orgBId }, async (client) => {
      await expect(
        client.query("select public.emit_visitor_identified_event($1, $2)", [visitorId, orgBContactId]),
      ).resolves.toBeDefined();
    });
    expect(await eventCountFor(fx.orgAId, visitorId)).toBe(0);
    expect(await eventCountFor(fx.orgBId, visitorId)).toBe(0);
  });

  it("same-org visitor/contact pair, but the visitor is NOT actually linked to that contact -> no event, no exception (cannot forge an unrelated pairing)", async () => {
    const { visitorId } = await seedIdentifiedVisitor(fx.orgAId);
    const unrelatedContact = await seedAsAdmin((client) => seedContact(client, fx.orgAId));
    await withCommittingTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await expect(
        client.query("select public.emit_visitor_identified_event($1, $2)", [visitorId, unrelatedContact]),
      ).resolves.toBeDefined();
    });
    expect(await eventCountFor(fx.orgAId, visitorId)).toBe(0);
  });

  it("previously linked but now unlinked visitor (identified_contact_id nulled) -> no event, no exception", async () => {
    const { visitorId, contactId } = await seedIdentifiedVisitor(fx.orgAId);
    await seedAsAdmin((client) =>
      client.query("update public.website_visitors set identified_contact_id = null where id = $1", [visitorId]),
    );
    await withCommittingTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await expect(
        client.query("select public.emit_visitor_identified_event($1, $2)", [visitorId, contactId]),
      ).resolves.toBeDefined();
    });
    expect(await eventCountFor(fx.orgAId, visitorId)).toBe(0);
  });

  it("EXECUTE grant is present for authenticated (the function itself, not the grant, is the security boundary)", async () => {
    const r = await seedAsAdmin((client) =>
      client.query<{ has_execute: boolean }>(
        "select has_function_privilege('authenticated', 'public.emit_visitor_identified_event(uuid, uuid)', 'execute') as has_execute",
      ),
    );
    expect(r.rows[0]!.has_execute).toBe(true);
  });

  it("the old 3-argument (organization_id, website_visitor_id, contact_id) signature no longer exists -- organization_id can never be supplied by a caller", async () => {
    const { visitorId, contactId } = await seedIdentifiedVisitor(fx.orgAId);
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await expect(
        client.query("select public.emit_visitor_identified_event($1, $2, $3)", [fx.orgAId, visitorId, contactId]),
      ).rejects.toThrow(/function public\.emit_visitor_identified_event\(.*\) does not exist/i);
    });
  });
});
