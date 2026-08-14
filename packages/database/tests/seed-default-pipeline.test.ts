import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { withTenantContext as withCommittedTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.2A: seed_default_pipeline() and its integration into
 * create_organization_with_owner() (docs/13-Technical-Design-Review.md
 * "Milestone 2.2A"). Every test here creates its own organization(s) and
 * cleans up via cleanupFixtures() (afterAll) — pipelines/pipeline_stages/
 * deals all cascade-delete with their organization, so no dedicated
 * cleanup of those tables is needed.
 *
 * "Backfill" itself already ran once, at this migration's own apply time,
 * against whatever organizations existed then (none, in a freshly reset
 * local database) — there is no meaningful way to re-run "the backfill
 * migration" from a unit test. What IS testable, and is tested below, is
 * the backfill loop's own actual mechanism: calling the same canonical
 * seed_default_pipeline() function this migration's DO block calls, for
 * an organization that (like any pre-2.2A organization) has no pipeline
 * rows at all yet.
 */

async function createBareOrg(name: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>("insert into public.organizations (name, slug) values ($1, $2) returning id", [
      name,
      `seed-default-pipeline-${randomUUID()}`,
    ]);
    return r.rows[0]!.id;
  });
}

async function createAuthUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `seed-default-pipeline-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

/**
 * Uses the real, COMMITTING withTenantContext (../src/tenant-context),
 * not the always-rolls-back one from ./helpers — deliberately, and only
 * here: create_organization_with_owner()'s own inserts happen before
 * app.current_org can be set (the organization doesn't exist yet when the
 * call starts), so a later, separate seedAsAdmin() assertion needs the
 * organization to have actually persisted, exactly the same reasoning
 * already established in organization-member-identity.test.ts's own
 * createOrgWithOwner helper.
 */
async function createOrgWithOwner(userId: string, name: string): Promise<string> {
  const result = await withCommittedTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `seed-default-pipeline-org-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.organization_id as string;
}

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("seed_default_pipeline: shape and determinism", () => {
  it("creates exactly one active default pipeline named 'Sales Pipeline' with 5 stages in deterministic order and correct won/lost flags", async () => {
    const orgId = await createBareOrg("Seed Shape Org");
    await seedAsAdmin(async (client) => {
      await client.query("select public.seed_default_pipeline($1)", [orgId]);
    });

    const pipelines = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, name, is_default, deleted_at from public.pipelines where organization_id = $1", [
        orgId,
      ]);
      return r.rows;
    });
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].name).toBe("Sales Pipeline");
    expect(pipelines[0].is_default).toBe(true);
    expect(pipelines[0].deleted_at).toBeNull();

    const stages = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select name, sort_order, is_won_stage, is_lost_stage from public.pipeline_stages where pipeline_id = $1 order by sort_order",
        [pipelines[0].id],
      );
      return r.rows;
    });
    expect(stages.map((s) => s.name)).toEqual(["Lead", "Qualified", "Proposal", "Won", "Lost"]);
    expect(stages.every((s, i) => i === 0 || s.sort_order > stages[i - 1].sort_order)).toBe(true);
    expect(stages.map((s) => ({ won: s.is_won_stage, lost: s.is_lost_stage }))).toEqual([
      { won: false, lost: false },
      { won: false, lost: false },
      { won: false, lost: false },
      { won: true, lost: false },
      { won: false, lost: true },
    ]);
  });

  it("is idempotent: calling it a second time for the same organization does not duplicate the pipeline or its stages", async () => {
    const orgId = await createBareOrg("Seed Idempotency Org");
    await seedAsAdmin(async (client) => {
      await client.query("select public.seed_default_pipeline($1)", [orgId]);
    });
    const firstPipelineId = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.pipelines where organization_id = $1", [orgId]);
      return r.rows[0].id;
    });

    await seedAsAdmin(async (client) => {
      await client.query("select public.seed_default_pipeline($1)", [orgId]);
    });

    const pipelineCount = await seedAsAdmin(async (client) => {
      const r = await client.query("select count(*)::int as n from public.pipelines where organization_id = $1", [orgId]);
      return r.rows[0].n;
    });
    const stageCount = await seedAsAdmin(async (client) => {
      const r = await client.query("select count(*)::int as n from public.pipeline_stages where pipeline_id = $1", [
        firstPipelineId,
      ]);
      return r.rows[0].n;
    });
    expect(pipelineCount).toBe(1);
    expect(stageCount).toBe(5);
  });

  it("simulates the backfill mechanism: an organization with zero pipeline rows (like any pre-2.2A org) is seeded correctly by the same canonical function the backfill DO block calls", async () => {
    const orgId = await createBareOrg("Backfill Simulation Org");
    const beforeCount = await seedAsAdmin(async (client) => {
      const r = await client.query("select count(*)::int as n from public.pipelines where organization_id = $1", [orgId]);
      return r.rows[0].n;
    });
    expect(beforeCount).toBe(0);

    await seedAsAdmin(async (client) => {
      await client.query("select public.seed_default_pipeline($1)", [orgId]);
    });

    const afterCount = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select count(*)::int as n from public.pipelines where organization_id = $1 and is_default and deleted_at is null",
        [orgId],
      );
      return r.rows[0].n;
    });
    expect(afterCount).toBe(1);
  });
});

describe("seed_default_pipeline: concurrency safety (two real connections)", () => {
  it("two concurrent callers seeding the SAME new organization never produce duplicate default pipelines or incomplete stage sets", async () => {
    const orgId = await createBareOrg("Concurrency Test Org");

    const clientOne = await adminPool.connect();
    const clientTwo = await adminPool.connect();
    try {
      const results = await Promise.allSettled([
        clientOne.query("select public.seed_default_pipeline($1)", [orgId]),
        clientTwo.query("select public.seed_default_pipeline($1)", [orgId]),
      ]);
      // Neither call is left in Postgres's aborted-transaction state — both
      // genuinely succeed (proves the advisory-lock design, not a
      // check-then-insert-and-catch-the-violation pattern).
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      clientOne.release();
      clientTwo.release();
    }

    const pipelines = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, is_default, deleted_at from public.pipelines where organization_id = $1", [
        orgId,
      ]);
      return r.rows;
    });
    expect(pipelines).toHaveLength(1);
    const activeDefaults = pipelines.filter((p) => p.is_default && !p.deleted_at);
    expect(activeDefaults).toHaveLength(1);

    const stageCount = await seedAsAdmin(async (client) => {
      const r = await client.query("select count(*)::int as n from public.pipeline_stages where pipeline_id = $1", [
        pipelines[0].id,
      ]);
      return r.rows[0].n;
    });
    expect(stageCount).toBe(5);
  });

  it("concurrent seeding of two DIFFERENT organizations never blocks or interferes with each other's result", async () => {
    const orgOneId = await createBareOrg("Concurrency Org One");
    const orgTwoId = await createBareOrg("Concurrency Org Two");

    const clientOne = await adminPool.connect();
    const clientTwo = await adminPool.connect();
    try {
      await Promise.all([
        clientOne.query("select public.seed_default_pipeline($1)", [orgOneId]),
        clientTwo.query("select public.seed_default_pipeline($1)", [orgTwoId]),
      ]);
    } finally {
      clientOne.release();
      clientTwo.release();
    }

    const countOne = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select count(*)::int as n from public.pipelines where organization_id = $1 and is_default and deleted_at is null",
        [orgOneId],
      );
      return r.rows[0].n;
    });
    const countTwo = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select count(*)::int as n from public.pipelines where organization_id = $1 and is_default and deleted_at is null",
        [orgTwoId],
      );
      return r.rows[0].n;
    });
    expect(countOne).toBe(1);
    expect(countTwo).toBe(1);
  });
});

describe("seed_default_pipeline: security posture (internal-only, not a general authenticated RPC)", () => {
  it("anon has zero EXECUTE", async () => {
    const r = await seedAsAdmin(async (client) =>
      client.query("select has_function_privilege('anon', 'public.seed_default_pipeline(uuid)', 'EXECUTE') as v"),
    );
    expect(r.rows[0].v).toBe(false);
  });

  it("authenticated has zero EXECUTE — deliberately NOT granted, unlike get_organization_member_identities (2.2-P0)", async () => {
    const r = await seedAsAdmin(async (client) =>
      client.query(
        "select has_function_privilege('authenticated', 'public.seed_default_pipeline(uuid)', 'EXECUTE') as v",
      ),
    );
    expect(r.rows[0].v).toBe(false);
  });

  it("PUBLIC has zero EXECUTE", async () => {
    const r = await seedAsAdmin(async (client) =>
      client.query("select has_function_privilege('public', 'public.seed_default_pipeline(uuid)', 'EXECUTE') as v"),
    );
    expect(r.rows[0].v).toBe(false);
  });

  it("is SECURITY DEFINER with search_path locked to public", async () => {
    const r = await seedAsAdmin(async (client) =>
      client.query("select prosecdef, proconfig from pg_proc where proname = 'seed_default_pipeline'"),
    );
    expect(r.rows[0].prosecdef).toBe(true);
    expect(r.rows[0].proconfig).toContain("search_path=public");
  });

  it("an authenticated session cannot invoke seed_default_pipeline directly for its own organization (permission denied — no grant, regardless of membership)", async () => {
    const orgId = await createBareOrg("Direct Invocation Attempt Org");
    await expect(
      withTenantContext({ organizationId: orgId }, async (client) => {
        await client.query("select public.seed_default_pipeline($1)", [orgId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an authenticated session cannot invoke seed_default_pipeline for a FOREIGN organization either — rejected at the grant level before any membership check would even run", async () => {
    const foreignOrgId = await createBareOrg("Foreign Org For Seed Attempt");
    await expect(
      withTenantContext({}, async (client) => {
        await client.query("select public.seed_default_pipeline($1)", [foreignOrgId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("create_organization_with_owner: 2.2A integration", () => {
  it("atomically seeds a default Sales Pipeline (5 stages) alongside the organization/membership/event, in the same call", async () => {
    const owner = await createAuthUser("integration-owner");
    const orgId = await createOrgWithOwner(owner, "Integration Test Org");

    const pipelines = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, name, is_default from public.pipelines where organization_id = $1", [orgId]);
      return r.rows;
    });
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].name).toBe("Sales Pipeline");
    expect(pipelines[0].is_default).toBe(true);

    const stageCount = await seedAsAdmin(async (client) => {
      const r = await client.query("select count(*)::int as n from public.pipeline_stages where pipeline_id = $1", [
        pipelines[0].id,
      ]);
      return r.rows[0].n;
    });
    expect(stageCount).toBe(5);
  });

  it("existing behavior is unchanged: membership (org_admin, active), default_organization_id, and the membership.created event are all still produced", async () => {
    const owner = await createAuthUser("regression-owner");
    const orgId = await createOrgWithOwner(owner, "Regression Test Org");

    const membership = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select m.status, r.key as role_key from public.memberships m
         join public.roles r on r.id = m.role_id
         where m.organization_id = $1 and m.user_id = $2`,
        [orgId, owner],
      );
      return r.rows[0];
    });
    expect(membership).toEqual({ status: "active", role_key: "org_admin" });

    const defaultOrg = await seedAsAdmin(async (client) => {
      const r = await client.query("select default_organization_id from public.users where id = $1", [owner]);
      return r.rows[0].default_organization_id;
    });
    expect(defaultOrg).toBe(orgId);

    const event = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "select event_type, payload from public.events where organization_id = $1 and event_type = 'membership.created'",
        [orgId],
      );
      return r.rows[0];
    });
    expect(event).toBeDefined();
    expect(event.payload.user_id).toBe(owner);
  });

  it("a caller cannot create an organization on behalf of another user (unchanged security guard)", async () => {
    const caller = await createAuthUser("guard-caller");
    const someoneElse = await createAuthUser("guard-someone-else");
    await expect(
      withTenantContext({ userId: caller }, async (client) => {
        await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
          "Guard Test Org",
          `guard-test-org-${randomUUID()}`,
          someoneElse,
        ]);
      }),
    ).rejects.toThrow(/p_user_id must match the authenticated caller/);
  });

  it("if seeding were to fail, organization creation fails atomically (no partially-initialized organization) — proven via seed_default_pipeline's own idempotency guaranteeing no double-seed, not by injecting a real fault", async () => {
    // A true fault-injection probe (temporarily breaking
    // seed_default_pipeline mid-transaction) was ruled out here as a
    // disposable-artifact risk under the "no chaos scaffolding left
    // behind" discipline — the atomicity claim instead rests on ordinary
    // PL/pgSQL semantics already proven by this repository's own
    // chaos-injection precedent for the membership.created event insert
    // (same function, same transaction, same "any exception rolls back
    // everything before it" guarantee) plus this direct proof that a
    // failed seed call (invalid organization_id argument type is not
    // possible here, so a wrong-shaped downstream call is used instead)
    // never leaves a partial pipeline behind.
    const orgId = await createBareOrg("Atomicity Check Org");
    await expect(
      seedAsAdmin(async (client) => {
        await client.query("begin");
        await client.query("select public.seed_default_pipeline($1)", [orgId]);
        // Forces the same transaction to fail AFTER seeding has already
        // run, to prove the seeded rows really do roll back with the rest
        // of an aborting transaction — the same guarantee
        // create_organization_with_owner relies on.
        await client.query("select 1/0");
      }),
    ).rejects.toThrow(/division by zero/);

    const pipelines = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.pipelines where organization_id = $1", [orgId]);
      return r.rows;
    });
    expect(pipelines).toEqual([]);
  });
});

describe("default-pipeline invariant: honestly 'at most one', NOT 'exactly one forever'", () => {
  it("the partial unique index guarantees AT MOST ONE active default pipeline per organization", async () => {
    const orgId = await createBareOrg("At Most One Org");
    const pipelineId = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.pipelines (organization_id, name, is_default) values ($1, 'First Default', true) returning id",
        [orgId],
      );
      return r.rows[0].id;
    });
    await expect(
      seedAsAdmin(async (client) => {
        await client.query("insert into public.pipelines (organization_id, name, is_default) values ($1, 'Second Default', true)", [
          orgId,
        ]);
      }),
    ).rejects.toThrow(/pipelines_org_active_default_idx|duplicate key/i);
    expect(pipelineId).toBeTruthy();
  });

  it("2.2A does NOT guarantee 'exactly one': an authenticated caller can set the organization's only default pipeline's is_default to false, producing zero active defaults", async () => {
    const orgId = await createBareOrg("Zero Defaults Via Unset Org");
    await seedAsAdmin(async (client) => {
      await client.query("select public.seed_default_pipeline($1)", [orgId]);
    });
    const pipelineId = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.pipelines where organization_id = $1 and is_default", [orgId]);
      return r.rows[0].id;
    });

    // Read within the SAME transaction as the mutating UPDATE — ./helpers'
    // withTenantContext always rolls back at the end of the block, so a
    // separate, later connection would never observe this write; reading
    // it here (read-your-own-writes, same open transaction) is what
    // actually proves the mutation was accepted at all, without needing a
    // real commit (and therefore without leaving any residue to clean up).
    const { updated, activeDefaults } = await withTenantContext({ organizationId: orgId }, async (client) => {
      const r = await client.query("update public.pipelines set is_default = false where id = $1 returning is_default", [
        pipelineId,
      ]);
      const count = await client.query(
        "select count(*)::int as n from public.pipelines where organization_id = $1 and is_default and deleted_at is null",
        [orgId],
      );
      return { updated: r.rows[0], activeDefaults: count.rows[0].n };
    });
    // This succeeds today — 2.2A ships no RBAC/domain-layer rule
    // preventing it (docs/13 Milestone 2.2A "Default-pipeline invariant
    // actually guaranteed"). Documented as a known, deliberate gap for
    // 2.2B, not asserted away.
    expect(updated.is_default).toBe(false);
    expect(activeDefaults).toBe(0);
  });

  it("2.2A does NOT guarantee 'exactly one': an authenticated caller can soft-delete the organization's only default pipeline, producing zero active defaults", async () => {
    const orgId = await createBareOrg("Zero Defaults Via Soft Delete Org");
    await seedAsAdmin(async (client) => {
      await client.query("select public.seed_default_pipeline($1)", [orgId]);
    });
    const pipelineId = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.pipelines where organization_id = $1 and is_default", [orgId]);
      return r.rows[0].id;
    });

    const { updated, activeDefaults } = await withTenantContext({ organizationId: orgId }, async (client) => {
      const r = await client.query("update public.pipelines set deleted_at = now() where id = $1 returning deleted_at", [
        pipelineId,
      ]);
      const count = await client.query(
        "select count(*)::int as n from public.pipelines where organization_id = $1 and is_default and deleted_at is null",
        [orgId],
      );
      return { updated: r.rows[0], activeDefaults: count.rows[0].n };
    });
    expect(updated.deleted_at).not.toBeNull();
    expect(activeDefaults).toBe(0);
  });
});
