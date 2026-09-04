import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeCursor, decodeCursor, resolveLimit, buildPage, DEFAULT_LIMIT, MAX_LIMIT } from "../src/pagination";
import { ValidationError } from "../src/errors";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a valid cursor", () => {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const encoded = encodeCursor({ createdAt, id });
    expect(decodeCursor(encoded)).toEqual({ createdAt, id });
  });

  it("is opaque base64url, not raw JSON", () => {
    const encoded = encodeCursor({ createdAt: new Date().toISOString(), id: randomUUID() });
    expect(() => JSON.parse(encoded)).toThrow();
  });

  it("rejects malformed base64url/JSON", () => {
    expect(() => decodeCursor("not-valid-{{{")).toThrow(ValidationError);
  });

  it("rejects a cursor with missing fields", () => {
    const encoded = Buffer.from(JSON.stringify({ createdAt: new Date().toISOString() }), "utf8").toString(
      "base64url",
    );
    expect(() => decodeCursor(encoded)).toThrow(ValidationError);
  });

  it("rejects a cursor with an invalid createdAt", () => {
    const encoded = Buffer.from(JSON.stringify({ createdAt: "not-a-date", id: randomUUID() }), "utf8").toString(
      "base64url",
    );
    expect(() => decodeCursor(encoded)).toThrow(ValidationError);
  });

  it("rejects a cursor with an invalid id (not a uuid)", () => {
    const encoded = Buffer.from(
      JSON.stringify({ createdAt: new Date().toISOString(), id: "not-a-uuid" }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(encoded)).toThrow(ValidationError);
  });

  it("rejects a cursor that decodes to a non-object (e.g. an array)", () => {
    const encoded = Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url");
    expect(() => decodeCursor(encoded)).toThrow(ValidationError);
  });
});

describe("resolveLimit", () => {
  it("defaults to 25 when undefined", () => {
    expect(resolveLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(DEFAULT_LIMIT).toBe(25);
  });

  it("accepts a valid limit within range", () => {
    expect(resolveLimit(10)).toBe(10);
    expect(resolveLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
  });

  it("rejects a limit over the maximum", () => {
    expect(MAX_LIMIT).toBe(100);
    expect(() => resolveLimit(101)).toThrow(ValidationError);
  });

  it("rejects zero, negative, and non-integer limits", () => {
    expect(() => resolveLimit(0)).toThrow(ValidationError);
    expect(() => resolveLimit(-5)).toThrow(ValidationError);
    expect(() => resolveLimit(1.5)).toThrow(ValidationError);
  });
});

describe("buildPage", () => {
  interface Row {
    created_at: string;
    created_at_cursor: string;
    id: string;
  }

  function makeRows(n: number): Row[] {
    return Array.from({ length: n }, (_, i) => {
      const createdAt = new Date(2026, 0, 1, 0, 0, i).toISOString();
      return { created_at: createdAt, created_at_cursor: createdAt, id: randomUUID() };
    });
  }

  it("returns nextCursor: null when there is no extra row (last page)", () => {
    const rows = makeRows(3);
    const page = buildPage(rows, 3, (r) => r.id);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it("strips the extra row and returns a non-null nextCursor when more exist", () => {
    const rows = makeRows(4); // limit=3, fetched limit+1=4
    const page = buildPage(rows, 3, (r) => r.id);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    const decoded = decodeCursor(page.nextCursor!);
    expect(decoded.id).toBe(rows[2]!.id);
    expect(decoded.createdAt).toBe(rows[2]!.created_at_cursor);
  });

  it("handles an empty result set", () => {
    const page = buildPage([], 25, (r: Row) => r.id);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  /**
   * M4.1 Phase 2 pagination-precision correction — direct helper-level
   * proof that the cursor is built from `created_at_cursor`, never from
   * `created_at`. Deliberately makes the two fields DIFFER (as they would
   * in production whenever `created_at` has been through node-postgres's
   * lossy `Date` parsing but `created_at_cursor` carries the full-
   * precision `::text` cast) — if buildPage ever regressed to reading
   * `created_at` again, this test would immediately fail.
   */
  it("builds the cursor from created_at_cursor, not from created_at, even when they differ", () => {
    // limit=1, two rows fetched (the standard limit+1 lookahead): row[0] is
    // the one actual page item (and therefore the one buildPage builds the
    // cursor from); row[1] is only the lookahead row used to detect
    // hasMore, never itself a cursor source.
    const pageItemId = randomUUID();
    const rows: Row[] = [
      {
        // Deliberately mismatched: created_at (lossy, as node-postgres's
        // default Date parser would produce) vs created_at_cursor (full
        // precision, as the `::text` cast produces) — a realistic
        // production pair for a row whose real timestamp carries
        // sub-millisecond digits.
        created_at: "2026-01-01T00:00:00.200Z",
        created_at_cursor: "2026-01-01 00:00:00.200999+00",
        id: pageItemId,
      },
      { created_at: "2026-01-01T00:00:00.000Z", created_at_cursor: "2026-01-01 00:00:00.000000+00", id: randomUUID() },
    ];
    const page = buildPage(rows, 1, (r) => r.id);
    expect(page.nextCursor).not.toBeNull();
    const decoded = decodeCursor(page.nextCursor!);
    expect(decoded.id).toBe(pageItemId);
    expect(decoded.createdAt).toBe("2026-01-01 00:00:00.200999+00");
    expect(decoded.createdAt).not.toBe("2026-01-01T00:00:00.200Z");
  });
});
