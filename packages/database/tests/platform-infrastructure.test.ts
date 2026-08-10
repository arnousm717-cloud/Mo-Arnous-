import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
// The production helper (commits on success), same reasoning as
// signup-flow.test.ts — these tests verify real commit/rollback behavior.
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * M1.7 platform infrastructure: api_keys, events (outbox), event_deliveries,
 * webhook_events_seen. Covers schema/grants/RLS, the membership.created
 * emission retrofitted into create_organization_with_owner() (Decision C),
 * outbox atomicity under injected failure, and cross-tenant correctness.
 * Dispatcher idempotency/failure-isolation lives in its own file
 * (dispatcher.test.ts) since it exercises different code (packages/database's
 * TS dispatcher, not SQL migrations).
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `platform-infra-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("membership.created event emission (M1.7 Decision C)", () => {
  it("create_organization_with_owner() emits exactly one membership.created event with the correct payload", async () => {
    const userId = await createAuthUser("emit-happy");
    const slug = `platform-infra-emit-${randomUUID()}`;

    const result = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "Platform Infra Emit Org",
        slug,
        userId,
      ]);
      return r.rows[0];
    });

    const events = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select event_type, event_version, organization_id, payload, processed_at from public.events where organization_id = $1",
        [result.organization_id],
      );
      return r.rows;
    });

    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("membership.created");
    expect(events[0].event_version).toBe(1);
    expect(events[0].organization_id).toBe(result.organization_id);
    expect(events[0].payload).toMatchObject({
      membership_id: result.membership_id,
      user_id: userId,
      organization_id: result.organization_id,
      role_key: "org_admin",
    });
    // Not yet dispatched — processed_at is advisory-only and set exclusively
    // by the dispatcher, never by the emitting write itself.
    expect(events[0].processed_at).toBeNull();
  });
});

describe("outbox atomicity under injected failure (Decision C: 'preserve transaction atomicity')", () => {
  let userId: string;

  beforeEach(async () => {
    userId = await createAuthUser("atomicity");
  });

  it("chaos: a failure during the events insert rolls back the organization AND membership rows too — direct DB inspection", async () => {
    const slug = `platform-infra-chaos-${randomUUID()}`;
    try {
      await seedAsAdmin(async (client) => {
        await client.query(`
          create or replace function public._chaos_fail_events_insert()
          returns trigger language plpgsql as $$
          begin
            raise exception 'chaos-injected failure: events insert';
          end;
          $$;
          create trigger _chaos_events_trigger
            before insert on public.events
            for each row execute function public._chaos_fail_events_insert();
        `);
      });

      await expect(
        withTenantContext({ userId }, async (client) => {
          await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
            "Platform Infra Chaos Org",
            slug,
            userId,
          ]);
        }),
      ).rejects.toThrow(/chaos-injected failure/);
    } finally {
      await seedAsAdmin(async (client) => {
        await client.query(`
          drop trigger if exists _chaos_events_trigger on public.events;
          drop function if exists public._chaos_fail_events_insert();
        `);
      });
    }

    // Direct database inspection (M1.6's own established discipline,
    // applied here) — neither the organization nor the membership row may
    // survive a failure in the LAST statement of the same function call.
    const orphanOrg = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.organizations where slug = $1", [slug]);
      return r.rows;
    });
    expect(orphanOrg).toHaveLength(0);

    const orphanMembership = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select id from public.memberships where user_id = $1 and organization_id is not null",
        [userId],
      );
      return r.rows;
    });
    expect(orphanMembership).toHaveLength(0);

    const orphanEvent = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select id from public.events where payload->>'user_id' = $1",
        [userId],
      );
      return r.rows;
    });
    expect(orphanEvent).toHaveLength(0);
  });
});

describe("cross-tenant correctness: organization_id always comes from trusted transaction context", () => {
  it("two organizations created in sequence each get an event carrying their own, never the other's, organization_id", async () => {
    const userA = await createAuthUser("cross-tenant-a");
    const userB = await createAuthUser("cross-tenant-b");

    const orgA = await withTenantContext({ userId: userA }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "Platform Infra Cross Tenant A",
        `platform-infra-cross-a-${randomUUID()}`,
        userA,
      ]);
      return r.rows[0].organization_id as string;
    });

    const orgB = await withTenantContext({ userId: userB }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        "Platform Infra Cross Tenant B",
        `platform-infra-cross-b-${randomUUID()}`,
        userB,
      ]);
      return r.rows[0].organization_id as string;
    });

    expect(orgA).not.toBe(orgB);

    const eventA = await seedAsAdmin(async (client) => {
      const r = await client.query("select organization_id, payload from public.events where organization_id = $1", [orgA]);
      return r.rows[0];
    });
    const eventB = await seedAsAdmin(async (client) => {
      const r = await client.query("select organization_id, payload from public.events where organization_id = $1", [orgB]);
      return r.rows[0];
    });

    expect(eventA.organization_id).toBe(orgA);
    expect(eventA.payload.organization_id).toBe(orgA);
    expect(eventB.organization_id).toBe(orgB);
    expect(eventB.payload.organization_id).toBe(orgB);
    // The strongest possible proof of no cross-tenant leakage/spoofing at
    // the emission layer: neither event's organization_id ever equals the
    // OTHER organization's id — and there is structurally no parameter on
    // create_organization_with_owner() a caller could use to influence
    // this even if they wanted to (it takes no organization_id argument
    // at all; v_org_id is only ever the row this exact call just created).
    expect(eventA.organization_id).not.toBe(orgB);
    expect(eventB.organization_id).not.toBe(orgA);
  });
});

describe("events / event_deliveries: RLS enabled, zero grants to authenticated (M1.7 scope)", () => {
  it("a session-scoped SELECT on events fails with permission denied, not merely zero rows", async () => {
    await expect(
      withTenantContext({ userId: await createAuthUser("events-no-grant") }, async (client) => {
        await client.query("select id from public.events limit 1");
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("a session-scoped SELECT on event_deliveries fails with permission denied", async () => {
    await expect(
      withTenantContext({ userId: await createAuthUser("deliveries-no-grant") }, async (client) => {
        await client.query("select id from public.event_deliveries limit 1");
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("a session-scoped SELECT on webhook_events_seen fails with permission denied", async () => {
    await expect(
      withTenantContext({ userId: await createAuthUser("webhooks-no-grant") }, async (client) => {
        await client.query("select id from public.webhook_events_seen limit 1");
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("api_keys: RLS isolation, no write grant for authenticated", () => {
  async function createOrgAdmin(label: string, orgName: string): Promise<{ userId: string; organizationId: string }> {
    const userId = await createAuthUser(label);
    const organizationId = await withTenantContext({ userId }, async (client) => {
      const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
        orgName,
        `platform-infra-apikeys-${randomUUID()}`,
        userId,
      ]);
      return r.rows[0].organization_id as string;
    });
    return { userId, organizationId };
  }

  it("an org_admin can read their own org's api_keys (seeded directly — issuance is script-only)", async () => {
    const { userId, organizationId } = await createOrgAdmin("apikeys-select", "Platform Infra API Keys Org");

    await seedAsAdmin(async (client) => {
      await client.query(
        "insert into public.api_keys (organization_id, name, key_hash, key_prefix) values ($1, 'Test Key', $2, 'arev_test_')",
        [organizationId, `test-hash-${randomUUID()}`],
      );
    });

    const rows = await withTenantContext(
      { userId, organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("select name, key_prefix from public.api_keys where organization_id = $1", [
          organizationId,
        ]);
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Test Key");
  });

  it("org A cannot read org B's api_keys", async () => {
    const orgA = await createOrgAdmin("apikeys-isolation-a", "Platform Infra API Keys Isolation A");
    const orgB = await createOrgAdmin("apikeys-isolation-b", "Platform Infra API Keys Isolation B");

    await seedAsAdmin(async (client) => {
      await client.query(
        "insert into public.api_keys (organization_id, name, key_hash, key_prefix) values ($1, 'B Key', $2, 'arev_test_')",
        [orgB.organizationId, `test-hash-${randomUUID()}`],
      );
    });

    const rows = await withTenantContext(
      { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: "org_admin" },
      async (client) => {
        const r = await client.query("select id from public.api_keys where organization_id = $1", [
          orgB.organizationId,
        ]);
        return r.rows;
      },
    );
    expect(rows).toHaveLength(0);
  });

  it("an ordinary session cannot INSERT into api_keys — issuance is script-only, not RLS-permitted", async () => {
    const { userId, organizationId } = await createOrgAdmin("apikeys-no-insert", "Platform Infra API Keys No Insert Org");

    await expect(
      withTenantContext({ userId, organizationId, roleKey: "org_admin" }, async (client) => {
        await client.query(
          "insert into public.api_keys (organization_id, name, key_hash, key_prefix) values ($1, 'Should Fail', 'x', 'arev_test_')",
          [organizationId],
        );
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
