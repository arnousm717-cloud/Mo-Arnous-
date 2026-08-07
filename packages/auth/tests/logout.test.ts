import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

// Same well-known local Supabase CLI demo keys as the other tests in this
// package — never valid against a real project.
const API_URL = "http://127.0.0.1:54321";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * apps/web's logoutAction (app/dashboard/actions.ts) calls
 * packages/auth's signOut(), which is a thin wrapper:
 *   const supabase = createSupabaseServerClient(cookieStore);
 *   await supabase.auth.signOut();
 * signOut() itself can't be called directly in a test — it reads cookies()
 * from next/headers, which requires an active Next.js request context a
 * vitest process doesn't have (the same constraint documented on
 * exchangeAuthCode/refreshSession in src/middleware.ts). This test exercises
 * the exact same underlying operation (supabase.auth.signOut() on a client
 * holding the real session cookies) via the same cookie-jar technique used
 * throughout this suite, which is functionally identical — only the cookie
 * plumbing differs, not the behavior under test.
 */
describe("logout: supabase.auth.signOut() invalidates the real session", () => {
  const cleanupUserIds: string[] = [];

  afterAll(async () => {
    for (const id of cleanupUserIds) {
      await adminClient.auth.admin.deleteUser(id);
    }
  });

  it("a session that works before signOut() no longer resolves a user afterward", async () => {
    const email = `logout-${randomUUID()}@example.test`;
    const password = "Correct horse battery staple 1!";

    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError || !created.user) {
      throw new Error(`Test setup failed to create auth user: ${createError?.message}`);
    }
    cleanupUserIds.push(created.user.id);

    const jar = new Map<string, string>();
    const supabase = createServerClient(API_URL, ANON_KEY, {
      cookies: {
        getAll() {
          return Array.from(jar.entries()).map(([name, value]) => ({ name, value }));
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) jar.set(name, value);
        },
      },
    });

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();

    // Sanity: the session genuinely works before logout.
    const before = await supabase.auth.getUser();
    expect(before.error).toBeNull();
    expect(before.data.user?.id).toBe(created.user.id);

    // The exact call signOut() makes.
    const { error: signOutError } = await supabase.auth.signOut();
    expect(signOutError).toBeNull();

    // After logout, the same client (same cookies jar) must no longer
    // resolve an authenticated user — this is what actually protects
    // /dashboard from a "logged out" browser that still has stale cookies.
    const after = await supabase.auth.getUser();
    expect(after.error).not.toBeNull();
    expect(after.data.user).toBeNull();
  });

  it("the session is invalidated server-side, not just locally — a second independent client using the old cookies is also rejected", async () => {
    const email = `logout-serverside-${randomUUID()}@example.test`;
    const password = "Correct horse battery staple 1!";

    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError || !created.user) {
      throw new Error(`Test setup failed to create auth user: ${createError?.message}`);
    }
    cleanupUserIds.push(created.user.id);

    const jar = new Map<string, string>();
    const supabase = createServerClient(API_URL, ANON_KEY, {
      cookies: {
        getAll() {
          return Array.from(jar.entries()).map(([name, value]) => ({ name, value }));
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) jar.set(name, value);
        },
      },
    });
    await supabase.auth.signInWithPassword({ email, password });
    const capturedCookies = new Map(jar);

    await supabase.auth.signOut();

    // A brand-new client, seeded with the cookies as they were captured
    // right after sign-in (simulating a second browser tab that hasn't
    // refreshed yet) — if signOut() only cleared local state, this client
    // would still work. It must not.
    const staleClient = createServerClient(API_URL, ANON_KEY, {
      cookies: {
        getAll() {
          return Array.from(capturedCookies.entries()).map(([name, value]) => ({ name, value }));
        },
        setAll() {
          // no-op
        },
      },
    });
    const result = await staleClient.auth.getUser();
    expect(result.error).not.toBeNull();
    expect(result.data.user).toBeNull();
  });
});
