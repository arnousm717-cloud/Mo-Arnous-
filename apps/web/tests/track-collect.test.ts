import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@ai-revenue-os/database";
import { OPTIONS, POST } from "../app/track/collect/route";
import { handleCollectRequest } from "../app/track/collect/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1C-C adversarial coverage for POST/OPTIONS /track/collect.
 * Real Postgres throughout — no mocking of RLS, SECURITY DEFINER
 * behavior, or rate-limit atomicity/concurrency (those two properties are
 * exhaustively owned by packages/database's own 3.1C-A test suites and
 * apps/web/tests/track-rate-limit.test.ts; this file proves the ROUTE's
 * own orchestration/validation/response-normalization behavior on top of
 * them). Fail-closed DB-error-mapping is covered separately in
 * track-failure-policy.test.ts, which needs module mocking incompatible
 * with this file's own real-DB fixtures.
 */

const adminPool = getPool();

interface Fixture {
  orgAId: string;
  activeSiteAId: string;
  revokedSiteId: string;
}

async function seedFixture(): Promise<Fixture> {
  const client = await adminPool.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Track Collect Test Org', $1) returning id",
      [`track-collect-org-${randomUUID()}`],
    );
    const activeSite = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [org.rows[0]!.id, "Active Site"],
    );
    const revokedSite = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label, revoked_at) values ($1, $2, now()) returning id",
      [org.rows[0]!.id, "Revoked Site"],
    );
    return { orgAId: org.rows[0]!.id, activeSiteAId: activeSite.rows[0]!.id, revokedSiteId: revokedSite.rows[0]!.id };
  } finally {
    client.release();
  }
}

async function grantConsent(organizationId: string, anonymousId: string): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query(
      `insert into public.consent_records (organization_id, subject_type, subject_id, consent_type, status)
       values ($1, 'visitor', $2, 'cookie_tracking', 'granted')`,
      [organizationId, anonymousId],
    );
  } finally {
    client.release();
  }
}

async function eventCountFor(anonymousId: string): Promise<number> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ n: number }>(
      `select count(*)::int as n
       from public.visitor_events ve
       join public.visitor_sessions vs on vs.id = ve.session_id
       join public.website_visitors wv on wv.id = vs.visitor_id
       where wv.anonymous_id = $1`,
      [anonymousId],
    );
    return r.rows[0]!.n;
  } finally {
    client.release();
  }
}

function collectRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/track/collect", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.5", ...headers },
  });
}

function rawCollectRequest(rawBody: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/track/collect", {
    method: "POST",
    body: rawBody,
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.6", ...headers },
  });
}

function validEventBody(over: Record<string, unknown> = {}) {
  return {
    siteKey: randomUUID(),
    anonymousId: randomUUID(),
    anonymousSessionId: randomUUID(),
    eventType: "pageview",
    ...over,
  };
}

let fx: Fixture;

afterAll(async () => {
  // adminPool is getPool()'s own singleton, not a separate pool —
  // closePool() alone ends it; calling adminPool.end() too would end the
  // same underlying pool object twice.
  await closePool();
});

describe("OPTIONS /track/collect", () => {
  it("returns 204 with CORS headers and an empty body", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
  });
});

describe("POST /track/collect: happy path and non-oracle behavior", () => {
  it("a valid event with granted consent persists and returns 204", async () => {
    fx = await seedFixture();
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);
    const response = await handleCollectRequest(
      collectRequest({
        siteKey: fx.activeSiteAId,
        anonymousId,
        anonymousSessionId: randomUUID(),
        eventType: "pageview",
      }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await eventCountFor(anonymousId)).toBe(1);
  });

  it("no consent on file returns the identical 204 and persists nothing", async () => {
    const anonymousId = randomUUID();
    const response = await handleCollectRequest(
      collectRequest({ siteKey: fx.activeSiteAId, anonymousId, anonymousSessionId: randomUUID(), eventType: "pageview" }),
    );
    expect(response.status).toBe(204);
    expect(await eventCountFor(anonymousId)).toBe(0);
  });

  it("a revoked site returns the identical 204", async () => {
    const anonymousId = randomUUID();
    const response = await handleCollectRequest(
      collectRequest({
        siteKey: fx.revokedSiteId,
        anonymousId,
        anonymousSessionId: randomUUID(),
        eventType: "pageview",
      }),
    );
    expect(response.status).toBe(204);
  });

  it("a nonexistent site returns the identical 204", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody()));
    expect(response.status).toBe(204);
  });
});

describe("POST /track/collect: malformed/invalid input -> 400", () => {
  it("malformed JSON -> 400", async () => {
    const response = await handleCollectRequest(rawCollectRequest("{not json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("empty body -> 400", async () => {
    const response = await handleCollectRequest(rawCollectRequest(""));
    expect(response.status).toBe(400);
  });

  it("invalid siteKey UUID -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ siteKey: "not-a-uuid" })));
    expect(response.status).toBe(400);
  });

  it("invalid anonymousId UUID -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ anonymousId: "not-a-uuid" })));
    expect(response.status).toBe(400);
  });

  it("invalid anonymousSessionId UUID -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ anonymousSessionId: "nope" })));
    expect(response.status).toBe(400);
  });

  it("invalid eventType -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ eventType: "not_a_type" })));
    expect(response.status).toBe(400);
  });

  it("unknown top-level field -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ extra: "nope" })));
    expect(response.status).toBe(400);
  });

  it("url over 2048 characters -> 400", async () => {
    const response = await handleCollectRequest(
      collectRequest(validEventBody({ url: "https://x.test/" + "a".repeat(2048) })),
    );
    expect(response.status).toBe(400);
  });

  it("referrer over 2048 characters -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ referrer: "a".repeat(2049) })));
    expect(response.status).toBe(400);
  });

  it("landingPage over 2048 characters -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ landingPage: "a".repeat(2049) })));
    expect(response.status).toBe(400);
  });

  it("UTM fields over 255 characters -> 400", async () => {
    expect((await handleCollectRequest(collectRequest(validEventBody({ utmSource: "a".repeat(256) })))).status).toBe(
      400,
    );
    expect((await handleCollectRequest(collectRequest(validEventBody({ utmMedium: "a".repeat(256) })))).status).toBe(
      400,
    );
    expect(
      (await handleCollectRequest(collectRequest(validEventBody({ utmCampaign: "a".repeat(256) })))).status,
    ).toBe(400);
  });

  it("deviceType over 50 characters -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ deviceType: "a".repeat(51) })));
    expect(response.status).toBe(400);
  });

  it("metadata over 4096 serialized bytes -> 400", async () => {
    const response = await handleCollectRequest(
      collectRequest(validEventBody({ metadata: { big: "x".repeat(5000) } })),
    );
    expect(response.status).toBe(400);
  });

  it("metadata depth >3 -> 400", async () => {
    const response = await handleCollectRequest(
      collectRequest(validEventBody({ metadata: { a: { b: { c: { d: 1 } } } } })),
    );
    expect(response.status).toBe(400);
  });

  it("metadata exactly depth 3 -> 204, accepted", async () => {
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);
    const response = await handleCollectRequest(
      collectRequest({
        siteKey: fx.activeSiteAId,
        anonymousId,
        anonymousSessionId: randomUUID(),
        eventType: "pageview",
        metadata: { a: { b: { c: 1 } } },
      }),
    );
    expect(response.status).toBe(204);
    expect(await eventCountFor(anonymousId)).toBe(1);
  });

  it(">50 total metadata keys -> 400", async () => {
    const metadata: Record<string, number> = {};
    for (let i = 0; i < 51; i++) metadata[`k${i}`] = i;
    const response = await handleCollectRequest(collectRequest(validEventBody({ metadata })));
    expect(response.status).toBe(400);
  });

  it("exactly 50 metadata keys -> 204, accepted", async () => {
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);
    const metadata: Record<string, number> = {};
    for (let i = 0; i < 50; i++) metadata[`k${i}`] = i;
    const response = await handleCollectRequest(
      collectRequest({
        siteKey: fx.activeSiteAId,
        anonymousId,
        anonymousSessionId: randomUUID(),
        eventType: "pageview",
        metadata,
      }),
    );
    expect(response.status).toBe(204);
  });

  it("metadata key over 100 characters -> 400", async () => {
    const response = await handleCollectRequest(
      collectRequest(validEventBody({ metadata: { [`k${"x".repeat(100)}`]: 1 } })),
    );
    expect(response.status).toBe(400);
  });

  it("metadata string value over 500 characters -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ metadata: { s: "x".repeat(501) } })));
    expect(response.status).toBe(400);
  });

  it("metadata as a top-level array -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ metadata: [1, 2, 3] })));
    expect(response.status).toBe(400);
  });

  it("metadata as null -> 400", async () => {
    const response = await handleCollectRequest(collectRequest(validEventBody({ metadata: null })));
    expect(response.status).toBe(400);
  });
});

describe("POST /track/collect: UUID case normalization", () => {
  it("uppercase UUIDs are normalized and the event is still persisted correctly", async () => {
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);
    const response = await handleCollectRequest(
      collectRequest({
        siteKey: fx.activeSiteAId.toUpperCase(),
        anonymousId: anonymousId.toUpperCase(),
        anonymousSessionId: randomUUID().toUpperCase(),
        eventType: "pageview",
      }),
    );
    expect(response.status).toBe(204);
    expect(await eventCountFor(anonymousId)).toBe(1);
  });

  it("an uppercase site-key variant cannot occupy a separate site-aggregate rate-limit bucket from its lowercase form", async () => {
    const client = await adminPool.connect();
    let siteId: string;
    try {
      const org = await client.query<{ id: string }>(
        "insert into public.organizations (name, slug) values ('Case Norm Org', $1) returning id",
        [`case-norm-org-${randomUUID()}`],
      );
      const site = await client.query<{ id: string }>(
        "insert into public.tracking_sites (organization_id, label) values ($1, 'Case Norm Site') returning id",
        [org.rows[0]!.id],
      );
      siteId = site.rows[0]!.id;
    } finally {
      client.release();
    }

    // Two requests: one with the lowercase site key, one with an
    // uppercase variant of the identical UUID. If normalization worked,
    // both must hash to the SAME rate_limit_counters row (single bucket).
    const anon1 = randomUUID();
    const anon2 = randomUUID();
    await handleCollectRequest(
      collectRequest({ siteKey: siteId, anonymousId: anon1, anonymousSessionId: randomUUID(), eventType: "pageview" }),
    );
    await handleCollectRequest(
      collectRequest({
        siteKey: siteId.toUpperCase(),
        anonymousId: anon2,
        anonymousSessionId: randomUUID(),
        eventType: "pageview",
      }),
    );

    const bucketClient = await adminPool.connect();
    try {
      const { createHash } = await import("node:crypto");
      const expectedHash = createHash("sha256").update(`collect:site:${siteId.toLowerCase()}`, "utf8").digest("hex");
      const row = await bucketClient.query<{ count: number }>(
        "select count from public.rate_limit_counters where bucket_hash = $1",
        [expectedHash],
      );
      // Both calls landed in the single canonical-hash bucket — count 2,
      // not two separate rows.
      expect(row.rows[0]?.count).toBe(2);
    } finally {
      bucketClient.release();
    }
  });
});

describe("POST /track/collect: raw body byte limit", () => {
  it("a body exactly at the 16384-byte boundary passes the byte-size gate (never 413) — url's own 2048-char field cap means it correctly fails FIELD validation (400) instead, proving the byte check and field checks are independent gates", async () => {
    const base = validEventBody();
    const baselineBytes = Buffer.byteLength(JSON.stringify({ ...base, url: "" }), "utf8");
    const fillerLength = 16384 - baselineBytes;
    const raw = JSON.stringify({ ...base, url: "x".repeat(fillerLength) });
    expect(Buffer.byteLength(raw, "utf8")).toBe(16384);
    const response = await handleCollectRequest(rawCollectRequest(raw));
    expect(response.status).not.toBe(413);
    expect(response.status).toBe(400); // rejected for url length, not body size
  });

  it("a body over 16384 bytes -> 413", async () => {
    const filler = "x".repeat(20000);
    const raw = JSON.stringify({ ...validEventBody(), url: filler });
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(16384);
    const response = await handleCollectRequest(rawCollectRequest(raw));
    expect(response.status).toBe(413);
  });

  it("Content-Length declared over the limit -> 413 before parsing", async () => {
    const response = await handleCollectRequest(rawCollectRequest("{}", { "content-length": "999999" }));
    expect(response.status).toBe(413);
  });

  it("an understated Content-Length cannot bypass the actual-byte limit -> 413", async () => {
    const filler = "x".repeat(20000);
    const raw = JSON.stringify({ ...validEventBody(), url: filler });
    const response = await handleCollectRequest(rawCollectRequest(raw, { "content-length": "10" }));
    expect(response.status).toBe(413);
  });

  it("a missing Content-Length cannot bypass the actual-byte limit -> 413", async () => {
    const filler = "x".repeat(20000);
    const raw = JSON.stringify({ ...validEventBody(), url: filler });
    const request = new Request("https://example.test/track/collect", {
      method: "POST",
      body: raw,
      headers: { "x-real-ip": "203.0.113.7" },
    });
    const response = await handleCollectRequest(request);
    expect(response.status).toBe(413);
  });

  it("a malformed/negative Content-Length cannot bypass the actual-byte limit -> 413", async () => {
    const filler = "x".repeat(20000);
    const raw = JSON.stringify({ ...validEventBody(), url: filler });
    const response = await handleCollectRequest(rawCollectRequest(raw, { "content-length": "-1" }));
    expect(response.status).toBe(413);
  });
});

describe("POST /track/collect: rate limiting", () => {
  it("the per-anonymousId rate limit (60/min) rejects the 61st collect request with 429 and the exact headers", async () => {
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);
    let last: Response | undefined;
    for (let i = 0; i < 61; i++) {
      last = await handleCollectRequest(
        collectRequest(
          { siteKey: fx.activeSiteAId, anonymousId, anonymousSessionId: randomUUID(), eventType: "pageview" },
          { "x-real-ip": `198.51.100.${(i % 200) + 1}` },
        ),
      );
    }
    expect(last!.status).toBe(429);
    expect(await last!.json()).toEqual({ error: "rate_limited" });
    expect(last!.headers.get("Retry-After")).toBe("60");
    expect(last!.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(last!.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("the per-IP rate limit (600/min) is a real, distinct dimension from the anonymous limit — a shared IP with distinct anonymousIds still accumulates against the IP bucket", async () => {
    // A guaranteed-valid IPv4 octet (0-254) — the pre-fix version of this
    // test used a random hex slice, which was not guaranteed IPv4-shaped
    // and would now (post 3.1C-C acceptance-audit fix) validly fall back
    // to the "unknown" bucket instead of its own distinct one, breaking
    // this test's own premise.
    const sharedIp = `198.51.100.${Math.floor(Math.random() * 254) + 1}`;
    const anon1 = randomUUID();
    const anon2 = randomUUID();
    const r1 = await handleCollectRequest(
      collectRequest(
        { siteKey: fx.activeSiteAId, anonymousId: anon1, anonymousSessionId: randomUUID(), eventType: "pageview" },
        { "x-real-ip": sharedIp },
      ),
    );
    const r2 = await handleCollectRequest(
      collectRequest(
        { siteKey: fx.activeSiteAId, anonymousId: anon2, anonymousSessionId: randomUUID(), eventType: "pageview" },
        { "x-real-ip": sharedIp },
      ),
    );
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);

    const { createHash } = await import("node:crypto");
    const ipHash = createHash("sha256").update(`collect:ip:${sharedIp}`, "utf8").digest("hex");
    const client = await adminPool.connect();
    try {
      const row = await client.query<{ count: number }>(
        "select count from public.rate_limit_counters where bucket_hash = $1",
        [ipHash],
      );
      expect(row.rows[0]?.count).toBeGreaterThanOrEqual(2);
    } finally {
      client.release();
    }
  });

  it("the site aggregate rate limit uses the resolved trackingSiteId, verified by inspecting the persisted bucket_hash directly", async () => {
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);
    await handleCollectRequest(
      collectRequest({
        siteKey: fx.activeSiteAId,
        anonymousId,
        anonymousSessionId: randomUUID(),
        eventType: "pageview",
      }),
    );
    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256")
      .update(`collect:site:${fx.activeSiteAId.toLowerCase()}`, "utf8")
      .digest("hex");
    const client = await adminPool.connect();
    try {
      const row = await client.query("select 1 from public.rate_limit_counters where bucket_hash = $1", [
        expectedHash,
      ]);
      expect(row.rows.length).toBe(1);
    } finally {
      client.release();
    }
  });
});

describe("POST /track/collect: malformed source-IP header value maps to the fixed 'unknown' rate-limit bucket, not an attacker-chosen one (3.1C-C acceptance-audit fix)", () => {
  it("two different malformed x-real-ip values both increment the SAME persisted 'unknown' bucket — neither raw malformed value is ever stored", async () => {
    const anon1 = randomUUID();
    const anon2 = randomUUID();
    await grantConsent(fx.orgAId, anon1);
    await grantConsent(fx.orgAId, anon2);
    await handleCollectRequest(
      collectRequest(
        { siteKey: fx.activeSiteAId, anonymousId: anon1, anonymousSessionId: randomUUID(), eventType: "pageview" },
        { "x-real-ip": "totally-not-an-ip-address" },
      ),
    );
    await handleCollectRequest(
      collectRequest(
        { siteKey: fx.activeSiteAId, anonymousId: anon2, anonymousSessionId: randomUUID(), eventType: "pageview" },
        { "x-real-ip": "another-garbage-value" },
      ),
    );

    const { createHash } = await import("node:crypto");
    const unknownHash = createHash("sha256").update("collect:ip:unknown", "utf8").digest("hex");
    const garbage1Hash = createHash("sha256").update("collect:ip:totally-not-an-ip-address", "utf8").digest("hex");
    const garbage2Hash = createHash("sha256").update("collect:ip:another-garbage-value", "utf8").digest("hex");

    const client = await adminPool.connect();
    try {
      const unknownRow = await client.query<{ count: number }>(
        "select count from public.rate_limit_counters where bucket_hash = $1",
        [unknownHash],
      );
      expect(unknownRow.rows[0]?.count).toBeGreaterThanOrEqual(2);

      const garbage1Row = await client.query("select 1 from public.rate_limit_counters where bucket_hash = $1", [
        garbage1Hash,
      ]);
      const garbage2Row = await client.query("select 1 from public.rate_limit_counters where bucket_hash = $1", [
        garbage2Hash,
      ]);
      expect(garbage1Row.rows).toEqual([]);
      expect(garbage2Row.rows).toEqual([]);

      // Neither raw malformed string appears anywhere in the table at all.
      const rawScan = await client.query(
        "select 1 from public.rate_limit_counters where bucket_hash = any($1::text[])",
        [["totally-not-an-ip-address", "another-garbage-value"]],
      );
      expect(rawScan.rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it("two genuinely distinct valid IPv4 addresses still create two distinct persisted buckets — the fix collapses malformed IPs, not legitimate ones", async () => {
    const anon1 = randomUUID();
    const anon2 = randomUUID();
    await grantConsent(fx.orgAId, anon1);
    await grantConsent(fx.orgAId, anon2);
    // Random-but-valid octets (1-254) — not fixed literals — so this test
    // remains correct even if the suite is run repeatedly against the
    // same database without an intervening reset (mirrors the identical
    // Math.floor(Math.random() * 254) + 1 pattern already used elsewhere
    // in this file for the same reason).
    const ipA = `192.0.2.${Math.floor(Math.random() * 254) + 1}`;
    const ipB = `192.0.2.${Math.floor(Math.random() * 254) + 1}`;
    await handleCollectRequest(
      collectRequest(
        { siteKey: fx.activeSiteAId, anonymousId: anon1, anonymousSessionId: randomUUID(), eventType: "pageview" },
        { "x-real-ip": ipA },
      ),
    );
    await handleCollectRequest(
      collectRequest(
        { siteKey: fx.activeSiteAId, anonymousId: anon2, anonymousSessionId: randomUUID(), eventType: "pageview" },
        { "x-real-ip": ipB },
      ),
    );

    const { createHash } = await import("node:crypto");
    const hashA = createHash("sha256").update(`collect:ip:${ipA}`, "utf8").digest("hex");
    const hashB = createHash("sha256").update(`collect:ip:${ipB}`, "utf8").digest("hex");
    const client = await adminPool.connect();
    try {
      const rowA = await client.query<{ count: number }>(
        "select count from public.rate_limit_counters where bucket_hash = $1",
        [hashA],
      );
      const rowB = await client.query<{ count: number }>(
        "select count from public.rate_limit_counters where bucket_hash = $1",
        [hashB],
      );
      expect(rowA.rows[0]?.count).toBe(1);
      expect(rowB.rows[0]?.count).toBe(1);
    } finally {
      client.release();
    }
  });

  it("IPv6 case variants of the identical address still increment the SAME persisted bucket, re-proven after the fix by inspecting rate_limit_counters directly", async () => {
    const anon1 = randomUUID();
    const anon2 = randomUUID();
    await grantConsent(fx.orgAId, anon1);
    await grantConsent(fx.orgAId, anon2);
    // A random hex suffix keeps this address unique per test run (see the
    // IPv4 test above for why) while remaining a genuinely valid IPv6
    // address in both the uppercase and lowercase forms.
    const suffix = randomUUID().replace(/-/g, "").slice(0, 4);
    const upper = `2001:DB8::${suffix.toUpperCase()}`;
    const lower = `2001:db8::${suffix.toLowerCase()}`;
    await handleCollectRequest(
      collectRequest(
        { siteKey: fx.activeSiteAId, anonymousId: anon1, anonymousSessionId: randomUUID(), eventType: "pageview" },
        { "x-real-ip": upper },
      ),
    );
    await handleCollectRequest(
      collectRequest(
        { siteKey: fx.activeSiteAId, anonymousId: anon2, anonymousSessionId: randomUUID(), eventType: "pageview" },
        { "x-real-ip": lower },
      ),
    );
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(`collect:ip:${lower}`, "utf8").digest("hex");
    const client = await adminPool.connect();
    try {
      const row = await client.query<{ count: number }>(
        "select count from public.rate_limit_counters where bucket_hash = $1",
        [hash],
      );
      expect(row.rows[0]?.count).toBe(2);
    } finally {
      client.release();
    }
  });
});

describe("POST /track/collect: CORS on every response class", () => {
  it("204, 400, 413, and 429 all carry the CORS headers", async () => {
    const ok204 = await handleCollectRequest(
      rawCollectRequest(JSON.stringify(validEventBody({ siteKey: randomUUID() }))),
    );
    expect(ok204.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const bad400 = await handleCollectRequest(rawCollectRequest("{not json"));
    expect(bad400.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const big413 = await handleCollectRequest(rawCollectRequest("x".repeat(20000)));
    expect(big413.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("POST /track/collect: logging discipline", () => {
  it("a full request/response cycle through the real logged route (POST from route.ts, wrapped by withRequestLogging) never writes the raw siteKey/anonymousId/anonymousSessionId to stdout", async () => {
    const logSpy = { calls: [] as string[] };
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logSpy.calls.push(args.map(String).join(" "));
    };
    let anonymousId: string;
    let sessionId: string;
    try {
      anonymousId = randomUUID();
      sessionId = randomUUID();
      await grantConsent(fx.orgAId, anonymousId);
      await POST(
        collectRequest({
          siteKey: fx.activeSiteAId,
          anonymousId,
          anonymousSessionId: sessionId,
          eventType: "pageview",
        }),
      );
    } finally {
      console.log = originalLog;
    }
    expect(logSpy.calls.length).toBeGreaterThan(0); // proves logging actually ran
    const combined = logSpy.calls.join("\n");
    expect(combined).not.toContain(fx.activeSiteAId);
    expect(combined).not.toContain(anonymousId!);
    expect(combined).not.toContain(sessionId!);
  });
});
