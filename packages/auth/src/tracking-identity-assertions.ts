import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

/**
 * Ed25519 visitor-identification assertion parsing/validation (Milestone
 * 3.2B, post-Phase-0 architecture amendment — supersedes the originally
 * accepted HMAC/reversible-secret design: this repository has no shipped
 * encryption-at-rest primitive to reuse for a reversible signing secret
 * (confirmed empirically, not merely assumed, before writing this file).
 * Asymmetric signing removes that requirement by construction: the
 * customer's own trusted backend holds the Ed25519 private key and this
 * platform only ever stores/sees the corresponding public key, which is
 * not a secret.
 *
 * Deliberately NOT a JWT/JWS-compatible format. A general JWT library
 * (or a hand-rolled JWS-compatible parser) was considered and rejected:
 * JWS's own negotiable `alg` header is exactly the surface algorithm-
 * confusion attacks exploit, and reproducing that surface manually for a
 * single-purpose, single-algorithm assertion would be unnecessary
 * protocol risk for zero real benefit here. This format has no header
 * segment and no algorithm field of any kind — the verifier only ever
 * knows one algorithm (Ed25519) and applies it unconditionally; there is
 * nothing in the token itself capable of selecting a different one.
 *
 * Compact format: base64url(claimsJson) + "." + base64url(signature),
 * where the signature covers the UTF-8 bytes of the first segment
 * exactly as transmitted (never the decoded JSON, and never a re-
 * serialized form of it — this repository's own signing/verification
 * code and any customer's independent implementation must agree
 * byte-for-byte on what was actually signed, not on a canonicalization
 * rule).
 */

export const ASSERTION_ISSUER = "ai-revenue-os:visitor-identify";

/**
 * Hard server-side ceiling on assertion lifetime, independent of
 * whatever iat/exp a customer's backend actually signs — closes the
 * "attacker/customer crafts an artificially long-lived token" risk
 * (Milestone 3.2 architecture amendment §TOKEN FORMAT: "Do not silently
 * turn the assertion into a long-lived authentication token"). The
 * recommended default for customers to actually use remains much
 * shorter (documented separately, not enforced here beyond this
 * ceiling) — this constant is a maximum, not a suggestion.
 */
export const MAX_ASSERTION_LIFETIME_SECONDS = 300;

/** Bounded tolerance for clock skew between the customer's backend and this platform. */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 30;

/** Defensive ceiling on the raw compact-assertion string itself, checked before any decoding/crypto work. */
export const MAX_ASSERTION_STRING_LENGTH = 2048;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EMAIL_LENGTH = 320; // RFC 5321 practical upper bound.

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface IdentityAssertionClaims {
  iss: string;
  /** Bound to the trackingSiteId this assertion is scoped to. */
  aud: string;
  /** Which registered public key (tracking_site_public_keys.id) verifies this assertion. */
  kid: string;
  /** The one piece of contact-resolution evidence carried in the token — never a raw contactId. */
  email: string;
  iat: number;
  exp: number;
  /** Single-use replay-protection nonce. */
  jti: string;
  /** Optional redundant cross-check against the resolved tracking site's own organization. */
  organizationId?: string;
  /** Optional binding to a specific browser session — when present, must match the request's own anonymousId exactly. */
  anonymousId?: string;
}

interface ParsedAssertion {
  payloadSegment: string;
  signature: Buffer;
}

/**
 * Structural parse only — exactly one ".", both segments valid base64url,
 * total length bounded before any decoding is attempted. Never throws;
 * returns null for any malformed input, matching every other
 * public-tracking-pathway "fail closed, non-oracle" convention in this
 * repository.
 */
export function parseCompactAssertion(assertion: unknown): ParsedAssertion | null {
  if (typeof assertion !== "string" || assertion.length === 0 || assertion.length > MAX_ASSERTION_STRING_LENGTH) {
    return null;
  }
  const parts = assertion.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payloadSegment, signatureSegment] = parts as [string, string];
  if (payloadSegment.length === 0 || signatureSegment.length === 0) {
    return null;
  }
  try {
    const signature = Buffer.from(signatureSegment, "base64url");
    // Ed25519 signatures are always exactly 64 bytes -- a cheap, early
    // structural rejection before any public-key lookup or crypto call.
    if (signature.length !== 64) {
      return null;
    }
    return { payloadSegment, signature };
  } catch {
    return null;
  }
}

/**
 * Decodes and strictly validates the claims segment's shape. Never
 * throws; returns null for any missing/mistyped/out-of-policy field.
 * Does NOT verify the signature -- that is a separate step
 * (verifyAssertionSignature) so callers can resolve which key to check
 * against using the (unverified-but-parsed) kid/aud first, exactly as
 * the accepted design's verifier order requires.
 */
export function parseAndValidateClaims(payloadSegment: string): IdentityAssertionClaims | null {
  let json: unknown;
  try {
    const decoded = Buffer.from(payloadSegment, "base64url").toString("utf8");
    json = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return null;
  }
  const raw = json as Record<string, unknown>;

  if (raw.iss !== ASSERTION_ISSUER) return null;
  if (!isUuid(raw.aud)) return null;
  if (!isUuid(raw.kid)) return null;
  if (typeof raw.email !== "string" || raw.email.length === 0 || raw.email.length > MAX_EMAIL_LENGTH) return null;
  if (typeof raw.iat !== "number" || !Number.isFinite(raw.iat) || raw.iat < 0) return null;
  if (typeof raw.exp !== "number" || !Number.isFinite(raw.exp) || raw.exp < 0) return null;
  if (!isUuid(raw.jti)) return null;
  if (raw.exp <= raw.iat) return null;
  if (raw.exp - raw.iat > MAX_ASSERTION_LIFETIME_SECONDS) return null;

  if (raw.organizationId !== undefined && !isUuid(raw.organizationId)) return null;
  if (raw.anonymousId !== undefined && !isUuid(raw.anonymousId)) return null;

  const claims: IdentityAssertionClaims = {
    iss: raw.iss,
    aud: raw.aud as string,
    kid: raw.kid as string,
    email: raw.email,
    iat: raw.iat,
    exp: raw.exp,
    jti: raw.jti as string,
    ...(raw.organizationId !== undefined ? { organizationId: raw.organizationId as string } : {}),
    ...(raw.anonymousId !== undefined ? { anonymousId: raw.anonymousId as string } : {}),
  };
  return claims;
}

/** Bounded-tolerance freshness check, evaluated separately from shape validation so callers can distinguish "malformed" from "expired" if ever needed -- both currently collapse to the same non-oracle rejection at the call site regardless. */
export function isAssertionCurrentlyValid(claims: IdentityAssertionClaims, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean {
  return nowSeconds <= claims.exp + CLOCK_SKEW_TOLERANCE_SECONDS && nowSeconds >= claims.iat - CLOCK_SKEW_TOLERANCE_SECONDS;
}

const MAX_PUBLIC_KEY_PEM_LENGTH = 500;

/**
 * Validates that a PEM string is a genuine, parseable Ed25519 SPKI
 * public key -- used both at key-registration time (Milestone 3.2B) and
 * defensively immediately before every verification attempt. Never
 * throws.
 */
export function isValidEd25519SpkiPublicKeyPem(pem: unknown): pem is string {
  if (typeof pem !== "string" || pem.length === 0 || pem.length > MAX_PUBLIC_KEY_PEM_LENGTH) {
    return false;
  }
  try {
    const keyObject = createPublicKey({ key: pem, format: "pem", type: "spki" });
    return keyObject.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/**
 * Verifies the Ed25519 signature over the exact payload segment bytes
 * that were transmitted. Explicitly re-checks asymmetricKeyType ===
 * "ed25519" immediately before verifying -- defense in depth against
 * algorithm confusion even in the hypothetical case a non-Ed25519 PEM
 * somehow reached this function (registration-time validation already
 * prevents that; this is a second, independent gate, not a trust of the
 * first). Never throws -- any crypto-layer exception (malformed key,
 * malformed signature) is treated as verification failure, fail closed.
 */
export function verifyAssertionSignature(payloadSegment: string, signature: Buffer, publicKeyPem: string): boolean {
  try {
    const keyObject: KeyObject = createPublicKey({ key: publicKeyPem, format: "pem", type: "spki" });
    if (keyObject.asymmetricKeyType !== "ed25519") {
      return false;
    }
    return cryptoVerify(null, Buffer.from(payloadSegment, "utf8"), keyObject, signature);
  } catch {
    return false;
  }
}
