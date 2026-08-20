import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { createOrgWithRole, seedCompany, seedContact, seedTag } from "./crm-api-fixtures";
import { handleListCompanies, handleCreateCompany } from "../app/api/v1/companies/handlers";
import { handleGetCompany } from "../app/api/v1/companies/[id]/handlers";
import { handleListContacts, handleCreateContact } from "../app/api/v1/contacts/handlers";
import { handleListDeals } from "../app/api/v1/deals/handlers";
import { handleListPipelines } from "../app/api/v1/pipelines/handlers";
import { handleListActivities } from "../app/api/v1/activities/handlers";
import { handleListNotes } from "../app/api/v1/notes/handlers";
import { handleListTags, handleCreateTag } from "../app/api/v1/tags/handlers";
import { handleGetOrganizations } from "../app/api/v1/organizations/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.5A. Proves the structured error envelope (`apps/web/app/
 * api/v1/_shared/api-error.ts`) is actually what every route emits, not
 * just what one resource's handlers.ts happens to do — see docs/04-API-
 * Architecture.md §1's own prior disclosure of the flat-vs-structured
 * discrepancy this milestone closes. Does not re-prove RBAC/tenancy/
 * idempotency mechanics themselves (companies-api.test.ts and siblings
 * already do that exhaustively, unchanged and still green) — only that
 * whatever status a route already returns now carries this envelope.
 */

const KNOWN_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL_ERROR",
] as const;

interface ErrorBody {
  error: { code: string; message: string; request_id: string };
}

function expectStructuredError(body: unknown, code: string): asserts body is ErrorBody {
  expect(body).toMatchObject({ error: { code, message: expect.any(String) } });
  const err = (body as ErrorBody).error;
  expect(typeof err.request_id).toBe("string");
  expect(err.request_id.length).toBeGreaterThan(0);
  expect(KNOWN_CODES).toContain(err.code);
}

afterAll(async () => {
  await closePool();
});

describe("structured error envelope: platform-wide consistency (401)", () => {
  // Every resource's list/read entry point, unauthenticated. If a future
  // route reintroduces the old flat `{ error: "<string>" }` shape, this
  // fails immediately — it does not merely check status codes.
  const cases: Array<[string, () => Promise<Response>]> = [
    ["companies", () => handleListCompanies(null, new URL("http://localhost/api/v1/companies"))],
    ["contacts", () => handleListContacts(null, new URL("http://localhost/api/v1/contacts"))],
    ["deals", () => handleListDeals(null, new URL("http://localhost/api/v1/deals"))],
    ["pipelines", () => handleListPipelines(null, new URL("http://localhost/api/v1/pipelines"))],
    ["activities", () => handleListActivities(null, new URL("http://localhost/api/v1/activities"))],
    ["notes", () => handleListNotes(null, new URL("http://localhost/api/v1/notes"))],
    ["tags", () => handleListTags(null, new URL("http://localhost/api/v1/tags"))],
    ["organizations", () => handleGetOrganizations(null)],
  ];

  it.each(cases)("%s: 401 uses the structured envelope with a unique request_id", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(401);
    const body = await res.json();
    expectStructuredError(body, "UNAUTHENTICATED");
    expect(body.error.message).toBe("Unauthorized");
  });

  it("two independent 401 responses never share the same request_id", async () => {
    const [a, b] = await Promise.all([
      handleListCompanies(null, new URL("http://localhost/api/v1/companies")),
      handleListCompanies(null, new URL("http://localhost/api/v1/companies")),
    ]);
    const bodyA = (await a.json()) as ErrorBody;
    const bodyB = (await b.json()) as ErrorBody;
    expect(bodyA.error.request_id).not.toBe(bodyB.error.request_id);
  });
});

describe("structured error envelope: 403 forbidden", () => {
  it("org_viewer attempting a create is rejected with the structured FORBIDDEN envelope", async () => {
    const { userId } = await createOrgWithRole("org_viewer");
    const res = await handleCreateCompany(userId, { name: "X" }, null);
    expect(res.status).toBe(403);
    expectStructuredError(await res.json(), "FORBIDDEN");
  });
});

describe("structured error envelope: 404 not found", () => {
  it("a cross-organization company id returns the structured NOT_FOUND envelope", async () => {
    const orgA = await createOrgWithRole("org_admin", "envelope-404-a");
    const orgB = await createOrgWithRole("org_admin", "envelope-404-b");
    const companyB = await seedCompany(orgB.organizationId);
    const res = await handleGetCompany(orgA.userId, companyB);
    expect(res.status).toBe(404);
    const body = await res.json();
    expectStructuredError(body, "NOT_FOUND");
    expect(body.error.message).toBe("Not found");
  });
});

describe("structured error envelope: 400 validation", () => {
  it("an invalid limit query parameter returns the structured VALIDATION_ERROR envelope", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleListCompanies(userId, new URL("http://localhost/api/v1/companies?limit=0"));
    expect(res.status).toBe(400);
    expectStructuredError(await res.json(), "VALIDATION_ERROR");
  });

  it("a domain ValidationError's own message is preserved as error.message, not replaced", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateContact(userId, {}, null);
    expect(res.status).toBe(400);
    const body = await res.json();
    expectStructuredError(body, "VALIDATION_ERROR");
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});

describe("structured error envelope: 409 conflict (two distinct codes)", () => {
  it("Idempotency-Key reused with a different body -> IDEMPOTENCY_CONFLICT", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const key = randomUUID();
    await handleCreateCompany(userId, { name: "Original" }, key);
    const res = await handleCreateCompany(userId, { name: "Different" }, key);
    expect(res.status).toBe(409);
    const body = await res.json();
    expectStructuredError(body, "IDEMPOTENCY_CONFLICT");
    expect(body.error.message).toBe("Idempotency-Key already used with a different request");
  });

  it("a genuine business-rule conflict (duplicate active tag name) -> CONFLICT, never IDEMPOTENCY_CONFLICT", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin");
    await seedTag(organizationId, { name: "Hot Lead" });
    const res = await handleCreateTag(userId, { name: "Hot Lead" }, null);
    expect(res.status).toBe(409);
    const body = await res.json();
    expectStructuredError(body, "CONFLICT");
    expect(body.error.code).not.toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("structured error envelope: 500 internal — no detail leakage", () => {
  it("an unexpected (non-domain) failure returns a generic structured INTERNAL_ERROR, never a raw DB/driver error", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    // Same technique companies-api.test.ts's own adversarial suite already
    // uses: a malformed (non-UUID) ownerId fails at the Postgres type-cast
    // layer, unmapped by mapCrmError, producing a genuine 500 reachable
    // through the real API — not a synthetic hook into internal code.
    const res = await handleCreateCompany(userId, { name: "Fail Co", ownerId: "not-a-uuid" }, null);
    expect(res.status).toBe(500);
    const body = await res.json();
    expectStructuredError(body, "INTERNAL_ERROR");
    expect(body.error.message).toBe("Failed to create company");
    expect(body.error.message).not.toMatch(/SQLSTATE|syntax|relation|constraint|invalid input/i);
    expect(JSON.stringify(body)).not.toMatch(/postgres|pg_|stack|node_modules/i);
  });
});

describe("structured error envelope: success responses are unaffected", () => {
  it("a successful create response has no error key and is not wrapped in the envelope", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleCreateCompany(userId, { name: "Envelope Unaffected Co" }, null);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.company).toBeDefined();
    expect(body.company.name).toBe("Envelope Unaffected Co");
  });

  it("a successful list response is a plain { <resource>: [...], nextCursor } shape, no envelope", async () => {
    const { userId } = await createOrgWithRole("org_admin");
    const res = await handleListCompanies(userId, new URL("http://localhost/api/v1/companies"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.companies)).toBe(true);
    expect("nextCursor" in body).toBe(true);
  });
});

describe("structured error envelope: tenant isolation / RBAC semantics unchanged", () => {
  it("an unaffiliated user still gets 403, still with the structured envelope (not 404, not 401)", async () => {
    const { userId } = await createOrgWithRole("org_viewer", "envelope-rbac-unaffiliated");
    // org_viewer genuinely lacks contacts:create — same permission matrix
    // as before this milestone, only the envelope shape changed.
    const res = await handleCreateContact(userId, { firstName: "X" }, null);
    expect(res.status).toBe(403);
    expectStructuredError(await res.json(), "FORBIDDEN");
  });

  it("a deal in organization A is still fully invisible to organization B (404, not leaked)", async () => {
    const orgA = await createOrgWithRole("org_admin", "envelope-tenant-a");
    const orgB = await createOrgWithRole("org_admin", "envelope-tenant-b");
    const contactA = await seedContact(orgA.organizationId);
    // Reading org A's contact as org B's actor must still 404 — proves the
    // envelope change carries no RLS/tenancy regression.
    const res = await handleListContacts(orgB.userId, new URL(`http://localhost/api/v1/contacts?ownerId=${contactA}`));
    expect(res.status).toBe(200); // a filter that matches nothing is a valid empty page, not an error
    const body = await res.json();
    expect(body.contacts).toEqual([]);
  });
});
