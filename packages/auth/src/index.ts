export { createSupabaseServerClient } from "./supabase-server-client";
export { getAuthenticatedUser, type AuthenticatedUser } from "./session";
export { resolveRequestContext, type ResolvedRequestContext } from "./request-context";
export { signUpWithPassword, signInWithPassword, signOut, AuthError, type AuthResult } from "./actions";
// refreshSession and exchangeAuthCode are deliberately NOT re-exported here
// — they must be imported from "@ai-revenue-os/auth/middleware" directly.
// This barrel pulls in resolveRequestContext, which depends on pg (Node-only
// APIs); middleware.ts runs on the Edge runtime, where that import chain
// fails to bundle safely. Keeping the two import paths separate is what
// makes that mistake impossible to make again, not just documented.
