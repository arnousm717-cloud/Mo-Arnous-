/**
 * Single shared redaction implementation (M1.8, docs/08-Security.md §7) —
 * used identically by the structured logger (_shared/logger.ts) and
 * Sentry's beforeSend/beforeSendTransaction hooks (instrumentation.ts), so
 * there is exactly one place the redaction rule set is defined. Pattern-
 * based, not a hardcoded literal list — the TDR (docs/13) names a
 * hardcoded-list approach as this milestone's central named risk, since it
 * would silently fail to cover a future secret shape.
 */

const REDACTED = "[REDACTED]";

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replace: (...args: string[]) => string;
}

// Order matters only in that more specific patterns run first where two
// patterns could otherwise both match the same substring (e.g. a Bearer
// JWT is caught by the Bearer rule before the bare-JWT rule would need to).
const RULES: RedactionRule[] = [
  {
    name: "arev-api-key",
    pattern: /\barev_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9\-_.~+/]+=*/gi,
    replace: () => `Bearer ${REDACTED}`,
  },
  {
    name: "jwt",
    // Three base64url segments; the header segment of a real JWT always
    // starts "eyJ" (base64url of `{"`), which keeps this from matching
    // arbitrary dot-separated tokens that aren't actually JWT-shaped.
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: "provider-key",
    pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
    replace: () => REDACTED,
  },
  {
    name: "db-connection-credentials",
    // postgres://user:password@host — redact the user:password portion,
    // keep the host visible since that's useful, non-secret triage context.
    pattern: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\/\s@]+:[^@\/\s]+@/gi,
    replace: (match) => `${match.slice(0, match.indexOf("://") + 3)}${REDACTED}@`,
  },
  {
    name: "cookie-or-session-credential",
    // Defense-in-depth backstop: raw cookies/headers are never logged in
    // the first place (logger.ts never accepts them), but if a
    // cookie/session-shaped value ends up embedded in some other string
    // (e.g. an upstream error message), it's still caught here.
    pattern: /\b(sb-access-token|sb-refresh-token|session|sid|connect\.sid|auth[-_]?token)=[^;\s"']+/gi,
    replace: (_match, cookieName) => `${cookieName}=${REDACTED}`,
  },
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: () => REDACTED,
  },
];

/** Redacts every known secret/PII-shaped substring in a single string. */
export function redactString(input: string): string {
  return RULES.reduce((value, rule) => value.replace(rule.pattern, rule.replace), input);
}

// Key-name-based redaction, distinct from (and a backstop for) the
// pattern-based rules above. Found necessary empirically (M1.8 Decision
// D): Sentry's own RequestData integration auto-parses a raw `Cookie`
// header string into a structured `request.cookies` object keyed by
// cookie name — e.g. `{ "sb-access-token": "<raw value>" }` — where the
// *value* alone has no "name=value" shape for the string patterns above to
// match. Pattern-matching string content is not sufficient on its own;
// anything reachable under one of these key names is redacted outright,
// regardless of its shape, on the assumption that the key name itself
// already declares the value sensitive.
const SENSITIVE_KEY_PATTERN = /^(cookie|cookies|set-cookie|authorization|password|secret|session)$/i;

/**
 * Recursively redacts an arbitrary JSON-like structure (log payloads,
 * Sentry event contexts): every string value against the pattern-based
 * rules above, and the entire value at any key whose *name* is itself
 * sensitive-shaped (see SENSITIVE_KEY_PATTERN), regardless of that value's
 * own shape. Non-string, non-object leaves (numbers, booleans, null) pass
 * through unchanged.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactDeep(val);
    }
    return result as unknown as T;
  }
  return value;
}
