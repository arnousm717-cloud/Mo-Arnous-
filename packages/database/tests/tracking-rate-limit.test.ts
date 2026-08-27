import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1C-A coverage for check_tracking_rate_limit() (20260820110200)
 * and its backing rate_limit_counters table/RLS (20260820110000/110100).
 * Real Postgres, real role simulation, real concurrent connections — never
 * mocked, mirroring tracking-site-resolver.test.ts /
 * visitor-cookie-tracking-consent.test.ts's own style.
 *
 * Unlike those two read-only functions, this one WRITES, and several of
 * these tests need to inspect the actual persisted row state afterward —
 * requiring a real commit (the rollback-based withTenantContext helper in
 * ./helpers would make every concurrent caller wait forever on a lock held
 * by a transaction that never finishes; see asAuthenticatedCommitted below).
 * afterEach wipes the whole table: nothing else in this milestone's scope
 * writes to it, and this file's own tests run sequentially (vitest's
 * default within a single file), so a full wipe between tests is safe and
 * keeps every test's fixture state exactly isolated.
 */

/** Runs as `authenticated` (the only role with EXECUTE) and genuinely
 * commits — required so a) a second concurrent caller's row-lock wait
 * actually resolves against a real committed row, and b) the persisted
 * counter row can be inspected afterward via a separate seedAsAdmin call. */
async function asAuthenticatedCommitted<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Runs as the raw `anon` Postgres role directly, always rolled back —
 * mirrors every other test file's own asAnon helper. */
async function asAnon<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    await client.query("set local role anon");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

async function checkRateLimit(bucketHash: string, windowSeconds: number, limit: number): Promise<boolean> {
  return asAuthenticatedCommitted(async (client) => {
    const r = await client.query<{ check_tracking_rate_limit: boolean }>(
      "select public.check_tracking_rate_limit($1, $2, $3) as check_tracking_rate_limit",
      [bucketHash, windowSeconds, limit],
    );
    return r.rows[0]!.check_tracking_rate_limit;
  });
}

/** Mirrors check_tracking_rate_limit()'s own window formula exactly
 * (to_timestamp(floor(extract(epoch from now())/p_window_seconds)*p_window_seconds)),
 * so fixtures can be seeded into a specific, predictable window without
 * ever waiting on real wall-clock time to cross a boundary. */
function windowStartFor(windowSeconds: number, atMs = Date.now()): Date {
  const epochSeconds = Math.floor(atMs / 1000);
  const windowStartEpoch = Math.floor(epochSeconds / windowSeconds) * windowSeconds;
  return new Date(windowStartEpoch * 1000);
}

async function seedCounterRow(bucketHash: string, windowStart: Date, count: number): Promise<void> {
  await seedAsAdmin(async (client) => {
    await client.query(
      "insert into public.rate_limit_counters (bucket_hash, window_start, count) values ($1, $2, $3)",
      [bucketHash, windowStart.toISOString(), count],
    );
  });
}

async function getCounterRow(bucketHash: string, windowStart: Date): Promise<{ count: number } | undefined> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ count: number }>(
      "select count from public.rate_limit_counters where bucket_hash = $1 and window_start = $2",
      [bucketHash, windowStart.toISOString()],
    );
    return r.rows[0];
  });
}

async function countRowsForBucket(bucketHash: string): Promise<number> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ n: number }>(
      "select count(*)::int as n from public.rate_limit_counters where bucket_hash = $1",
      [bucketHash],
    );
    return r.rows[0]!.n;
  });
}

beforeAll(async () => {
  await seedAsAdmin(async (client) => {
    await client.query("delete from public.rate_limit_counters where true");
  });
});

afterEach(async () => {
  await seedAsAdmin(async (client) => {
    await client.query("delete from public.rate_limit_counters where true");
  });
});

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("check_tracking_rate_limit: functional behavior", () => {
  it("1. first call for a fresh bucket/window returns true and persists count=1", async () => {
    const bucket = randomUUID();
    const result = await checkRateLimit(bucket, 3600, 100);
    expect(result).toBe(true);
    const row = await getCounterRow(bucket, windowStartFor(3600));
    expect(row?.count).toBe(1);
  });

  it("2. sequential calls under the limit all return true and count increments by exactly 1 each time", async () => {
    const bucket = randomUUID();
    for (let i = 1; i <= 5; i++) {
      const result = await checkRateLimit(bucket, 3600, 100);
      expect(result).toBe(true);
      const row = await getCounterRow(bucket, windowStartFor(3600));
      expect(row?.count).toBe(i);
    }
  });

  it("3. the call that brings count exactly to p_limit returns true (boundary: <= limit is allowed)", async () => {
    const bucket = randomUUID();
    let last = false;
    for (let i = 1; i <= 3; i++) {
      last = await checkRateLimit(bucket, 3600, 3);
    }
    expect(last).toBe(true);
    const row = await getCounterRow(bucket, windowStartFor(3600));
    expect(row?.count).toBe(3);
  });

  it("4. the next call beyond p_limit returns false (boundary: count > limit is rejected)", async () => {
    const bucket = randomUUID();
    for (let i = 1; i <= 3; i++) {
      await checkRateLimit(bucket, 3600, 3);
    }
    const fourth = await checkRateLimit(bucket, 3600, 3);
    expect(fourth).toBe(false);
    const row = await getCounterRow(bucket, windowStartFor(3600));
    expect(row?.count).toBe(4);
  });

  it("5. two distinct bucket_hash values under the same window are fully independent — no cross-bucket bleed", async () => {
    const bucketA = randomUUID();
    const bucketB = randomUUID();
    for (let i = 1; i <= 3; i++) {
      await checkRateLimit(bucketA, 3600, 3);
    }
    // bucketB has never been called — its own first call must start at 1,
    // not inherit any part of bucketA's count.
    const result = await checkRateLimit(bucketB, 3600, 1);
    expect(result).toBe(true);
    const rowB = await getCounterRow(bucketB, windowStartFor(3600));
    expect(rowB?.count).toBe(1);
  });

  it("6. distinct windows for the SAME bucket_hash are independent — a stale window's count never carries into the current window", async () => {
    const bucket = randomUUID();
    const windowSeconds = 500;
    const currentStart = windowStartFor(windowSeconds);
    const previousStart = new Date(currentStart.getTime() - windowSeconds * 1000);
    await seedCounterRow(bucket, previousStart, 9999);

    const result = await checkRateLimit(bucket, windowSeconds, 1);
    expect(result).toBe(true);

    const currentRow = await getCounterRow(bucket, currentStart);
    expect(currentRow?.count).toBe(1);
  });

  it("7. p_limit = 0 raises an exception", async () => {
    await expect(checkRateLimit(randomUUID(), 3600, 0)).rejects.toThrow(/p_limit must be positive/i);
  });

  it("8. p_limit negative raises an exception", async () => {
    await expect(checkRateLimit(randomUUID(), 3600, -1)).rejects.toThrow(/p_limit must be positive/i);
  });

  it("9. p_window_seconds = 0 raises an exception", async () => {
    await expect(checkRateLimit(randomUUID(), 0, 10)).rejects.toThrow(/p_window_seconds must be positive/i);
  });

  it("10. p_window_seconds negative raises an exception", async () => {
    await expect(checkRateLimit(randomUUID(), -60, 10)).rejects.toThrow(/p_window_seconds must be positive/i);
  });

  it("10a. p_window_seconds = 86400 (exactly the Tier 2 retention horizon) is accepted — the upper boundary is inclusive", async () => {
    await expect(checkRateLimit(randomUUID(), 86400, 10)).resolves.toBe(true);
  });

  it("10b. p_window_seconds = 86401 (one second past the retention horizon) raises an exception", async () => {
    await expect(checkRateLimit(randomUUID(), 86401, 10)).rejects.toThrow(
      /p_window_seconds must not exceed 86400/i,
    );
  });

  it("10c. a very large p_window_seconds value raises an exception, not just a value barely over the boundary", async () => {
    await expect(checkRateLimit(randomUUID(), 31536000 /* 1 year */, 10)).rejects.toThrow(
      /p_window_seconds must not exceed 86400/i,
    );
  });

  it("10d. the stored function definition contains the upper-bound guard — structural presence check, mirroring the Tier 2 structural check below", async () => {
    const def = await seedAsAdmin(async (client) => {
      const r = await client.query<{ def: string }>(
        `select pg_get_functiondef(p.oid) as def from pg_proc p where p.proname = 'check_tracking_rate_limit'`,
      );
      return r.rows[0]!.def;
    });
    expect(def).toContain("p_window_seconds > 86400");
  });
});

describe("check_tracking_rate_limit: real concurrency (Promise.all over independently committed connections)", () => {
  it("11. 25 genuinely concurrent calls to the same bucket/window under a high limit produce zero lost increments — final count is exactly 25, all 25 return true", async () => {
    const bucket = randomUUID();
    const calls = Array.from({ length: 25 }, () => checkRateLimit(bucket, 3600, 1000));
    const results = await Promise.all(calls);
    expect(results.every((r) => r === true)).toBe(true);
    const row = await getCounterRow(bucket, windowStartFor(3600));
    expect(row?.count).toBe(25);
  });

  it("12. 20 genuinely concurrent calls with limit=10 yield exactly 10 true / 10 false, and the final persisted count is exactly 20 — proving the atomic INSERT...ON CONFLICT...RETURNING correctly serializes concurrent writers via row-level locking, not merely usually-correct", async () => {
    const bucket = randomUUID();
    const calls = Array.from({ length: 20 }, () => checkRateLimit(bucket, 3600, 10));
    const results = await Promise.all(calls);
    const trueCount = results.filter((r) => r === true).length;
    const falseCount = results.filter((r) => r === false).length;
    expect(trueCount).toBe(10);
    expect(falseCount).toBe(10);
    const row = await getCounterRow(bucket, windowStartFor(3600));
    expect(row?.count).toBe(20);
  });
});

describe("check_tracking_rate_limit: retention / cleanup", () => {
  it("13. Tier 1 per-bucket cleanup deletes this bucket's own stale (earlier-window) row as part of the same call", async () => {
    const bucket = randomUUID();
    const windowSeconds = 500;
    const currentStart = windowStartFor(windowSeconds);
    const previousStart = new Date(currentStart.getTime() - windowSeconds * 1000);
    await seedCounterRow(bucket, previousStart, 42);

    await checkRateLimit(bucket, windowSeconds, 1);

    const staleRow = await getCounterRow(bucket, previousStart);
    expect(staleRow).toBeUndefined();
    // Only the current window's own row should remain for this bucket.
    expect(await countRowsForBucket(bucket)).toBe(1);
  });

  it("14. Tier 1 cleanup never touches a DIFFERENT bucket's stale row", async () => {
    const bucketUnderTest = randomUUID();
    const otherBucket = randomUUID();
    const windowSeconds = 500;
    const currentStart = windowStartFor(windowSeconds);
    const previousStart = new Date(currentStart.getTime() - windowSeconds * 1000);
    await seedCounterRow(otherBucket, previousStart, 7);

    await checkRateLimit(bucketUnderTest, windowSeconds, 1);

    const otherStaleRow = await getCounterRow(otherBucket, previousStart);
    expect(otherStaleRow?.count).toBe(7);
  });

  it("15. the >24h-stale predicate matches a row older than 24 hours and does not match one just under 24 hours — deterministic predicate check, no dependency on the function's own random trigger firing", async () => {
    const staleBucket = randomUUID();
    const freshBucket = randomUUID();
    const staleWindowStart = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const freshWindowStart = new Date(Date.now() - 23 * 60 * 60 * 1000 - 59 * 60 * 1000);
    await seedCounterRow(staleBucket, staleWindowStart, 1);
    await seedCounterRow(freshBucket, freshWindowStart, 1);

    const matches = await seedAsAdmin(async (client) => {
      const r = await client.query<{ bucket_hash: string }>(
        `select bucket_hash from public.rate_limit_counters
         where window_start < now() - interval '24 hours'
           and bucket_hash in ($1, $2)`,
        [staleBucket, freshBucket],
      );
      return r.rows.map((row) => row.bucket_hash);
    });
    expect(matches).toEqual([staleBucket]);
  });

  it("16. rate_limit_counters_window_start_idx exists on (window_start) — required for the Tier 2 predicate to be servable without a full scan", async () => {
    const indexes = await seedAsAdmin(async (client) => {
      const r = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where tablename = 'rate_limit_counters' and indexname = 'rate_limit_counters_window_start_idx'`,
      );
      return r.rows;
    });
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.indexdef).toContain("(window_start)");
  });

  it("17. the stored function definition contains the probabilistic Tier 2 trigger, its 24-hour threshold, and its 1000-row cap — structural presence check, never dependent on random() actually firing in this test run", async () => {
    const def = await seedAsAdmin(async (client) => {
      const r = await client.query<{ def: string }>(
        `select pg_get_functiondef(p.oid) as def from pg_proc p where p.proname = 'check_tracking_rate_limit'`,
      );
      return r.rows[0]!.def;
    });
    expect(def).toContain("random() < 0.001");
    expect(def).toContain("interval '24 hours'");
    expect(def).toMatch(/limit 1000/i);
  });
});

describe("check_tracking_rate_limit: privilege boundary", () => {
  it("18. PUBLIC/anon has zero EXECUTE (inherited from the M1.7-era default-privilege hardening, no explicit revoke needed)", async () => {
    const granted = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        `select has_function_privilege('anon', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = 'check_tracking_rate_limit'`,
      );
      return r.rows[0]?.x;
    });
    expect(granted).toBe(false);
  });

  it("19. anon cannot execute — rejected at the grant level, before any function logic runs", async () => {
    await expect(
      asAnon(async (client) => {
        await client.query("select public.check_tracking_rate_limit($1, $2, $3)", [randomUUID(), 60, 10]);
      }),
    ).rejects.toThrow(/permission denied for function check_tracking_rate_limit/i);
  });

  it("20. authenticated has EXECUTE", async () => {
    const granted = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = 'check_tracking_rate_limit'`,
      );
      return r.rows[0]?.x;
    });
    expect(granted).toBe(true);
  });

  it("21. authenticated can actually call it without a permission error", async () => {
    await expect(checkRateLimit(randomUUID(), 3600, 10)).resolves.not.toThrow();
  });

  it("22. service_role has no explicit EXECUTE grant on this function — access is not silently broadened beyond the intended authenticated-only matrix", async () => {
    const granted = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        `select has_function_privilege('service_role', p.oid, 'EXECUTE') as x
         from pg_proc p where p.proname = 'check_tracking_rate_limit'`,
      );
      return r.rows[0]?.x;
    });
    expect(granted).toBe(false);

    const acl = await seedAsAdmin(async (client) => {
      const r = await client.query<{ proacl: string | null }>(
        `select proacl::text as proacl from pg_proc where proname = 'check_tracking_rate_limit'`,
      );
      return r.rows[0]?.proacl ?? "";
    });
    expect(acl).not.toContain("service_role=X");
  });
});

describe("rate_limit_counters: direct table access is fully blocked regardless of function-level grants", () => {
  it("23. authenticated cannot SELECT the table directly", async () => {
    const has = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        "select has_table_privilege('authenticated', 'public.rate_limit_counters', 'SELECT') as x",
      );
      return r.rows[0]!.x;
    });
    expect(has).toBe(false);
  });

  it("24. authenticated cannot INSERT the table directly", async () => {
    const has = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        "select has_table_privilege('authenticated', 'public.rate_limit_counters', 'INSERT') as x",
      );
      return r.rows[0]!.x;
    });
    expect(has).toBe(false);
  });

  it("25. authenticated cannot UPDATE the table directly", async () => {
    const has = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        "select has_table_privilege('authenticated', 'public.rate_limit_counters', 'UPDATE') as x",
      );
      return r.rows[0]!.x;
    });
    expect(has).toBe(false);
  });

  it("26. authenticated cannot DELETE the table directly", async () => {
    const has = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        "select has_table_privilege('authenticated', 'public.rate_limit_counters', 'DELETE') as x",
      );
      return r.rows[0]!.x;
    });
    expect(has).toBe(false);
  });

  it("27. anon cannot SELECT the table directly", async () => {
    const has = await seedAsAdmin(async (client) => {
      const r = await client.query<{ x: boolean }>(
        "select has_table_privilege('anon', 'public.rate_limit_counters', 'SELECT') as x",
      );
      return r.rows[0]!.x;
    });
    expect(has).toBe(false);
  });

  it("28. RLS is enabled on the table and zero policies are defined on it — two independent, stacked blocks, not one", async () => {
    const rls = await seedAsAdmin(async (client) => {
      const r = await client.query<{ relrowsecurity: boolean }>(
        "select relrowsecurity from pg_class where relname = 'rate_limit_counters'",
      );
      return r.rows[0]!.relrowsecurity;
    });
    expect(rls).toBe(true);

    const policies = await seedAsAdmin(async (client) => {
      const r = await client.query("select policyname from pg_policies where tablename = 'rate_limit_counters'");
      return r.rows;
    });
    expect(policies).toEqual([]);
  });
});
