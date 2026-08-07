import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantContext } from "@ai-revenue-os/database";

// Same well-known local Supabase CLI demo keys as the other tests in this
// package — never valid against a real project.
const API_URL = "http://127.0.0.1:54321";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonClient = createClient(API_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface RealUser {
  userId: string;
  organizationId: string;
}

async function createRealSignedUpUser(orgName: string): Promise<RealUser> {
  const email = `tenant-isolation-${randomUUID()}@example.test`;
  const password = "correct horse battery staple 1!";

  // A real Supabase Auth identity, created and signed in exactly as the app's
  // own signup flow does it (packages/auth/src/actions.ts's signUpWithPassword
  // + the auth.users -> public.users trigger) — email_confirm: true here only
  // substitutes for the user clicking the real confirmation link, which
  // requires the deployed frontend this suite doesn't depend on.
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    throw new Error(`Test setup failed to create auth user: ${createError?.message}`);
  }

  const { data: signIn, error: signInError } = await anonClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signIn.session) {
    throw new Error(`Test setup failed to sign in: ${signInError?.message}`);
  }

  // The real create_organization_with_owner() SECURITY DEFINER function
  // (same one apps/web's signup Server Action calls via
  // @ai-revenue-os/tenancy's createOrganizationForNewUser), run with this
  // user's real, Auth-issued id — not a fabricated one.
  const slug = `tenant-isolation-${randomUUID()}`;
  const orgId = await withTenantContext({ userId: created.user.id }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      orgName,
      slug,
      created.user.id,
    ]);
    return r.rows[0].organization_id as string;
  });

  return { userId: created.user.id, organizationId: orgId };
}

/**
 * M1.3's own required-tests line (docs/12-Implementation-Milestones.md):
 * "a test confirming a logged-in user's requests resolve to their own
 * organization_id and never another's." rls-isolation.test.ts proves this at
 * the raw-RLS/table level with a manufactured session context;
 * signup-flow.test.ts proves get_my_membership_context() resolves correctly
 * for a single user. Neither, until now, proved it end-to-end for two real,
 * distinct logged-in users sharing one database — this does.
 */
describe("get_my_membership_context(): cross-user isolation for two real logged-in users", () => {
  let userA: RealUser;
  let userB: RealUser;

  beforeAll(async () => {
    [userA, userB] = await Promise.all([
      createRealSignedUpUser("Tenant Isolation Org A"),
      createRealSignedUpUser("Tenant Isolation Org B"),
    ]);
  });

  afterAll(async () => {
    await adminClient.auth.admin.deleteUser(userA.userId);
    await adminClient.auth.admin.deleteUser(userB.userId);
  });

  it("user A's own context resolves to org A, never org B", async () => {
    const context = await withTenantContext({ userId: userA.userId }, async (client) => {
      const r = await client.query("select * from public.get_my_membership_context()");
      return r.rows[0];
    });
    expect(context.organization_id).toBe(userA.organizationId);
    expect(context.organization_id).not.toBe(userB.organizationId);
  });

  it("user B's own context resolves to org B, never org A", async () => {
    const context = await withTenantContext({ userId: userB.userId }, async (client) => {
      const r = await client.query("select * from public.get_my_membership_context()");
      return r.rows[0];
    });
    expect(context.organization_id).toBe(userB.organizationId);
    expect(context.organization_id).not.toBe(userA.organizationId);
  });

  it("get_my_membership_context() scopes by the JWT's own auth.uid(), not a client-supplied id — there is no parameter to spoof", async () => {
    // The function takes no arguments at all (see migration
    // 20260806100859_create_membership_context_function.sql) — it resolves
    // auth.uid() internally from request.jwt.claims. Calling it under user
    // B's session context can only ever resolve user B's own row, however
    // the caller might try to frame the request.
    const context = await withTenantContext({ userId: userB.userId }, async (client) => {
      const r = await client.query("select * from public.get_my_membership_context()");
      return r.rows[0];
    });
    expect(context.organization_id).toBe(userB.organizationId);
  });
});
