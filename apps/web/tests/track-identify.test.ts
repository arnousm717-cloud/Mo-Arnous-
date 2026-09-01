import { randomUUID, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@ai-revenue-os/database";
import { registerTrackingSitePublicKey } from "@ai-revenue-os/auth";
import { executeContactErasure, fileDataSubjectRequest } from "@ai-revenue-os/compliance";
import { identifyVisitor } from "@ai-revenue-os/intelligence";
import { OPTIONS, POST } from "../app/track/identify/route";
import { handleIdentifyRequest } from "../app/track/identify/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.2D — POST/OPTIONS /track/identify route-level coverage.
 * Mirrors track-collect.test.ts's own style exactly: real Postgres, real
 * Ed25519 signing (no mocking), a real registered public key. This file
 * proves the ROUTE's own orchestration/validation/response-normalization/
 * rate-limit-wiring behavior — the exhaustive cryptographic-verification
 * matrix (tampering, expiry, wrong-key, algorithm confusion, replay,
 * cross-tenant kid reuse) is already exhaustively owned by
 * packages/auth/tests/tracking-signing-keys.test.ts's own 29 tests, and
 * the atomic-transaction/conflict-policy/consent/suppression matrix by
 * packages/intelligence/tests/identify.test.ts's own 17 — not
 * re-proven here.
 */

const adminPool = getPool();

interface Fixture {
  orgAId: string;
  orgBId: string;
  activeSiteAId: string;
  revokedSiteId: string;
}

async function seedFixture(): Promise<Fixture> {
  const client = await adminPool.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Track Identify Test Org', $1) returning id",
      [`track-identify-org-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Track Identify Test Org B', $1) returning id",
      [`track-identify-org-b-${randomUUID()}`],
    );
    const activeSite = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [org.rows[0]!.id, "Active Site"],
    );
    const revokedSite = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label, revoked_at) values ($1, $2, now()) returning id",
      [org.rows[0]!.id, "Revoked Site"],
    );
    return { orgAId: org.rows[0]!.id, orgBId: orgB.rows[0]!.id, activeSiteAId: activeSite.rows[0]!.id, revokedSiteId: revokedSite.rows[0]!.id };
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

async function createContact(organizationId: string, email: string): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, email) values ($1, $2, $3) returning id",
      [organizationId, "Test", email],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function identifiedContactOf(anonymousId: string): Promise<string | null> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ identified_contact_id: string | null }>(
      "select identified_contact_id from public.website_visitors where anonymous_id = $1",
      [anonymousId],
    );
    return r.rows[0]?.identified_contact_id ?? null;
  } finally {
    client.release();
  }
}

async function registerKeyPair(organizationId: string, trackingSiteId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const key = await registerTrackingSitePublicKey({ organizationId }, trackingSiteId, publicKeyPem);
  return { keyId: key.id, privateKey };
}

function signAssertion(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], claims: Record<string, unknown>): string {
  const payloadSegment = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = cryptoSign(null, Buffer.from(payloadSegment, "utf8"), privateKey);
  return payloadSegment + "." + signature.toString("base64url");
}

function baseClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "ai-revenue-os:visitor-identify",
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    email: "person@example.com",
    ...over,
  };
}

function identifyRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/track/identify", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9", ...headers },
  });
}

afterAll(async () => {
  await closePool();
});

describe("OPTIONS /track/identify", () => {
  it("returns 204 with CORS headers and an empty body", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
  });
});

describe("POST /track/identify: happy path", () => {
  it("a genuinely valid, correctly-signed assertion identifies the visitor and returns 204", async () => {
    const fx = await seedFixture();
    const email = `person-${randomUUID()}@example.test`;
    const contactId = await createContact(fx.orgAId, email);
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);
    const { keyId, privateKey } = await registerKeyPair(fx.orgAId, fx.activeSiteAId);
    const assertion = signAssertion(privateKey, baseClaims({ aud: fx.activeSiteAId, kid: keyId, email }));

    const response = await handleIdentifyRequest(
      identifyRequest({ siteKey: fx.activeSiteAId, anonymousId, assertion }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await identifiedContactOf(anonymousId)).toBe(contactId);
  });
});

describe("POST /track/identify: request validation", () => {
  it("rejects an unknown top-level field with 400", async () => {
    const fx = await seedFixture();
    const response = await POST(
      identifyRequest({ siteKey: fx.activeSiteAId, anonymousId: randomUUID(), assertion: "x.y", extra: "nope" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects a missing field with 400", async () => {
    const fx = await seedFixture();
    const response = await POST(identifyRequest({ siteKey: fx.activeSiteAId, anonymousId: randomUUID() }));
    expect(response.status).toBe(400);
  });

  it("rejects a non-UUID siteKey/anonymousId with 400", async () => {
    const response1 = await POST(identifyRequest({ siteKey: "not-a-uuid", anonymousId: randomUUID(), assertion: "x.y" }));
    expect(response1.status).toBe(400);
    const fx = await seedFixture();
    const response2 = await POST(identifyRequest({ siteKey: fx.activeSiteAId, anonymousId: "not-a-uuid", assertion: "x.y" }));
    expect(response2.status).toBe(400);
  });

  it("rejects an empty assertion with 400", async () => {
    const fx = await seedFixture();
    const response = await POST(identifyRequest({ siteKey: fx.activeSiteAId, anonymousId: randomUUID(), assertion: "" }));
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await POST(
      new Request("https://example.test/track/identify", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("POST /track/identify: non-oracle behavior — every rejection reason produces the identical 204", () => {
  it("nonexistent site key => 204", async () => {
    const response = await POST(identifyRequest({ siteKey: randomUUID(), anonymousId: randomUUID(), assertion: "x.y" }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("revoked site key => 204", async () => {
    const fx = await seedFixture();
    const response = await POST(
      identifyRequest({ siteKey: fx.revokedSiteId, anonymousId: randomUUID(), assertion: "x.y" }),
    );
    expect(response.status).toBe(204);
  });

  it("structurally malformed assertion (not two base64url segments) => 204", async () => {
    const fx = await seedFixture();
    const response = await POST(
      identifyRequest({ siteKey: fx.activeSiteAId, anonymousId: randomUUID(), assertion: "not-a-real-assertion" }),
    );
    expect(response.status).toBe(204);
  });

  it("well-formed but unsigned/unverifiable assertion (unregistered key) => 204", async () => {
    const fx = await seedFixture();
    const { privateKey } = generateKeyPairSync("ed25519");
    const assertion = signAssertion(privateKey, baseClaims({ aud: fx.activeSiteAId, kid: randomUUID() }));
    const response = await POST(
      identifyRequest({ siteKey: fx.activeSiteAId, anonymousId: randomUUID(), assertion }),
    );
    expect(response.status).toBe(204);
  });

  it("no consent granted => 204 (fails closed, indistinguishable from success)", async () => {
    const fx = await seedFixture();
    const email = `person-${randomUUID()}@example.test`;
    await createContact(fx.orgAId, email);
    const anonymousId = randomUUID(); // no consent granted
    const { keyId, privateKey } = await registerKeyPair(fx.orgAId, fx.activeSiteAId);
    const assertion = signAssertion(privateKey, baseClaims({ aud: fx.activeSiteAId, kid: keyId, email }));

    const response = await POST(identifyRequest({ siteKey: fx.activeSiteAId, anonymousId, assertion }));
    expect(response.status).toBe(204);
    expect(await identifiedContactOf(anonymousId)).toBeNull();
  });

  it("no matching contact => 204, identical shape to success", async () => {
    const fx = await seedFixture();
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);
    const { keyId, privateKey } = await registerKeyPair(fx.orgAId, fx.activeSiteAId);
    const assertion = signAssertion(
      privateKey,
      baseClaims({ aud: fx.activeSiteAId, kid: keyId, email: `nobody-${randomUUID()}@example.test` }),
    );

    const response = await POST(identifyRequest({ siteKey: fx.activeSiteAId, anonymousId, assertion }));
    expect(response.status).toBe(204);
  });

  it("cross-tenant: a real key/assertion signed for org B cannot identify a visitor under org A's site", async () => {
    const fx = await seedFixture();
    const orgBSite = await adminPool.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [fx.orgBId, "Org B Site"],
    );
    const { keyId, privateKey } = await registerKeyPair(fx.orgBId, orgBSite.rows[0]!.id);
    const assertion = signAssertion(privateKey, baseClaims({ aud: orgBSite.rows[0]!.id, kid: keyId }));
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);

    // Present org B's own valid assertion against org A's site.
    const response = await POST(identifyRequest({ siteKey: fx.activeSiteAId, anonymousId, assertion }));
    expect(response.status).toBe(204);
    expect(await identifiedContactOf(anonymousId)).toBeNull();
  });

  it("a previously-consumed jti, replayed verbatim after the visitor has since been legitimately rebound to a different contact, still returns the identical 204 -- not a 500 (Final Implementation Acceptance Audit remediation regression)", async () => {
    const fx = await seedFixture();
    const emailA = `a-${randomUUID()}@example.test`;
    const emailB = `b-${randomUUID()}@example.test`;
    const contactB = await createContact(fx.orgAId, emailB);
    await createContact(fx.orgAId, emailA);
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);
    const { keyId, privateKey } = await registerKeyPair(fx.orgAId, fx.activeSiteAId);

    // Real assertion #1, real jti, real route call -- binds to Contact A.
    const originalAssertion = signAssertion(privateKey, baseClaims({ aud: fx.activeSiteAId, kid: keyId, email: emailA }));
    const first = await POST(identifyRequest({ siteKey: fx.activeSiteAId, anonymousId, assertion: originalAssertion }));
    expect(first.status).toBe(204);

    // Simulates a legitimate withdraw+re-identify cycle rebinding the
    // same visitor to a different contact (packages/intelligence's own
    // unlinkVisitorIdentityOnWithdrawal, already covered elsewhere --
    // the unlink itself is not what this test is proving).
    const client = await adminPool.connect();
    try {
      await client.query("update public.website_visitors set identified_contact_id = null where anonymous_id = $1", [
        anonymousId,
      ]);
    } finally {
      client.release();
    }
    const secondAssertion = signAssertion(privateKey, baseClaims({ aud: fx.activeSiteAId, kid: keyId, email: emailB }));
    const second = await POST(identifyRequest({ siteKey: fx.activeSiteAId, anonymousId, assertion: secondAssertion }));
    expect(second.status).toBe(204);
    expect(await identifiedContactOf(anonymousId)).toBe(contactB);

    // Replay the ORIGINAL assertion bytes verbatim (same jti, same
    // signature -- a genuine byte-for-byte replay, exactly what an
    // attacker or a naive retry would send). The visitor is now bound
    // to Contact B, so this lands on the conflict path, where jti X was
    // already consumed by `first`. Must resolve to the same uniform
    // 204 as every other rejection reason -- not a 500.
    const replay = await POST(identifyRequest({ siteKey: fx.activeSiteAId, anonymousId, assertion: originalAssertion }));
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe("");
    // Binding is unaffected by the replay attempt.
    expect(await identifiedContactOf(anonymousId)).toBe(contactB);
  });
});

describe("POST /track/identify: rate limiting", () => {
  it("the per-anonymousId rate limit (10/min) rejects the 11th identify request with 429 and the exact headers", async () => {
    const fx = await seedFixture();
    const anonymousId = randomUUID();
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await POST(
        identifyRequest(
          { siteKey: fx.activeSiteAId, anonymousId, assertion: "x.y" },
          { "x-real-ip": `198.51.100.${(i % 200) + 1}` },
        ),
      );
    }
    expect(last!.status).toBe(429);
    expect(await last!.json()).toEqual({ error: "rate_limited" });
    expect(last!.headers.get("Retry-After")).toBe("60");
    expect(last!.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("the per-email rate limit (5/min) rejects the 6th distinct identify attempt using the same email", async () => {
    const fx = await seedFixture();
    const email = `email-limit-${randomUUID()}@example.test`;
    await createContact(fx.orgAId, email);
    const { keyId, privateKey } = await registerKeyPair(fx.orgAId, fx.activeSiteAId);
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      const anonymousId = randomUUID();
      await grantConsent(fx.orgAId, anonymousId);
      const assertion = signAssertion(privateKey, baseClaims({ aud: fx.activeSiteAId, kid: keyId, email }));
      last = await POST(
        identifyRequest(
          { siteKey: fx.activeSiteAId, anonymousId, assertion },
          { "x-real-ip": `198.51.100.${100 + i}` },
        ),
      );
    }
    expect(last!.status).toBe(429);
  });
});

describe("erasure anti-relink guard, end-to-end (Milestone 3.2F)", () => {
  async function createAdminUserForOrg(organizationId: string): Promise<string> {
    const userId = randomUUID();
    const client = await adminPool.connect();
    try {
      await client.query("insert into auth.users (id, email) values ($1, $2)", [userId, `identify-erasure-admin-${userId}@example.test`]);
      const role = await client.query<{ id: string }>("select id from public.roles where key = 'org_admin'", []);
      await client.query("insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')", [
        userId,
        organizationId,
        role.rows[0]!.id,
      ]);
    } finally {
      client.release();
    }
    return userId;
  }

  it("a contact erased via a real GDPR data-subject request permanently prevents its identified visitor from later being identified to a RECREATED contact with the same email", async () => {
    const fx = await seedFixture();
    const email = `person-${randomUUID()}@example.test`;
    const originalContactId = await createContact(fx.orgAId, email);
    const anonymousId = randomUUID();
    await grantConsent(fx.orgAId, anonymousId);

    // Step 1: genuinely identify the visitor to the original contact.
    const identifyResult = await identifyVisitor(
      { organizationId: fx.orgAId },
      { trackingSiteId: fx.activeSiteAId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(identifyResult.accepted).toBe(true);

    // Step 2: erase the contact via the REAL GDPR DSR flow (fileDataSubjectRequest -> executeContactErasure), not a raw DELETE.
    const adminUserId = await createAdminUserForOrg(fx.orgAId);
    const dsr = await fileDataSubjectRequest(
      { userId: adminUserId, organizationId: fx.orgAId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: originalContactId, requestType: "delete" },
    );
    const erasure = await executeContactErasure({ userId: adminUserId }, dsr.id);
    expect(erasure.targetContactId).toBe(originalContactId);

    // Confirm the original contact is genuinely gone.
    const contactRow = await adminPool.query("select id from public.contacts where id = $1", [originalContactId]);
    expect(contactRow.rows).toHaveLength(0);

    // Confirm the existing FK already nulled identified_contact_id, and the new suppression flag is set.
    const visitorAfterErasure = await adminPool.query<{ identified_contact_id: string | null; identification_suppressed_at: string | null }>(
      "select identified_contact_id, identification_suppressed_at from public.website_visitors where organization_id = $1 and anonymous_id = $2",
      [fx.orgAId, anonymousId],
    );
    expect(visitorAfterErasure.rows[0]!.identified_contact_id).toBeNull();
    expect(visitorAfterErasure.rows[0]!.identification_suppressed_at).not.toBeNull();

    // Step 3: "the replacement/recreated contact" — same email, brand-new contact row, exactly the attack scenario.
    const recreatedContactId = await createContact(fx.orgAId, email);
    expect(recreatedContactId).not.toBe(originalContactId);

    // Step 4: the SAME anonymousId (the browser's own persisted identity, unaffected by server-side erasure)
    // attempts to identify to the recreated contact. This MUST be rejected.
    const secondAttempt = await identifyVisitor(
      { organizationId: fx.orgAId },
      { trackingSiteId: fx.activeSiteAId, anonymousId, contactEmail: email, tokenJti: randomUUID() },
    );
    expect(secondAttempt).toEqual({ accepted: false, reason: "visitor_suppressed" });

    // And the same guarantee holds through the full public HTTP endpoint, not only the domain function directly.
    const { keyId, privateKey } = await registerKeyPair(fx.orgAId, fx.activeSiteAId);
    const assertion = signAssertion(privateKey, baseClaims({ aud: fx.activeSiteAId, kid: keyId, email }));
    const httpResponse = await POST(identifyRequest({ siteKey: fx.activeSiteAId, anonymousId, assertion }));
    expect(httpResponse.status).toBe(204); // non-oracle -- rejected, but indistinguishable externally.

    const visitorAfterSecondAttempt = await adminPool.query<{ identified_contact_id: string | null }>(
      "select identified_contact_id from public.website_visitors where organization_id = $1 and anonymous_id = $2",
      [fx.orgAId, anonymousId],
    );
    expect(visitorAfterSecondAttempt.rows[0]!.identified_contact_id).toBeNull();
  });

  it("erasure of a contact that was never identified by any visitor suppresses nothing (no unrelated side effects)", async () => {
    const fx = await seedFixture();
    const email = `person-${randomUUID()}@example.test`;
    const contactId = await createContact(fx.orgAId, email);
    const unrelatedAnonymousId = randomUUID();
    await grantConsent(fx.orgAId, unrelatedAnonymousId);
    await adminPool.query("insert into public.website_visitors (organization_id, anonymous_id) values ($1, $2)", [
      fx.orgAId,
      unrelatedAnonymousId,
    ]);

    const adminUserId = await createAdminUserForOrg(fx.orgAId);
    const dsr = await fileDataSubjectRequest(
      { userId: adminUserId, organizationId: fx.orgAId, roleKey: "org_admin" },
      { subjectType: "contact", subjectId: contactId, requestType: "delete" },
    );
    await executeContactErasure({ userId: adminUserId }, dsr.id);

    const unrelatedVisitor = await adminPool.query<{ identification_suppressed_at: string | null }>(
      "select identification_suppressed_at from public.website_visitors where organization_id = $1 and anonymous_id = $2",
      [fx.orgAId, unrelatedAnonymousId],
    );
    expect(unrelatedVisitor.rows[0]!.identification_suppressed_at).toBeNull();
  });
});
