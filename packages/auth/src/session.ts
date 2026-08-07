import { cookies } from "next/headers";
import { createSupabaseServerClient } from "./supabase-server-client";

export interface AuthenticatedUser {
  id: string;
  email: string | undefined;
}

/**
 * Resolves the authenticated user for the current request, or null.
 *
 * Deliberately uses supabase.auth.getUser(), not getSession() — getUser()
 * re-validates the JWT against Supabase Auth's server on every call, while
 * getSession() only decodes the cookie locally and can be spoofed by a
 * tampered cookie. This is Supabase's own documented security guidance,
 * not a stylistic choice — getSession() is fine for non-security-sensitive
 * UI state, never for an authorization decision.
 */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const cookieStore = await cookies();
  const supabase = createSupabaseServerClient(cookieStore);
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return null;
  }
  return { id: user.id, email: user.email };
}
