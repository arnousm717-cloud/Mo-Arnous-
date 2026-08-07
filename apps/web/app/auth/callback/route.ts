import { NextResponse, type NextRequest } from "next/server";
import { exchangeAuthCode } from "@ai-revenue-os/auth/middleware";

/**
 * Handles the redirect from Supabase Auth's confirmation email link
 * (signUpWithPassword in packages/auth sets emailRedirectTo to this route).
 * The actual PKCE exchange lives in @ai-revenue-os/auth's exchangeAuthCode
 * (business logic belongs in packages/*, not inline in a Route Handler —
 * docs/10-CLAUDE.md). A missing/invalid code (expired link, tampered URL,
 * already used) falls back to /login rather than throwing.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  const loginUrl = new URL("/login", request.url);

  if (!code) {
    return NextResponse.redirect(loginUrl);
  }

  return exchangeAuthCode(request, code, {
    success: new URL("/dashboard", request.url),
    failure: loginUrl,
  });
}
