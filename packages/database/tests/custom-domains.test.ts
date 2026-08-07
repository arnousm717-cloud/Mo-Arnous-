import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * custom_domains: schema-only in M1.4 (docs/12-Implementation-Milestones.md
 * — verification flow is Phase 7). Tests here cover the schema/RLS/status-
 * field contract only, nothing about actual domain verification.
 */

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `custom-domains-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

async function createAgencyWithOwner(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
      name,
      `custom-domains-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.agency_id as string;
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("custom_domains: schema, defaults, and status fields", () => {
  it("a new domain row defaults to pending verification and pending SSL status", async () => {
    const userId = await createAuthUser("defaults");
    const agencyId = await createAgencyWithOwner(userId, "Custom Domains Defaults Agency");

    const row = await withTenantContext(
      { userId, agencyId, roleKey: "agency_owner" },
      async (client) => {
        const r = await client.query(
          "insert into public.custom_domains (agency_id, domain) values ($1, $2) returning verification_status, ssl_status, verified_at",
          [agencyId, `defaults-${randomUUID()}.example.test`],
        );
        return r.rows[0];
      },
    );
    expect(row.verification_status).toBe("pending");
    expect(row.ssl_status).toBe("pending");
    expect(row.verified_at).toBeNull();
  });

  it("rejects an invalid verification_status value", async () => {
    const userId = await createAuthUser("bad-status");
    const agencyId = await createAgencyWithOwner(userId, "Custom Domains Bad Status Agency");

    await expect(
      withTenantContext({ userId, agencyId, roleKey: "agency_owner" }, async (client) => {
        await client.query(
          "insert into public.custom_domains (agency_id, domain, verification_status) values ($1, $2, $3)",
          [agencyId, `bad-status-${randomUUID()}.example.test`, "not-a-real-status"],
        );
      }),
    ).rejects.toThrow();
  });
});

describe("custom_domains: cross-agency isolation", () => {
  it("agency A cannot read agency B's custom domains", async () => {
    const userA = await createAuthUser("isolation-a");
    const agencyA = await createAgencyWithOwner(userA, "Custom Domains Isolation A");
    const userB = await createAuthUser("isolation-b");
    const agencyB = await createAgencyWithOwner(userB, "Custom Domains Isolation B");

    await withTenantContext({ userId: userB, agencyId: agencyB, roleKey: "agency_owner" }, async (client) => {
      await client.query("insert into public.custom_domains (agency_id, domain) values ($1, $2)", [
        agencyB,
        `isolation-b-${randomUUID()}.example.test`,
      ]);
    });

    const readAttempt = await withTenantContext(
      { userId: userA, agencyId: agencyA, roleKey: "agency_owner" },
      async (client) => {
        const r = await client.query("select id from public.custom_domains where agency_id = $1", [
          agencyB,
        ]);
        return r.rows;
      },
    );
    expect(readAttempt).toHaveLength(0);
  });

  it("agency A cannot insert a domain under agency B's agency_id", async () => {
    const userA = await createAuthUser("insert-block-a");
    const agencyA = await createAgencyWithOwner(userA, "Custom Domains Insert Block A");
    const userB = await createAuthUser("insert-block-b");
    const agencyB = await createAgencyWithOwner(userB, "Custom Domains Insert Block B");

    await expect(
      withTenantContext({ userId: userA, agencyId: agencyA, roleKey: "agency_owner" }, async (client) => {
        await client.query("insert into public.custom_domains (agency_id, domain) values ($1, $2)", [
          agencyB,
          `cross-agency-insert-${randomUUID()}.example.test`,
        ]);
      }),
    ).rejects.toThrow();
  });
});
