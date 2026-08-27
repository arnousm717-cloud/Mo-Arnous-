import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, seedAsAdmin } from "./helpers";
import { resolveOrCreateVisitor } from "../src/visitors";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("resolveOrCreateVisitor", () => {
  it("creates a new visitor on first call", async () => {
    const organizationId = await createOrg();
    const anonymousId = randomUUID();
    const visitor = await resolveOrCreateVisitor({ organizationId }, anonymousId);
    expect(visitor.organizationId).toBe(organizationId);
    expect(visitor.anonymousId).toBe(anonymousId);
    expect(visitor.identifiedContactId).toBeNull();
  });

  it("reuses the same visitor row on a repeat call for the same anonymous_id", async () => {
    const organizationId = await createOrg();
    const anonymousId = randomUUID();
    const first = await resolveOrCreateVisitor({ organizationId }, anonymousId);
    const second = await resolveOrCreateVisitor({ organizationId }, anonymousId);
    expect(second.id).toBe(first.id);
  });

  it("first_seen_at is preserved across a repeat call", async () => {
    const organizationId = await createOrg();
    const anonymousId = randomUUID();
    const first = await resolveOrCreateVisitor({ organizationId }, anonymousId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await resolveOrCreateVisitor({ organizationId }, anonymousId);
    // pg returns timestamptz columns as Date instances (no type-parser
    // override exists anywhere in this repo), so a fresh query result's
    // Date object is never reference-equal (toBe) to an earlier one even
    // when it represents the identical instant — compare by value.
    expect(new Date(second.firstSeenAt).getTime()).toBe(new Date(first.firstSeenAt).getTime());
  });

  it("last_seen_at advances on a repeat call", async () => {
    const organizationId = await createOrg();
    const anonymousId = randomUUID();
    const first = await resolveOrCreateVisitor({ organizationId }, anonymousId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await resolveOrCreateVisitor({ organizationId }, anonymousId);
    expect(new Date(second.lastSeenAt).getTime()).toBeGreaterThan(new Date(first.lastSeenAt).getTime());
  });

  it("identified_contact_id remains NULL — no identification logic exists in 3.1B", async () => {
    const organizationId = await createOrg();
    const visitor = await resolveOrCreateVisitor({ organizationId }, randomUUID());
    expect(visitor.identifiedContactId).toBeNull();
    const stored = await seedAsAdmin(async (client) => {
      const r = await client.query("select identified_contact_id from public.website_visitors where id = $1", [
        visitor.id,
      ]);
      return r.rows[0]!.identified_contact_id;
    });
    expect(stored).toBeNull();
  });

  it("the same anonymous_id in a different organization resolves to an independent visitor row", async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const sharedAnonymousId = randomUUID();
    const visitorA = await resolveOrCreateVisitor({ organizationId: orgA }, sharedAnonymousId);
    const visitorB = await resolveOrCreateVisitor({ organizationId: orgB }, sharedAnonymousId);
    expect(visitorA.id).not.toBe(visitorB.id);
    expect(visitorA.organizationId).toBe(orgA);
    expect(visitorB.organizationId).toBe(orgB);
  });
});
