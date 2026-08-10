import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * API-key hash/verify utilities (M1.7 Decision D). Deliberately NOT wired
 * into resolveRequestContext() or any route in M1.7 — nothing calls the API
 * with a key yet (n8n's own key issuance is Phase 3). This is the credential
 * primitive existing ahead of its first real caller, matching the same
 * "table + minimal mechanism, no premature integration" scope every other
 * M1.7 piece follows.
 *
 * Hashing is a fast cryptographic hash (SHA-256), not a deliberately slow
 * password hash (bcrypt/argon2) — API keys are generated with 256 bits of
 * random entropy, unlike user-chosen passwords, so there is no brute-force
 * risk a slow hash would meaningfully mitigate, and a fast hash is what lets
 * key verification happen on every authenticated request without adding
 * material latency.
 */

const KEY_BYTE_LENGTH = 32; // 256 bits of entropy
export const API_KEY_PREFIX_LIVE = "arev_live_";
export const API_KEY_PREFIX_TEST = "arev_test_";

export interface GeneratedApiKey {
  /** The full, displayable secret — returned exactly once, at generation. Never persisted. */
  plaintext: string;
  /** What actually gets stored — never reversible back to plaintext. */
  keyHash: string;
  keyPrefix: string;
}

/**
 * Generates a new API key. base64url encoding keeps the plaintext safe to
 * display/copy/paste (no characters requiring escaping in a URL, shell, or
 * JSON string) — part of the "prefix/plaintext is safe/displayable"
 * requirement, not just the prefix in isolation.
 */
export function generateApiKey(environment: "live" | "test"): GeneratedApiKey {
  const keyPrefix = environment === "live" ? API_KEY_PREFIX_LIVE : API_KEY_PREFIX_TEST;
  const randomPortion = randomBytes(KEY_BYTE_LENGTH).toString("base64url");
  const plaintext = `${keyPrefix}${randomPortion}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix,
  };
}

export function hashApiKey(plaintextKey: string): string {
  return createHash("sha256").update(plaintextKey, "utf8").digest("hex");
}

/**
 * Pure hash comparison only — does not know about revocation. Timing-safe
 * (constant-time) comparison so response timing can't be used to infer a
 * partial hash match. Deliberately synchronous and side-effect-free, same
 * design discipline as can() (docs/08-Security.md §2's RBAC facade) — this
 * makes it trivially unit-testable and reusable from any future caller
 * (a Route Handler, an Edge Function) without dragging in I/O.
 */
export function verifyApiKey(plaintextKey: string, storedHash: string): boolean {
  const candidateHash = Buffer.from(hashApiKey(plaintextKey), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (candidateHash.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(candidateHash, stored);
}

export interface ApiKeyRecord {
  keyHash: string;
  revokedAt: string | null;
}

/**
 * The real "is this key usable right now" check a future caller (Phase 3's
 * request-authentication middleware) would actually use — composes the pure
 * hash check above with revocation state. Kept separate from verifyApiKey()
 * itself so the crypto primitive stays uncluttered and independently
 * testable, while this is where "a revoked key fails verification" (M1.7
 * requirement) is actually enforced.
 */
export function isApiKeyValid(plaintextKey: string, record: ApiKeyRecord): boolean {
  if (record.revokedAt) {
    return false;
  }
  return verifyApiKey(plaintextKey, record.keyHash);
}
