import { isIP } from "node:net";

/**
 * Trusted source-IP extraction for the public /track/* routes (Milestone
 * 3.1C-C). Never reads IP from the JSON body — a browser-controlled body
 * field could claim to be any IP at all; only server-observed headers are
 * trusted here.
 *
 * Priority: x-vercel-forwarded-for, then x-forwarded-for, then x-real-ip.
 * Verified against Vercel's own documentation during the 3.1C-A design
 * phase: Vercel's edge overwrites/anti-spoofs x-forwarded-for by default
 * and does not forward external IPs through it unmodified, while
 * x-vercel-forwarded-for survives an additional proxy hop on top of
 * Vercel's own — making it the strongest available signal when present.
 *
 * The result of resolveTrustedSourceIp() is ALWAYS a usable bucket
 * identifier — it never returns null/undefined and callers must never
 * skip the IP rate-limit dimension because no header was present. A
 * missing, malformed, or implausible value falls back to the fixed
 * constant "unknown", which is itself rate-limited like any other
 * identifier (bounded, never exempt).
 *
 * Milestone 3.1C-C acceptance-audit fix: a header value is only ever
 * accepted as a candidate once Node's own isIP() confirms it is a
 * genuine IPv4 or IPv6 textual address (isIP() returns 0 for anything
 * else, 4 or 6 otherwise) — a length/non-emptiness check alone (the
 * pre-fix behavior) let arbitrary non-IP strings each become their own,
 * distinct, persisted rate-limit bucket identifier, contradicting this
 * module's own "malformed value -> unknown" contract. isIP() is the
 * authority here deliberately, rather than a hand-written regex — no
 * custom IPv4/IPv6 format logic is reinvented.
 */

const MAX_IP_LENGTH = 45; // Longest valid textual IPv6 representation.
const UNKNOWN_IP = "unknown";

/**
 * A comma-separated forwarded-header value lists proxies left-to-right in
 * hop order — the leftmost entry is the original client, each subsequent
 * proxy appends its own hop. Only the first entry is ever trusted.
 */
function firstForwardedEntry(headerValue: string): string {
  const commaIndex = headerValue.indexOf(",");
  const first = commaIndex === -1 ? headerValue : headerValue.slice(0, commaIndex);
  return first.trim();
}

/**
 * IPv6 textual hex is case-insensitive (2001:DB8::1 and 2001:db8::1 are
 * the identical address) — without lowercasing, two case variants of the
 * same address would hash to two different rate-limit buckets, exactly
 * the same class of bypass identified for tracking-site UUIDs in 3.1C-B.
 * Lowercasing an IPv4 address is a harmless no-op (no letters).
 */
function canonicalizeIp(candidate: string): string {
  return candidate.toLowerCase();
}

function isPlausibleIpCandidate(value: string): boolean {
  return value.length > 0 && value.length <= MAX_IP_LENGTH && isIP(value) !== 0;
}

export interface TrackRequestHeaders {
  get(name: string): string | null;
}

/**
 * Resolves the trusted source IP for rate-limiting purposes. Always
 * returns a non-empty string — "unknown" is the deliberate, fixed
 * fallback bucket for a missing/malformed/implausible value, never a
 * skipped check.
 */
export function resolveTrustedSourceIp(headers: TrackRequestHeaders): string {
  const vercelForwardedFor = headers.get("x-vercel-forwarded-for");
  if (vercelForwardedFor) {
    const candidate = firstForwardedEntry(vercelForwardedFor);
    if (isPlausibleIpCandidate(candidate)) {
      return canonicalizeIp(candidate);
    }
  }

  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const candidate = firstForwardedEntry(forwardedFor);
    if (isPlausibleIpCandidate(candidate)) {
      return canonicalizeIp(candidate);
    }
  }

  const realIp = headers.get("x-real-ip");
  if (realIp) {
    const candidate = realIp.trim();
    if (isPlausibleIpCandidate(candidate)) {
      return canonicalizeIp(candidate);
    }
  }

  return UNKNOWN_IP;
}
