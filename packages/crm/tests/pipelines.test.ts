import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin, createOrgWithActiveMember } from "./helpers";
import { closePool } from "@ai-revenue-os/database";
import {
  createPipeline,
  getPipelineById,
  getPipelineByIdIncludingDeleted,
  listPipelines,
  updatePipeline,
  setDefaultPipeline,
  softDeletePipeline,
} from "../src/pipelines";
import { ValidationError, InvalidPipelineRelationshipError, CannotDeleteDefaultPipelineError } from "../src/errors";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("createPipeline", () => {
  it("creates a non-default pipeline and persists organization_id from ctx", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const pipeline = await createPipeline({ userId, organizationId, roleKey }, { name: "Enterprise Pipeline" });
    expect(pipeline.organizationId).toBe(organizationId);
    expect(pipeline.name).toBe("Enterprise Pipeline");
    expect(pipeline.isDefault).toBe(false);
    expect(pipeline.deletedAt).toBeNull();
  });

  it("rejects a whitespace-only name", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    await expect(createPipeline({ userId, organizationId, roleKey }, { name: "   " })).rejects.toThrow(
      ValidationError,
    );
  });

  it("creating as default unsets any prior active default transactionally, leaving exactly one active default", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const first = await createPipeline(ctx, { name: "First Default", isDefault: true });
    expect(first.isDefault).toBe(true);

    const second = await createPipeline(ctx, { name: "Second Default", isDefault: true });
    expect(second.isDefault).toBe(true);

    const refetchedFirst = await getPipelineById(ctx, first.id);
    expect(refetchedFirst?.isDefault).toBe(false);

    const activeDefaults = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select count(*)::int as n from public.pipelines where organization_id = $1 and is_default and deleted_at is null",
        [organizationId],
      );
      return r.rows[0].n;
    });
    expect(activeDefaults).toBe(1);
  });

  it("creating as non-default leaves an existing default untouched", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const defaultPipeline = await createPipeline(ctx, { name: "The Default", isDefault: true });
    await createPipeline(ctx, { name: "Ordinary Pipeline" });

    const refetched = await getPipelineById(ctx, defaultPipeline.id);
    expect(refetched?.isDefault).toBe(true);
  });
});

describe("getPipelineById / getPipelineByIdIncludingDeleted", () => {
  it("excludes a soft-deleted pipeline from getPipelineById but not from the includingDeleted variant", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const first = await createPipeline(ctx, { name: "Default", isDefault: true });
    const second = await createPipeline(ctx, { name: "Deletable" });
    await softDeletePipeline(ctx, second.id);

    expect(await getPipelineById(ctx, second.id)).toBeNull();
    const includingDeleted = await getPipelineByIdIncludingDeleted(ctx, second.id);
    expect(includingDeleted?.id).toBe(second.id);
    expect(includingDeleted?.deletedAt).not.toBeNull();
    expect(first).toBeTruthy();
  });

  it("returns null identically for nonexistent and cross-org ids", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const pipelineInB = await createPipeline(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Pipeline" },
    );

    const ctxA = { userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey };
    const crossOrg = await getPipelineById(ctxA, pipelineInB.id);
    const nonexistent = await getPipelineById(ctxA, "00000000-0000-0000-0000-000000000000");
    expect(crossOrg).toBeNull();
    expect(nonexistent).toBeNull();
  });
});

describe("listPipelines", () => {
  it("lists only active pipelines for this organization, cursor-paginated", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    await createPipeline(ctx, { name: "Pipeline One" });
    await createPipeline(ctx, { name: "Pipeline Two" });
    const deleted = await createPipeline(ctx, { name: "Pipeline Three" });
    await softDeletePipeline(ctx, deleted.id);

    const page = await listPipelines(ctx, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();

    const secondPage = await listPipelines(ctx, { limit: 10, cursor: page.nextCursor! });
    const allNames = [...page.items, ...secondPage.items].map((p) => p.name);
    expect(allNames).toContain("Pipeline One");
    expect(allNames).toContain("Pipeline Two");
    expect(allNames).not.toContain("Pipeline Three");
  });

  it("tenant isolation: org A never sees org B's pipelines", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    await createPipeline(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Only" },
    );

    const page = await listPipelines({ userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey });
    expect(page.items.map((p) => p.name)).not.toContain("Org B Only");
  });
});

describe("updatePipeline", () => {
  it("updates the name", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const pipeline = await createPipeline(ctx, { name: "Original Name" });
    const updated = await updatePipeline(ctx, pipeline.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
  });

  it("has no isDefault field in its input type — TypeScript structurally prevents mutating it through updatePipeline", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const pipeline = await createPipeline(ctx, { name: "Default Pipeline", isDefault: true });
    // Even a raw object smuggling isDefault is ignored — updatePipeline
    // only ever reads `name` off its input.
    const updated = await updatePipeline(ctx, pipeline.id, { name: "Still Default", isDefault: false } as never);
    expect(updated?.isDefault).toBe(true);
  });

  it("no-op update (empty input) returns the current row unchanged", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const pipeline = await createPipeline(ctx, { name: "Unchanged" });
    const updated = await updatePipeline(ctx, pipeline.id, {});
    expect(updated?.name).toBe("Unchanged");
  });

  it("returns null for a nonexistent/cross-org/already-deleted pipeline", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const pipeline = await createPipeline(ctx, { name: "To Be Deleted" });
    await softDeletePipeline(ctx, pipeline.id);
    expect(await updatePipeline(ctx, pipeline.id, { name: "New Name" })).toBeNull();
  });
});

describe("setDefaultPipeline", () => {
  it("switches the default atomically: old default unset, new one set, exactly one active default afterward", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const first = await createPipeline(ctx, { name: "First", isDefault: true });
    const second = await createPipeline(ctx, { name: "Second" });

    const result = await setDefaultPipeline(ctx, second.id);
    expect(result.isDefault).toBe(true);

    const refetchedFirst = await getPipelineById(ctx, first.id);
    expect(refetchedFirst?.isDefault).toBe(false);

    const activeDefaults = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select count(*)::int as n from public.pipelines where organization_id = $1 and is_default and deleted_at is null",
        [organizationId],
      );
      return r.rows[0].n;
    });
    expect(activeDefaults).toBe(1);
  });

  it("is a no-op when the target is already the default", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const pipeline = await createPipeline(ctx, { name: "Already Default", isDefault: true });
    const result = await setDefaultPipeline(ctx, pipeline.id);
    expect(result.isDefault).toBe(true);
    expect(result.id).toBe(pipeline.id);
  });

  it("rejects a target that does not belong to this organization", async () => {
    const orgA = await createOrgWithActiveMember();
    const orgB = await createOrgWithActiveMember();
    const pipelineInB = await createPipeline(
      { userId: orgB.userId, organizationId: orgB.organizationId, roleKey: orgB.roleKey },
      { name: "Org B Pipeline" },
    );
    await expect(
      setDefaultPipeline({ userId: orgA.userId, organizationId: orgA.organizationId, roleKey: orgA.roleKey }, pipelineInB.id),
    ).rejects.toThrow(InvalidPipelineRelationshipError);
  });

  it("rejects a soft-deleted target", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const pipeline = await createPipeline(ctx, { name: "Soon Deleted" });
    await softDeletePipeline(ctx, pipeline.id);
    await expect(setDefaultPipeline(ctx, pipeline.id)).rejects.toThrow(InvalidPipelineRelationshipError);
  });

  it("rolls back cleanly on a failed switch — the prior default remains the sole active default", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const original = await createPipeline(ctx, { name: "Original Default", isDefault: true });

    await expect(setDefaultPipeline(ctx, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      InvalidPipelineRelationshipError,
    );

    const stillDefault = await getPipelineById(ctx, original.id);
    expect(stillDefault?.isDefault).toBe(true);
    const activeDefaults = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select count(*)::int as n from public.pipelines where organization_id = $1 and is_default and deleted_at is null",
        [organizationId],
      );
      return r.rows[0].n;
    });
    expect(activeDefaults).toBe(1);
  });
});

describe("softDeletePipeline: zero-default prevention (2.2B closes the domain-layer gap)", () => {
  it("rejects deleting the organization's only active default pipeline", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const pipeline = await createPipeline(ctx, { name: "The Only Default", isDefault: true });
    await expect(softDeletePipeline(ctx, pipeline.id)).rejects.toThrow(CannotDeleteDefaultPipelineError);

    const stillActive = await getPipelineById(ctx, pipeline.id);
    expect(stillActive?.deletedAt).toBeNull();
  });

  it("allows deleting the default AFTER switching the default to another active pipeline first", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    const original = await createPipeline(ctx, { name: "Original Default", isDefault: true });
    const replacement = await createPipeline(ctx, { name: "Replacement" });

    await setDefaultPipeline(ctx, replacement.id);
    const deleted = await softDeletePipeline(ctx, original.id);
    expect(deleted?.deletedAt).not.toBeNull();

    const activeDefaults = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select count(*)::int as n from public.pipelines where organization_id = $1 and is_default and deleted_at is null",
        [organizationId],
      );
      return r.rows[0].n;
    });
    expect(activeDefaults).toBe(1);
  });

  it("allows deleting a non-default pipeline freely, even one still referenced by deals (frozen Milestone 2.2 decision)", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    await createPipeline(ctx, { name: "Default", isDefault: true });
    const nonDefault = await createPipeline(ctx, { name: "Non Default" });

    const deleted = await softDeletePipeline(ctx, nonDefault.id);
    expect(deleted?.deletedAt).not.toBeNull();
  });

  it("returns null (not an error) for a nonexistent/cross-org/already-deleted pipeline", async () => {
    const { organizationId, userId, roleKey } = await createOrgWithActiveMember();
    const ctx = { userId, organizationId, roleKey };
    expect(await softDeletePipeline(ctx, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
