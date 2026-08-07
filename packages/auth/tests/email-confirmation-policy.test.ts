import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

// Same well-known local Supabase CLI demo keys as session-refresh.test.ts —
// never valid against a real project.
const API_URL = "http://127.0.0.1:54321";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonClient = createClient(API_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Verifies the deliberate decision recorded in
 * packages/database/supabase/config.toml ([auth.email] enable_confirmations
 * = true, docs/13-Technical-Design-Review.md M1.3 §5): create_organization_
 * with_owner() grants org_admin at signup time, so a session must not be
 * usable until the user has proven they control the email address —
 * otherwise anyone could sign up with an address they don't own and
 * immediately act as org_admin on a brand-new organization.
 */
describe("email confirmation policy (config-as-code decision, docs/13 M1.3 §5)", () => {
  const cleanupUserIds: string[] = [];

  afterAll(async () => {
    for (const id of cleanupUserIds) {
      await adminClient.auth.admin.deleteUser(id);
    }
  });

  it("rejects sign-in for a real user who has not confirmed their email", async () => {
    const email = `unconfirmed-${randomUUID()}@example.test`;
    const password = "correct horse battery staple 1!";

    const { data, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: false, // mirrors what a real self-service signup produces
    });
    if (createError || !data.user) {
      throw new Error(`Test setup failed to create auth user: ${createError?.message}`);
    }
    cleanupUserIds.push(data.user.id);

    const { data: signInData, error: signInError } = await anonClient.auth.signInWithPassword({
      email,
      password,
    });

    expect(signInData.session).toBeNull();
    expect(signInError).not.toBeNull();
    expect(signInError?.message).toMatch(/email not confirmed/i);
  });

  it("allows sign-in once the same user's email is confirmed", async () => {
    const email = `confirmed-${randomUUID()}@example.test`;
    const password = "correct horse battery staple 1!";

    const { data, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
    });
    if (createError || !data.user) {
      throw new Error(`Test setup failed to create auth user: ${createError?.message}`);
    }
    cleanupUserIds.push(data.user.id);

    // Simulates the user clicking the real confirmation link Resend/GoTrue
    // sends — done here via the admin API rather than parsing a real email,
    // since actually receiving and clicking that link requires the deployed
    // frontend this test suite deliberately doesn't depend on.
    const { error: updateError } = await adminClient.auth.admin.updateUserById(data.user.id, {
      email_confirm: true,
    });
    expect(updateError).toBeNull();

    const { data: signInData, error: signInError } = await anonClient.auth.signInWithPassword({
      email,
      password,
    });

    expect(signInError).toBeNull();
    expect(signInData.session).toBeTruthy();
  });
});
