import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.3A RLS/privilege adversarial coverage (docs/13-Technical-
 * Design-Review.md "Milestone 2.3"). Mirrors pipelines-deals-rls.test.ts
 * exactly in style: real Postgres, never mocked, org A vs org B, and a
 * direct information_schema check for the effective privilege set rather
 * than trusting "should inherit defaults" without proof.
 *
 * Taggings deliberately gets its own describe blocks throughout — it is
 * the one table in this family with a real DELETE grant/policy and no
 * UPDATE policy at all (2.3 frozen design decision, docs/13 Milestone
 * 2.3), so its adversarial shape differs from activities/notes/tags.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
  activityAId: string;
  activityBId: string;
  noteAId: string;
  noteBId: string;
  tagAId: string;
  tagBId: string;
  taggingAId: string;
  taggingBId: string;
}

let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Activities RLS Test Org A', $1) returning id",
      [`activities-rls-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Activities RLS Test Org B', $1) returning id",
      [`activities-rls-test-org-b-${randomUUID()}`],
    );
    const activityA = await client.query<{ id: string }>(
      "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'call', 'deal', $2) returning id",
      [orgA.rows[0]!.id, randomUUID()],
    );
    const activityB = await client.query<{ id: string }>(
      "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'call', 'deal', $2) returning id",
      [orgB.rows[0]!.id, randomUUID()],
    );
    const noteA = await client.query<{ id: string }>(
      "insert into public.notes (organization_id, related_to_type, related_to_id, body) values ($1, 'contact', $2, 'Org A Note') returning id",
      [orgA.rows[0]!.id, randomUUID()],
    );
    const noteB = await client.query<{ id: string }>(
      "insert into public.notes (organization_id, related_to_type, related_to_id, body) values ($1, 'contact', $2, 'Org B Note') returning id",
      [orgB.rows[0]!.id, randomUUID()],
    );
    const tagA = await client.query<{ id: string }>(
      "insert into public.tags (organization_id, name) values ($1, 'Org A Tag') returning id",
      [orgA.rows[0]!.id],
    );
    const tagB = await client.query<{ id: string }>(
      "insert into public.tags (organization_id, name) values ($1, 'Org B Tag') returning id",
      [orgB.rows[0]!.id],
    );
    const taggingA = await client.query<{ id: string }>(
      "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3) returning id",
      [orgA.rows[0]!.id, tagA.rows[0]!.id, randomUUID()],
    );
    const taggingB = await client.query<{ id: string }>(
      "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3) returning id",
      [orgB.rows[0]!.id, tagB.rows[0]!.id, randomUUID()],
    );
    return {
      orgAId: orgA.rows[0]!.id,
      orgBId: orgB.rows[0]!.id,
      activityAId: activityA.rows[0]!.id,
      activityBId: activityB.rows[0]!.id,
      noteAId: noteA.rows[0]!.id,
      noteBId: noteB.rows[0]!.id,
      tagAId: tagA.rows[0]!.id,
      tagBId: tagB.rows[0]!.id,
      taggingAId: taggingA.rows[0]!.id,
      taggingBId: taggingB.rows[0]!.id,
    };
  });
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedFixture();
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("activities/notes/tags/taggings RLS: cross-tenant SELECT/UPDATE isolation", () => {
  it("org A cannot SELECT org B's activity", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.activities where id = $1", [fx.activityBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's activity", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "update public.activities set subject = 'Hijacked' where id = $1 returning id",
        [fx.activityBId],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
    const stillIntact = await seedAsAdmin(async (client) => {
      const r = await client.query("select subject from public.activities where id = $1", [fx.activityBId]);
      return r.rows[0];
    });
    expect(stillIntact.subject).toBeNull();
  });

  it("org A cannot SELECT org B's note", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.notes where id = $1", [fx.noteBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's note", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.notes set body = 'Hijacked' where id = $1 returning id", [
        fx.noteBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
    const stillIntact = await seedAsAdmin(async (client) => {
      const r = await client.query("select body from public.notes where id = $1", [fx.noteBId]);
      return r.rows[0];
    });
    expect(stillIntact.body).toBe("Org B Note");
  });

  it("org A cannot SELECT org B's tag", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.tags where id = $1", [fx.tagBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot UPDATE org B's tag", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("update public.tags set name = 'Hijacked' where id = $1 returning id", [
        fx.tagBId,
      ]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot SELECT org B's tagging", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("select id from public.taggings where id = $1", [fx.taggingBId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("org A cannot soft-delete org B's activity", async () => {
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "update public.activities set deleted_at = now() where id = $1 returning id",
        [fx.activityBId],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
    const stillActive = await seedAsAdmin(async (client) => {
      const r = await client.query("select deleted_at from public.activities where id = $1", [fx.activityBId]);
      return r.rows[0];
    });
    expect(stillActive.deleted_at).toBeNull();
  });
});

describe("activities/notes/tags RLS: WITH CHECK prevents organization_id spoofing/mutation", () => {
  it("INSERT cannot spoof organization_id on an activity to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'call', 'deal', $2)",
          [fx.orgBId, randomUUID()],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("UPDATE cannot move an activity from org A to org B", async () => {
    const activity = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'call', 'deal', $2) returning id",
        [fx.orgAId, randomUUID()],
      );
      return r.rows[0]!;
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("update public.activities set organization_id = $1 where id = $2", [
          fx.orgBId,
          activity.id,
        ]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("INSERT cannot spoof organization_id on a note to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.notes (organization_id, related_to_type, related_to_id, body) values ($1, 'contact', $2, 'x')",
          [fx.orgBId, randomUUID()],
        );
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("INSERT cannot spoof organization_id on a tag to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.tags (organization_id, name) values ($1, 'Spoofed Tag')", [
          fx.orgBId,
        ]);
      }),
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });

  it("INSERT cannot spoof organization_id on a tagging to another tenant while scoped to org A", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3)",
          [fx.orgBId, fx.tagAId, randomUUID()],
        );
      }),
      // Rejected by RLS's WITH CHECK before taggings_tag_org_fk is even
      // relevant here (tag belongs to org A, not org B).
    ).rejects.toThrow(/new row violates row-level security policy/i);
  });
});

describe("activities/notes/tags privileges: effective grants match the approved design", () => {
  it.each(["activities", "notes", "tags"])(
    "authenticated has exactly SELECT/INSERT/UPDATE on %s — no DELETE, no TRUNCATE/REFERENCES/TRIGGER",
    async (table) => {
      const rows = await seedAsAdmin(async (client) => {
        const r = await client.query<{ privilege_type: string }>(
          `select privilege_type from information_schema.role_table_grants
           where table_schema = 'public' and table_name = $1 and grantee = 'authenticated'
           order by privilege_type`,
          [table],
        );
        return r.rows.map((row) => row.privilege_type);
      });
      expect(rows).toEqual(["INSERT", "SELECT", "UPDATE"]);
    },
  );

  it.each(["activities", "notes", "tags", "taggings"])("anon has zero grants on %s", async (table) => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = $1 and grantee = 'anon'`,
        [table],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("an authenticated session genuinely cannot physically DELETE an activity row", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.activities where id = $1", [fx.activityAId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an authenticated session genuinely cannot physically DELETE a note row", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.notes where id = $1", [fx.noteAId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an authenticated session genuinely cannot physically DELETE a tag row", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("delete from public.tags where id = $1", [fx.tagAId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it.each(["activities", "notes", "tags", "taggings"])("an authenticated session genuinely cannot TRUNCATE %s", async (table) => {
    await expect(
      withTenantContext({}, async (client) => {
        await client.query(`truncate public.${table}`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("taggings: the deliberate DELETE exception (2.3 frozen design decision)", () => {
  it("authenticated has exactly SELECT/INSERT/DELETE on taggings — no UPDATE", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'taggings' and grantee = 'authenticated'
         order by privilege_type`,
      );
      return r.rows.map((row) => row.privilege_type);
    });
    expect(rows).toEqual(["DELETE", "INSERT", "SELECT"]);
  });

  it("a same-org authenticated session CAN physically DELETE its own organization's tagging", async () => {
    // withTenantContext always rolls back its transaction (test-isolation
    // harness behavior, see helpers.ts) — "rows affected = 1" inside that
    // transaction is itself the proof that RLS + the grant permit the
    // delete; a real request would commit exactly this. Persistence across
    // a commit is proven separately by the cascade-delete schema test
    // (activities-notes-tags-schema.test.ts, which uses seedAsAdmin's own
    // begin/commit).
    const tagging = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3) returning id",
        [fx.orgAId, fx.tagAId, randomUUID()],
      );
      return r.rows[0]!;
    });
    const deletedRows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("delete from public.taggings where id = $1 returning id", [tagging.id]);
      return r.rows;
    });
    expect(deletedRows).toHaveLength(1);
  });

  it("org A cannot physically DELETE org B's tagging — the DELETE grant is tenant-scoped, not global", async () => {
    const deletedRows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query("delete from public.taggings where id = $1 returning id", [fx.taggingBId]);
      return r.rows;
    });
    expect(deletedRows).toEqual([]);
    const stillExists = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.taggings where id = $1", [fx.taggingBId]);
      return r.rows;
    });
    expect(stillExists).toHaveLength(1);
  });

  it("an authenticated session genuinely cannot UPDATE a tagging row — no update policy exists", async () => {
    const tagging = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'deal', $3) returning id",
        [fx.orgAId, fx.tagAId, randomUUID()],
      );
      return r.rows[0]!;
    });
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("update public.taggings set taggable_type = 'company' where id = $1", [tagging.id]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
