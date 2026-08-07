import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

function getSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.");
  }
  return { url, anonKey };
}

/**
 * Called from apps/web's middleware.ts on every request (Edge runtime).
 * Refreshes the Supabase Auth session cookie if the access token has
 * expired — this is session/cookie maintenance only. It never resolves
 * tenant context or touches Postgres directly: pg needs the Node.js
 * runtime, not Edge, so that resolution happens inside Server
 * Actions/Route Handlers via @ai-revenue-os/auth's resolveRequestContext(),
 * not here (ADR-004).
 */
export async function refreshSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const { url, anonKey } = getSupabaseEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // The call itself is what triggers a token refresh when the access token
  // is expired — omitting it is the most common way this pattern silently
  // breaks (cookies never refresh, users get logged out at the token TTL).
  await supabase.auth.getUser();

  return response;
}

/**
 * Exchanges a PKCE `code` (from Supabase Auth's email-confirmation redirect
 * — signUpWithPassword in ./actions.ts sets emailRedirectTo to
 * apps/web's /auth/callback route) for a real session, writing the
 * resulting cookies onto a redirect response. Kept here, request/response
 * cookie-based rather than next/headers-based, for the same two reasons as
 * refreshSession above: it stays callable standalone in tests (next/headers'
 * cookies() requires an active Next.js request context a test process
 * doesn't have), and it never risks pulling pg into an Edge-adjacent code
 * path (ADR-004) even though apps/web's Route Handler itself runs on Node.
 */
export async function exchangeAuthCode(
  request: NextRequest,
  code: string,
  destinations: { success: URL; failure: URL },
): Promise<NextResponse> {
  const { url, anonKey } = getSupabaseEnv();
  const successResponse = NextResponse.redirect(destinations.success);

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          successResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  return error ? NextResponse.redirect(destinations.failure) : successResponse;
}
