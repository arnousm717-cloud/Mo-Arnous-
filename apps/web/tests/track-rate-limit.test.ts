import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@ai-revenue-os/database";
import {
  checkTrackingRateLimit,
  getRateLimitConfig,
  hashTrackingRateLimitBucket,
} from "../app/track/_shared/rate-limit";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1C-B coverage for the tracking rate-limit application
 * wrapper — a thin caller of the already-proven
 * public.check_tracking_rate_limit() (20260820110200), so this file does
 * not re-prove that function's own boundary/retention/ACL behavior (fully
 * owned by packages/database/tests/tracking-rate-limit.test.ts's 28
 * tests) — only that the wrapper itself hashes correctly, maps
 * configuration correctly, and doesn't introduce its own race or
 * error-swallowing bug.
 */

const adminPool = getPool();

async function bucketRowFor(bucketHash: string): Promise<{ bucket_hash: string; count: number } | undefined> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ bucket_hash: string; count: number }>(
      "select bucket_hash, count from public.rate_limit_counters where bucket_hash = $1",
      [bucketHash],
    );
    return r.rows[0];
  } finally {
    client.release();
  }
}

async function anyRowContainingRawValue(rawValue: string): Promise<boolean> {
  const client = await adminPool.connect();
  try {
    // rate_limit_counters.bucket_hash is a fixed-width hex digest — a raw
    // identifier (a UUID, an IP-shaped string) could never equal it, but
    // this proves it directly against the live table rather than assuming.
    const r = await client.query("select 1 from public.rate_limit_counters where bucket_hash = $1", [rawValue]);
    return r.rows.length > 0;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await closePool();
});

describe("hashTrackingRateLimitBucket: hashing contract", () => {
  it("1. deterministic — identical (surface, dimension, identifier) always produces the identical hash", () => {
    const id = randomUUID();
    const a = hashTrackingRateLimitBucket("collect", "anon", id);
    const b = hashTrackingRateLimitBucket("collect", "anon", id);
    expect(a).toBe(b);
  });

  it("2. lowercase SHA-256 hex, exactly 64 characters", () => {
    const hash = hashTrackingRateLimitBucket("collect", "anon", randomUUID());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the exact sha256Hex algorithm (createHash('sha256').update(input, 'utf8').digest('hex')) against the canonical '<surface>:<dimension>:<identifier>' input", () => {
    const identifier = randomUUID();
    const expected = createHash("sha256").update(`collect:anon:${identifier}`, "utf8").digest("hex");
    expect(hashTrackingRateLimitBucket("collect", "anon", identifier)).toBe(expected);
  });

  it("3a. namespace separation: collect:anon:X != consent:anon:X for the identical identifier", () => {
    const id = randomUUID();
    expect(hashTrackingRateLimitBucket("collect", "anon", id)).not.toBe(hashTrackingRateLimitBucket("consent", "anon", id));
  });

  it("3b. namespace separation: collect:anon:X != collect:ip:X for the identical identifier", () => {
    const id = randomUUID();
    expect(hashTrackingRateLimitBucket("collect", "anon", id)).not.toBe(hashTrackingRateLimitBucket("collect", "ip", id));
  });

  it("3c. namespace separation: the site dimension differs from both anon and IP for the identical identifier", () => {
    const id = randomUUID();
    const site = hashTrackingRateLimitBucket("collect", "site", id);
    expect(site).not.toBe(hashTrackingRateLimitBucket("collect", "anon", id));
    expect(site).not.toBe(hashTrackingRateLimitBucket("collect", "ip", id));
  });

  it("a different identifier under the identical (surface, dimension) produces a different hash", () => {
    const a = hashTrackingRateLimitBucket("collect", "anon", randomUUID());
    const b = hashTrackingRateLimitBucket("collect", "anon", randomUUID());
    expect(a).not.toBe(b);
  });

  it("the raw identifier never appears as a substring of its own hash", () => {
    const id = randomUUID();
    const hash = hashTrackingRateLimitBucket("collect", "anon", id);
    expect(hash).not.toContain(id);
  });
});

describe("getRateLimitConfig: approved limit configuration mapping", () => {
  it("4. window is always exactly 60 for every (surface, dimension) pair", () => {
    const pairs: Array<["collect" | "consent", "anon" | "ip" | "site"]> = [
      ["collect", "anon"],
      ["collect", "ip"],
      ["collect", "site"],
      ["consent", "anon"],
      ["consent", "ip"],
      ["consent", "site"],
    ];
    for (const [surface, dimension] of pairs) {
      expect(getRateLimitConfig(surface, dimension).windowSeconds).toBe(60);
    }
  });

  it("5. collect:anon maps to limit 60", () => {
    expect(getRateLimitConfig("collect", "anon").limit).toBe(60);
  });

  it("6. collect:ip maps to limit 600", () => {
    expect(getRateLimitConfig("collect", "ip").limit).toBe(600);
  });

  it("7. collect:site maps to limit 6000", () => {
    expect(getRateLimitConfig("collect", "site").limit).toBe(6000);
  });

  it("8. consent:anon maps to limit 10", () => {
    expect(getRateLimitConfig("consent", "anon").limit).toBe(10);
  });

  it("9. consent:ip maps to limit 100", () => {
    expect(getRateLimitConfig("consent", "ip").limit).toBe(100);
  });

  it("10. consent:site maps to limit 1000", () => {
    expect(getRateLimitConfig("consent", "site").limit).toBe(1000);
  });
});

describe("checkTrackingRateLimit: real DB threshold behavior (end-to-end wiring proof, not a re-proof of check_tracking_rate_limit()'s own boundary math)", () => {
  it("11. exact configured threshold surfaces correctly — 10 calls at consent:anon (limit 10) all return true", async () => {
    const id = randomUUID();
    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(await checkTrackingRateLimit("consent", "anon", id));
    }
    expect(results.every((r) => r === true)).toBe(true);
  });

  it("12. threshold + 1 returns false — the 11th call at consent:anon (limit 10) is rejected", async () => {
    const id = randomUUID();
    for (let i = 0; i < 10; i++) {
      await checkTrackingRateLimit("consent", "anon", id);
    }
    const eleventh = await checkTrackingRateLimit("consent", "anon", id);
    expect(eleventh).toBe(false);
  });

  it("13. bucket isolation: a different identifier under the same (surface, dimension) starts fresh, unaffected by another identifier's exhausted limit", async () => {
    const exhaustedId = randomUUID();
    for (let i = 0; i < 10; i++) {
      await checkTrackingRateLimit("consent", "anon", exhaustedId);
    }
    expect(await checkTrackingRateLimit("consent", "anon", exhaustedId)).toBe(false);

    const freshId = randomUUID();
    expect(await checkTrackingRateLimit("consent", "anon", freshId)).toBe(true);
  });

  it("13b. bucket isolation: the identical identifier under a different (surface, dimension) is a completely independent bucket", async () => {
    const id = randomUUID();
    for (let i = 0; i < 10; i++) {
      await checkTrackingRateLimit("consent", "anon", id);
    }
    expect(await checkTrackingRateLimit("consent", "anon", id)).toBe(false);
    // Same raw identifier, but consent:ip has its own limit (100) and its
    // own bucket_hash (different namespace) — must not inherit the
    // exhausted consent:anon bucket's state.
    expect(await checkTrackingRateLimit("consent", "ip", id)).toBe(true);
  });
});

describe("checkTrackingRateLimit: raw identifiers never reach rate_limit_counters", () => {
  it("14. only the hash is persisted — the raw identifier itself is never a stored bucket_hash value", async () => {
    const id = randomUUID();
    await checkTrackingRateLimit("collect", "anon", id);
    const expectedHash = hashTrackingRateLimitBucket("collect", "anon", id);
    const row = await bucketRowFor(expectedHash);
    expect(row).toBeDefined();
    expect(await anyRowContainingRawValue(id)).toBe(false);
  });
});

describe("checkTrackingRateLimit: error propagation and concurrency", () => {
  it("15. DB errors are never swallowed — the wrapper contains no try/catch around the database call (structural proof, not a mocked failure)", () => {
    const source = readFileSync(path.join(__dirname, "../app/track/_shared/rate-limit.ts"), "utf8");
    // Isolate checkTrackingRateLimit's own function body and confirm no
    // exception-swallowing construct wraps its DB call — mirrors this
    // package's own structural-proof style (idempotency.ts's docstring
    // guarantees are proven the same way elsewhere in this test suite).
    const fnStart = source.indexOf("export async function checkTrackingRateLimit");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart);
    expect(fnBody).not.toContain("catch");
  });

  it("16. genuine concurrent calls do not introduce a wrapper-level race — 15 concurrent calls at consent:anon (limit 10) split exactly 10 true / 5 false, with zero lost increments", async () => {
    const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 15 }, () => checkTrackingRateLimit("consent", "anon", id)));
    const trueCount = results.filter((r) => r === true).length;
    const falseCount = results.filter((r) => r === false).length;
    expect(trueCount).toBe(10);
    expect(falseCount).toBe(5);

    const expectedHash = hashTrackingRateLimitBucket("consent", "anon", id);
    const row = await bucketRowFor(expectedHash);
    expect(row?.count).toBe(15);
  });
});
