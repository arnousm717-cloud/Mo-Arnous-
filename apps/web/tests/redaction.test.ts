import { describe, expect, it } from "vitest";
import { redactDeep, redactString } from "../app/api/v1/_shared/redaction";

// M1.8's own named "single most important test" (docs/12-Implementation-
// Milestones.md, docs/13-Technical-Design-Review.md): the TDR explicitly
// calls out a hardcoded-list redaction implementation as the central risk,
// so this suite covers every secret shape named in the approved plan
// individually, plus the inverse (safe values must survive unredacted).

describe("redactString: secret shapes", () => {
  it("redacts an arev_live_ API key", () => {
    const input = "used key arev_live_ab12CD34ef56GH78 to call the API";
    expect(redactString(input)).toBe("used key [REDACTED] to call the API");
  });

  it("redacts an arev_test_ API key", () => {
    const input = "arev_test_zzzz1111yyyy2222";
    expect(redactString(input)).toBe("[REDACTED]");
  });

  it("redacts a Bearer token", () => {
    const input = "Authorization: Bearer abc123.def456-ghi_789";
    expect(redactString(input)).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts a JWT-shaped value", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactString(`session token: ${jwt}`)).toBe("session token: [REDACTED]");
  });

  it("redacts an sk_live_-shaped provider key", () => {
    // Deliberately synthetic (not a real-looking Stripe key shape) — GitHub
    // push protection flags anything resembling a real Stripe secret key,
    // even well-known published documentation examples.
    expect(redactString("provider key sk_live_synthetictestvalue0001")).toBe(
      "provider key [REDACTED]",
    );
  });

  it("redacts a pk_test_-shaped provider key", () => {
    expect(redactString("pk_test_synthetictestvalue0002")).toBe("[REDACTED]");
  });

  it("redacts credentials embedded in a Postgres connection string, keeping the host visible", () => {
    const input = "connecting to postgresql://myuser:sup3rSecret!@db.example.com:5432/postgres";
    expect(redactString(input)).toBe(
      "connecting to postgresql://[REDACTED]@db.example.com:5432/postgres",
    );
  });

  it("redacts an email address", () => {
    expect(redactString("contact arnousm717@gmail.com for support")).toBe(
      "contact [REDACTED] for support",
    );
  });

  it("redacts a session cookie value while preserving the cookie name", () => {
    expect(redactString("Cookie header contained sb-access-token=abc.def.ghi; other=1")).toBe(
      "Cookie header contained sb-access-token=[REDACTED]; other=1",
    );
  });

  it("redacts a generic session= credential value", () => {
    expect(redactString("session=s%3AxyzABC123.signature")).toBe("session=[REDACTED]");
  });

  it("redacts multiple distinct secrets in the same string", () => {
    const input = "key arev_live_aaaaaaaaaa and email test@example.com both leaked";
    expect(redactString(input)).toBe("key [REDACTED] and email [REDACTED] both leaked");
  });
});

describe("redactString: safe values pass through unchanged", () => {
  it("does not touch a plain organizationId UUID", () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(redactString(id)).toBe(id);
  });

  it("does not touch a route path", () => {
    expect(redactString("/api/v1/organizations")).toBe("/api/v1/organizations");
  });

  it("does not touch an HTTP method or status code", () => {
    expect(redactString("GET")).toBe("GET");
    expect(redactString("200")).toBe("200");
  });

  it("does not touch an ordinary log message", () => {
    const msg = "organization created successfully";
    expect(redactString(msg)).toBe(msg);
  });

  it("does not touch a bare host/domain name with no embedded credentials", () => {
    expect(redactString("db.example.com")).toBe("db.example.com");
  });
});

describe("redactDeep: recursive structural redaction", () => {
  it("redacts secret-shaped string values nested inside an object", () => {
    const input = {
      route: "/api/v1/organizations",
      status: 500,
      organizationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      error: { message: "failed for arnousm717@gmail.com with key arev_live_aaaaaaaaaa" },
    };
    const result = redactDeep(input);
    expect(result.route).toBe("/api/v1/organizations");
    expect(result.status).toBe(500);
    expect(result.organizationId).toBe("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    expect(result.error.message).toBe("failed for [REDACTED] with key [REDACTED]");
  });

  it("redacts secret-shaped strings inside an array", () => {
    const result = redactDeep(["clean", "arev_test_bbbbbbbbbb", 42, null]);
    expect(result).toEqual(["clean", "[REDACTED]", 42, null]);
  });

  it("leaves non-string primitives untouched", () => {
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep(true)).toBe(true);
    expect(redactDeep(null)).toBe(null);
  });

  // Regression test for a gap found empirically (M1.8 Decision D): Sentry's
  // own RequestData integration auto-parses a raw Cookie header into a
  // structured `request.cookies` object keyed by cookie name, e.g.
  // `{ "sb-access-token": "<raw value>" }` — a shape the pattern-based
  // rules above cannot catch, since the *value* alone has no "name=value"
  // structure. Key-name-based redaction (SENSITIVE_KEY_PATTERN) exists
  // specifically to cover this case.
  it("redacts every value under a 'cookies' key regardless of the value's own shape", () => {
    const input = {
      request: {
        cookies: { "sb-access-token": "raw-session-value", other: "1" },
      },
    };
    const result = redactDeep(input);
    expect(result.request.cookies).toBe("[REDACTED]");
  });

  it("redacts a top-level 'authorization' key even when its value is not a Bearer-shaped string", () => {
    const result = redactDeep({ authorization: "some-opaque-credential" });
    expect(result.authorization).toBe("[REDACTED]");
  });

  it("redacts a 'password' or 'secret' key outright", () => {
    const result = redactDeep({ password: "hunter2", secret: { nested: "value" } });
    expect(result.password).toBe("[REDACTED]");
    expect(result.secret).toBe("[REDACTED]");
  });

  it("does not redact a key that merely contains 'session' as a substring, only an exact sensitive key name", () => {
    // sanity check that SENSITIVE_KEY_PATTERN is an exact match, not a
    // substring match, so ordinary keys like "sessionCount" aren't nuked.
    const result = redactDeep({ sessionCount: 3 });
    expect(result.sessionCount).toBe(3);
  });
});
