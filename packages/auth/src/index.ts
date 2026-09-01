export { createSupabaseServerClient } from "./supabase-server-client";
export { getAuthenticatedUser, type AuthenticatedUser } from "./session";
export {
  resolveRequestContext,
  resolveOrganizationContextForUser,
  type ResolvedRequestContext,
  type OrganizationContext,
} from "./request-context";
export { resolveOrganizationContextForTrackingSite, type TrackingSiteContext } from "./tracking-context";
export {
  ASSERTION_ISSUER,
  MAX_ASSERTION_LIFETIME_SECONDS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MAX_ASSERTION_STRING_LENGTH,
  parseCompactAssertion,
  parseAndValidateClaims,
  isAssertionCurrentlyValid,
  isValidEd25519SpkiPublicKeyPem,
  verifyAssertionSignature,
  type IdentityAssertionClaims,
} from "./tracking-identity-assertions";
export {
  registerTrackingSitePublicKey,
  listTrackingSitePublicKeys,
  revokeTrackingSitePublicKey,
  resolveActiveTrackingSitePublicKey,
  verifyIdentityAssertion,
  InvalidPublicKeyError,
  type RegisteredTrackingSitePublicKey,
  type VerifyIdentityAssertionInput,
} from "./tracking-signing-keys";
export {
  resolveAgencyRequestContext,
  resolveAgencyContextForUser,
  type ResolvedAgencyContext,
  type AgencyMembershipContext,
} from "./agency-context";
export { signUpWithPassword, signInWithPassword, signOut, AuthError, type AuthResult } from "./actions";
export {
  can,
  PERMISSION_MATRIX,
  type Actor,
  type PermissionKey,
  type ResourceContext,
} from "./permissions";
export {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  isApiKeyValid,
  API_KEY_PREFIX_LIVE,
  API_KEY_PREFIX_TEST,
  type GeneratedApiKey,
  type ApiKeyRecord,
} from "./api-keys";
// refreshSession and exchangeAuthCode are deliberately NOT re-exported here
// — they must be imported from "@ai-revenue-os/auth/middleware" directly.
// This barrel pulls in resolveRequestContext, which depends on pg (Node-only
// APIs); middleware.ts runs on the Edge runtime, where that import chain
// fails to bundle safely. Keeping the two import paths separate is what
// makes that mistake impossible to make again, not just documented.
