import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyCorsHeaders, CORS_HEADERS, corsPreflightResponse } from "../app/track/_shared/cors";
import {
  internalErrorResponse,
  invalidRequestResponse,
  noContentResponse,
  payloadTooLargeResponse,
  rateLimitedResponse,
} from "../app/track/_shared/responses";
import { InvalidJsonError, PayloadTooLargeError, readBoundedJsonBody } from "../app/track/_shared/request";
import {
  ValidationError,
  validateCollectRequest,
  validateConsentRequest,
} from "../app/track/_shared/validation";
import { resolveTrustedSourceIp } from "../app/track/_shared/ip";

/**
 * Milestone 3.1C-C — pure/structural unit tests for the /track/* shared
 * utilities. No database needed for any of these; DB/security/concurrency
 * behavior is exercised end-to-end by track-collect.test.ts and
 * track-consent-route.test.ts instead.
 */

describe("cors.ts", () => {
  it("CORS_HEADERS matches the exact approved contract", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
    expect(CORS_HEADERS["Access-Control-Allow-Headers"]).toBe("Content-Type");
    expect(CORS_HEADERS["Access-Control-Max-Age"]).toBe("86400");
    expect(CORS_HEADERS["Access-Control-Expose-Headers"]).toBe("Retry-After, X-RateLimit-Remaining");
    expect(CORS_HEADERS["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("applyCorsHeaders sets every header on an existing Headers instance", () => {
    const headers = new Headers();
    applyCorsHeaders(headers);
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      expect(headers.get(name)).toBe(value);
    }
  });

  it("corsPreflightResponse is 204 with an empty body and CORS headers", async () => {
    const response = corsPreflightResponse();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("responses.ts", () => {
  it("noContentResponse: 204, empty body, CORS headers", async () => {
    const r = noContentResponse();
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("invalidRequestResponse: 400 {error:invalid_request}, CORS headers", async () => {
    const r = invalidRequestResponse();
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_request" });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("payloadTooLargeResponse: 413 {error:payload_too_large}, CORS headers", async () => {
    const r = payloadTooLargeResponse();
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: "payload_too_large" });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rateLimitedResponse: 429 {error:rate_limited}, Retry-After: 60, X-RateLimit-Remaining: 0, CORS headers", async () => {
    const r = rateLimitedResponse();
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "rate_limited" });
    expect(r.headers.get("Retry-After")).toBe("60");
    expect(r.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("internalErrorResponse: 500 {error:internal_error}, CORS headers, no raw exception detail", async () => {
    const r = internalErrorResponse();
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "internal_error" });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/track/collect", { method: "POST", body, headers });
}

describe("request.ts: readBoundedJsonBody", () => {
  it("accepts a body exactly at the 16384-byte boundary", async () => {
    // Build an exact-length JSON body deterministically.
    const filler = "x".repeat(16384 - '{"a":""}'.length);
    const exactBody = `{"a":"${filler}"}`;
    expect(Buffer.byteLength(exactBody, "utf8")).toBe(16384);
    const result = await readBoundedJsonBody(makeRequest(exactBody));
    expect(result).toEqual({ a: filler });
  });

  it("rejects a body one byte over the limit (16385 bytes) with PayloadTooLargeError", async () => {
    const filler = "x".repeat(16384 - '{"a":""}'.length + 1);
    const overBody = `{"a":"${filler}"}`;
    expect(Buffer.byteLength(overBody, "utf8")).toBe(16385);
    await expect(readBoundedJsonBody(makeRequest(overBody))).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("rejects via Content-Length pre-check before reading the body, when Content-Length > limit", async () => {
    const request = makeRequest("{}", { "content-length": "999999" });
    await expect(readBoundedJsonBody(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("an understated Content-Length cannot bypass the actual-byte limit", async () => {
    const filler = "x".repeat(20000);
    const oversized = `{"a":"${filler}"}`;
    const request = makeRequest(oversized, { "content-length": "10" });
    await expect(readBoundedJsonBody(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("a missing Content-Length still enforces the actual-byte limit", async () => {
    const filler = "x".repeat(20000);
    const oversized = `{"a":"${filler}"}`;
    const request = new Request("https://example.test/track/collect", { method: "POST", body: oversized });
    await expect(readBoundedJsonBody(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("a malformed/negative Content-Length is not trusted; the actual stream limit remains authoritative", async () => {
    const smallBody = JSON.stringify({ a: "ok" });
    const request = makeRequest(smallBody, { "content-length": "-5" });
    const result = await readBoundedJsonBody(request);
    expect(result).toEqual({ a: "ok" });

    const request2 = makeRequest(smallBody, { "content-length": "not-a-number" });
    const result2 = await readBoundedJsonBody(request2);
    expect(result2).toEqual({ a: "ok" });
  });

  it("empty body -> InvalidJsonError", async () => {
    await expect(readBoundedJsonBody(makeRequest(""))).rejects.toBeInstanceOf(InvalidJsonError);
  });

  it("malformed JSON -> InvalidJsonError", async () => {
    await expect(readBoundedJsonBody(makeRequest("{not json"))).rejects.toBeInstanceOf(InvalidJsonError);
  });
});

describe("validation.ts: UUID canonicalization", () => {
  it("an uppercase UUID is accepted and normalized to lowercase", () => {
    const id = randomUUID();
    const fields = validateCollectRequest({
      siteKey: id.toUpperCase(),
      anonymousId: id,
      anonymousSessionId: id,
      eventType: "pageview",
    });
    expect(fields.siteKey).toBe(id.toLowerCase());
    expect(fields.siteKey).toBe(fields.siteKey.toLowerCase());
  });

  it("a mixed-case UUID and its lowercase form normalize identically", () => {
    const id = randomUUID();
    const mixed = id
      .split("")
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
      .join("");
    const fieldsA = validateCollectRequest({
      siteKey: mixed,
      anonymousId: id,
      anonymousSessionId: id,
      eventType: "pageview",
    });
    const fieldsB = validateCollectRequest({
      siteKey: id,
      anonymousId: id,
      anonymousSessionId: id,
      eventType: "pageview",
    });
    expect(fieldsA.siteKey).toBe(fieldsB.siteKey);
  });

  it("a non-UUID-shaped siteKey is rejected", () => {
    expect(() =>
      validateCollectRequest({
        siteKey: "not-a-uuid",
        anonymousId: randomUUID(),
        anonymousSessionId: randomUUID(),
        eventType: "pageview",
      }),
    ).toThrow(ValidationError);
  });
});

describe("validation.ts: unknown-field rejection", () => {
  it("collect rejects an unknown top-level field", () => {
    expect(() =>
      validateCollectRequest({
        siteKey: randomUUID(),
        anonymousId: randomUUID(),
        anonymousSessionId: randomUUID(),
        eventType: "pageview",
        extraField: "nope",
      }),
    ).toThrow(ValidationError);
  });

  it("consent rejects anonymousSessionId", () => {
    expect(() =>
      validateConsentRequest({
        siteKey: randomUUID(),
        anonymousId: randomUUID(),
        status: "granted",
        anonymousSessionId: randomUUID(),
      }),
    ).toThrow(ValidationError);
  });

  it("consent rejects metadata", () => {
    expect(() =>
      validateConsentRequest({
        siteKey: randomUUID(),
        anonymousId: randomUUID(),
        status: "granted",
        metadata: {},
      }),
    ).toThrow(ValidationError);
  });

  it("consent rejects organizationId, even a plausible-looking one", () => {
    expect(() =>
      validateConsentRequest({
        siteKey: randomUUID(),
        anonymousId: randomUUID(),
        status: "granted",
        organizationId: randomUUID(),
      }),
    ).toThrow(ValidationError);
  });
});

describe("validation.ts: metadata limits", () => {
  const base = () => ({
    siteKey: randomUUID(),
    anonymousId: randomUUID(),
    anonymousSessionId: randomUUID(),
    eventType: "pageview" as const,
  });

  it("metadata >4096 serialized bytes is rejected", () => {
    const metadata = { big: "x".repeat(5000) };
    expect(() => validateCollectRequest({ ...base(), metadata })).toThrow(ValidationError);
  });

  it("metadata at exactly depth 3 is accepted", () => {
    const metadata = { a: { b: { c: 1 } } }; // top(1) -> a(2) -> b(3)
    const fields = validateCollectRequest({ ...base(), metadata });
    expect(fields.metadata).toEqual(metadata);
  });

  it("metadata depth >3 is rejected", () => {
    const metadata = { a: { b: { c: { d: 1 } } } }; // top(1)->a(2)->b(3)->c(4)
    expect(() => validateCollectRequest({ ...base(), metadata })).toThrow(ValidationError);
  });

  it("nested arrays count toward depth", () => {
    const metadata = { a: [{ b: [{ c: 1 }] }] }; // top(1)->a(2,array)->[0](3,obj)->b(4,array) rejected
    expect(() => validateCollectRequest({ ...base(), metadata })).toThrow(ValidationError);
  });

  it("exactly 50 total metadata keys is accepted", () => {
    const metadata: Record<string, number> = {};
    for (let i = 0; i < 50; i++) metadata[`k${i}`] = i;
    const fields = validateCollectRequest({ ...base(), metadata });
    expect(Object.keys(fields.metadata!)).toHaveLength(50);
  });

  it(">50 total metadata object keys is rejected", () => {
    const metadata: Record<string, number> = {};
    for (let i = 0; i < 51; i++) metadata[`k${i}`] = i;
    expect(() => validateCollectRequest({ ...base(), metadata })).toThrow(ValidationError);
  });

  it("keys nested inside objects count toward the same global 50-key budget", () => {
    const metadata: Record<string, unknown> = { nested: {} };
    const nested = metadata.nested as Record<string, number>;
    for (let i = 0; i < 50; i++) nested[`k${i}`] = i; // 1 (top "nested" key) + 50 = 51
    expect(() => validateCollectRequest({ ...base(), metadata })).toThrow(ValidationError);
  });

  it("a metadata key longer than 100 characters is rejected", () => {
    const metadata = { [`k${"x".repeat(100)}`]: 1 };
    expect(() => validateCollectRequest({ ...base(), metadata })).toThrow(ValidationError);
  });

  it("a metadata string value longer than 500 characters is rejected", () => {
    const metadata = { s: "x".repeat(501) };
    expect(() => validateCollectRequest({ ...base(), metadata })).toThrow(ValidationError);
  });

  it("a top-level metadata array is rejected", () => {
    expect(() => validateCollectRequest({ ...base(), metadata: [1, 2, 3] })).toThrow(ValidationError);
  });

  it("a top-level metadata null is rejected (metadata field must be an object when present)", () => {
    expect(() => validateCollectRequest({ ...base(), metadata: null })).toThrow(ValidationError);
  });

  it("parsed metadata is passed through unchanged, including a literal __proto__ own key, without mutating any real prototype", () => {
    const metadata = JSON.parse('{"__proto__":{"polluted":true}}');
    const fields = validateCollectRequest({ ...base(), metadata });
    expect(fields.metadata).toBeDefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe("validation.ts: collect field length limits", () => {
  const base = () => ({
    siteKey: randomUUID(),
    anonymousId: randomUUID(),
    anonymousSessionId: randomUUID(),
    eventType: "pageview" as const,
  });

  it("url over 2048 characters is rejected", () => {
    expect(() => validateCollectRequest({ ...base(), url: "https://x.test/" + "a".repeat(2048) })).toThrow(
      ValidationError,
    );
  });

  it("referrer over 2048 characters is rejected", () => {
    expect(() => validateCollectRequest({ ...base(), referrer: "a".repeat(2049) })).toThrow(ValidationError);
  });

  it("landingPage over 2048 characters is rejected", () => {
    expect(() => validateCollectRequest({ ...base(), landingPage: "a".repeat(2049) })).toThrow(ValidationError);
  });

  it("utmSource/utmMedium/utmCampaign over 255 characters are each rejected", () => {
    expect(() => validateCollectRequest({ ...base(), utmSource: "a".repeat(256) })).toThrow(ValidationError);
    expect(() => validateCollectRequest({ ...base(), utmMedium: "a".repeat(256) })).toThrow(ValidationError);
    expect(() => validateCollectRequest({ ...base(), utmCampaign: "a".repeat(256) })).toThrow(ValidationError);
  });

  it("deviceType over 50 characters is rejected", () => {
    expect(() => validateCollectRequest({ ...base(), deviceType: "a".repeat(51) })).toThrow(ValidationError);
  });

  it("eventType not in the allowed set is rejected", () => {
    expect(() => validateCollectRequest({ ...base(), eventType: "not_a_real_type" })).toThrow(ValidationError);
  });
});

describe("ip.ts: resolveTrustedSourceIp", () => {
  function headersOf(values: Record<string, string>) {
    return { get: (name: string) => values[name.toLowerCase()] ?? null };
  }

  it("prefers x-vercel-forwarded-for over x-forwarded-for and x-real-ip", () => {
    const ip = resolveTrustedSourceIp(
      headersOf({ "x-vercel-forwarded-for": "1.1.1.1", "x-forwarded-for": "2.2.2.2", "x-real-ip": "3.3.3.3" }),
    );
    expect(ip).toBe("1.1.1.1");
  });

  it("falls back to x-forwarded-for when x-vercel-forwarded-for is absent", () => {
    expect(resolveTrustedSourceIp(headersOf({ "x-forwarded-for": "2.2.2.2", "x-real-ip": "3.3.3.3" }))).toBe(
      "2.2.2.2",
    );
  });

  it("falls back to x-real-ip when the others are absent", () => {
    expect(resolveTrustedSourceIp(headersOf({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
  });

  it("takes the first entry of a comma-separated forwarded header and trims it", () => {
    expect(resolveTrustedSourceIp(headersOf({ "x-forwarded-for": " 5.5.5.5 , 6.6.6.6, 7.7.7.7" }))).toBe("5.5.5.5");
  });

  it("normalizes IPv6 textual hex case to lowercase before hashing", () => {
    expect(resolveTrustedSourceIp(headersOf({ "x-real-ip": "2001:DB8::1" }))).toBe("2001:db8::1");
  });

  it("two IPv6 case variants of the identical address resolve to the identical bucket identifier", () => {
    const a = resolveTrustedSourceIp(headersOf({ "x-real-ip": "2001:DB8::AB" }));
    const b = resolveTrustedSourceIp(headersOf({ "x-real-ip": "2001:db8::ab" }));
    expect(a).toBe(b);
  });

  it("falls back to the fixed 'unknown' bucket when no header is present — never skips the IP dimension", () => {
    expect(resolveTrustedSourceIp(headersOf({}))).toBe("unknown");
  });

  it("falls back to 'unknown' for an implausibly long header value", () => {
    expect(resolveTrustedSourceIp(headersOf({ "x-real-ip": "x".repeat(1000) }))).toBe("unknown");
  });

  // Milestone 3.1C-C acceptance-audit fix: isPlausibleIpCandidate now
  // requires node:net's isIP() to recognize the candidate as a genuine
  // IPv4/IPv6 address — a length/non-emptiness check alone previously let
  // arbitrary non-IP strings each become their own distinct, persisted
  // rate-limit bucket identifier. These tests exercise
  // resolveTrustedSourceIp() itself (not isIP() in isolation).

  describe("valid IPv4 addresses are recognized", () => {
    for (const ip of ["127.0.0.1", "192.168.1.1", "8.8.8.8", "255.255.255.255"]) {
      it(`accepts ${ip}`, () => {
        expect(resolveTrustedSourceIp(headersOf({ "x-real-ip": ip }))).toBe(ip);
      });
    }
  });

  describe("malformed IPv4-shaped values fall back to 'unknown', never their own bucket", () => {
    for (const bad of [
      "abc",
      "garbage",
      "totally-not-an-ip-address",
      "999.999.999.999",
      "256.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "1..2.3",
      "1.2.3.-1",
      "",
    ]) {
      it(`rejects "${bad}"`, () => {
        expect(resolveTrustedSourceIp(headersOf({ "x-real-ip": bad }))).toBe("unknown");
      });
    }
  });

  describe("valid IPv6 addresses are recognized and canonicalized to lowercase", () => {
    const cases: Array<[string, string]> = [
      ["::1", "::1"],
      ["2001:db8::1", "2001:db8::1"],
      ["2001:DB8::1", "2001:db8::1"],
      ["fe80::1", "fe80::1"],
      ["::ffff:192.0.2.128", "::ffff:192.0.2.128"],
    ];
    for (const [input, expected] of cases) {
      it(`accepts ${input} -> ${expected}`, () => {
        expect(resolveTrustedSourceIp(headersOf({ "x-real-ip": input }))).toBe(expected);
      });
    }
  });

  describe("malformed IPv6-shaped values fall back to 'unknown'", () => {
    for (const bad of ["2001:db8:::1", "2001:db8::gggg", "::::"]) {
      it(`rejects "${bad}"`, () => {
        expect(resolveTrustedSourceIp(headersOf({ "x-real-ip": bad }))).toBe("unknown");
      });
    }
  });

  describe("malformed higher-priority headers correctly fall through to the next header, never straight to an attacker-chosen bucket", () => {
    it("a malformed x-vercel-forwarded-for falls through to a valid x-forwarded-for", () => {
      const ip = resolveTrustedSourceIp(
        headersOf({ "x-vercel-forwarded-for": "garbage", "x-forwarded-for": "9.9.9.9" }),
      );
      expect(ip).toBe("9.9.9.9");
    });

    it("malformed x-vercel-forwarded-for AND x-forwarded-for fall through to a valid x-real-ip", () => {
      const ip = resolveTrustedSourceIp(
        headersOf({ "x-vercel-forwarded-for": "garbage", "x-forwarded-for": "also-garbage", "x-real-ip": "10.10.10.10" }),
      );
      expect(ip).toBe("10.10.10.10");
    });

    it("malformed values on all three headers resolve to 'unknown', never any of the raw garbage values", () => {
      const ip = resolveTrustedSourceIp(
        headersOf({ "x-vercel-forwarded-for": "garbage", "x-forwarded-for": "garbage", "x-real-ip": "garbage" }),
      );
      expect(ip).toBe("unknown");
    });

    it("'garbage' via x-vercel-forwarded-for alone never returns 'garbage'", () => {
      expect(resolveTrustedSourceIp(headersOf({ "x-vercel-forwarded-for": "garbage" }))).toBe("unknown");
    });

    it("'garbage' via x-forwarded-for alone never returns 'garbage'", () => {
      expect(resolveTrustedSourceIp(headersOf({ "x-forwarded-for": "garbage" }))).toBe("unknown");
    });

    it("'garbage' via x-real-ip alone never returns 'garbage'", () => {
      expect(resolveTrustedSourceIp(headersOf({ "x-real-ip": "garbage" }))).toBe("unknown");
    });
  });
});
