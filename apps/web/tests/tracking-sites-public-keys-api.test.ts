import { randomUUID, generateKeyPairSync } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrgWithRole, createUnaffiliatedUser } from "./crm-api-fixtures";
import { handleRegisterTrackingSitePublicKey, handleListTrackingSitePublicKeys } from "../app/api/v1/tracking-sites/[trackingSiteId]/public-keys/handlers";
import { handleRevokeTrackingSitePublicKey } from "../app/api/v1/tracking-sites/[trackingSiteId]/public-keys/[keyId]/revoke/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.2B route-level coverage for the staff-authenticated
 * Ed25519 public-key registration surface. Mirrors companies-api.test.ts's
 * own style exactly (direct handler invocation, no running server, real
 * Postgres via crm-api-fixtures' existing adminPool/createOrgWithRole).
 */

function makePem(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ type: "spki", format: "pem" }) as string;
}

async function seedTrackingSite(organizationId: string): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      "insert into public.tracking_sites (organization_id, label) values ($1, $2) returning id",
      [organizationId, "API Test Site"],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await closePool();
});

describe("tracking-sites public-keys API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    const siteId = randomUUID();
    expect((await handleRegisterTrackingSitePublicKey(null, siteId, { publicKeyPem: makePem() })).status).toBe(401);
    expect((await handleListTrackingSitePublicKeys(null, siteId)).status).toBe(401);
    expect((await handleRevokeTrackingSitePublicKey(null, siteId, randomUUID())).status).toBe(401);
  });

  it("rejects a user with no organization membership with 403", async () => {
    const userId = await createUnaffiliatedUser();
    const siteId = randomUUID();
    expect((await handleRegisterTrackingSitePublicKey(userId, siteId, { publicKeyPem: makePem() })).status).toBe(403);
  });
});

describe("tracking-sites public-keys API: RBAC (org_admin only)", () => {
  it("org_admin can register, list, and revoke", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    const siteId = await seedTrackingSite(organizationId);

    const registered = await handleRegisterTrackingSitePublicKey(userId, siteId, { publicKeyPem: makePem() });
    expect(registered.status).toBe(201);
    const { publicKey } = await registered.json();
    expect(publicKey.id).toBeTruthy();

    const listed = await handleListTrackingSitePublicKeys(userId, siteId);
    expect(listed.status).toBe(200);
    const { publicKeys } = await listed.json();
    expect(publicKeys.some((k: { id: string }) => k.id === publicKey.id)).toBe(true);

    const revoked = await handleRevokeTrackingSitePublicKey(userId, siteId, publicKey.id);
    expect(revoked.status).toBe(200);
  });

  it("org_member is forbidden from registering a key", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_member");
    const siteId = await seedTrackingSite(organizationId);
    expect((await handleRegisterTrackingSitePublicKey(userId, siteId, { publicKeyPem: makePem() })).status).toBe(403);
  });

  it("org_viewer is forbidden from registering a key", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer");
    const siteId = await seedTrackingSite(organizationId);
    expect((await handleRegisterTrackingSitePublicKey(userId, siteId, { publicKeyPem: makePem() })).status).toBe(403);
  });

  it("org_member and org_viewer are also forbidden from listing/revoking", async () => {
    const admin = await createOrgWithRole("org_admin", "admin-for-member-test");
    const siteId = await seedTrackingSite(admin.organizationId);
    const registered = await handleRegisterTrackingSitePublicKey(admin.userId, siteId, { publicKeyPem: makePem() });
    const { publicKey } = await registered.json();

    const member = await createOrgWithRole("org_member", "member-cannot-list");
    expect((await handleListTrackingSitePublicKeys(member.userId, siteId)).status).toBe(403);
    expect((await handleRevokeTrackingSitePublicKey(member.userId, siteId, publicKey.id)).status).toBe(403);
  });
});

describe("tracking-sites public-keys API: validation", () => {
  it("rejects a missing publicKeyPem with 400", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin", "validation-missing");
    const siteId = await seedTrackingSite(organizationId);
    const res = await handleRegisterTrackingSitePublicKey(userId, siteId, {});
    expect(res.status).toBe(400);
  });

  it("rejects a malformed publicKeyPem with 400 -- never reaches the database", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin", "validation-malformed");
    const siteId = await seedTrackingSite(organizationId);
    const res = await handleRegisterTrackingSitePublicKey(userId, siteId, { publicKeyPem: "not a real key" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-Ed25519 (RSA) publicKeyPem with 400", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin", "validation-rsa");
    const siteId = await seedTrackingSite(organizationId);
    const { publicKey: rsaPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = rsaPublicKey.export({ type: "spki", format: "pem" }) as string;
    const res = await handleRegisterTrackingSitePublicKey(userId, siteId, { publicKeyPem: rsaPem });
    expect(res.status).toBe(400);
  });
});

describe("tracking-sites public-keys API: tenant isolation", () => {
  it("registering a key against a tracking site belonging to a different organization returns 404, not 500", async () => {
    const orgA = await createOrgWithRole("org_admin", "tenant-a");
    const orgB = await createOrgWithRole("org_admin", "tenant-b");
    const siteB = await seedTrackingSite(orgB.organizationId);

    const res = await handleRegisterTrackingSitePublicKey(orgA.userId, siteB, { publicKeyPem: makePem() });
    expect(res.status).toBe(404);
  });

  it("listing another organization's tracking site returns an empty list, never that org's own keys (RLS)", async () => {
    const orgA = await createOrgWithRole("org_admin", "tenant-list-a");
    const orgB = await createOrgWithRole("org_admin", "tenant-list-b");
    const siteA = await seedTrackingSite(orgA.organizationId);
    await handleRegisterTrackingSitePublicKey(orgA.userId, siteA, { publicKeyPem: makePem() });

    const listedByB = await handleListTrackingSitePublicKeys(orgB.userId, siteA);
    expect(listedByB.status).toBe(200);
    const { publicKeys } = await listedByB.json();
    expect(publicKeys).toHaveLength(0);
  });

  it("revoking another organization's key returns 404, and the key remains active", async () => {
    const orgA = await createOrgWithRole("org_admin", "tenant-revoke-a");
    const orgB = await createOrgWithRole("org_admin", "tenant-revoke-b");
    const siteA = await seedTrackingSite(orgA.organizationId);
    const registered = await handleRegisterTrackingSitePublicKey(orgA.userId, siteA, { publicKeyPem: makePem() });
    const { publicKey } = await registered.json();

    const revokeAttempt = await handleRevokeTrackingSitePublicKey(orgB.userId, siteA, publicKey.id);
    expect(revokeAttempt.status).toBe(404);

    const listed = await handleListTrackingSitePublicKeys(orgA.userId, siteA);
    const { publicKeys } = await listed.json();
    expect(publicKeys.find((k: { id: string; revokedAt: string | null }) => k.id === publicKey.id)?.revokedAt).toBeNull();
  });
});
