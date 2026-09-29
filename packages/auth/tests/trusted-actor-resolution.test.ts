import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool, withTenantContext } from "@ai-revenue-os/database";
import { can } from "../src/permissions";
import { resolveTrustedActorForOrganization } from "../src/trusted-actor-resolution";

// Same well-known local Supabase CLI demo keys as tenant-isolation.test.ts —
// never valid against a real project.
const API_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * M4.3 Step 2A — resolveTrustedActorForOrganization coverage. Real Postgres
 * throughout, mirroring tenant-isolation.test.ts's own real-Auth-identity
 * fixture style — but this suite deliberately NEVER calls
 * anonClient.auth.signInWithPassword or establishes any browser session at
 * all, which is the whole point: this resolver must work from nothing but
 * a trusted userId + organizationId, proving no auth.uid()/session
 * dependency exists anywhere in its own path.
 */

afterAll(async () => {
  await closePool();
});

/** Creates a real auth.users row (via the Supabase Admin API, same as
 * tenant-isolation.test.ts) without ever signing in — resolveTrustedActor-
 * ForOrganization must work from the raw userId alone. */
async function createRealAuthUser(label: string): Promise<string> {
  const email = `trusted-actor-${label}-${randomUUID()}@example.test`;
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password: "correct horse battery staple 1!",
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Test setup failed to create auth user: ${error?.message}`);
  }
  return data.user.id;
}

/** The real create_organization_with_owner() SECURITY DEFINER function —
 * gives userId an 'active' org_admin membership in a brand-new org.
 * Requires auth.uid() = p_user_id (the function's own self-service guard),
 * so this must run through withTenantContext({ userId }), exactly like
 * tenant-isolation.test.ts's own identical fixture — never a raw getPool()
 * connection, which has no request.jwt.claims set at all. */
async function createOrgWithOwner(userId: string, label: string): Promise<string> {
  return withTenantContext({ userId }, async (client) => {
    const r = await client.query<{ organization_id: string }>(
      "select * from public.create_organization_with_owner($1, $2, $3)",
      [label, `trusted-actor-${label}-${randomUUID()}`, userId],
    );
    return r.rows[0]!.organization_id;
  });
}

/** Raw privileged insert (bypasses RLS entirely via getPool()'s own
 * postgres-role connection) — for constructing a second, independent
 * membership for an already-existing user, in a different organization,
 * with a specific role and status. Mirrors service-auth.test.ts's own
 * getPool()-direct-insert fixture convention. */
async function seedOrg(label: string): Promise<string> {
  const client = await getPool().connect();
  try {
    const r = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      [label, `trusted-actor-org-${label}-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function seedMembership(
  userId: string,
  organizationId: string,
  roleKey: string,
  status: "invited" | "active" | "removed",
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      `insert into public.memberships (user_id, organization_id, role_id, status)
       select $1, $2, r.id, $3 from public.roles r where r.key = $4`,
      [userId, organizationId, status, roleKey],
    );
  } finally {
    client.release();
  }
}

describe("resolveTrustedActorForOrganization: happy path", () => {
  it("known user + exact organization + valid active membership resolves the correct existing Actor", async () => {
    const userId = await createRealAuthUser("happy-path");
    const organizationId = await createOrgWithOwner(userId, "Happy Path Org");

    const actor = await resolveTrustedActorForOrganization(userId, organizationId);

    expect(actor).toEqual({ userId, roleKey: "org_admin", organizationId });
  });

  it("the resolved Actor works with the existing can() facade — allowed permission", async () => {
    const userId = await createRealAuthUser("can-allow");
    const organizationId = await createOrgWithOwner(userId, "Can Allow Org");

    const actor = await resolveTrustedActorForOrganization(userId, organizationId);

    expect(can(actor, "contacts:read")).toBe(true);
  });
});

describe("resolveTrustedActorForOrganization: fails closed", () => {
  it("wrong organization (real user, real org, but no membership there) resolves null", async () => {
    const userId = await createRealAuthUser("wrong-org");
    await createOrgWithOwner(userId, "Wrong Org Home");
    const otherOrg = await seedOrg("Wrong Org Target");

    const actor = await resolveTrustedActorForOrganization(userId, otherOrg);

    expect(actor).toBeNull();
  });

  it("nonexistent user resolves null", async () => {
    const organizationId = await seedOrg("Nonexistent User Org");

    const actor = await resolveTrustedActorForOrganization(randomUUID(), organizationId);

    expect(actor).toBeNull();
  });

  it("nonexistent organization resolves null", async () => {
    const userId = await createRealAuthUser("nonexistent-org");
    await createOrgWithOwner(userId, "Nonexistent Org Home");

    const actor = await resolveTrustedActorForOrganization(userId, randomUUID());

    expect(actor).toBeNull();
  });

  it("an 'invited' (not yet active) membership resolves null", async () => {
    const userId = await createRealAuthUser("invited");
    const organizationId = await seedOrg("Invited Org");
    await seedMembership(userId, organizationId, "org_member", "invited");

    const actor = await resolveTrustedActorForOrganization(userId, organizationId);

    expect(actor).toBeNull();
  });

  it("a 'removed' membership resolves null", async () => {
    const userId = await createRealAuthUser("removed");
    const organizationId = await seedOrg("Removed Org");
    await seedMembership(userId, organizationId, "org_member", "removed");

    const actor = await resolveTrustedActorForOrganization(userId, organizationId);

    expect(actor).toBeNull();
  });

  it("an empty userId resolves null without a database round trip", async () => {
    const organizationId = await seedOrg("Empty UserId Org");

    const actor = await resolveTrustedActorForOrganization("", organizationId);

    expect(actor).toBeNull();
  });

  it("an empty organizationId resolves null without a database round trip", async () => {
    const userId = await createRealAuthUser("empty-org-id");

    const actor = await resolveTrustedActorForOrganization(userId, "");

    expect(actor).toBeNull();
  });

  // "Invalid/unknown role" (§11) is deliberately NOT exercised as a real
  // Postgres fixture: public.memberships.role_id is a NOT NULL FK to
  // public.roles(id), and public.roles.key itself carries a CHECK
  // constraint limiting it to the same six keys PERMISSION_MATRIX already
  // recognizes (20260714093502_create_core_tenancy_schema.sql) — there is
  // no legitimate way to construct a membership row with an unrecognized
  // role_key through real schema operations. Weakening that constraint
  // just to exercise this function's own defensive isKnownRoleKey() branch
  // would violate the instruction not to weaken production constraints for
  // a test fixture. The branch exists as defense-in-depth against a role
  // seeded into public.roles in the future without a matching
  // PERMISSION_MATRIX entry — not a reachable state today.
});

describe("resolveTrustedActorForOrganization: multi-org isolation", () => {
  it("a user with active memberships in two different organizations never bleeds role/org between them", async () => {
    const userId = await createRealAuthUser("multi-org");
    const orgA = await createOrgWithOwner(userId, "Multi Org A"); // org_admin, active
    const orgB = await seedOrg("Multi Org B");
    await seedMembership(userId, orgB, "org_member", "active");

    const actorA = await resolveTrustedActorForOrganization(userId, orgA);
    const actorB = await resolveTrustedActorForOrganization(userId, orgB);

    expect(actorA).toEqual({ userId, roleKey: "org_admin", organizationId: orgA });
    expect(actorB).toEqual({ userId, roleKey: "org_member", organizationId: orgB });

    // Cross-check: resolving org A never leaks org B's role, and vice versa.
    expect(actorA?.roleKey).not.toBe(actorB?.roleKey);
    expect(actorA?.organizationId).not.toBe(actorB?.organizationId);

    // The two resolved Actors behave correctly and independently under can().
    expect(can(actorA, "contacts:delete")).toBe(true); // org_admin has delete
    expect(can(actorB, "contacts:delete")).toBe(false); // org_member does not
    expect(can(actorB, "contacts:read")).toBe(true); // org_member still has read
  });
});

describe("resolveTrustedActorForOrganization: no session dependency", () => {
  it("resolves correctly having never established any Supabase session (no signInWithPassword call anywhere in this suite)", async () => {
    // Every test in this file already proves this implicitly (no test above
    // ever calls anonClient.auth.signInWithPassword or any session-issuing
    // API) — this test exists only to name the property explicitly as its
    // own assertion, per the Step-2A test-plan requirement.
    const userId = await createRealAuthUser("no-session");
    const organizationId = await createOrgWithOwner(userId, "No Session Org");

    const actor = await resolveTrustedActorForOrganization(userId, organizationId);

    expect(actor).not.toBeNull();
  });
});
