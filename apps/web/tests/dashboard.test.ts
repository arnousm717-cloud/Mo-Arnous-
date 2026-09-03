import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, afterAll } from "vitest";
import { closePool, getPool } from "@ai-revenue-os/database";
import {
  getDealDashboardMetrics,
  listDeals,
  softDeleteDeal,
  softDeletePipelineStage,
  softDeleteContact,
  type DealDashboardMetrics,
  type DealsByStageMetric,
  type Deal,
} from "@ai-revenue-os/crm";
import {
  getLeadScoreDistribution,
  getHighScoreContacts,
  getIdentifiedVisitorMetrics,
  type HighScoreContact,
} from "@ai-revenue-os/intelligence";
import {
  createOrgWithRole,
  seedPipeline,
  seedPipelineStage,
  seedPipelineWithStage,
  seedContact,
} from "./crm-api-fixtures";
import { canViewDealKpis } from "../app/dashboard/kpi-access";
import { buildDealKpiViewModel } from "../app/dashboard/kpi-view-model";
import { buildStageOverviewViewModel } from "../app/dashboard/stage-overview-view-model";
import { canViewLeadIntelligence } from "../app/dashboard/lead-intelligence-access";
import { buildLeadScoreDistributionViewModel } from "../app/dashboard/lead-score-distribution-view-model";
import { buildHighScoreContactsViewModel } from "../app/dashboard/high-score-contacts-view-model";
import { buildRecentDealsViewModel } from "../app/dashboard/recent-deals-view-model";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 3.5B. Mirrors this repo's own established page-test
 * convention (deals-board.test.ts, contacts-console.test.ts): no jsdom/
 * @testing-library exist in this dependency tree, so page-level coverage
 * targets the pure, extracted logic (kpi-access.ts, kpi-view-model.ts)
 * plus real end-to-end domain calls against Postgres, never a rendered
 * DOM. getDealDashboardMetrics' own aggregate correctness (currency
 * segregation, latest-row semantics, tenant isolation, soft-delete
 * exclusion) is already exhaustively covered by packages/crm/tests/
 * dashboard-metrics.test.ts — re-verified here only where this page's own
 * NEW wiring (the view-model transform, the deals:read content gate)
 * could independently break it.
 */

afterAll(async () => {
  await closePool();
});

/** crm-api-fixtures' seedDeal has no amount/currency/status overrides --
 * this page-local helper mirrors its exact direct-SQL style for the
 * fixtures this test file specifically needs. `status` defaults to
 * 'open' (the column's own DB default) since this is a raw-SQL fixture,
 * not the packages/crm domain layer -- deriveDealStatus (the sole real
 * status-computation path) never runs here, so a deal seeded onto a
 * won/lost-flagged stage must have its status set explicitly. */
async function seedDealWithAmount(
  organizationId: string,
  pipelineId: string,
  stageId: string,
  amount: number | null,
  currency = "EUR",
  status: "open" | "won" | "lost" = "open",
): Promise<string> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: string }>(
      `insert into public.deals (organization_id, pipeline_id, stage_id, amount, currency, status) values ($1, $2, $3, $4, $5, $6) returning id`,
      [organizationId, pipelineId, stageId, amount, currency, status],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

describe("canViewDealKpis: content gate (deals:read, no new permission)", () => {
  it.each(["org_admin", "org_member", "org_viewer"] as const)("%s can view the KPI row", (roleKey) => {
    expect(canViewDealKpis({ userId: "u", organizationId: "o", roleKey })).toBe(true);
  });

  it.each(["agency_owner", "agency_admin", "portal_customer"] as const)(
    "%s (no deals:read) cannot view the KPI row",
    (roleKey) => {
      expect(canViewDealKpis({ userId: "u", organizationId: "o", roleKey })).toBe(false);
    },
  );

  it("no actor (unauthenticated) cannot view the KPI row", () => {
    expect(canViewDealKpis(null)).toBe(false);
  });
});

describe("buildDealKpiViewModel: Open Deals", () => {
  it("renders the count as-is", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({ openDealCount: 7 }));
    expect(vm.openDealCount).toBe(7);
  });

  it("zero open deals renders as 0, not a placeholder", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({ openDealCount: 0 }));
    expect(vm.openDealCount).toBe(0);
  });
});

describe("buildDealKpiViewModel: currency rendering", () => {
  it("a single currency renders one formatted line", () => {
    const vm = buildDealKpiViewModel(
      emptyMetrics({ openPipelineValueByCurrency: [{ currency: "EUR", totalAmount: "12500" }] }),
    );
    expect(vm.openPipelineValueLines).toEqual([{ currency: "EUR", formattedAmount: "12,500.00" }]);
  });

  it("mixed currencies render as separate lines, never summed into one", () => {
    const vm = buildDealKpiViewModel(
      emptyMetrics({
        openPipelineValueByCurrency: [
          { currency: "EUR", totalAmount: "12500" },
          { currency: "USD", totalAmount: "4200" },
        ],
      }),
    );
    expect(vm.openPipelineValueLines).toHaveLength(2);
    expect(vm.openPipelineValueLines).toEqual([
      { currency: "EUR", formattedAmount: "12,500.00" },
      { currency: "USD", formattedAmount: "4,200.00" },
    ]);
    // No combined-total field exists anywhere on the view model.
    expect(vm).not.toHaveProperty("totalOpenPipelineValue");
  });

  it("no monetary data renders a truthful empty state (empty array, not a fabricated zero line)", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({ openPipelineValueByCurrency: [] }));
    expect(vm.openPipelineValueLines).toEqual([]);
  });

  it("an unrecognized-but-schema-valid currency code never throws", () => {
    // deals.currency is regex-validated as three uppercase letters only
    // (packages/crm/src/deals.ts) -- "ZZZ" passes that check but is not a
    // real ISO 4217 code, which Intl.NumberFormat's currency style would
    // reject. This view model must format it anyway, not crash the page.
    expect(() =>
      buildDealKpiViewModel(emptyMetrics({ openPipelineValueByCurrency: [{ currency: "ZZZ", totalAmount: "100" }] })),
    ).not.toThrow();
  });
});

describe("buildDealKpiViewModel: NULL-amount disclosure", () => {
  it("discloses the count of open deals with no amount set", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({ openDealsWithNullAmountCount: 2 }));
    expect(vm.nullAmountDisclosure).toBe("2 open deals have no amount set.");
  });

  it("uses singular phrasing for exactly one", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({ openDealsWithNullAmountCount: 1 }));
    expect(vm.nullAmountDisclosure).toBe("1 open deal has no amount set.");
  });

  it("is null (no disclosure rendered) when every open deal has an amount", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({ openDealsWithNullAmountCount: 0 }));
    expect(vm.nullAmountDisclosure).toBeNull();
  });

  it("a NULL amount is never displayed as a fabricated 0 currency line", () => {
    // All open deals lack an amount: the sum is genuinely absent data,
    // not a real total of zero -- the currency-lines array must stay
    // empty, never contain e.g. { currency: "EUR", formattedAmount: "0.00" }.
    const vm = buildDealKpiViewModel(
      emptyMetrics({ openDealCount: 3, openDealsWithNullAmountCount: 3, openPipelineValueByCurrency: [] }),
    );
    expect(vm.openPipelineValueLines).toEqual([]);
    expect(vm.nullAmountDisclosure).toBe("3 open deals have no amount set.");
  });
});

describe("buildDealKpiViewModel: win rate", () => {
  it("renders won/(won+lost) as a rounded percentage", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({ winRate: 0.75 }));
    expect(vm.winRateLabel).toBe("75%");
  });

  it("a null denominator (no closed deals) renders a truthful label, never 0%", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({ winRate: null }));
    expect(vm.winRateLabel).toBe("No closed deals yet");
    expect(vm.winRateLabel).not.toContain("0%");
  });

  it("an actual 0% win rate (closed deals exist, none won) still renders 0%, distinct from no-data", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({ winRate: 0 }));
    expect(vm.winRateLabel).toBe("0%");
  });
});

describe("buildDealKpiViewModel: average open deal size", () => {
  it("a single currency renders one formatted line", () => {
    const vm = buildDealKpiViewModel(
      emptyMetrics({ averageOpenDealSizeByCurrency: [{ currency: "EUR", totalAmount: "4200" }] }),
    );
    expect(vm.averageOpenDealSizeLines).toEqual([{ currency: "EUR", formattedAmount: "4,200.00" }]);
  });

  it("mixed currencies render as separate lines, never averaged together", () => {
    const vm = buildDealKpiViewModel(
      emptyMetrics({
        averageOpenDealSizeByCurrency: [
          { currency: "EUR", totalAmount: "4200" },
          { currency: "USD", totalAmount: "3100" },
        ],
      }),
    );
    expect(vm.averageOpenDealSizeLines).toHaveLength(2);
  });

  it("no open deal amounts renders a truthful empty state", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({ averageOpenDealSizeByCurrency: [] }));
    expect(vm.averageOpenDealSizeLines).toEqual([]);
  });
});

describe("buildDealKpiViewModel: privacy — no forbidden fields", () => {
  it("exposes only the four KPI concepts, never PII or internal fields", () => {
    const vm = buildDealKpiViewModel(emptyMetrics({}));
    expect(Object.keys(vm).sort()).toEqual(
      ["averageOpenDealSizeLines", "nullAmountDisclosure", "openDealCount", "openPipelineValueLines", "winRateLabel"].sort(),
    );
  });
});

/** Strips /* block *\/ comments and import lines, so a source-scanning
 * test checks only code that actually executes/renders -- an explanatory
 * comment mentioning a forbidden word (e.g. this very file's own "never a
 * browser fetch()" doc comment) must never trip a test meant to catch a
 * REAL usage. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Strips a full import statement, single- or multi-line (e.g. a
    // brace-grouped `import {\n  a,\n  b,\n} from "pkg";`) -- a
    // line-by-line `startsWith("import")` filter alone misses every
    // continuation line of a multi-line import, which can otherwise
    // slip a package name like "@ai-revenue-os/intelligence" past a
    // forbidden-word scan undetected.
    .replace(/^import[\s\S]*?from\s+["'][^"']*["'];?$/gm, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("import"))
    .join("\n");
}

describe("Dashboard page source: forbidden wording and error-handling discipline", () => {
  const pageSource = readFileSync(join(__dirname, "../app/dashboard/page.tsx"), "utf8");

  it.each(["revenue", "mrr", "arr"])("never labels deal value with the forbidden word '%s'", (word) => {
    expect(codeOnly(pageSource)).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
  });

  it("does not catch/swallow the getDealDashboardMetrics call — a failure must propagate to error.tsx, never render as zero", () => {
    expect(pageSource).not.toMatch(/try\s*{[^}]*getDealDashboardMetrics/s);
    expect(pageSource).not.toContain("catch");
  });

  it("has a dedicated error boundary (mirrors the established apps/web/app/agency/error.tsx pattern)", () => {
    const errorSource = readFileSync(join(__dirname, "../app/dashboard/error.tsx"), "utf8");
    expect(errorSource).toContain("export default function");
    expect(errorSource).toContain("reset");
  });
});

describe("End-to-end: real domain data through the view-model pipeline", () => {
  it("organization-wide across multiple pipelines, excludes soft-deleted, isolates tenants, no PII leak", async () => {
    const admin = await createOrgWithRole("org_admin", "dashboard-e2e");
    const otherOrg = await createOrgWithRole("org_admin", "dashboard-e2e-other");

    const { pipelineId: pipelineA, stageId: openA } = await seedPipelineWithStage(admin.organizationId, {
      pipelineName: "Pipeline A",
    });
    const pipelineB = await seedPipeline(admin.organizationId, { name: "Pipeline B" });
    const openB = await seedPipelineStage(admin.organizationId, pipelineB, { name: "Open B", sortOrder: 10 });
    const wonB = await seedPipelineStage(admin.organizationId, pipelineB, {
      name: "Won B",
      sortOrder: 20,
      isWonStage: true,
    });

    await seedDealWithAmount(admin.organizationId, pipelineA, openA, 1000, "EUR");
    await seedDealWithAmount(admin.organizationId, pipelineB, openB, 500, "USD");
    const wonDealId = await seedDealWithAmount(admin.organizationId, pipelineB, wonB, 250, "EUR", "won");
    const toDeleteId = await seedDealWithAmount(admin.organizationId, pipelineA, openA, 99999, "EUR");

    // Noise in a different organization -- must never leak into org A's numbers.
    const { pipelineId: otherPipeline, stageId: otherStage } = await seedPipelineWithStage(otherOrg.organizationId);
    await seedDealWithAmount(otherOrg.organizationId, otherPipeline, otherStage, 777777, "EUR");

    const actor = { userId: admin.userId, organizationId: admin.organizationId, roleKey: admin.roleKey };
    await softDeleteDeal(actor, toDeleteId);
    void wonDealId;

    const vm = buildDealKpiViewModel(await getDealDashboardMetrics(actor));

    // Organization-wide: both pipelines' open deals counted (2 open, the
    // soft-deleted third one excluded).
    expect(vm.openDealCount).toBe(2);
    expect(vm.openPipelineValueLines).toEqual(
      expect.arrayContaining([
        { currency: "EUR", formattedAmount: "1,000.00" },
        { currency: "USD", formattedAmount: "500.00" },
      ]),
    );
    // The org-B noise deal's 777,777 EUR must never appear here.
    expect(vm.openPipelineValueLines.find((l) => l.currency === "EUR")?.formattedAmount).toBe("1,000.00");

    // No PII/internal field anywhere on the rendered view model.
    expect(JSON.stringify(vm)).not.toMatch(/@example\.test|contact|email|visitor/i);
  });
});

describe("buildStageOverviewViewModel: pipeline grouping", () => {
  it("groups stages under their own pipeline, preserving names and counts", () => {
    const vm = buildStageOverviewViewModel(
      emptyMetrics({
        dealsByStage: [
          stageRow("pipeline-a", "Pipeline A", "stage-a1", "Qualification", 4),
          stageRow("pipeline-a", "Pipeline A", "stage-a2", "Proposal", 2),
          stageRow("pipeline-b", "Pipeline B", "stage-b1", "New", 3),
        ],
      }),
    );

    expect(vm.pipelineGroups).toHaveLength(2);
    const pipelineA = vm.pipelineGroups.find((g) => g.pipelineId === "pipeline-a")!;
    const pipelineB = vm.pipelineGroups.find((g) => g.pipelineId === "pipeline-b")!;
    expect(pipelineA.pipelineName).toBe("Pipeline A");
    expect(pipelineA.stages).toEqual([
      { stageId: "stage-a1", stageName: "Qualification", dealCount: 4 },
      { stageId: "stage-a2", stageName: "Proposal", dealCount: 2 },
    ]);
    expect(pipelineB.pipelineName).toBe("Pipeline B");
    expect(pipelineB.stages).toEqual([{ stageId: "stage-b1", stageName: "New", dealCount: 3 }]);
  });

  it("never merges two pipelines' stages together, even when a stage NAME is identical across pipelines", () => {
    const vm = buildStageOverviewViewModel(
      emptyMetrics({
        dealsByStage: [
          stageRow("pipeline-a", "Pipeline A", "stage-a-won", "Won", 1),
          stageRow("pipeline-b", "Pipeline B", "stage-b-won", "Won", 5),
        ],
      }),
    );

    expect(vm.pipelineGroups).toHaveLength(2);
    expect(vm.pipelineGroups[0]!.stages[0]!.stageId).not.toBe(vm.pipelineGroups[1]!.stages[0]!.stageId);
    expect(vm.pipelineGroups[0]!.stages[0]!.dealCount).toBe(1);
    expect(vm.pipelineGroups[1]!.stages[0]!.dealCount).toBe(5);
  });

  it("a zero-count stage stays visible, rendered as the number 0, not filtered out or shown as a placeholder", () => {
    const vm = buildStageOverviewViewModel(
      emptyMetrics({ dealsByStage: [stageRow("pipeline-a", "Pipeline A", "stage-a1", "Negotiation", 0)] }),
    );
    expect(vm.pipelineGroups[0]!.stages).toEqual([{ stageId: "stage-a1", stageName: "Negotiation", dealCount: 0 }]);
  });

  it("an empty dealsByStage array (no pipeline/stage configuration at all) yields zero pipeline groups -- a truthful empty state, not a fabricated 'no deals' message", () => {
    const vm = buildStageOverviewViewModel(emptyMetrics({ dealsByStage: [] }));
    expect(vm.pipelineGroups).toEqual([]);
  });

  it("preserves the domain's own ordering exactly -- never re-sorts pipelines or stages itself", () => {
    // Deliberately NOT alphabetical/sort_order-ascending input order, to
    // prove this function does no sorting of its own -- it must emit
    // pipelines/stages in the exact sequence the domain layer supplied.
    const vm = buildStageOverviewViewModel(
      emptyMetrics({
        dealsByStage: [
          stageRow("pipeline-z", "Zeta Pipeline", "stage-z2", "Second", 1),
          stageRow("pipeline-z", "Zeta Pipeline", "stage-z1", "First", 2),
          stageRow("pipeline-a", "Alpha Pipeline", "stage-a1", "Only", 3),
        ],
      }),
    );
    expect(vm.pipelineGroups.map((g) => g.pipelineId)).toEqual(["pipeline-z", "pipeline-a"]);
    expect(vm.pipelineGroups[0]!.stages.map((s) => s.stageId)).toEqual(["stage-z2", "stage-z1"]);
  });

  it("exposes only stageId/stageName/dealCount and pipelineId/pipelineName -- no deal title, no PII, no monetary value", () => {
    const vm = buildStageOverviewViewModel(
      emptyMetrics({ dealsByStage: [stageRow("pipeline-a", "Pipeline A", "stage-a1", "Qualification", 4)] }),
    );
    expect(Object.keys(vm.pipelineGroups[0]!).sort()).toEqual(["pipelineId", "pipelineName", "stages"].sort());
    expect(Object.keys(vm.pipelineGroups[0]!.stages[0]!).sort()).toEqual(
      ["stageId", "stageName", "dealCount"].sort(),
    );
  });
});

describe("Dashboard page source: 3.5C wiring discipline", () => {
  const pageSource = readFileSync(join(__dirname, "../app/dashboard/page.tsx"), "utf8");

  it("calls getDealDashboardMetrics exactly once, feeding both the KPI row and the stage overview", () => {
    const occurrences = pageSource.match(/getDealDashboardMetrics\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(pageSource).toContain("buildStageOverviewViewModel(dealMetrics)");
    expect(pageSource).toContain("buildDealKpiViewModel(dealMetrics)");
  });

  it("gates the stage overview behind the same deals:read check as the KPI row -- no second/new permission", () => {
    expect(pageSource).toMatch(/showDealSections\s*=\s*canViewDealKpis\(actor\)/);
    expect(pageSource).not.toMatch(/canViewStageOverview|"stages:read"|"pipeline:read"|dashboard:/);
  });

  it("does not fetch its own HTTP API for dashboard data", () => {
    expect(codeOnly(pageSource)).not.toMatch(/fetch\(/);
  });

  it("does not import a chart library", () => {
    expect(codeOnly(pageSource)).not.toMatch(/chart/i);
  });
});

describe("stage-overview-view-model.ts source: no client-side deal aggregation", () => {
  const source = readFileSync(join(__dirname, "../app/dashboard/stage-overview-view-model.ts"), "utf8");

  it("only maps the already-aggregated dealsByStage field -- never calls listDeals or sums individual deals", () => {
    expect(source).not.toMatch(/listDeals|getDealById/);
    expect(source).toContain("metrics.dealsByStage");
  });
});

describe("End-to-end: Deals by Stage through real domain data", () => {
  it("multi-pipeline grouping, zero-count stages, soft-deleted deal/stage exclusion, and tenant isolation", async () => {
    const admin = await createOrgWithRole("org_admin", "dashboard-stage-e2e");
    const otherOrg = await createOrgWithRole("org_admin", "dashboard-stage-e2e-other");
    const actor = { userId: admin.userId, organizationId: admin.organizationId, roleKey: admin.roleKey };

    const pipelineA = await seedPipeline(admin.organizationId, { name: "Pipeline A" });
    const stageOpenA = await seedPipelineStage(admin.organizationId, pipelineA, { name: "Open A", sortOrder: 10 });
    await seedPipelineStage(admin.organizationId, pipelineA, { name: "Empty A", sortOrder: 20 });
    const stageToDeleteA = await seedPipelineStage(admin.organizationId, pipelineA, {
      name: "Soon Deleted",
      sortOrder: 30,
    });

    const pipelineB = await seedPipeline(admin.organizationId, { name: "Pipeline B" });
    const stageOpenB = await seedPipelineStage(admin.organizationId, pipelineB, { name: "Open B", sortOrder: 10 });

    await seedDealWithAmount(admin.organizationId, pipelineA, stageOpenA, 1000, "EUR");
    await seedDealWithAmount(admin.organizationId, pipelineA, stageOpenA, 2000, "EUR");
    const toDeleteDealId = await seedDealWithAmount(admin.organizationId, pipelineA, stageOpenA, 3000, "EUR");
    await seedDealWithAmount(admin.organizationId, pipelineB, stageOpenB, 500, "USD");
    await seedDealWithAmount(admin.organizationId, pipelineA, stageToDeleteA, 999, "EUR");

    await softDeleteDeal(actor, toDeleteDealId);
    await softDeletePipelineStage(actor, pipelineA, stageToDeleteA);

    // Cross-tenant noise -- must never affect org A's stage counts.
    const { pipelineId: otherPipeline, stageId: otherStage } = await seedPipelineWithStage(otherOrg.organizationId);
    await seedDealWithAmount(otherOrg.organizationId, otherPipeline, otherStage, 1, "EUR");
    await seedDealWithAmount(otherOrg.organizationId, otherPipeline, otherStage, 1, "EUR");

    const metrics = await getDealDashboardMetrics(actor);
    const vm = buildStageOverviewViewModel(metrics);

    expect(vm.pipelineGroups).toHaveLength(2);
    const groupA = vm.pipelineGroups.find((g) => g.pipelineId === pipelineA)!;
    const groupB = vm.pipelineGroups.find((g) => g.pipelineId === pipelineB)!;

    expect(groupA.pipelineName).toBe("Pipeline A");
    // Only 2 non-deleted stages remain in Pipeline A -- the soft-deleted
    // stage is gone entirely, not shown at count 0.
    expect(groupA.stages.map((s) => s.stageName).sort()).toEqual(["Empty A", "Open A"].sort());
    expect(groupA.stages.find((s) => s.stageName === "Open A")?.dealCount).toBe(2); // 3rd deal soft-deleted
    expect(groupA.stages.find((s) => s.stageName === "Empty A")?.dealCount).toBe(0); // zero-count stays visible

    expect(groupB.pipelineName).toBe("Pipeline B");
    expect(groupB.stages).toEqual([{ stageId: stageOpenB, stageName: "Open B", dealCount: 1 }]);

    // Existing 3.5B KPI behavior is unaffected by this same shared call.
    // Note: 4, not 3 -- softDeletePipelineStage soft-deletes only the
    // STAGE row, never cascades to the deals sitting on it (same as
    // /deals/board's own "Deleted stage" holding-column precedent: a
    // deal survives its stage's soft-deletion). The 999 EUR deal on the
    // now-deleted "Soon Deleted" stage is therefore still an open deal
    // for the KPI count, even though its stage no longer appears in the
    // Deals by Stage breakdown below -- an inherited M3.5A domain
    // behavior, not something this sub-phase changes.
    const kpiVm = buildDealKpiViewModel(metrics);
    expect(kpiVm.openDealCount).toBe(4);

    // No PII/deal-title/monetary field anywhere in the stage overview.
    expect(JSON.stringify(vm)).not.toMatch(/EUR|USD|amount|@example\.test/i);
  });
});

describe("canViewLeadIntelligence: content gate (contacts:read, no new permission)", () => {
  it.each(["org_admin", "org_member", "org_viewer"] as const)("%s can view lead intelligence", (roleKey) => {
    expect(canViewLeadIntelligence({ userId: "u", organizationId: "o", roleKey })).toBe(true);
  });

  it.each(["agency_owner", "agency_admin", "portal_customer"] as const)(
    "%s (no contacts:read) cannot view lead intelligence",
    (roleKey) => {
      expect(canViewLeadIntelligence({ userId: "u", organizationId: "o", roleKey })).toBe(false);
    },
  );

  it("no actor (unauthenticated) cannot view lead intelligence", () => {
    expect(canViewLeadIntelligence(null)).toBe(false);
  });
});

describe("buildLeadScoreDistributionViewModel", () => {
  it("zero-fills a grade the domain omitted, in a fixed A/B/C/D order", () => {
    const vm = buildLeadScoreDistributionViewModel([
      { grade: "A", contactCount: 3 },
      { grade: "C", contactCount: 1 },
    ]);
    expect(vm.grades).toEqual([
      { grade: "A", contactCount: 3 },
      { grade: "B", contactCount: 0 },
      { grade: "C", contactCount: 1 },
      { grade: "D", contactCount: 0 },
    ]);
  });

  it("isEmpty is true only when the domain returned zero grade rows at all", () => {
    expect(buildLeadScoreDistributionViewModel([]).isEmpty).toBe(true);
    expect(buildLeadScoreDistributionViewModel([{ grade: "A", contactCount: 1 }]).isEmpty).toBe(false);
  });

  it("A/B/C/D order is fixed regardless of the input array's own order", () => {
    const vm = buildLeadScoreDistributionViewModel([
      { grade: "D", contactCount: 1 },
      { grade: "A", contactCount: 2 },
    ]);
    expect(vm.grades.map((g) => g.grade)).toEqual(["A", "B", "C", "D"]);
  });

  it("exposes only grade/contactCount per line, plus isEmpty at the top level", () => {
    const vm = buildLeadScoreDistributionViewModel([{ grade: "A", contactCount: 1 }]);
    expect(Object.keys(vm).sort()).toEqual(["grades", "isEmpty"].sort());
    expect(Object.keys(vm.grades[0]!).sort()).toEqual(["grade", "contactCount"].sort());
  });
});

describe("buildHighScoreContactsViewModel", () => {
  it("preserves the domain's own order exactly -- no re-sorting", () => {
    const input: HighScoreContact[] = [
      highScoreContactRow("c3", "Charlie", null, "c3@example.test", 90),
      highScoreContactRow("c1", "Alice", null, "a1@example.test", 70),
      highScoreContactRow("c2", "Bob", null, "b2@example.test", 80),
    ];
    const vm = buildHighScoreContactsViewModel(input);
    expect(vm.map((c) => c.contactId)).toEqual(["c3", "c1", "c2"]);
  });

  it("first+last name present -> joined display name", () => {
    const vm = buildHighScoreContactsViewModel([highScoreContactRow("c1", "Ada", "Lovelace", "ada@example.test", 90)]);
    expect(vm[0]!.displayName).toBe("Ada Lovelace");
  });

  it("names absent, email present -> falls back to email, never a fabricated name", () => {
    const vm = buildHighScoreContactsViewModel([highScoreContactRow("c1", null, null, "only-email@example.test", 90)]);
    expect(vm[0]!.displayName).toBe("only-email@example.test");
  });

  it("names and email both absent -> a truthful literal fallback, never a fabricated name", () => {
    const vm = buildHighScoreContactsViewModel([highScoreContactRow("c1", null, null, null, 90)]);
    expect(vm[0]!.displayName).toBe("(no name)");
  });

  it("exposes only contactId/displayName/email/score/grade/computedAt -- no breakdown or other field", () => {
    const vm = buildHighScoreContactsViewModel([highScoreContactRow("c1", "Ada", "Lovelace", "ada@example.test", 90)]);
    expect(Object.keys(vm[0]!).sort()).toEqual(
      ["contactId", "displayName", "email", "score", "grade", "computedAt"].sort(),
    );
  });
});

describe("Dashboard page source: 3.5D wiring discipline", () => {
  const pageSource = readFileSync(join(__dirname, "../app/dashboard/page.tsx"), "utf8");

  it("calls getLeadScoreDistribution and getHighScoreContacts exactly once each", () => {
    expect(pageSource.match(/getLeadScoreDistribution\(/g) ?? []).toHaveLength(1);
    expect(pageSource.match(/getHighScoreContacts\(/g) ?? []).toHaveLength(1);
  });

  it("gates both calls behind the same showLeadIntelligence check, in one Promise.all", () => {
    expect(pageSource).toMatch(/showLeadIntelligence\s*=\s*canViewLeadIntelligence\(actor\)/);
    expect(pageSource).toMatch(
      /showLeadIntelligence\s*\?\s*await Promise\.all\(\[\s*getLeadScoreDistribution\(actor\),\s*getHighScoreContacts\(actor,\s*HIGH_SCORE_LIMIT\)/,
    );
  });

  it("the high-score limit is a literal server-defined constant, never sourced from searchParams/params", () => {
    expect(pageSource).toMatch(/const HIGH_SCORE_LIMIT = 5;/);
    expect(pageSource).not.toMatch(/searchParams[\s\S]{0,80}HIGH_SCORE_LIMIT|HIGH_SCORE_LIMIT[\s\S]{0,80}searchParams/);
  });

  it("does not catch/swallow either lead-intelligence call -- a failure must propagate to error.tsx, never render as zero", () => {
    expect(pageSource).not.toContain("catch");
  });

  it("does not import a chart library (already covered for the whole page, re-affirmed for 3.5D)", () => {
    expect(codeOnly(pageSource)).not.toMatch(/chart/i);
  });
});

describe("End-to-end: Lead Intelligence through real domain data", () => {
  it("latest-score-only, no duplicates, deleted-contact exclusion, tenant isolation, no forbidden fields", async () => {
    const admin = await createOrgWithRole("org_admin", "dashboard-lead-e2e");
    const otherOrg = await createOrgWithRole("org_admin", "dashboard-lead-e2e-other");
    const actor = { userId: admin.userId, organizationId: admin.organizationId, roleKey: admin.roleKey };

    // Contact A: scored A historically, then D most recently -- must
    // appear only in D, counted once, not in both A and D.
    const contactA = await seedContact(admin.organizationId, { firstName: "Historical" });
    await insertLeadScore(admin.organizationId, contactA, 90, daysAgo(10)); // grade A, stale
    await insertLeadScore(admin.organizationId, contactA, 35, daysAgo(1)); // grade D, latest

    // Contact B: single high score, appears in High-Score Contacts.
    const contactB = await seedContact(admin.organizationId, { firstName: "TopScorer" });
    await insertLeadScore(admin.organizationId, contactB, 95, daysAgo(1));

    // Contact C: soft-deleted after being scored -- must never appear.
    const contactC = await seedContact(admin.organizationId, { firstName: "Deleted" });
    await insertLeadScore(admin.organizationId, contactC, 99, daysAgo(1));
    await softDeleteContact(actor, contactC);

    // Cross-tenant noise -- must never leak into org A's results.
    const otherContact = await seedContact(otherOrg.organizationId, { firstName: "OtherOrgTop" });
    await insertLeadScore(otherOrg.organizationId, otherContact, 100, daysAgo(1));

    const [distribution, highScoreContacts] = await Promise.all([
      getLeadScoreDistribution(actor),
      getHighScoreContacts(actor, 5),
    ]);
    const distributionVm = buildLeadScoreDistributionViewModel(distribution);
    const highScoreVm = buildHighScoreContactsViewModel(highScoreContacts);

    // Latest-score-only: contact A's stale 90 (grade A) is superseded by
    // its latest 35 (grade D) -- it must be counted once, in D, never
    // also (or still) in A. Contact B's own single score of 95 is
    // legitimately grade A, so grade A's count of 1 here is contact B,
    // not a leftover of contact A's stale score.
    expect(distributionVm.grades.find((g) => g.grade === "D")?.contactCount).toBe(1);
    expect(distributionVm.grades.find((g) => g.grade === "A")?.contactCount).toBe(1);
    // Only 2 scored, non-deleted, own-org contacts exist (A and B) --
    // contact C is deleted, the other-org contact is a different tenant.
    const totalScored = distributionVm.grades.reduce((sum, g) => sum + g.contactCount, 0);
    expect(totalScored).toBe(2);

    // High-score contacts: exactly the 2 own-org, non-deleted contacts,
    // each exactly once, ordered by score descending (B's 95 before A's 35).
    expect(highScoreVm.map((c) => c.contactId)).toEqual([contactB, contactA]);
    expect(highScoreVm.find((c) => c.contactId === contactC)).toBeUndefined();
    expect(highScoreVm.find((c) => c.displayName === "OtherOrgTop")).toBeUndefined();

    // No forbidden field anywhere in either rendered view model.
    const serialized = JSON.stringify({ distributionVm, highScoreVm });
    expect(serialized).not.toMatch(/breakdown|enrichment|anonymous|workflow|visitor|organization_id|organizationId/i);
  });

  it("no scored contacts yields a truthful empty state on both sub-sections", async () => {
    const admin = await createOrgWithRole("org_admin", "dashboard-lead-e2e-empty");
    const actor = { userId: admin.userId, organizationId: admin.organizationId, roleKey: admin.roleKey };

    const [distribution, highScoreContacts] = await Promise.all([
      getLeadScoreDistribution(actor),
      getHighScoreContacts(actor, 5),
    ]);
    const distributionVm = buildLeadScoreDistributionViewModel(distribution);
    const highScoreVm = buildHighScoreContactsViewModel(highScoreContacts);

    expect(distributionVm.isEmpty).toBe(true);
    expect(distributionVm.grades.every((g) => g.contactCount === 0)).toBe(true);
    expect(highScoreVm).toEqual([]);
  });
});

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function insertLeadScore(organizationId: string, contactId: string, score: number, computedAt: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(
      `insert into public.lead_scores (organization_id, contact_id, score, computed_at) values ($1, $2, $3, $4)`,
      [organizationId, contactId, score, computedAt],
    );
  } finally {
    client.release();
  }
}

function highScoreContactRow(
  contactId: string,
  firstName: string | null,
  lastName: string | null,
  email: string | null,
  score: number,
): HighScoreContact {
  return {
    contactId,
    firstName,
    lastName,
    email,
    score,
    grade: score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D",
    computedAt: new Date().toISOString(),
  };
}

describe("Dashboard page source: 3.5E wiring discipline", () => {
  const pageSource = readFileSync(join(__dirname, "../app/dashboard/page.tsx"), "utf8");

  it("calls getIdentifiedVisitorMetrics exactly once", () => {
    expect(pageSource.match(/getIdentifiedVisitorMetrics\(/g) ?? []).toHaveLength(1);
  });

  it("reuses canViewLeadIntelligence (contacts:read) -- no new permission or gate helper introduced", () => {
    expect(pageSource).toMatch(/showVisitorIntelligence\s*=\s*canViewLeadIntelligence\(actor\)/);
    expect(codeOnly(pageSource)).not.toMatch(/canViewVisitorIntelligence|"visitors:read"|"tracking:read"/);
  });

  it("the window is a literal server-defined constant, never sourced from searchParams/params", () => {
    expect(pageSource).toMatch(/const VISITOR_WINDOW_DAYS = 30;/);
    expect(pageSource).not.toMatch(/searchParams[\s\S]{0,80}VISITOR_WINDOW_DAYS|VISITOR_WINDOW_DAYS[\s\S]{0,80}searchParams/);
  });

  it("does not catch/swallow the visitor-intelligence call -- a failure must propagate to error.tsx, never render as zero", () => {
    expect(pageSource).not.toContain("catch");
  });

  it("does not query website_visitors/visitor_identifications directly -- no duplicated SQL in apps/web", () => {
    expect(codeOnly(pageSource)).not.toMatch(/website_visitors|visitor_identifications|client\.query/);
  });

  it("does not render identifiedVisitorCount (the unwindowed all-time total) -- only the windowed metric is in this sub-phase's locked scope", () => {
    expect(codeOnly(pageSource)).not.toMatch(/\bidentifiedVisitorCount\b/);
  });

  it("does not render any visitor/contact identifier, email, or organizationId", () => {
    const visitorSection = pageSource.slice(pageSource.indexOf("visitor-intelligence-heading"));
    expect(visitorSection).not.toMatch(/anonymousId|anonymousSessionId|websiteVisitorId|contactId|organizationId|email/i);
  });

  it("does not import a chart library (re-affirmed for 3.5E)", () => {
    expect(codeOnly(pageSource)).not.toMatch(/chart/i);
  });
});

describe("End-to-end: Visitor Intelligence hostile timestamp semantics", () => {
  it("A/B/C/D: recent-row/old-identification excluded, old-row/recent-identification included, never-identified excluded, cross-tenant excluded", async () => {
    const admin = await createOrgWithRole("org_admin", "dashboard-visitor-e2e");
    const otherOrg = await createOrgWithRole("org_admin", "dashboard-visitor-e2e-other");
    const actor = { userId: admin.userId, organizationId: admin.organizationId, roleKey: admin.roleKey };
    const contactA = await seedContact(admin.organizationId, { firstName: "A" });
    const contactB = await seedContact(admin.organizationId, { firstName: "B" });

    // A: first_seen recent, identified >30 days ago -- must NOT count.
    const visitorA = await createVisitor(admin.organizationId, contactA, daysAgo(1));
    await insertIdentificationEvent(admin.organizationId, visitorA, contactA, "identified", daysAgo(45));

    // B: first_seen long ago, identified within the window -- MUST count.
    const visitorB = await createVisitor(admin.organizationId, contactB, daysAgo(200));
    await insertIdentificationEvent(admin.organizationId, visitorB, contactB, "identified", daysAgo(5));

    // C: ordinary visitor, never identified at all -- must NOT count.
    await createVisitor(admin.organizationId, null, daysAgo(3));

    // D: another tenant's identification -- must NOT count in org A's result.
    const otherContact = await seedContact(otherOrg.organizationId, { firstName: "Other" });
    const otherVisitor = await createVisitor(otherOrg.organizationId, otherContact, daysAgo(200));
    await insertIdentificationEvent(otherOrg.organizationId, otherVisitor, otherContact, "identified", daysAgo(1));

    const metrics = await getIdentifiedVisitorMetrics(actor, 30);
    expect(metrics.identifiedInWindowCount).toBe(1); // only visitor B
    expect(metrics.windowDays).toBe(30);
  });

  it("a visitor with only an unlinked_withdrawal event (no longer currently identified) never counts, even if the withdrawal itself is recent", async () => {
    const admin = await createOrgWithRole("org_admin", "dashboard-visitor-e2e-withdrawn");
    const actor = { userId: admin.userId, organizationId: admin.organizationId, roleKey: admin.roleKey };
    const contact = await seedContact(admin.organizationId, { firstName: "Withdrawn" });

    const visitor = await createVisitor(admin.organizationId, null, daysAgo(10));
    await insertIdentificationEvent(admin.organizationId, visitor, contact, "identified", daysAgo(9));
    // Withdrawal clears identified_contact_id -- the visitor is no longer
    // "currently identified", regardless of how recent the identification was.
    await clearIdentifiedContact(admin.organizationId, visitor);
    await insertIdentificationEvent(admin.organizationId, visitor, contact, "unlinked_withdrawal", daysAgo(1));

    const metrics = await getIdentifiedVisitorMetrics(actor, 30);
    expect(metrics.identifiedInWindowCount).toBe(0);
  });
});

describe("End-to-end: Visitor Intelligence zero/authorization behavior", () => {
  it("zero identified visitors renders truthfully as 0, not omitted or hidden", async () => {
    const admin = await createOrgWithRole("org_admin", "dashboard-visitor-e2e-zero");
    const actor = { userId: admin.userId, organizationId: admin.organizationId, roleKey: admin.roleKey };

    const metrics = await getIdentifiedVisitorMetrics(actor, 30);
    expect(metrics.identifiedInWindowCount).toBe(0);
    // 0 is a real, renderable number -- not null/undefined, which the
    // page's `{visitorMetrics.identifiedInWindowCount}` JSX interpolation
    // would need special-casing for (it does not; 0 renders as "0" as-is).
    expect(metrics.identifiedInWindowCount).not.toBeNull();
    expect(metrics.identifiedInWindowCount).not.toBeUndefined();
  });

  it("an actor without contacts:read never triggers the visitor-intelligence query (same gate as Lead Intelligence, already exhaustively tested)", () => {
    expect(canViewLeadIntelligence({ userId: "u", organizationId: "o", roleKey: "portal_customer" })).toBe(false);
    expect(canViewLeadIntelligence({ userId: "u", organizationId: "o", roleKey: "agency_owner" })).toBe(false);
  });
});

// Reuses the `daysAgo` helper already defined further below in this file
// (from Milestone 3.5D) -- function declarations are hoisted, so it's
// callable here without duplicating it.

async function createVisitor(organizationId: string, identifiedContactId: string | null, firstSeenAt: string): Promise<string> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: string }>(
      `insert into public.website_visitors (organization_id, anonymous_id, identified_contact_id, first_seen_at, last_seen_at)
       values ($1, $2, $3, $4, $4) returning id`,
      [organizationId, randomUUID(), identifiedContactId, firstSeenAt],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function insertIdentificationEvent(
  organizationId: string,
  websiteVisitorId: string,
  contactId: string | null,
  eventType: "identified" | "unlinked_withdrawal" | "unlinked_erasure" | "rejected_conflict",
  occurredAt: string,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(
      `insert into public.visitor_identifications (organization_id, website_visitor_id, contact_id, event_type, token_jti, occurred_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [organizationId, websiteVisitorId, contactId, eventType, randomUUID(), occurredAt],
    );
  } finally {
    client.release();
  }
}

async function clearIdentifiedContact(organizationId: string, websiteVisitorId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(
      `update public.website_visitors set identified_contact_id = null where organization_id = $1 and id = $2`,
      [organizationId, websiteVisitorId],
    );
  } finally {
    client.release();
  }
}

describe("Dashboard page source: 3.5F wiring discipline", () => {
  const pageSource = readFileSync(join(__dirname, "../app/dashboard/page.tsx"), "utf8");

  it("calls listDeals exactly once for this section", () => {
    expect(pageSource.match(/listDeals\(actor/g) ?? []).toHaveLength(1);
  });

  it("reuses canViewDealKpis (deals:read) via showDealSections -- no new permission or gate helper introduced", () => {
    expect(pageSource).toMatch(/recentDeals\s*=\s*showDealSections\s*\?\s*\(await listDeals\(actor,\s*\{\s*limit:\s*RECENT_DEALS_LIMIT\s*\}\)\)\.items/);
  });

  it("the limit is a literal server-defined constant, never sourced from searchParams/params, and no pagination cursor is threaded through", () => {
    expect(pageSource).toMatch(/const RECENT_DEALS_LIMIT = 5;/);
    expect(pageSource).not.toMatch(/searchParams[\s\S]{0,80}RECENT_DEALS_LIMIT|RECENT_DEALS_LIMIT[\s\S]{0,80}searchParams/);
    expect(codeOnly(pageSource)).not.toMatch(/cursor/i);
  });

  it("does not catch/swallow the listDeals call -- a failure must propagate to error.tsx, never render as an empty list", () => {
    expect(pageSource).not.toContain("catch");
  });

  it("does not query public.deals directly -- no duplicated SQL in apps/web", () => {
    expect(codeOnly(pageSource)).not.toMatch(/client\.query|from public\.deals/);
  });

  it("does not render any contact email, visitor identifier, or organizationId in this section", () => {
    const recentDealsSection = pageSource.slice(pageSource.indexOf("recent-deals-heading"));
    expect(recentDealsSection).not.toMatch(/email|anonymousId|websiteVisitorId|organizationId|contactId/i);
  });

  it("does not import a chart library (re-affirmed for 3.5F)", () => {
    expect(codeOnly(pageSource)).not.toMatch(/chart/i);
  });

  it("does not introduce activity-log-shaped wording (activity, history, audit) for this section", () => {
    const recentDealsSection = pageSource.slice(
      pageSource.indexOf("recent-deals-heading"),
      pageSource.indexOf("recent-deals-heading") + 800,
    );
    expect(recentDealsSection).not.toMatch(/\bactivity\b|\bhistory\b|\baudit\b/i);
  });
});

describe("buildRecentDealsViewModel", () => {
  function deal(overrides: Partial<Deal> = {}): Deal {
    return {
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      organizationId: "org-1",
      companyId: null,
      primaryContactId: null,
      pipelineId: "pipeline-1",
      stageId: "stage-1",
      amount: null,
      currency: "EUR",
      probability: null,
      expectedCloseDate: null,
      status: "open",
      ownerId: null,
      deletedAt: null,
      createdAt: "2026-01-15T00:00:00.000Z",
      updatedAt: "2026-01-15T00:00:00.000Z",
      ...overrides,
    };
  }

  it("uses the established dealDisplayLabel fallback (no title column exists) -- never the full raw UUID", () => {
    const vm = buildRecentDealsViewModel([deal({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })]);
    expect(vm[0]!.label).toBe("Deal aaaaaaaa");
    expect(vm[0]!.label).not.toContain("bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it.each([
    ["open", "Open"],
    ["won", "Won"],
    ["lost", "Lost"],
  ] as const)("renders the domain's own %s status as %s, without re-deriving it", (status, label) => {
    const vm = buildRecentDealsViewModel([deal({ status })]);
    expect(vm[0]!.statusLabel).toBe(label);
  });

  it("amount present -> formatted amount + its own currency", () => {
    const vm = buildRecentDealsViewModel([deal({ amount: "1500.5", currency: "USD" })]);
    expect(vm[0]!.amountLabel).toBe("1,500.50 USD");
  });

  it("amount NULL -> 'No amount', never 0/0.00/€0", () => {
    const vm = buildRecentDealsViewModel([deal({ amount: null })]);
    expect(vm[0]!.amountLabel).toBe("No amount");
    expect(vm[0]!.amountLabel).not.toMatch(/0/);
  });

  it("a genuine numeric zero amount stays distinguishable from NULL", () => {
    const vm = buildRecentDealsViewModel([deal({ amount: "0", currency: "EUR" })]);
    expect(vm[0]!.amountLabel).toBe("0.00 EUR");
    expect(vm[0]!.amountLabel).not.toBe("No amount");
  });

  it("mixed currencies across rows stay independent -- no cross-row aggregation", () => {
    const vm = buildRecentDealsViewModel([
      deal({ id: "aaaaaaaa-0000-0000-0000-000000000001", amount: "100", currency: "EUR" }),
      deal({ id: "aaaaaaaa-0000-0000-0000-000000000002", amount: "200", currency: "USD" }),
    ]);
    expect(vm[0]!.amountLabel).toBe("100.00 EUR");
    expect(vm[1]!.amountLabel).toBe("200.00 USD");
  });

  it("renders createdAt with a fixed, deployment-independent locale -- never updatedAt", () => {
    const vm = buildRecentDealsViewModel([deal({ createdAt: "2026-03-05T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" })]);
    expect(vm[0]!.createdAtLabel).toBe("Mar 5, 2026");
  });

  it("preserves input order exactly -- no re-sorting", () => {
    const vm = buildRecentDealsViewModel([
      deal({ id: "aaaaaaaa-0000-0000-0000-000000000003" }),
      deal({ id: "aaaaaaaa-0000-0000-0000-000000000001" }),
      deal({ id: "aaaaaaaa-0000-0000-0000-000000000002" }),
    ]);
    expect(vm.map((d) => d.dealId)).toEqual([
      "aaaaaaaa-0000-0000-0000-000000000003",
      "aaaaaaaa-0000-0000-0000-000000000001",
      "aaaaaaaa-0000-0000-0000-000000000002",
    ]);
  });

  it("exposes only dealId/label/statusLabel/amountLabel/createdAtLabel -- no company/contact/enrichment field", () => {
    const vm = buildRecentDealsViewModel([deal()]);
    expect(Object.keys(vm[0]!).sort()).toEqual(["dealId", "label", "statusLabel", "amountLabel", "createdAtLabel"].sort());
  });
});

describe("End-to-end: Recently Created Deals through real domain data", () => {
  it("created_at DESC ordering, deterministic tie-break, bounded to the configured limit, soft-delete exclusion, tenant isolation, updated_at never drives order", async () => {
    const admin = await createOrgWithRole("org_admin", "dashboard-recent-deals-e2e");
    const otherOrg = await createOrgWithRole("org_admin", "dashboard-recent-deals-e2e-other");
    const actor = { userId: admin.userId, organizationId: admin.organizationId, roleKey: admin.roleKey };
    const { pipelineId, stageId } = await seedPipelineWithStage(admin.organizationId);

    const dealOldest = await seedDealAt(admin.organizationId, pipelineId, stageId, daysAgo(10));
    const dealSecond = await seedDealAt(admin.organizationId, pipelineId, stageId, daysAgo(9));
    const dealTiedA = await seedDealAt(admin.organizationId, pipelineId, stageId, daysAgo(8));
    const dealTiedB = await seedDealAt(admin.organizationId, pipelineId, stageId, daysAgo(8));
    // Touched "just now" via updated_at -- must still sort by its OWN
    // created_at (2 days ago), never by this recent update.
    const dealRecent1 = await seedDealAt(admin.organizationId, pipelineId, stageId, daysAgo(2), { updatedAt: daysAgo(0) });
    const dealRecent2 = await seedDealAt(admin.organizationId, pipelineId, stageId, daysAgo(1));

    const toDeleteDeal = await seedDealAt(admin.organizationId, pipelineId, stageId, daysAgo(0.5));
    await softDeleteDeal(actor, toDeleteDeal);

    const { pipelineId: otherPipeline, stageId: otherStage } = await seedPipelineWithStage(otherOrg.organizationId);
    const otherOrgDeal = await seedDealAt(otherOrg.organizationId, otherPipeline, otherStage, daysAgo(0.1));

    const page = await listDeals(actor, { limit: 5 });
    const ids = page.items.map((d) => d.id);

    // Bounded to 5: dealOldest (the oldest surviving candidate) is
    // excluded even though it's a real, non-deleted deal.
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain(dealOldest);
    // The soft-deleted and cross-tenant deals never appear regardless of
    // how recent they are.
    expect(ids).not.toContain(toDeleteDeal);
    expect(ids).not.toContain(otherOrgDeal);

    // Most-recent-created_at-first ordering; dealRecent1's own recent
    // updated_at touch does not move it ahead of dealRecent2.
    expect(ids[0]).toBe(dealRecent2);
    expect(ids[1]).toBe(dealRecent1);
    expect(ids).toContain(dealSecond);

    // Deterministic tie-break for the two identically-created_at deals:
    // re-running the identical query must reproduce the identical order.
    expect(ids.slice(2, 4).sort()).toEqual([dealTiedA, dealTiedB].sort());
    const pageAgain = await listDeals(actor, { limit: 5 });
    expect(pageAgain.items.map((d) => d.id)).toEqual(ids);
  });

  it("zero deals yields a truthful empty state", async () => {
    const admin = await createOrgWithRole("org_admin", "dashboard-recent-deals-e2e-empty");
    const actor = { userId: admin.userId, organizationId: admin.organizationId, roleKey: admin.roleKey };

    const page = await listDeals(actor, { limit: 5 });
    expect(buildRecentDealsViewModel(page.items)).toEqual([]);
  });
});

async function seedDealAt(
  organizationId: string,
  pipelineId: string,
  stageId: string,
  createdAt: string,
  overrides: { amount?: number | null; currency?: string; updatedAt?: string } = {},
): Promise<string> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: string }>(
      `insert into public.deals (organization_id, pipeline_id, stage_id, amount, currency, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        organizationId,
        pipelineId,
        stageId,
        overrides.amount ?? null,
        overrides.currency ?? "EUR",
        createdAt,
        overrides.updatedAt ?? createdAt,
      ],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

function stageRow(
  pipelineId: string,
  pipelineName: string,
  stageId: string,
  stageName: string,
  dealCount: number,
): DealsByStageMetric {
  return { pipelineId, pipelineName, stageId, stageName, dealCount };
}

function emptyMetrics(overrides: Partial<DealDashboardMetrics>): DealDashboardMetrics {
  return {
    openDealCount: 0,
    openDealsWithNullAmountCount: 0,
    openPipelineValueByCurrency: [],
    averageOpenDealSizeByCurrency: [],
    wonDealCount: 0,
    lostDealCount: 0,
    winRate: null,
    wonDealValueByCurrency: [],
    dealsByStage: [],
    ...overrides,
  };
}
