import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, recordConsent } from "./helpers";
import { checkCookieTrackingConsent } from "../src/consent";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("checkCookieTrackingConsent", () => {
  it("returns false when no consent has ever been recorded", async () => {
    const organizationId = await createOrg();
    const result = await checkCookieTrackingConsent({ organizationId }, randomUUID());
    expect(result).toBe(false);
  });

  it("returns true when the latest consent is granted", async () => {
    const organizationId = await createOrg();
    const anonymousId = randomUUID();
    await recordConsent({ organizationId, anonymousId, status: "granted" });
    const result = await checkCookieTrackingConsent({ organizationId }, anonymousId);
    expect(result).toBe(true);
  });

  it("returns false when the latest consent is withdrawn", async () => {
    const organizationId = await createOrg();
    const anonymousId = randomUUID();
    await recordConsent({ organizationId, anonymousId, status: "withdrawn" });
    const result = await checkCookieTrackingConsent({ organizationId }, anonymousId);
    expect(result).toBe(false);
  });

  it("respects grant -> withdraw -> grant ordering (latest row governs)", async () => {
    const organizationId = await createOrg();
    const anonymousId = randomUUID();
    const base = Date.now();
    await recordConsent({ organizationId, anonymousId, status: "granted", recordedAt: new Date(base).toISOString() });
    await recordConsent({
      organizationId,
      anonymousId,
      status: "withdrawn",
      recordedAt: new Date(base + 1000).toISOString(),
    });
    await recordConsent({
      organizationId,
      anonymousId,
      status: "granted",
      recordedAt: new Date(base + 2000).toISOString(),
    });
    const result = await checkCookieTrackingConsent({ organizationId }, anonymousId);
    expect(result).toBe(true);
  });

  it("does not go through consent_records directly — only the narrow SECURITY DEFINER helper (proven by the same role-less context that would fail against the raw table)", async () => {
    const organizationId = await createOrg();
    const anonymousId = randomUUID();
    await recordConsent({ organizationId, anonymousId, status: "granted" });
    // No roleKey, no userId — the exact role-less shape that a direct
    // consent_records SELECT would return zero rows for (proven in the
    // 3.1B database-prerequisite audit). This function still succeeds,
    // proving it goes through check_visitor_cookie_tracking_consent(),
    // never a direct table read.
    const result = await checkCookieTrackingConsent({ organizationId }, anonymousId);
    expect(result).toBe(true);
  });
});
