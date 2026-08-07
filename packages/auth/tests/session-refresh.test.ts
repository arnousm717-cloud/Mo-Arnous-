import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshSession } from "../src/middleware";

// Local Supabase CLI dev stack only — these are the well-known, publicly
// documented demo keys `supabase start` prints for every local install
// everywhere (see `supabase status`), never valid against a real project.
// Same precedent as packages/database/tests/helpers.ts's hardcoded local
// DATABASE_URL.
const API_URL = "http://127.0.0.1:54321";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= API_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= ANON_KEY;

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface CookieRecord {
  name: string;
  value: string;
}

/**
 * Signs a real user in against the local GoTrue instance and captures the
 * exact cookies @supabase/ssr would have written to a response — using its
 * own createServerClient/setSession round trip rather than hand-constructing
 * the cookie format, so this test tracks whatever serialization the actual
 * @supabase/ssr version in use produces.
 */
async function signInAndCaptureCookies(email: string, password: string): Promise<{
  cookies: CookieRecord[];
  accessToken: string;
}> {
  const jar = new Map<string, string>();
  const cookieMethods: CookieMethodsServer = {
    getAll() {
      return Array.from(jar.entries()).map(([name, value]) => ({ name, value }));
    },
    setAll(cookiesToSet) {
      for (const { name, value } of cookiesToSet) {
        jar.set(name, value);
      }
    },
  };
  const supabase = createServerClient(API_URL, ANON_KEY, { cookies: cookieMethods });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`signInWithPassword failed in test setup: ${error?.message}`);
  }

  return {
    cookies: Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
    accessToken: data.session.access_token,
  };
}

function buildRequestWithCookies(cookies: CookieRecord[]): NextRequest {
  const request = new NextRequest("http://localhost:3000/dashboard");
  for (const { name, value } of cookies) {
    request.cookies.set(name, value);
  }
  return request;
}

describe("refreshSession (session-expiry/refresh, docs/13 M1.3 required test)", () => {
  const email = `session-refresh-${randomUUID()}@example.test`;
  const password = "correct horse battery staple 1!";
  let userId: string;

  beforeAll(async () => {
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(`Test setup failed to create auth user: ${error?.message}`);
    }
    userId = data.user.id;
  });

  afterAll(async () => {
    if (userId) {
      await adminClient.auth.admin.deleteUser(userId);
    }
  });

  it("passes a still-valid session straight through with a working auth cookie", async () => {
    const { cookies } = await signInAndCaptureCookies(email, password);
    const request = buildRequestWithCookies(cookies);

    const response = await refreshSession(request);

    expect(response).toBeInstanceOf(Response);
    // A valid session must not be silently dropped: the request (which
    // refreshSession forwards to downstream handlers via NextResponse.next())
    // must still carry the auth cookie(s) that came in.
    for (const { name } of cookies) {
      expect(request.cookies.get(name)?.value).toBeTruthy();
    }
  });

  it("does not throw when the session has been revoked server-side (expired/invalidated refresh token)", async () => {
    const { cookies, accessToken } = await signInAndCaptureCookies(email, password);

    // Simulate real session expiry: revoke every refresh token for this
    // session server-side, the same effective end-state as the refresh
    // token's TTL lapsing. This is what actually happens once a session
    // expires — the access token eventually stops working and the refresh
    // token GoTrue holds no longer honors a refresh.
    const { error: signOutError } = await adminClient.auth.admin.signOut(accessToken, "global");
    expect(signOutError).toBeNull();

    const request = buildRequestWithCookies(cookies);

    // The real failure mode this test guards against: middleware.ts runs on
    // every request, so an unhandled rejection here would 500 the entire
    // app for any user whose session expired — refreshSession must degrade
    // gracefully (effectively logged-out), never throw.
    await expect(refreshSession(request)).resolves.toBeInstanceOf(Response);
  });

  it("does not throw for a request with no session cookies at all (anonymous visitor)", async () => {
    const request = buildRequestWithCookies([]);
    await expect(refreshSession(request)).resolves.toBeInstanceOf(Response);
  });
});
