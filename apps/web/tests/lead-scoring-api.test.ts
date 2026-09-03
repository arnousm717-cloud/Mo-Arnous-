import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrgWithRole, createPureAgencyActor, seedContact } from "./crm-api-fixtures";
import { handleGetContactLeadScores } from "../app/api/v1/contacts/[id]/lead-scores/handlers";
import { handleRecalculateContactScore } from "../app/api/v1/contacts/[id]/lead-scores/recalculate/handlers";
import { handleListScoringRules, handleCreateScoringRule } from "../app/api/v1/scoring-rules/handlers";
import { handleUpdateScoringRule } from "../app/api/v1/scoring-rules/[id]/handlers";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.4D — HTTP-level coverage for the session-authenticated
 * staff lead-score read/recalculate and scoring-rule CRUD endpoints.
 * Direct handler invocation, no running server, real Postgres — mirrors
 * contacts-api.test.ts's own style exactly.
 */

function scoresUrl(params: Record<string, string> = {}): URL {
  const url = new URL("http://localhost/api/v1/contacts/x/lead-scores");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

async function seedRule(
  organizationId: string,
  overrides: { field?: string; operator?: string; value?: unknown; weight?: number; name?: string } = {},
): Promise<string> {
  const client = await adminPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      `insert into public.scoring_rules (organization_id, name, field, operator, value, weight)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        organizationId,
        overrides.name ?? `Rule ${randomUUID()}`,
        overrides.field ?? "contact.lifecycle_stage",
        overrides.operator ?? "eq",
        JSON.stringify(overrides.value ?? "customer"),
        overrides.weight ?? 25,
      ],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await closePool();
});

describe("lead-scores API: auth", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleGetContactLeadScores(null, randomUUID(), scoresUrl())).status).toBe(401);
    expect((await handleRecalculateContactScore(null, randomUUID())).status).toBe(401);
  });
});

describe("lead-scores API: RBAC", () => {
  it("org_viewer can read lead scores but not trigger a recalculation (contacts:update required)", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_viewer", "leadscore-viewer");
    const contactId = await seedContact(organizationId);
    expect((await handleGetContactLeadScores(userId, contactId, scoresUrl())).status).toBe(200);
    expect((await handleRecalculateContactScore(userId, contactId)).status).toBe(403);
  });

  it("a pure agency actor gets 403 on every verb", async () => {
    const userId = await createPureAgencyActor();
    expect((await handleGetContactLeadScores(userId, randomUUID(), scoresUrl())).status).toBe(403);
    expect((await handleRecalculateContactScore(userId, randomUUID())).status).toBe(403);
  });
});

describe("lead-scores API: read/recalculate behavior", () => {
  it("no score yet -> latest is null and history is empty; recalculate -> latest reflects the new score", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin", "leadscore-lifecycle");
    const contactId = await seedContact(organizationId);
    await adminPool.query("update public.contacts set lifecycle_stage = 'customer' where id = $1", [contactId]);
    await seedRule(organizationId, { field: "contact.lifecycle_stage", operator: "eq", value: "customer", weight: 40 });

    const beforeLatest = await handleGetContactLeadScores(userId, contactId, scoresUrl({ latest: "true" }));
    expect((await beforeLatest.json()).score).toBeNull();

    const beforeHistory = await handleGetContactLeadScores(userId, contactId, scoresUrl());
    expect((await beforeHistory.json()).scores).toEqual([]);

    const recalced = await handleRecalculateContactScore(userId, contactId);
    expect(recalced.status).toBe(200);
    const recalcedBody = await recalced.json();
    expect(recalcedBody.score.score).toBe(40);
    expect(recalcedBody.score.grade).toBe("C");

    const afterLatest = await handleGetContactLeadScores(userId, contactId, scoresUrl({ latest: "true" }));
    const latestBody = await afterLatest.json();
    expect(latestBody.score.score).toBe(40);

    const afterHistory = await handleGetContactLeadScores(userId, contactId, scoresUrl());
    expect((await afterHistory.json()).scores).toHaveLength(1);
  });

  it("cross-org contact id -> 404 for both read and recalculate, indistinguishable from nonexistent", async () => {
    const orgA = await createOrgWithRole("org_admin", "leadscore-a");
    const orgB = await createOrgWithRole("org_admin", "leadscore-b");
    const contactB = await seedContact(orgB.organizationId);
    const nonexistentId = randomUUID();

    const crossGet = await handleGetContactLeadScores(orgA.userId, contactB, scoresUrl());
    const missingGet = await handleGetContactLeadScores(orgA.userId, nonexistentId, scoresUrl());
    expect(crossGet.status).toBe(404);
    expect(missingGet.status).toBe(404);

    expect((await handleRecalculateContactScore(orgA.userId, contactB)).status).toBe(404);
    expect((await handleRecalculateContactScore(orgA.userId, nonexistentId)).status).toBe(404);
  });

  it("malformed cursor -> 400; invalid limit -> 400", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin", "leadscore-cursor");
    const contactId = await seedContact(organizationId);
    expect((await handleGetContactLeadScores(userId, contactId, scoresUrl({ cursor: "not-valid!!" }))).status).toBe(400);
    expect((await handleGetContactLeadScores(userId, contactId, scoresUrl({ limit: "0" }))).status).toBe(400);
    expect((await handleGetContactLeadScores(userId, contactId, scoresUrl({ limit: "101" }))).status).toBe(400);
  });
});

describe("scoring-rules API: auth and RBAC", () => {
  it("every verb rejects an unauthenticated caller with 401", async () => {
    expect((await handleListScoringRules(null)).status).toBe(401);
    expect((await handleCreateScoringRule(null, {})).status).toBe(401);
    expect((await handleUpdateScoringRule(null, randomUUID(), {})).status).toBe(401);
  });

  it("only org_admin has scoring-rules:read/write — org_member and org_viewer get 403 on every verb", async () => {
    for (const role of ["org_member", "org_viewer"] as const) {
      const { userId } = await createOrgWithRole(role, `scoring-rbac-${role}`);
      expect((await handleListScoringRules(userId)).status).toBe(403);
      expect(
        (
          await handleCreateScoringRule(userId, {
            name: "X",
            field: "contact.lifecycle_stage",
            operator: "eq",
            value: "customer",
            weight: 10,
          })
        ).status,
      ).toBe(403);
      expect((await handleUpdateScoringRule(userId, randomUUID(), { weight: 5 })).status).toBe(403);
    }
  });
});

describe("scoring-rules API: CRUD", () => {
  it("create -> 201, list includes it, patch -> 200 with updated fields", async () => {
    const { userId } = await createOrgWithRole("org_admin", "scoring-crud");
    const created = await handleCreateScoringRule(userId, {
      name: "High employee count",
      field: "company.employee_count",
      operator: "gte",
      value: 500,
      weight: 30,
    });
    expect(created.status).toBe(201);
    const { rule } = await created.json();
    expect(rule.weight).toBe(30);
    expect(rule.isActive).toBe(true);

    const listed = await handleListScoringRules(userId);
    const listedBody = await listed.json();
    expect(listedBody.rules.map((r: { id: string }) => r.id)).toContain(rule.id);

    const patched = await handleUpdateScoringRule(userId, rule.id, { weight: 55, isActive: false });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.rule.weight).toBe(55);
    expect(patchedBody.rule.isActive).toBe(false);
  });

  it("cross-org rule id on PATCH -> 404", async () => {
    const orgA = await createOrgWithRole("org_admin", "scoring-cross-a");
    const orgB = await createOrgWithRole("org_admin", "scoring-cross-b");
    const ruleB = await seedRule(orgB.organizationId);
    expect((await handleUpdateScoringRule(orgA.userId, ruleB, { weight: 1 })).status).toBe(404);
  });
});

describe("scoring-rules API: strict allowlist validation — hostile inputs", () => {
  it("rejects an unrecognized field with 400", async () => {
    const { userId } = await createOrgWithRole("org_admin", "scoring-hostile-field");
    const res = await handleCreateScoringRule(userId, { name: "X", field: "nope.field", operator: "eq", value: "x", weight: 1 });
    expect(res.status).toBe(400);
  });

  it.each(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"])(
    "Milestone 3.4 Targeted Acceptance Remediation, Finding 1 — a prototype-chain field name (%s) is rejected with a clean 400 on POST, never a 500/uncaught exception, and creates zero rows",
    async (hostileField) => {
      const { organizationId, userId } = await createOrgWithRole("org_admin", `scoring-proto-post-${hostileField}`);
      const res = await handleCreateScoringRule(userId, { name: "X", field: hostileField, operator: "exists", weight: 1 });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const rows = await adminPool.query("select count(*)::int as n from public.scoring_rules where organization_id = $1", [organizationId]);
      expect(rows.rows[0].n).toBe(0);
    },
  );

  it.each(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"])(
    "Milestone 3.4 Targeted Acceptance Remediation, Finding 1 — a prototype-chain field name (%s) is rejected with a clean 400 on PATCH, never a 500/uncaught exception, and leaves the existing rule unmodified",
    async (hostileField) => {
      const { organizationId, userId } = await createOrgWithRole("org_admin", `scoring-proto-patch-${hostileField}`);
      const ruleId = await seedRule(organizationId, { field: "contact.job_title", operator: "eq", value: "CEO", weight: 25 });
      const res = await handleUpdateScoringRule(userId, ruleId, { field: hostileField, operator: "exists" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      const row = await adminPool.query("select field, operator, weight from public.scoring_rules where id = $1", [ruleId]);
      expect(row.rows[0]).toEqual({ field: "contact.job_title", operator: "eq", weight: 25 });
    },
  );

  it("an ordinary unknown field name still behaves identically to a prototype-chain name (both are 'not in the allowlist', not two different code paths)", async () => {
    const { userId } = await createOrgWithRole("org_admin", "scoring-proto-parity");
    const ordinary = await handleCreateScoringRule(userId, { name: "X", field: "not.a.real.field", operator: "exists", weight: 1 });
    const prototypeChain = await handleCreateScoringRule(userId, { name: "X", field: "__proto__", operator: "exists", weight: 1 });
    expect(ordinary.status).toBe(prototypeChain.status);
    const ordinaryBody = await ordinary.json();
    const protoBody = await prototypeChain.json();
    expect(ordinaryBody.error.code).toBe(protoBody.error.code);
    expect(ordinaryBody.error.message).toBe(protoBody.error.message);
  });

  it("valid fields remain completely unaffected by the Finding 1 fix — create, list, and patch all still work", async () => {
    const { userId } = await createOrgWithRole("org_admin", "scoring-proto-regression");
    const created = await handleCreateScoringRule(userId, {
      name: "Valid rule",
      field: "company.employee_count",
      operator: "gt",
      value: 50,
      weight: 20,
    });
    expect(created.status).toBe(201);
    const { rule } = await created.json();
    expect(rule.field).toBe("company.employee_count");

    const patched = await handleUpdateScoringRule(userId, rule.id, { field: "contact.enrichment_completed", operator: "exists" });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.rule.field).toBe("contact.enrichment_completed");
  });

  it("rejects an operator not valid for the field's type with 400", async () => {
    const { userId } = await createOrgWithRole("org_admin", "scoring-hostile-operator");
    const res = await handleCreateScoringRule(userId, {
      name: "X",
      field: "contact.lifecycle_stage",
      operator: "gt",
      value: "customer",
      weight: 1,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a value of the wrong shape for the field's type with 400", async () => {
    const { userId } = await createOrgWithRole("org_admin", "scoring-hostile-value");
    const res = await handleCreateScoringRule(userId, {
      name: "X",
      field: "company.employee_count",
      operator: "gt",
      value: "not-a-number",
      weight: 1,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a weight out of the [-100, 100] bound with 400", async () => {
    const { userId } = await createOrgWithRole("org_admin", "scoring-hostile-weight");
    const res = await handleCreateScoringRule(userId, {
      name: "X",
      field: "contact.lifecycle_stage",
      operator: "eq",
      value: "customer",
      weight: 500,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an attempt to smuggle an executable expression as a field/value with 400 — never reaches the evaluator", async () => {
    const { userId } = await createOrgWithRole("org_admin", "scoring-hostile-injection");
    const res = await handleCreateScoringRule(userId, {
      name: "X",
      field: "1=1; DROP TABLE contacts;--",
      operator: "eq",
      value: "x",
      weight: 1,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown top-level field (mass-assignment attempt) with 400", async () => {
    const { userId } = await createOrgWithRole("org_admin", "scoring-hostile-mass-assignment");
    const res = await handleCreateScoringRule(userId, {
      name: "X",
      field: "contact.lifecycle_stage",
      operator: "eq",
      value: "customer",
      weight: 1,
      organizationId: randomUUID(),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects field without operator (partial condition update) with 400", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin", "scoring-hostile-patch");
    const ruleId = await seedRule(organizationId);
    const res = await handleUpdateScoringRule(userId, ruleId, { field: "company.employee_count" });
    expect(res.status).toBe(400);
  });

  it("PATCH with an empty body -> 400", async () => {
    const { organizationId, userId } = await createOrgWithRole("org_admin", "scoring-hostile-empty-patch");
    const ruleId = await seedRule(organizationId);
    const res = await handleUpdateScoringRule(userId, ruleId, {});
    expect(res.status).toBe(400);
  });
});
