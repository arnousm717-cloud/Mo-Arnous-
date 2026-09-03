import { afterAll, describe, expect, it } from "vitest";
import { adminPool, createOrgWithActiveMember } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import { createPipeline } from "../src/pipelines";
import { createPipelineStage } from "../src/pipeline-stages";
import { createDeal, softDeleteDeal, listDeals } from "../src/deals";
import { getDealDashboardMetrics } from "../src/dashboard-metrics";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

async function makeFixture() {
  const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
  const ctx = { userId, organizationId, roleKey };
  const pipeline = await createPipeline(ctx, { name: "Pipeline A", isDefault: true });
  const open = await createPipelineStage(ctx, { pipelineId: pipeline.id, name: "Open", sortOrder: 10 });
  const won = await createPipelineStage(ctx, {
    pipelineId: pipeline.id,
    name: "Won",
    sortOrder: 20,
    isWonStage: true,
  });
  const lost = await createPipelineStage(ctx, {
    pipelineId: pipeline.id,
    name: "Lost",
    sortOrder: 30,
    isLostStage: true,
  });
  return { ctx, pipeline, open, won, lost };
}

describe("getDealDashboardMetrics: open counts and null-amount handling", () => {
  it("counts only open deals, excluding won/lost", async () => {
    const { ctx, pipeline, open, won, lost } = await makeFixture();
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: won.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: lost.id });

    const metrics = await getDealDashboardMetrics(ctx);
    expect(metrics.openDealCount).toBe(2);
    expect(metrics.wonDealCount).toBe(1);
    expect(metrics.lostDealCount).toBe(1);
  });

  it("openDealsWithNullAmountCount counts only open deals with a null amount, never treating null as zero", async () => {
    const { ctx, pipeline, open } = await makeFixture();
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id, amount: 0 });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id, amount: 500 });

    const metrics = await getDealDashboardMetrics(ctx);
    expect(metrics.openDealsWithNullAmountCount).toBe(1);
  });

  it("a zero amount is a real value, distinct from null — it is included in value/average sums", async () => {
    const { ctx, pipeline, open } = await makeFixture();
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id, amount: 0, currency: "USD" });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id, amount: 100, currency: "USD" });

    const metrics = await getDealDashboardMetrics(ctx);
    const usd = metrics.openPipelineValueByCurrency.find((c) => c.currency === "USD");
    expect(Number(usd?.totalAmount)).toBeCloseTo(100, 5);
    const avgUsd = metrics.averageOpenDealSizeByCurrency.find((c) => c.currency === "USD");
    expect(Number(avgUsd?.totalAmount)).toBeCloseTo(50, 5);
  });
});

describe("getDealDashboardMetrics: currency segregation (locked decision #2)", () => {
  it("never combines currencies — separate deals in EUR and USD produce two distinct entries, never a merged total", async () => {
    const { ctx, pipeline, open } = await makeFixture();
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id, amount: 1000, currency: "EUR" });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id, amount: 500, currency: "USD" });

    const metrics = await getDealDashboardMetrics(ctx);
    expect(metrics.openPipelineValueByCurrency).toHaveLength(2);
    const eur = metrics.openPipelineValueByCurrency.find((c) => c.currency === "EUR");
    const usd = metrics.openPipelineValueByCurrency.find((c) => c.currency === "USD");
    expect(Number(eur?.totalAmount)).toBeCloseTo(1000, 5);
    expect(Number(usd?.totalAmount)).toBeCloseTo(500, 5);
    // Structural guarantee: the type is an array of per-currency entries,
    // never a single combined-total field anywhere on the response.
    expect(metrics).not.toHaveProperty("totalOpenPipelineValue");
  });

  it("wonDealValueByCurrency sums only won deals, grouped by currency, excluding open/lost", async () => {
    const { ctx, pipeline, open, won, lost } = await makeFixture();
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: won.id, amount: 2000, currency: "EUR" });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: won.id, amount: 300, currency: "EUR" });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id, amount: 9999, currency: "EUR" });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: lost.id, amount: 9999, currency: "EUR" });

    const metrics = await getDealDashboardMetrics(ctx);
    expect(metrics.wonDealValueByCurrency).toHaveLength(1);
    expect(metrics.wonDealValueByCurrency[0]!.currency).toBe("EUR");
    expect(Number(metrics.wonDealValueByCurrency[0]!.totalAmount)).toBeCloseTo(2300, 5);
  });
});

describe("getDealDashboardMetrics: win rate", () => {
  it("computes won / (won + lost), never diluted by open deals", async () => {
    const { ctx, pipeline, open, won, lost } = await makeFixture();
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: won.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: won.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: won.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: lost.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id });

    const metrics = await getDealDashboardMetrics(ctx);
    expect(metrics.winRate).toBeCloseTo(0.75, 5);
  });

  it("returns null, never 0 or NaN, when there are no closed deals at all", async () => {
    const { ctx, pipeline, open } = await makeFixture();
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id });

    const metrics = await getDealDashboardMetrics(ctx);
    expect(metrics.winRate).toBeNull();
  });
});

describe("getDealDashboardMetrics: deals by stage (locked decision #3 — organization-wide, all pipelines)", () => {
  it("aggregates across every active pipeline, not only the default one", async () => {
    const { ctx, pipeline, open } = await makeFixture();
    const secondPipeline = await createPipeline(ctx, { name: "Pipeline B", isDefault: false });
    const secondStage = await createPipelineStage(ctx, {
      pipelineId: secondPipeline.id,
      name: "Qualifying",
      sortOrder: 10,
    });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id });
    await createDeal(ctx, { pipelineId: secondPipeline.id, stageId: secondStage.id });
    await createDeal(ctx, { pipelineId: secondPipeline.id, stageId: secondStage.id });

    const metrics = await getDealDashboardMetrics(ctx);
    const defaultStageEntry = metrics.dealsByStage.find((s) => s.stageId === open.id);
    const secondStageEntry = metrics.dealsByStage.find((s) => s.stageId === secondStage.id);
    expect(defaultStageEntry?.dealCount).toBe(1);
    expect(secondStageEntry?.dealCount).toBe(2);
    expect(secondStageEntry?.pipelineId).toBe(secondPipeline.id);
  });

  it("a stage with zero deals still appears, at count 0, rather than disappearing from the result", async () => {
    const { ctx, won } = await makeFixture();
    const metrics = await getDealDashboardMetrics(ctx);
    const wonStageEntry = metrics.dealsByStage.find((s) => s.stageId === won.id);
    expect(wonStageEntry?.dealCount).toBe(0);
  });
});

describe("getDealDashboardMetrics: soft-delete exclusion", () => {
  it("excludes soft-deleted deals from every count, value sum, and stage aggregate", async () => {
    const { ctx, pipeline, open, won } = await makeFixture();
    const toDelete = await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id, amount: 777, currency: "EUR" });
    await createDeal(ctx, { pipelineId: pipeline.id, stageId: won.id, amount: 111, currency: "EUR" });
    await softDeleteDeal(ctx, toDelete.id);

    const metrics = await getDealDashboardMetrics(ctx);
    expect(metrics.openDealCount).toBe(0);
    expect(metrics.openPipelineValueByCurrency).toHaveLength(0);
    const openStageEntry = metrics.dealsByStage.find((s) => s.stageId === open.id);
    expect(openStageEntry?.dealCount).toBe(0);
  });
});

describe("Recent Deals: listDeals reuse (Milestone 3.5A locked decision #4 — no new activity-log mechanism)", () => {
  it("orders by created_at desc with a deterministic id tie-break, organization-wide across all pipelines", async () => {
    const { ctx, pipeline, open } = await makeFixture();
    const secondPipeline = await createPipeline(ctx, { name: "Pipeline B", isDefault: false });
    const secondStage = await createPipelineStage(ctx, {
      pipelineId: secondPipeline.id,
      name: "Qualifying",
      sortOrder: 10,
    });
    const a = await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id });
    const b = await createDeal(ctx, { pipelineId: secondPipeline.id, stageId: secondStage.id });

    const page = await listDeals(ctx, { limit: 10 });
    const ids = page.items.map((d) => d.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(page.items.some((d) => d.pipelineId === secondPipeline.id)).toBe(true);
  });

  it("excludes soft-deleted deals", async () => {
    const { ctx, pipeline, open } = await makeFixture();
    const deal = await createDeal(ctx, { pipelineId: pipeline.id, stageId: open.id });
    await softDeleteDeal(ctx, deal.id);

    const page = await listDeals(ctx, { limit: 10 });
    expect(page.items.find((d) => d.id === deal.id)).toBeUndefined();
  });

  it("rejects an oversized limit rather than silently truncating it", async () => {
    const { ctx } = await makeFixture();
    await expect(listDeals(ctx, { limit: 100000 })).rejects.toThrow("limit must not exceed 100");
  });
});

describe("getDealDashboardMetrics: tenant isolation", () => {
  it("never includes another organization's deals in any metric", async () => {
    const fixtureA = await makeFixture();
    const fixtureB = await makeFixture();
    await createDeal(fixtureA.ctx, { pipelineId: fixtureA.pipeline.id, stageId: fixtureA.open.id, amount: 1, currency: "EUR" });
    await createDeal(fixtureB.ctx, { pipelineId: fixtureB.pipeline.id, stageId: fixtureB.open.id, amount: 999, currency: "EUR" });

    const metricsA = await getDealDashboardMetrics(fixtureA.ctx);
    expect(metricsA.openDealCount).toBe(1);
    expect(metricsA.openPipelineValueByCurrency).toHaveLength(1);
    expect(Number(metricsA.openPipelineValueByCurrency[0]!.totalAmount)).toBeCloseTo(1, 5);
    expect(metricsA.dealsByStage.every((s) => s.pipelineId === fixtureA.pipeline.id)).toBe(true);
  });
});
