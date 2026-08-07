import { createServerClient } from "@supabase/ssr";
import type { cookies } from "next/headers";

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * Supabase Auth (GoTrue) client for server-side use — Server Actions, Route
 * Handlers, and middleware.ts. This is the ONLY thing in this package that
 * talks to Supabase's hosted client library; actual tenant data queries
 * never go through this or PostgREST (ADR-004) — they go through
 * @ai-revenue-os/database's direct Postgres connection instead.
 */
export function createSupabaseServerClient(cookieStore: CookieStore) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.");
  }

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Thrown when called from a Server Component, where cookies() is
          // read-only — safe to ignore because middleware.ts (apps/web) is
          // what actually refreshes the session cookie on every request;
          // this client is still correct for reading the session here.
        }
      },
    },
  });
}
