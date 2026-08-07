import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { exchangeAuthCode } from "../src/middleware";

// Same well-known local Supabase CLI demo keys as the other tests in this
// package — never valid against a real project.
const API_URL = "http://127.0.0.1:54321";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const MAILPIT_URL = "http://127.0.0.1:54324";
// Must exactly match an entry in supabase/config.toml's
// additional_redirect_urls, or GoTrue silently falls back to site_url and
// never sends the /auth/callback link at all (verified against the real
// local Auth service before writing this test).
const CALLBACK_URL = "http://127.0.0.1:3000/auth/callback";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= API_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= ANON_KEY;

const adminClient = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface CookieRecord {
  name: string;
  value: string;
}

/** Real signup through the real local GoTrue instance — captures the exact
 * cookies @supabase/ssr writes (including the PKCE code_verifier), the same
 * way packages/auth/src/actions.ts's signUpWithPassword does it. */
async function signUpAndCaptureCookies(
  email: string,
  password: string,
): Promise<{ cookies: CookieRecord[]; userId: string }> {
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

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: CALLBACK_URL },
  });
  if (error || !data.user) {
    throw new Error(`Test setup failed to sign up: ${error?.message}`);
  }

  return {
    cookies: Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
    userId: data.user.id,
  };
}

/** Polls the local Mailpit inbox (what SMTP falls back to locally — the real
 * Cloud project uses Resend instead, but the message content/link format
 * GoTrue generates is identical either way) for the confirmation email. */
async function findConfirmationEmailVerifyUrl(email: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const list = (await (await fetch(`${MAILPIT_URL}/api/v1/messages`)).json()) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    const match = list.messages.find((m) => m.To.some((to) => to.Address === email));
    if (match) {
      const full = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${match.ID}`)).json()) as {
        Text: string;
      };
      const urlMatch = full.Text.match(/http:\/\/127\.0\.0\.1:54321\/auth\/v1\/verify\?\S+/);
      if (!urlMatch) {
        throw new Error("Confirmation email found but no verify URL matched in its body");
      }
      return urlMatch[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No confirmation email arrived for ${email} within the polling window`);
}

/** "Clicks" the confirmation link exactly as a real browser would: GoTrue
 * verifies the token server-side and 302s to CALLBACK_URL with a PKCE
 * `code` appended — captured here via a manual (non-followed) redirect. */
async function clickConfirmationLink(verifyUrl: string): Promise<string> {
  const response = await fetch(verifyUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`Expected a redirect from GoTrue's verify endpoint, got status ${response.status}`);
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) {
    throw new Error(`Redirect target had no ?code= param: ${location}`);
  }
  return code;
}

function buildCallbackRequest(code: string | null, cookies: CookieRecord[]): NextRequest {
  const url = code ? `${CALLBACK_URL}?code=${encodeURIComponent(code)}` : CALLBACK_URL;
  const request = new NextRequest(url);
  for (const { name, value } of cookies) {
    request.cookies.set(name, value);
  }
  return request;
}

const destinations = {
  success: new URL("http://127.0.0.1:3000/dashboard"),
  failure: new URL("http://127.0.0.1:3000/login"),
};

/**
 * End-to-end test of the exact flow this route exists for: sign up → real
 * confirmation email → click the link → exchange the code → session
 * established. Nothing here is mocked — real GoTrue, real Mailpit-captured
 * email, real PKCE code exchange — this is the automated equivalent of the
 * manual browser verification the M1.3 GO-condition ultimately requires.
 */
describe("exchangeAuthCode: real signup -> email -> confirmation link -> session", () => {
  const cleanupUserIds: string[] = [];

  afterAll(async () => {
    for (const id of cleanupUserIds) {
      await adminClient.auth.admin.deleteUser(id);
    }
  });

  it("exchanges a real confirmation-link code for a working session and redirects to /dashboard", async () => {
    const email = `callback-${randomUUID()}@example.test`;
    const password = "Correct horse battery staple 1!";

    const { cookies, userId } = await signUpAndCaptureCookies(email, password);
    cleanupUserIds.push(userId);

    const verifyUrl = await findConfirmationEmailVerifyUrl(email);
    const code = await clickConfirmationLink(verifyUrl);

    const request = buildCallbackRequest(code, cookies);
    const response = await exchangeAuthCode(request, code, destinations);

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location")).toBe(destinations.success.toString());

    const sessionCookie = response.cookies
      .getAll()
      .find((c) => c.name.includes("auth-token") && !c.name.includes("code-verifier"));
    expect(sessionCookie).toBeTruthy();

    // Prove it's a genuinely usable session, not just a cookie with the
    // right name — read it back with a fresh client and confirm it
    // resolves to the same user who signed up.
    const readBackJar = new Map<string, string>();
    for (const c of response.cookies.getAll()) readBackJar.set(c.name, c.value);
    const verifyClient = createServerClient(API_URL, ANON_KEY, {
      cookies: {
        getAll() {
          return Array.from(readBackJar.entries()).map(([name, value]) => ({ name, value }));
        },
        setAll() {
          // no-op: this client only reads the session just established above
        },
      },
    });
    const { data: userData, error: userError } = await verifyClient.auth.getUser();
    expect(userError).toBeNull();
    expect(userData.user?.id).toBe(userId);
  });

  it("redirects to /login without throwing when the code is invalid (expired/tampered/already-used link)", async () => {
    const request = buildCallbackRequest("not-a-real-code", []);
    const response = await exchangeAuthCode(request, "not-a-real-code", destinations);

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location")).toBe(destinations.failure.toString());
  });
});
