import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, createTrackingSite } from "./helpers";
import { resolveOrCreateVisitor } from "../src/visitors";
import { resolveOrCreateVisitorSession } from "../src/sessions";
import { appendVisitorEvent, type EventType } from "../src/events";
import { InvalidEventTypeError, InvalidSessionRelationshipError } from "../src/errors";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function fixture() {
  const organizationId = await createOrg();
  const trackingSiteId = await createTrackingSite(organizationId);
  const visitor = await resolveOrCreateVisitor({ organizationId }, randomUUID());
  const session = await resolveOrCreateVisitorSession(
    { organizationId },
    { trackingSiteId, visitorId: visitor.id, anonymousSessionId: randomUUID() },
  );
  return { organizationId, sessionId: session.id };
}

describe("appendVisitorEvent", () => {
  it.each(["pageview", "form_submit", "click"] as const)("accepts the supported event type %s", async (eventType) => {
    const { organizationId, sessionId } = await fixture();
    const event = await appendVisitorEvent({ organizationId }, { sessionId, eventType });
    expect(event.eventType).toBe(eventType);
  });

  it("rejects an unsupported event type with a typed domain error, before any DB write", async () => {
    const { organizationId, sessionId } = await fixture();
    await expect(
      appendVisitorEvent({ organizationId }, { sessionId, eventType: "scroll" as EventType }),
    ).rejects.toThrow(InvalidEventTypeError);
  });

  it("occurred_at is database-assigned — no occurredAt input exists on the type, and the returned value is a real recent timestamp", async () => {
    const { organizationId, sessionId } = await fixture();
    const before = Date.now();
    const event = await appendVisitorEvent({ organizationId }, { sessionId, eventType: "pageview" });
    const occurredAtMs = new Date(event.occurredAt).getTime();
    expect(occurredAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(occurredAtMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("url is nullable — omitting it persists null, not an error", async () => {
    const { organizationId, sessionId } = await fixture();
    const event = await appendVisitorEvent({ organizationId }, { sessionId, eventType: "pageview" });
    expect(event.url).toBeNull();
  });

  it("url round-trips when supplied", async () => {
    const { organizationId, sessionId } = await fixture();
    const event = await appendVisitorEvent(
      { organizationId },
      { sessionId, eventType: "pageview", url: "https://example.com/pricing" },
    );
    expect(event.url).toBe("https://example.com/pricing");
  });

  it("metadata defaults to an empty object when omitted", async () => {
    const { organizationId, sessionId } = await fixture();
    const event = await appendVisitorEvent({ organizationId }, { sessionId, eventType: "click" });
    expect(event.metadata).toEqual({});
  });

  it("metadata round-trips a JSON-compatible object", async () => {
    const { organizationId, sessionId } = await fixture();
    const event = await appendVisitorEvent(
      { organizationId },
      { sessionId, eventType: "form_submit", metadata: { formId: "signup", fields: ["email", "name"] } },
    );
    expect(event.metadata).toEqual({ formId: "signup", fields: ["email", "name"] });
  });

  it("a sessionId belonging to a different organization is rejected with a typed InvalidSessionRelationshipError, not a raw FK error", async () => {
    const { sessionId } = await fixture();
    const otherOrgId = await createOrg();
    await expect(
      appendVisitorEvent({ organizationId: otherOrgId }, { sessionId, eventType: "pageview" }),
    ).rejects.toThrow(InvalidSessionRelationshipError);
  });
});
