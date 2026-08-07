import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool, withTenantContext } from "@ai-revenue-os/database";
import { listOrganizationsForAgency } from "@ai-revenue-os/tenancy";
import { decideAgencyConsoleAccess } from "../app/agency/access";
import { createClientOrgForResolvedContext } from "../app/agency/create-client-org-logic";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminPool = getPool();

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  const client = await adminPool.connect();
  try {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `agency-console-${label}-${userId}@example.test`,
    ]);
  } finally {
    client.release();
  }
  return userId;
}

async function createAgencyWithOwner(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_agency_with_owner($1, $2, $3)", [
      name,
      `agency-console-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.agency_id as string;
}

afterAll(async () => {
  await closePool();
});

describe("decideAgencyConsoleAccess()", () => {
  it("an unauthenticated visitor is redirected to /login — unauthorized users cannot access the console", () => {
    const decision = decideAgencyConsoleAccess(null, null);
    expect(decision).toEqual({ kind: "redirect", to: "/login" });
  });

  it("an authenticated user with no agency context is redirected to /dashboard, not shown agency data", () => {
    // Covers both "authenticated but no membership at all" and, just as
    // importantly, an ordinary org-level user — decideAgencyConsoleAccess
    // never sees the difference between those two (both just resolve to a
    // null agencyContext), which is exactly the point: an org-level user
    // must never accidentally receive agency console data.
    const decision = decideAgencyConsoleAccess(randomUUID(), null);
    expect(decision).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it("an authenticated agency_owner/agency_admin is allowed through with their real context", () => {
    const agencyContext = { userId: randomUUID(), agencyId: randomUUID(), roleKey: "agency_owner" };
    const decision = decideAgencyConsoleAccess(agencyContext.userId, agencyContext);
    expect(decision).toEqual({ kind: "allow", agencyContext });
  });
});

describe("createClientOrgForResolvedContext()", () => {
  it("rejects when there is no resolved agency context", async () => {
    const result = await createClientOrgForResolvedContext(null, "Should Not Be Created");
    expect(result.error).toBeTruthy();
  });

  it("rejects a resolved context whose role isn't agency_owner/agency_admin", async () => {
    const result = await createClientOrgForResolvedContext(
      { userId: randomUUID(), agencyId: randomUUID(), roleKey: "org_admin" },
      "Should Not Be Created",
    );
    expect(result.error).toBeTruthy();
  });

  it("rejects an empty/whitespace-only name", async () => {
    const owner = await createAuthUser("empty-name");
    const agencyId = await createAgencyWithOwner(owner, "Console Empty Name Agency");

    const result = await createClientOrgForResolvedContext(
      { userId: owner, agencyId, roleKey: "agency_owner" },
      "   ",
    );
    expect(result.error).toBeTruthy();
  });

  it("creates the organization, and it's immediately visible via listOrganizationsForAgency — the data the console re-fetches after revalidatePath", async () => {
    const owner = await createAuthUser("create-visible");
    const agencyId = await createAgencyWithOwner(owner, "Console Create Visible Agency");
    const agencyContext = { userId: owner, agencyId, roleKey: "agency_owner" };

    const before = await listOrganizationsForAgency(agencyContext);
    expect(before).toEqual([]); // zero-client empty state, confirmed before creating anything

    const result = await createClientOrgForResolvedContext(agencyContext, "Freshly Created Client");
    expect(result.error).toBeUndefined();

    const after = await listOrganizationsForAgency(agencyContext);
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("Freshly Created Client");
  });
});

describe("the console's data layer shows only the caller's own agency's organizations", () => {
  it("two agencies each see only their own client list, never the other's", async () => {
    const ownerA = await createAuthUser("console-isolation-a");
    const agencyA = await createAgencyWithOwner(ownerA, "Console Isolation Agency A");
    await createClientOrgForResolvedContext(
      { userId: ownerA, agencyId: agencyA, roleKey: "agency_owner" },
      "Console Isolation A Client",
    );

    const ownerB = await createAuthUser("console-isolation-b");
    const agencyB = await createAgencyWithOwner(ownerB, "Console Isolation Agency B");

    const listA = await listOrganizationsForAgency({ userId: ownerA, agencyId: agencyA, roleKey: "agency_owner" });
    const listB = await listOrganizationsForAgency({ userId: ownerB, agencyId: agencyB, roleKey: "agency_owner" });

    expect(listA).toHaveLength(1);
    expect(listB).toEqual([]); // zero-client empty state for agency B specifically
  });
});
