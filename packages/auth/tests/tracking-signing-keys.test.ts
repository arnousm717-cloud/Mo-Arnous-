import { randomUUID, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@ai-revenue-os/database";
import {
  registerTrackingSitePublicKey,
  listTrackingSitePublicKeys,
  revokeTrackingSitePublicKey,
  resolveActiveTrackingSitePublicKey,
  verifyIdentityAssertion,
  InvalidPublicKeyError,
} from "../src/tracking-signing-keys";
import { ASSERTION_ISSUER } from "../src/tracking-identity-assertions";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.2B coverage for the Ed25519 public-key registration/lookup
 * wrappers. Reuses getPool()/closePool() as the admin-equivalent
 * fixture-seeding connection, matching tracking-context.test.ts's own
 * established pattern exactly.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
  siteAId: string;
  siteBId: string;
}

let fx: Fixture;

function makePem(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ type: "spki", format: "pem" }) as string;
}

async function seedFixture(): Promise<Fixture> {
  const client = await getPool().connect();
  try {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Signing Keys Test Org A', $1) returning id",
      [`signing-keys-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Signing Keys Test Org B', $1) returning id",
      [`signing-keys-test-org-b-${randomUUID()}`],
    );
    const siteA = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [orgA.rows[0]!.id, "Org A Site"],
    );
    const siteB = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [orgB.rows[0]!.id, "Org B Site"],
    );
    return { orgAId: orgA.rows[0]!.id, orgBId: orgB.rows[0]!.id, siteAId: siteA.rows[0]!.id, siteBId: siteB.rows[0]!.id };
  } finally {
    client.release();
  }
}

async function cleanupFixture(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("delete from public.organizations where id = any($1::uuid[])", [[fx.orgAId, fx.orgBId]]);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  fx = await seedFixture();
});

afterAll(async () => {
  await cleanupFixture();
  await closePool();
});

describe("registerTrackingSitePublicKey", () => {
  it("registers a valid Ed25519 public key for the caller's own tracking site", async () => {
    const key = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    expect(key.id).toBeTruthy();
    expect(key.revokedAt).toBeNull();
  });

  it("rejects a malformed public key before ever reaching the database", async () => {
    await expect(registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, "not a pem")).rejects.toThrow(
      InvalidPublicKeyError,
    );
  });

  it("rejects a non-Ed25519 key (RSA)", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    await expect(registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, rsaPem)).rejects.toThrow(
      InvalidPublicKeyError,
    );
  });

  it("rejects a tracking site belonging to a different organization (composite FK)", async () => {
    await expect(registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteBId, makePem())).rejects.toThrow(
      /tracking_site_public_keys_site_org_fk|foreign key/i,
    );
  });

  it("supports multiple independent keys for the same site (rotation)", async () => {
    const first = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    const second = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    expect(first.id).not.toBe(second.id);
  });
});

describe("listTrackingSitePublicKeys", () => {
  it("returns only the caller's own organization's keys for the given site, never the raw PEM", async () => {
    const key = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    const list = await listTrackingSitePublicKeys({ organizationId: fx.orgAId }, fx.siteAId);
    const found = list.find((k) => k.id === key.id);
    expect(found).toBeDefined();
    expect(found).not.toHaveProperty("publicKeyPem");
  });

  it("returns an empty list for a site with no registered keys", async () => {
    const client = await getPool().connect();
    let freshSiteId: string;
    try {
      const r = await client.query<{ id: string }>(
        "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
        [fx.orgAId, "Fresh Site With No Keys"],
      );
      freshSiteId = r.rows[0]!.id;
    } finally {
      client.release();
    }
    const list = await listTrackingSitePublicKeys({ organizationId: fx.orgAId }, freshSiteId);
    expect(list).toHaveLength(0);
  });
});

describe("revokeTrackingSitePublicKey", () => {
  it("revokes a key belonging to the caller's own organization and site", async () => {
    const key = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    const revoked = await revokeTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, key.id);
    expect(revoked).toBe(true);
    const list = await listTrackingSitePublicKeys({ organizationId: fx.orgAId }, fx.siteAId);
    expect(list.find((k) => k.id === key.id)?.revokedAt).not.toBeNull();
  });

  it("is idempotent -- revoking an already-revoked key returns false, not an error", async () => {
    const key = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    await revokeTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, key.id);
    const second = await revokeTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, key.id);
    expect(second).toBe(false);
  });

  it("returns false for a key belonging to a different organization -- never distinguishes 'not yours' from 'nonexistent'", async () => {
    const key = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    const revoked = await revokeTrackingSitePublicKey({ organizationId: fx.orgBId }, fx.siteAId, key.id);
    expect(revoked).toBe(false);
    const list = await listTrackingSitePublicKeys({ organizationId: fx.orgAId }, fx.siteAId);
    expect(list.find((k) => k.id === key.id)?.revokedAt).toBeNull();
  });

  it("returns false for a key that exists but belongs to a different tracking site under the same organization", async () => {
    const otherSite = await getPool().connect();
    let siteA2: string;
    try {
      const r = await otherSite.query<{ id: string }>(
        "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
        [fx.orgAId, "Org A Second Site"],
      );
      siteA2 = r.rows[0]!.id;
    } finally {
      otherSite.release();
    }
    const key = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    const revoked = await revokeTrackingSitePublicKey({ organizationId: fx.orgAId }, siteA2, key.id);
    expect(revoked).toBe(false);
  });

  it("returns false for a nonexistent keyId", async () => {
    const revoked = await revokeTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, randomUUID());
    expect(revoked).toBe(false);
  });
});

describe("resolveActiveTrackingSitePublicKey: cross-tenant kid lookup is structurally impossible", () => {
  it("resolves the PEM for an active key scoped to (organizationId, trackingSiteId, keyId)", async () => {
    const pem = makePem();
    const key = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, pem);
    const resolved = await resolveActiveTrackingSitePublicKey(fx.orgAId, fx.siteAId, key.id);
    expect(resolved).toBe(pem);
  });

  it("returns null for a revoked key", async () => {
    const key = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    await revokeTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, key.id);
    const resolved = await resolveActiveTrackingSitePublicKey(fx.orgAId, fx.siteAId, key.id);
    expect(resolved).toBeNull();
  });

  it("returns null when the same kid is looked up under the wrong organization -- kid can never select a foreign tenant's key", async () => {
    const key = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    const resolved = await resolveActiveTrackingSitePublicKey(fx.orgBId, fx.siteAId, key.id);
    expect(resolved).toBeNull();
  });

  it("returns null when the same kid is looked up under the wrong tracking site within the same organization", async () => {
    const client = await getPool().connect();
    let siteA2: string;
    try {
      const r = await client.query<{ id: string }>(
        "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
        [fx.orgAId, "Org A Third Site"],
      );
      siteA2 = r.rows[0]!.id;
    } finally {
      client.release();
    }
    const key = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, makePem());
    const resolved = await resolveActiveTrackingSitePublicKey(fx.orgAId, siteA2, key.id);
    expect(resolved).toBeNull();
  });

  it("returns null for a nonexistent kid", async () => {
    const resolved = await resolveActiveTrackingSitePublicKey(fx.orgAId, fx.siteAId, randomUUID());
    expect(resolved).toBeNull();
  });

  it("registering the identical public key bytes for two different sites is permitted and does not weaken kid-based scoping", async () => {
    const pem = makePem();
    const keyA = await registerTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, pem);
    const keyB = await registerTrackingSitePublicKey({ organizationId: fx.orgBId }, fx.siteBId, pem);
    expect(keyA.id).not.toBe(keyB.id);
    // site A's own kid never resolves anything under org B, even though the underlying key bytes are identical.
    expect(await resolveActiveTrackingSitePublicKey(fx.orgBId, fx.siteBId, keyA.id)).toBeNull();
    expect(await resolveActiveTrackingSitePublicKey(fx.orgAId, fx.siteAId, keyB.id)).toBeNull();
    // each site's own kid correctly resolves its own registration.
    expect(await resolveActiveTrackingSitePublicKey(fx.orgAId, fx.siteAId, keyA.id)).toBe(pem);
    expect(await resolveActiveTrackingSitePublicKey(fx.orgBId, fx.siteBId, keyB.id)).toBe(pem);
  });
});

describe("verifyIdentityAssertion: end-to-end real crypto + real DB round trip", () => {
  function makeSignedAssertion(
    privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
    claims: Record<string, unknown>,
  ): string {
    const payloadSegment = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signature = cryptoSign(null, Buffer.from(payloadSegment, "utf8"), privateKey);
    return payloadSegment + "." + signature.toString("base64url");
  }

  async function registerFreshKeyPair(organizationId: string, trackingSiteId: string) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const key = await registerTrackingSitePublicKey({ organizationId }, trackingSiteId, publicKeyPem);
    return { keyId: key.id, privateKey };
  }

  it("accepts a genuinely valid, correctly-signed, correctly-bound assertion", async () => {
    const { keyId, privateKey } = await registerFreshKeyPair(fx.orgAId, fx.siteAId);
    const anonymousId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const assertion = makeSignedAssertion(privateKey, {
      iss: ASSERTION_ISSUER,
      aud: fx.siteAId,
      kid: keyId,
      email: "person@example.com",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    });
    const claims = await verifyIdentityAssertion({ assertion, organizationId: fx.orgAId, trackingSiteId: fx.siteAId, anonymousId });
    expect(claims).not.toBeNull();
    expect(claims!.email).toBe("person@example.com");
  });

  it("rejects a structurally malformed assertion", async () => {
    const claims = await verifyIdentityAssertion({
      assertion: "not.an.assertion.at.all",
      organizationId: fx.orgAId,
      trackingSiteId: fx.siteAId,
      anonymousId: randomUUID(),
    });
    expect(claims).toBeNull();
  });

  it("rejects a token whose aud does not match the resolved trackingSiteId", async () => {
    const { keyId, privateKey } = await registerFreshKeyPair(fx.orgAId, fx.siteAId);
    const now = Math.floor(Date.now() / 1000);
    const assertion = makeSignedAssertion(privateKey, {
      iss: ASSERTION_ISSUER,
      aud: randomUUID(), // wrong site
      kid: keyId,
      email: "person@example.com",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    });
    const claims = await verifyIdentityAssertion({
      assertion,
      organizationId: fx.orgAId,
      trackingSiteId: fx.siteAId,
      anonymousId: randomUUID(),
    });
    expect(claims).toBeNull();
  });

  it("rejects a token signed for a DIFFERENT organization's site, even with a real, validly-registered key for that other org", async () => {
    const { keyId, privateKey } = await registerFreshKeyPair(fx.orgBId, fx.siteBId);
    const now = Math.floor(Date.now() / 1000);
    const assertion = makeSignedAssertion(privateKey, {
      iss: ASSERTION_ISSUER,
      aud: fx.siteBId,
      kid: keyId,
      email: "person@example.com",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    });
    // Attempt to use org B's own valid assertion against org A's site.
    const claims = await verifyIdentityAssertion({
      assertion,
      organizationId: fx.orgAId,
      trackingSiteId: fx.siteAId,
      anonymousId: randomUUID(),
    });
    expect(claims).toBeNull();
  });

  it("rejects a token with a bound anonymousId that does not match the request's own anonymousId", async () => {
    const { keyId, privateKey } = await registerFreshKeyPair(fx.orgAId, fx.siteAId);
    const now = Math.floor(Date.now() / 1000);
    const assertion = makeSignedAssertion(privateKey, {
      iss: ASSERTION_ISSUER,
      aud: fx.siteAId,
      kid: keyId,
      email: "person@example.com",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      anonymousId: randomUUID(),
    });
    const claims = await verifyIdentityAssertion({
      assertion,
      organizationId: fx.orgAId,
      trackingSiteId: fx.siteAId,
      anonymousId: randomUUID(), // different anonymousId than the one bound in the token
    });
    expect(claims).toBeNull();
  });

  it("accepts a token whose bound anonymousId exactly matches the request's own", async () => {
    const { keyId, privateKey } = await registerFreshKeyPair(fx.orgAId, fx.siteAId);
    const anonymousId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const assertion = makeSignedAssertion(privateKey, {
      iss: ASSERTION_ISSUER,
      aud: fx.siteAId,
      kid: keyId,
      email: "person@example.com",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      anonymousId,
    });
    const claims = await verifyIdentityAssertion({ assertion, organizationId: fx.orgAId, trackingSiteId: fx.siteAId, anonymousId });
    expect(claims).not.toBeNull();
  });

  it("rejects an expired token", async () => {
    const { keyId, privateKey } = await registerFreshKeyPair(fx.orgAId, fx.siteAId);
    const now = Math.floor(Date.now() / 1000) - 1000;
    const assertion = makeSignedAssertion(privateKey, {
      iss: ASSERTION_ISSUER,
      aud: fx.siteAId,
      kid: keyId,
      email: "person@example.com",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    });
    const claims = await verifyIdentityAssertion({
      assertion,
      organizationId: fx.orgAId,
      trackingSiteId: fx.siteAId,
      anonymousId: randomUUID(),
    });
    expect(claims).toBeNull();
  });

  it("rejects a token signed by a key that was never registered", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const now = Math.floor(Date.now() / 1000);
    const assertion = makeSignedAssertion(privateKey, {
      iss: ASSERTION_ISSUER,
      aud: fx.siteAId,
      kid: randomUUID(), // never registered
      email: "person@example.com",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    });
    const claims = await verifyIdentityAssertion({
      assertion,
      organizationId: fx.orgAId,
      trackingSiteId: fx.siteAId,
      anonymousId: randomUUID(),
    });
    expect(claims).toBeNull();
  });

  it("rejects a token signed by a REVOKED key", async () => {
    const { keyId, privateKey } = await registerFreshKeyPair(fx.orgAId, fx.siteAId);
    await revokeTrackingSitePublicKey({ organizationId: fx.orgAId }, fx.siteAId, keyId);
    const now = Math.floor(Date.now() / 1000);
    const assertion = makeSignedAssertion(privateKey, {
      iss: ASSERTION_ISSUER,
      aud: fx.siteAId,
      kid: keyId,
      email: "person@example.com",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    });
    const claims = await verifyIdentityAssertion({
      assertion,
      organizationId: fx.orgAId,
      trackingSiteId: fx.siteAId,
      anonymousId: randomUUID(),
    });
    expect(claims).toBeNull();
  });

  it("rejects a token whose payload was tampered with after signing", async () => {
    const { keyId, privateKey } = await registerFreshKeyPair(fx.orgAId, fx.siteAId);
    const now = Math.floor(Date.now() / 1000);
    const assertion = makeSignedAssertion(privateKey, {
      iss: ASSERTION_ISSUER,
      aud: fx.siteAId,
      kid: keyId,
      email: "person@example.com",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    });
    const [, sigSegment] = assertion.split(".") as [string, string];
    const tampered =
      Buffer.from(JSON.stringify({ email: "attacker@example.com" }), "utf8").toString("base64url") + "." + sigSegment;
    const claims = await verifyIdentityAssertion({
      assertion: tampered,
      organizationId: fx.orgAId,
      trackingSiteId: fx.siteAId,
      anonymousId: randomUUID(),
    });
    expect(claims).toBeNull();
  });

  it("rejects a token verified against the wrong tenant's key even when the kid happens to collide across organizations (cross-tenant kid reuse is structurally impossible)", async () => {
    // Extremely unlikely in practice (UUID collision), but prove the
    // lookup itself is tenant-scoped, not merely probabilistically safe.
    const { keyId: keyIdA, privateKey: privateKeyA } = await registerFreshKeyPair(fx.orgAId, fx.siteAId);
    const now = Math.floor(Date.now() / 1000);
    const assertion = makeSignedAssertion(privateKeyA, {
      iss: ASSERTION_ISSUER,
      aud: fx.siteBId, // claims org B's site, but signed by org A's key
      kid: keyIdA,
      email: "person@example.com",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    });
    const claims = await verifyIdentityAssertion({
      assertion,
      organizationId: fx.orgBId,
      trackingSiteId: fx.siteBId,
      anonymousId: randomUUID(),
    });
    expect(claims).toBeNull();
  });
});
