import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrg, seedAsAdmin } from "./helpers";
import { computeScore, recalculateContactScore, type ScoringRuleRow } from "../src/scoring";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function createContact(
  organizationId: string,
  opts: { jobTitle?: string; lifecycleStage?: string; companyId?: string | null; deleted?: boolean } = {},
): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.contacts (organization_id, first_name, job_title, lifecycle_stage, company_id, deleted_at) values ($1, $2, $3, $4, $5, $6) returning id",
      [
        organizationId,
        "Test",
        opts.jobTitle ?? null,
        opts.lifecycleStage ?? null,
        opts.companyId ?? null,
        opts.deleted ? new Date().toISOString() : null,
      ],
    );
    return r.rows[0]!.id;
  });
}

async function createCompany(
  organizationId: string,
  opts: { industry?: string; employeeCount?: number; annualRevenue?: number } = {},
): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.companies (organization_id, name, industry, employee_count, annual_revenue) values ($1, $2, $3, $4, $5) returning id",
      [organizationId, "Test Co", opts.industry ?? null, opts.employeeCount ?? null, opts.annualRevenue ?? null],
    );
    return r.rows[0]!.id;
  });
}

async function createRule(
  organizationId: string,
  rule: { field: string; operator: string; value: unknown; weight: number; isActive?: boolean },
): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>(
      "insert into public.scoring_rules (organization_id, name, field, operator, value, weight, is_active) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [organizationId, `rule-${randomUUID()}`, rule.field, rule.operator, JSON.stringify(rule.value), rule.weight, rule.isActive ?? true],
    );
    return r.rows[0]!.id;
  });
}

describe("computeScore: pure-function operator semantics", () => {
  const baseFacts = {
    "company.industry": "SaaS",
    "company.employee_count": 150,
    "company.annual_revenue": 5_000_000,
    "contact.job_title": "VP of Sales",
    "contact.lifecycle_stage": "prospect",
    "contact.enrichment_completed": true,
    "company.enrichment_completed": false,
    "engagement.pageviews_30d": 12,
    "engagement.form_submits_30d": 1,
    "engagement.sessions_30d": 3,
    "engagement.last_seen_days_ago": 2,
  } as const;

  it.each([
    ["eq", "company.industry", "SaaS", true],
    ["eq", "company.industry", "Fintech", false],
    ["neq", "company.industry", "Fintech", true],
    ["gt", "company.employee_count", 100, true],
    ["gt", "company.employee_count", 150, false],
    ["gte", "company.employee_count", 150, true],
    ["lt", "engagement.pageviews_30d", 20, true],
    ["lte", "engagement.pageviews_30d", 12, true],
    ["in", "contact.lifecycle_stage", ["lead", "prospect"], true],
    ["in", "contact.lifecycle_stage", ["customer"], false],
    ["contains", "contact.job_title", "VP", true],
    ["contains", "contact.job_title", "Engineer", false],
    ["exists", "company.industry", null, true],
  ] as const)("%s on %s with %j -> %s", (operator, field, value, expected) => {
    const rule: ScoringRuleRow = { id: "r1", field: field as never, operator: operator as never, value, weight: 10 };
    const { breakdown } = computeScore(baseFacts, [rule]);
    expect(breakdown[0]!.matched).toBe(expected);
  });

  it("a rule referencing a null field never matches (except exists) and never throws", () => {
    const facts = { ...baseFacts, "company.industry": null };
    const rule: ScoringRuleRow = { id: "r1", field: "company.industry", operator: "eq", value: "SaaS", weight: 10 };
    expect(() => computeScore(facts, [rule])).not.toThrow();
    expect(computeScore(facts, [rule]).breakdown[0]!.matched).toBe(false);

    const existsRule: ScoringRuleRow = { id: "r2", field: "company.industry", operator: "exists", value: null, weight: 10 };
    expect(computeScore(facts, [existsRule]).breakdown[0]!.matched).toBe(false);
  });

  it("matched rules sum their weights; unmatched rules contribute zero", () => {
    const rules: ScoringRuleRow[] = [
      { id: "r1", field: "company.industry", operator: "eq", value: "SaaS", weight: 20 },
      { id: "r2", field: "company.industry", operator: "eq", value: "Fintech", weight: 50 },
      { id: "r3", field: "engagement.pageviews_30d", operator: "gt", value: 5, weight: -10 },
    ];
    const { score, breakdown } = computeScore(baseFacts, rules);
    expect(score).toBe(10); // +20 (matched) + 0 (unmatched) - 10 (matched, negative weight)
    expect(breakdown.map((b) => b.contribution)).toEqual([20, 0, -10]);
  });

  it("score is clamped to [0, 100] even when summed weights exceed either bound", () => {
    const highRules: ScoringRuleRow[] = [
      { id: "r1", field: "company.industry", operator: "eq", value: "SaaS", weight: 100 },
      { id: "r2", field: "contact.job_title", operator: "contains", value: "VP", weight: 100 },
    ];
    expect(computeScore(baseFacts, highRules).score).toBe(100);

    const lowRules: ScoringRuleRow[] = [
      { id: "r1", field: "company.industry", operator: "eq", value: "SaaS", weight: -100 },
      { id: "r2", field: "contact.job_title", operator: "contains", value: "VP", weight: -100 },
    ];
    expect(computeScore(baseFacts, lowRules).score).toBe(0);
  });

  it("no rules produces a score of exactly 0 with an empty breakdown", () => {
    const { score, breakdown } = computeScore(baseFacts, []);
    expect(score).toBe(0);
    expect(breakdown).toEqual([]);
  });
});

describe("recalculateContactScore: real Postgres integration", () => {
  it("computes a score from real company/contact facts and grades it deterministically", async () => {
    const organizationId = await createOrg();
    const companyId = await createCompany(organizationId, { industry: "SaaS", employeeCount: 200 });
    const contactId = await createContact(organizationId, { jobTitle: "VP of Sales", companyId });
    await createRule(organizationId, { field: "company.industry", operator: "eq", value: "SaaS", weight: 40 });
    await createRule(organizationId, { field: "contact.job_title", operator: "contains", value: "VP", weight: 45 });

    const result = await recalculateContactScore({ organizationId }, { contactId });
    expect(result).toEqual({ accepted: true, score: 85, grade: "A" });

    const row = await seedAsAdmin((c) =>
      c.query("select score, grade, breakdown from public.lead_scores where contact_id = $1", [contactId]),
    );
    expect(row.rows[0].score).toBe(85);
    expect(row.rows[0].grade).toBe("A");
    expect(row.rows[0].breakdown).toHaveLength(2);
  });

  it("a nonexistent contact is rejected", async () => {
    const organizationId = await createOrg();
    const result = await recalculateContactScore({ organizationId }, { contactId: randomUUID() });
    expect(result).toEqual({ accepted: false, reason: "contact_not_found" });
  });

  it("a soft-deleted contact is rejected identically to a nonexistent one", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId, { deleted: true });
    const result = await recalculateContactScore({ organizationId }, { contactId });
    expect(result).toEqual({ accepted: false, reason: "contact_not_found" });
  });

  it("a contact belonging to a different organization is rejected, indistinguishably from nonexistent", async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const contactInOrgA = await createContact(orgA);
    const result = await recalculateContactScore({ organizationId: orgB }, { contactId: contactInOrgA });
    expect(result).toEqual({ accepted: false, reason: "contact_not_found" });
  });

  it("a contact with no matching rules scores 0, grade D", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    await createRule(organizationId, { field: "company.industry", operator: "eq", value: "Fintech", weight: 50 });
    const result = await recalculateContactScore({ organizationId }, { contactId });
    expect(result).toEqual({ accepted: true, score: 0, grade: "D" });
  });

  it("a disabled rule never contributes", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId, { lifecycleStage: "prospect" });
    await createRule(organizationId, { field: "contact.lifecycle_stage", operator: "eq", value: "prospect", weight: 60, isActive: false });
    const result = await recalculateContactScore({ organizationId }, { contactId });
    expect(result).toEqual({ accepted: true, score: 0, grade: "D" });
  });

  it("historized: two recalculations for the same contact both persist as independent rows, never overwriting each other", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    await recalculateContactScore({ organizationId }, { contactId });
    await recalculateContactScore({ organizationId }, { contactId });
    const rows = await seedAsAdmin((c) =>
      c.query("select count(*)::int as n from public.lead_scores where contact_id = $1", [contactId]),
    );
    expect(rows.rows[0].n).toBe(2);
  });

  it("real engagement signals (pageviews/sessions/form_submits/recency) feed the score via an identified visitor", async () => {
    const organizationId = await createOrg();
    const contactId = await createContact(organizationId);
    const siteId = await seedAsAdmin(async (c) => {
      const r = await c.query<{ id: string }>("insert into public.tracking_sites (organization_id, label) values ($1, 'Site') returning id", [organizationId]);
      return r.rows[0]!.id;
    });
    const visitorId = await seedAsAdmin(async (c) => {
      const r = await c.query<{ id: string }>(
        "insert into public.website_visitors (organization_id, anonymous_id, identified_contact_id) values ($1, $2, $3) returning id",
        [organizationId, randomUUID(), contactId],
      );
      return r.rows[0]!.id;
    });
    const sessionId = await seedAsAdmin(async (c) => {
      const r = await c.query<{ id: string }>(
        "insert into public.visitor_sessions (organization_id, visitor_id, tracking_site_id, anonymous_session_id) values ($1, $2, $3, $4) returning id",
        [organizationId, visitorId, siteId, randomUUID()],
      );
      return r.rows[0]!.id;
    });
    await seedAsAdmin((c) =>
      c.query("insert into public.visitor_events (organization_id, session_id, event_type) values ($1, $2, 'pageview'), ($1, $2, 'pageview'), ($1, $2, 'form_submit')", [
        organizationId,
        sessionId,
      ]),
    );

    await createRule(organizationId, { field: "engagement.pageviews_30d", operator: "gte", value: 2, weight: 30 });
    await createRule(organizationId, { field: "engagement.form_submits_30d", operator: "gte", value: 1, weight: 25 });
    await createRule(organizationId, { field: "engagement.last_seen_days_ago", operator: "lte", value: 30, weight: 20 });

    const result = await recalculateContactScore({ organizationId }, { contactId });
    expect(result).toEqual({ accepted: true, score: 75, grade: "B" });
  });
});
