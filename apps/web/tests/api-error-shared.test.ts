import { describe, expect, it } from "vitest";
import { apiError, buildApiErrorBody, type ApiErrorCode } from "../app/api/v1/_shared/api-error";

/**
 * Milestone 2.5A. Pure unit coverage of the one shared envelope
 * constructor every /api/v1 route now goes through — no database needed.
 * `api-error-envelope.test.ts` proves real routes actually use this;
 * this file proves the constructor itself is correct in isolation.
 */

const ALL_CODES: ApiErrorCode[] = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL_ERROR",
];

describe("buildApiErrorBody()", () => {
  it.each(ALL_CODES)("produces the exact envelope shape for code %s", (code) => {
    const body = buildApiErrorBody(code, "a safe message");
    expect(body).toEqual({
      error: { code, message: "a safe message", request_id: expect.any(String) },
    });
  });

  it("generates a fresh, non-empty request_id on every call", () => {
    const a = buildApiErrorBody("VALIDATION_ERROR", "x");
    const b = buildApiErrorBody("VALIDATION_ERROR", "x");
    expect(a.error.request_id.length).toBeGreaterThan(0);
    expect(b.error.request_id.length).toBeGreaterThan(0);
    expect(a.error.request_id).not.toBe(b.error.request_id);
  });

  it("passes the message through verbatim — never rewrites or truncates it", () => {
    const message = "amount must be a positive number";
    expect(buildApiErrorBody("VALIDATION_ERROR", message).error.message).toBe(message);
  });
});

describe("apiError()", () => {
  it("returns a Response whose status matches the given status and whose body is the same envelope buildApiErrorBody produces", async () => {
    const res = apiError("NOT_FOUND", "Not found", 404);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "NOT_FOUND", message: "Not found", request_id: expect.any(String) },
    });
  });

  it("the HTTP status is caller-supplied and independent of the code — the envelope never overrides status", () => {
    // Same code, deliberately different (still realistic) statuses -- proves
    // apiError never hardcodes a status per code; the route remains
    // authoritative for status, per docs/04-API-Architecture.md §1.
    expect(apiError("VALIDATION_ERROR", "x", 400).status).toBe(400);
    expect(apiError("VALIDATION_ERROR", "x", 422).status).toBe(422);
  });
});
