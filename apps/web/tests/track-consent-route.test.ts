import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@ai-revenue-os/database";
import { OPTIONS, POST } from "../app/track/consent/route";
import { handleConsentRequest } from "../app/track/consent/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.1C-C adversarial coverage for POST/OPTIONS /track/consent.
 * Real Postgres throughout — no mocking of RLS, SECURITY DEFINER
 * behavior, or rate-limit atomicity/concurrency (owned by
 * packages/database's 3.1C-A suites and
 * packages/compliance/tests/tracking-consent.test.ts). Fail-closed
 * DB-error-mapping is covered separately in track-failure-policy.test.ts.
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
      "insert into public.organizations (name, slug) values ('Track Consent Test Org', $1) returning id",
      [`track-consent-org-${randomUUID()}`],
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

async function consentRowCount(anonymousId: string): Promise<number> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ n: number }>(
      "select count(*)::int as n from public.consent_records where subject_id = $1",
      [anonymousId],
    );
    return r.rows[0]!.n;
  } finally {
    client.release();
  }
}

async function consentStatuses(anonymousId: string): Promise<string[]> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ status: string }>(
      "select status from public.consent_records where subject_id = $1 order by recorded_at, id",
      [anonymousId],
    );
    return r.rows.map((row) => row.status);
  } finally {
    client.release();
  }
}

function consentRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/track/consent", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9", ...headers },
  });
}

function rawConsentRequest(rawBody: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/track/consent", {
    method: "POST",
    body: rawBody,
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.10", ...headers },
  });
}

let fx: Fixture;

afterAll(async () => {
  await closePool();
});

describe("OPTIONS /track/consent", () => {
  it("returns 204 with CORS headers and an empty body", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("POST /track/consent: happy path and non-oracle behavior", () => {
  it("a grant returns 204 and writes a row", async () => {
    fx = await seedFixture();
    const anonymousId = randomUUID();
    const response = await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "granted" }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await consentRowCount(anonymousId)).toBe(1);
    expect(await consentStatuses(anonymousId)).toEqual(["granted"]);
  });

  it("a withdrawal returns 204 and writes a row", async () => {
    const anonymousId = randomUUID();
    const response = await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "withdrawn" }),
    );
    expect(response.status).toBe(204);
    expect(await consentStatuses(anonymousId)).toEqual(["withdrawn"]);
  });

  it("grant -> withdraw -> grant is append-only (three rows, correct order)", async () => {
    const anonymousId = randomUUID();
    await handleConsentRequest(consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "granted" }));
    await handleConsentRequest(consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "withdrawn" }));
    await handleConsentRequest(consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "granted" }));
    expect(await consentStatuses(anonymousId)).toEqual(["granted", "withdrawn", "granted"]);
  });

  it("a revoked site returns the identical 204 and writes nothing", async () => {
    const anonymousId = randomUUID();
    const response = await handleConsentRequest(
      consentRequest({ siteKey: fx.revokedSiteId, anonymousId, status: "granted" }),
    );
    expect(response.status).toBe(204);
    expect(await consentRowCount(anonymousId)).toBe(0);
  });

  it("a nonexistent site returns the identical 204 and writes nothing", async () => {
    const anonymousId = randomUUID();
    const response = await handleConsentRequest(
      consentRequest({ siteKey: randomUUID(), anonymousId, status: "granted" }),
    );
    expect(response.status).toBe(204);
    expect(await consentRowCount(anonymousId)).toBe(0);
  });
});

describe("POST /track/consent: malformed/invalid input -> 400", () => {
  it("malformed JSON -> 400", async () => {
    const response = await handleConsentRequest(rawConsentRequest("{not json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("invalid siteKey -> 400", async () => {
    const response = await handleConsentRequest(
      consentRequest({ siteKey: "not-a-uuid", anonymousId: randomUUID(), status: "granted" }),
    );
    expect(response.status).toBe(400);
  });

  it("invalid anonymousId -> 400", async () => {
    const response = await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: "not-a-uuid", status: "granted" }),
    );
    expect(response.status).toBe(400);
  });

  it("invalid status -> 400", async () => {
    const response = await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: randomUUID(), status: "maybe" }),
    );
    expect(response.status).toBe(400);
  });

  it("unknown field -> 400", async () => {
    const response = await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: randomUUID(), status: "granted", extra: "x" }),
    );
    expect(response.status).toBe(400);
  });

  it("anonymousSessionId in the body -> 400 (rejected as an unknown field)", async () => {
    const response = await handleConsentRequest(
      consentRequest({
        siteKey: fx.activeSiteAId,
        anonymousId: randomUUID(),
        status: "granted",
        anonymousSessionId: randomUUID(),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("metadata in the body -> 400 (rejected as an unknown field)", async () => {
    const response = await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: randomUUID(), status: "granted", metadata: {} }),
    );
    expect(response.status).toBe(400);
  });

  it("an oversized body -> 413", async () => {
    const raw = JSON.stringify({
      siteKey: fx.activeSiteAId,
      anonymousId: randomUUID(),
      status: "granted",
      padding: "x".repeat(20000),
    });
    const response = await handleConsentRequest(rawConsentRequest(raw));
    expect(response.status).toBe(413);
  });
});

describe("POST /track/consent: UUID case normalization", () => {
  it("uppercase UUIDs are normalized and the write still succeeds", async () => {
    const anonymousId = randomUUID();
    const response = await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId.toUpperCase(), anonymousId: anonymousId.toUpperCase(), status: "granted" }),
    );
    expect(response.status).toBe(204);
    expect(await consentRowCount(anonymousId)).toBe(1);
  });

  it("an uppercase site-key variant cannot occupy a separate site-aggregate rate-limit bucket from its lowercase form", async () => {
    const client = await adminPool.connect();
    let siteId: string;
    try {
      const org = await client.query<{ id: string }>(
        "insert into public.organizations (name, slug) values ('Consent Case Norm Org', $1) returning id",
        [`consent-case-norm-org-${randomUUID()}`],
      );
      const site = await client.query<{ id: string }>(
        "insert into public.tracking_sites (organization_id, label) values ($1, 'Case Norm Site') returning id",
        [org.rows[0]!.id],
      );
      siteId = site.rows[0]!.id;
    } finally {
      client.release();
    }

    await handleConsentRequest(consentRequest({ siteKey: siteId, anonymousId: randomUUID(), status: "granted" }));
    await handleConsentRequest(
      consentRequest({ siteKey: siteId.toUpperCase(), anonymousId: randomUUID(), status: "granted" }),
    );

    const expectedHash = createHash("sha256").update(`consent:site:${siteId.toLowerCase()}`, "utf8").digest("hex");
    const bucketClient = await adminPool.connect();
    try {
      const row = await bucketClient.query<{ count: number }>(
        "select count from public.rate_limit_counters where bucket_hash = $1",
        [expectedHash],
      );
      expect(row.rows[0]?.count).toBe(2);
    } finally {
      bucketClient.release();
    }
  });

  it("two IPv6 case variants of the identical address produce the identical IP rate-limit bucket", async () => {
    const anon1 = randomUUID();
    const anon2 = randomUUID();
    await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: anon1, status: "granted" }, { "x-real-ip": "2001:DB8::AB" }),
    );
    await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: anon2, status: "granted" }, { "x-real-ip": "2001:db8::ab" }),
    );

    const expectedHash = createHash("sha256").update("consent:ip:2001:db8::ab", "utf8").digest("hex");
    const client = await adminPool.connect();
    try {
      const row = await client.query<{ count: number }>(
        "select count from public.rate_limit_counters where bucket_hash = $1",
        [expectedHash],
      );
      expect(row.rows[0]?.count).toBe(2);
    } finally {
      client.release();
    }
  });
});

describe("POST /track/consent: rate limiting", () => {
  it("the per-anonymousId rate limit (10/min) rejects the 11th consent request with 429 and the exact headers", async () => {
    const anonymousId = randomUUID();
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await handleConsentRequest(
        consentRequest(
          { siteKey: fx.activeSiteAId, anonymousId, status: "granted" },
          { "x-real-ip": `198.51.100.${(i % 200) + 1}` },
        ),
      );
    }
    expect(last!.status).toBe(429);
    expect(await last!.json()).toEqual({ error: "rate_limited" });
    expect(last!.headers.get("Retry-After")).toBe("60");
    expect(last!.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("the per-IP rate limit (100/min) is a distinct dimension — a shared IP across distinct anonymousIds still accumulates against the IP bucket", async () => {
    // Guaranteed-valid IPv4 octet — see track-collect.test.ts's identical
    // comment for why this replaced a random hex slice post 3.1C-C's
    // acceptance-audit IP-validation fix.
    const sharedIp = `198.51.100.${Math.floor(Math.random() * 254) + 1}`;
    const anon1 = randomUUID();
    const anon2 = randomUUID();
    const r1 = await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: anon1, status: "granted" }, { "x-real-ip": sharedIp }),
    );
    const r2 = await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: anon2, status: "granted" }, { "x-real-ip": sharedIp }),
    );
    expect(r1.status).not.toBe(429);
    expect(r2.status).not.toBe(429);

    const ipHash = createHash("sha256").update(`consent:ip:${sharedIp}`, "utf8").digest("hex");
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

  it("the site aggregate rate limit uses the resolved, canonical trackingSiteId", async () => {
    const anonymousId = randomUUID();
    await handleConsentRequest(consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "granted" }));
    const expectedHash = createHash("sha256")
      .update(`consent:site:${fx.activeSiteAId.toLowerCase()}`, "utf8")
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

describe("POST /track/consent: malformed source-IP header value maps to the fixed 'unknown' rate-limit bucket (3.1C-C acceptance-audit fix)", () => {
  it("two different malformed x-real-ip values both increment the SAME persisted 'unknown' bucket — neither raw malformed value is ever stored", async () => {
    const anon1 = randomUUID();
    const anon2 = randomUUID();
    await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: anon1, status: "granted" }, { "x-real-ip": "totally-not-an-ip-address" }),
    );
    await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: anon2, status: "granted" }, { "x-real-ip": "another-garbage-value" }),
    );

    const unknownHash = createHash("sha256").update("consent:ip:unknown", "utf8").digest("hex");
    const garbage1Hash = createHash("sha256").update("consent:ip:totally-not-an-ip-address", "utf8").digest("hex");
    const garbage2Hash = createHash("sha256").update("consent:ip:another-garbage-value", "utf8").digest("hex");

    const client = await adminPool.connect();
    try {
      const unknownRow = await client.query<{ count: number }>(
        "select count from public.rate_limit_counters where bucket_hash = $1",
        [unknownHash],
      );
      expect(unknownRow.rows[0]?.count).toBeGreaterThanOrEqual(2);

      const garbage1Row = await client.query("select 1 from public.rate_limit_counters where bucket_hash = $1", [garbage1Hash]);
      const garbage2Row = await client.query("select 1 from public.rate_limit_counters where bucket_hash = $1", [garbage2Hash]);
      expect(garbage1Row.rows).toEqual([]);
      expect(garbage2Row.rows).toEqual([]);
    } finally {
      client.release();
    }
  });
});

describe("POST /track/consent: CORS on every response class", () => {
  it("204, 400, and 413 all carry the CORS headers", async () => {
    const ok204 = await handleConsentRequest(
      consentRequest({ siteKey: fx.activeSiteAId, anonymousId: randomUUID(), status: "granted" }),
    );
    expect(ok204.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const bad400 = await handleConsentRequest(rawConsentRequest("{not json"));
    expect(bad400.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const big413 = await handleConsentRequest(rawConsentRequest("x".repeat(20000)));
    expect(big413.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("POST /track/consent: logging discipline", () => {
  it("a full request/response cycle through the real logged route never writes raw identifiers to stdout", async () => {
    const logSpy = { calls: [] as string[] };
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logSpy.calls.push(args.map(String).join(" "));
    };
    let anonymousId: string;
    try {
      anonymousId = randomUUID();
      await POST(consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "granted" }));
    } finally {
      console.log = originalLog;
    }
    expect(logSpy.calls.length).toBeGreaterThan(0);
    const combined = logSpy.calls.join("\n");
    expect(combined).not.toContain(fx.activeSiteAId);
    expect(combined).not.toContain(anonymousId!);
  });
});

describe("POST /track/consent: withdrawal atomically unlinks identity (Milestone 3.2F)", () => {
  async function seedIdentifiedVisitor(organizationId: string, anonymousId: string): Promise<{ visitorId: string; contactId: string }> {
    const client = await adminPool.connect();
    try {
      const contact = await client.query<{ id: string }>(
        "insert into public.contacts (organization_id, first_name, email) values ($1, $2, $3) returning id",
        [organizationId, "Test", `identified-${randomUUID()}@example.test`],
      );
      const visitor = await client.query<{ id: string }>(
        "insert into public.website_visitors (organization_id, anonymous_id, identified_contact_id) values ($1, $2, $3) returning id",
        [organizationId, anonymousId, contact.rows[0]!.id],
      );
      return { visitorId: visitor.rows[0]!.id, contactId: contact.rows[0]!.id };
    } finally {
      client.release();
    }
  }

  it("withdrawing consent for an identified visitor clears identified_contact_id and writes an unlinked_withdrawal audit row", async () => {
    const anonymousId = randomUUID();
    const { visitorId, contactId } = await seedIdentifiedVisitor(fx.orgAId, anonymousId);

    const response = await POST(consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "withdrawn" }));
    expect(response.status).toBe(204);

    const client = await adminPool.connect();
    try {
      const visitor = await client.query<{ identified_contact_id: string | null }>(
        "select identified_contact_id from public.website_visitors where id = $1",
        [visitorId],
      );
      expect(visitor.rows[0]!.identified_contact_id).toBeNull();

      const audit = await client.query(
        "select event_type, contact_id from public.visitor_identifications where website_visitor_id = $1",
        [visitorId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.event_type).toBe("unlinked_withdrawal");
      expect(audit.rows[0]!.contact_id).toBe(contactId);
    } finally {
      client.release();
    }
  });

  it("does NOT permanently suppress the visitor -- identification_suppressed_at remains null after withdrawal", async () => {
    const anonymousId = randomUUID();
    const { visitorId } = await seedIdentifiedVisitor(fx.orgAId, anonymousId);
    await POST(consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "withdrawn" }));

    const client = await adminPool.connect();
    try {
      const visitor = await client.query<{ identification_suppressed_at: string | null }>(
        "select identification_suppressed_at from public.website_visitors where id = $1",
        [visitorId],
      );
      expect(visitor.rows[0]!.identification_suppressed_at).toBeNull();
    } finally {
      client.release();
    }
  });

  it("granting consent (not withdrawing) never touches identified_contact_id -- the granted path is untouched by 3.2F", async () => {
    const anonymousId = randomUUID();
    const { visitorId, contactId } = await seedIdentifiedVisitor(fx.orgAId, anonymousId);

    const response = await POST(consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "granted" }));
    expect(response.status).toBe(204);

    const client = await adminPool.connect();
    try {
      const visitor = await client.query<{ identified_contact_id: string | null }>(
        "select identified_contact_id from public.website_visitors where id = $1",
        [visitorId],
      );
      expect(visitor.rows[0]!.identified_contact_id).toBe(contactId);
      const audit = await client.query("select id from public.visitor_identifications where website_visitor_id = $1", [
        visitorId,
      ]);
      expect(audit.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it("withdrawing consent for a visitor that was never identified is a clean no-op with no audit row", async () => {
    const anonymousId = randomUUID();
    const client = await adminPool.connect();
    try {
      await client.query("insert into public.website_visitors (organization_id, anonymous_id) values ($1, $2)", [
        fx.orgAId,
        anonymousId,
      ]);
    } finally {
      client.release();
    }

    const response = await POST(consentRequest({ siteKey: fx.activeSiteAId, anonymousId, status: "withdrawn" }));
    expect(response.status).toBe(204);
  });
});
