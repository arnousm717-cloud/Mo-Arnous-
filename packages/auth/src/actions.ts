import { cookies, headers } from "next/headers";
import { createSupabaseServerClient } from "./supabase-server-client";

export interface AuthResult {
  userId: string;
  email: string | undefined;
  /**
   * False when email confirmation is required and pending — Supabase Auth
   * creates the auth.users row immediately either way (so the trigger fires
   * and this user id is real and usable), but no session cookie exists yet
   * until they confirm. Callers must check this before assuming the user is
   * actually logged in.
   */
  sessionActive: boolean;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Step one of signup — creates the auth.users identity via Supabase Auth.
 * The matching public.users row is created automatically by the
 * handle_new_auth_user() trigger (docs/03 §2.1, M1.3 migrations); creating
 * the user's first organization is a deliberate second step the caller
 * (apps/web) performs via @ai-revenue-os/tenancy once this succeeds — not
 * something this function does itself (see ADR-004's package-boundary note).
 */
export async function signUpWithPassword(email: string, password: string): Promise<AuthResult> {
  const cookieStore = await cookies();
  const supabase = createSupabaseServerClient(cookieStore);
  // The confirmation email's link must land on /auth/callback (which
  // exchanges the PKCE code for a session — see apps/web's route) rather
  // than GoTrue's site_url default, which points at the bare origin. The
  // exact URL must also be present in the project's redirect-URL allow-list
  // (supabase/config.toml's additional_redirect_urls locally, the dashboard's
  // URL Configuration in a real project) or GoTrue silently ignores it.
  const headersList = await headers();
  const origin =
    headersList.get("origin") ??
    `${headersList.get("x-forwarded-proto") ?? "http"}://${headersList.get("host")}`;
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error || !data.user) {
    throw new AuthError(error?.message ?? "Signup failed", error?.code ?? "unknown_error");
  }
  return { userId: data.user.id, email: data.user.email, sessionActive: data.session !== null };
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  const cookieStore = await cookies();
  const supabase = createSupabaseServerClient(cookieStore);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    throw new AuthError(error?.message ?? "Login failed", error?.code ?? "unknown_error");
  }
  return { userId: data.user.id, email: data.user.email, sessionActive: data.session !== null };
}

export async function signOut(): Promise<void> {
  const cookieStore = await cookies();
  const supabase = createSupabaseServerClient(cookieStore);
  await supabase.auth.signOut();
}
