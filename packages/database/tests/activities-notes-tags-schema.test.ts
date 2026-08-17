import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminPool, cleanupFixtures, seedAsAdmin, withTenantContext } from "./helpers";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.3A schema/constraint coverage (docs/13-Technical-Design-
 * Review.md "Milestone 2.3"). Mirrors pipelines-deals-schema.test.ts
 * exactly in style. activities/notes/tags/taggings all cascade-delete
 * along with their organization, so cleanupFixtures()'s existing
 * `delete from organizations` already tears these down too — no
 * dedicated cleanup needed here.
 */

interface Fixture {
  orgAId: string;
  orgBId: string;
}

let fx: Fixture;

async function seedOrgs(): Promise<Fixture> {
  return seedAsAdmin(async (client) => {
    const orgA = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Activities Schema Test Org A', $1) returning id",
      [`activities-schema-test-org-a-${randomUUID()}`],
    );
    const orgB = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ('Activities Schema Test Org B', $1) returning id",
      [`activities-schema-test-org-b-${randomUUID()}`],
    );
    return { orgAId: orgA.rows[0]!.id, orgBId: orgB.rows[0]!.id };
  });
}

async function seedTag(
  client: import("pg").PoolClient,
  organizationId: string,
  name = "Test Tag",
): Promise<string> {
  const r = await client.query<{ id: string }>(
    "insert into public.tags (organization_id, name) values ($1, $2) returning id",
    [organizationId, name],
  );
  return r.rows[0]!.id;
}

async function seedUser(label: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `activities-schema-${label}-${userId}@example.test`,
    ]);
  });
  return userId;
}

beforeAll(async () => {
  await cleanupFixtures();
  fx = await seedOrgs();
});

afterAll(async () => {
  await cleanupFixtures();
  await adminPool.end();
  await closePool();
});

describe("activities: basic schema and defaults", () => {
  it("an activity can be created with the required fields, and defaults apply", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        `insert into public.activities (organization_id, type, related_to_type, related_to_id)
         values ($1, 'call', 'contact', $2)
         returning organization_id, type, related_to_type, related_to_id, subject, body, due_at,
                   completed_at, created_by, deleted_at`,
        [fx.orgAId, randomUUID()],
      );
      return r.rows[0];
    });
    expect(row.organization_id).toBe(fx.orgAId);
    expect(row.type).toBe("call");
    expect(row.subject).toBeNull();
    expect(row.body).toBeNull();
    expect(row.due_at).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.created_by).toBeNull();
    expect(row.deleted_at).toBeNull();
  });

  it("type is required", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.activities (organization_id, related_to_type, related_to_id) values ($1, 'contact', $2)",
          [fx.orgAId, randomUUID()],
        );
      }),
    ).rejects.toThrow(/null value in column "type"/i);
  });

  it("related_to_type is required", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.activities (organization_id, type) values ($1, 'call')", [
          fx.orgAId,
        ]);
      }),
    ).rejects.toThrow(/null value in column "related_to_type"/i);
  });
});

describe("activities: type CHECK constraint", () => {
  it.each(["call", "email", "meeting", "note", "task"])("accepts type=%s", async (type) => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, $2, 'deal', $3) returning type",
        [fx.orgAId, type, randomUUID()],
      );
      return r.rows[0];
    });
    expect(row.type).toBe(type);
  });

  it("rejects an unrecognized type", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'sms', 'deal', $2)",
          [fx.orgAId, randomUUID()],
        );
      }),
    ).rejects.toThrow(/violates check constraint/i);
  });
});

describe("activities: related_to_type CHECK constraint", () => {
  it.each(["company", "contact", "deal"])("accepts related_to_type=%s", async (relatedToType) => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'task', $2, $3) returning related_to_type",
        [fx.orgAId, relatedToType, randomUUID()],
      );
      return r.rows[0];
    });
    expect(row.related_to_type).toBe(relatedToType);
  });

  it("rejects an unrecognized related_to_type", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'task', 'campaign', $2)",
          [fx.orgAId, randomUUID()],
        );
      }),
    ).rejects.toThrow(/violates check constraint/i);
  });
});

describe("activities: related_to_id is nullable at the DB level (GDPR erasure path only)", () => {
  it("accepts a NULL related_to_id — the DB does not enforce the domain-layer 'required at create time' rule", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'note', 'contact', null) returning related_to_id",
        [fx.orgAId],
      );
      return r.rows[0];
    });
    expect(row.related_to_id).toBeNull();
  });
});

describe("activities: FK organization_id", () => {
  it("rejects an activity for a non-existent organization", async () => {
    await expect(
      seedAsAdmin(async (client) => {
        await client.query(
          "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'call', 'deal', $2)",
          [randomUUID(), randomUUID()],
        );
      }),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("activities: FK created_by (ON DELETE SET NULL)", () => {
  it("nulls created_by when the referenced user is deleted, leaving the activity itself intact", async () => {
    const userId = await seedUser("activity-created-by");
    const activityId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.activities (organization_id, type, related_to_type, related_to_id, created_by) values ($1, 'call', 'deal', $2, $3) returning id",
        [fx.orgAId, randomUUID(), userId],
      );
      return r.rows[0]!.id;
    });
    await seedAsAdmin(async (client) => {
      await client.query("delete from auth.users where id = $1", [userId]);
    });
    const after = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, created_by, deleted_at from public.activities where id = $1", [
        activityId,
      ]);
      return r.rows[0];
    });
    expect(after).toBeDefined();
    expect(after.created_by).toBeNull();
    expect(after.deleted_at).toBeNull();
  });
});

describe("activities: indexes", () => {
  it("activities_org_active_idx, activities_org_related_idx, and activities_org_created_by_idx exist", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'public' and tablename = 'activities'",
      );
      return r.rows.map((row) => row.indexname);
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        "activities_org_active_idx",
        "activities_org_related_idx",
        "activities_org_created_by_idx",
      ]),
    );
  });
});

describe("activities: updated_at trigger", () => {
  it("advances updated_at when an activity row is updated", async () => {
    const inserted = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.activities (organization_id, type, related_to_type, related_to_id) values ($1, 'call', 'deal', $2) returning id, updated_at",
        [fx.orgAId, randomUUID()],
      );
      return r.rows[0];
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await seedAsAdmin(async (client) => {
      const r = await client.query("update public.activities set subject = $1 where id = $2 returning updated_at", [
        "Renamed",
        inserted.id,
      ]);
      return r.rows[0];
    });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(inserted.updated_at).getTime());
  });
});

describe("notes: basic schema and defaults", () => {
  it("a note can be created with the required fields, and defaults apply", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        `insert into public.notes (organization_id, related_to_type, related_to_id, body)
         values ($1, 'company', $2, 'Some note text')
         returning organization_id, related_to_type, related_to_id, body, created_by, deleted_at`,
        [fx.orgAId, randomUUID()],
      );
      return r.rows[0];
    });
    expect(row.organization_id).toBe(fx.orgAId);
    expect(row.body).toBe("Some note text");
    expect(row.created_by).toBeNull();
    expect(row.deleted_at).toBeNull();
  });

  it("related_to_type is required", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.notes (organization_id, body) values ($1, 'text')", [fx.orgAId]);
      }),
    ).rejects.toThrow(/null value in column "related_to_type"/i);
  });
});

describe("notes: related_to_type CHECK constraint", () => {
  it.each(["company", "contact", "deal"])("accepts related_to_type=%s", async (relatedToType) => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.notes (organization_id, related_to_type, related_to_id, body) values ($1, $2, $3, 'x') returning related_to_type",
        [fx.orgAId, relatedToType, randomUUID()],
      );
      return r.rows[0];
    });
    expect(row.related_to_type).toBe(relatedToType);
  });

  it("rejects an unrecognized related_to_type", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.notes (organization_id, related_to_type, related_to_id, body) values ($1, 'campaign', $2, 'x')",
          [fx.orgAId, randomUUID()],
        );
      }),
    ).rejects.toThrow(/violates check constraint/i);
  });
});

describe("notes: related_to_id and body are nullable at the DB level (GDPR erasure path only)", () => {
  it("accepts a NULL related_to_id and a NULL body simultaneously", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.notes (organization_id, related_to_type, related_to_id, body) values ($1, 'contact', null, null) returning related_to_id, body",
        [fx.orgAId],
      );
      return r.rows[0];
    });
    expect(row.related_to_id).toBeNull();
    expect(row.body).toBeNull();
  });
});

describe("notes: FK organization_id", () => {
  it("rejects a note for a non-existent organization", async () => {
    await expect(
      seedAsAdmin(async (client) => {
        await client.query(
          "insert into public.notes (organization_id, related_to_type, related_to_id, body) values ($1, 'deal', $2, 'x')",
          [randomUUID(), randomUUID()],
        );
      }),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("notes: FK created_by (ON DELETE SET NULL)", () => {
  it("nulls created_by when the referenced user is deleted, leaving the note itself intact", async () => {
    const userId = await seedUser("note-created-by");
    const noteId = await seedAsAdmin(async (client) => {
      const r = await client.query<{ id: string }>(
        "insert into public.notes (organization_id, related_to_type, related_to_id, body, created_by) values ($1, 'deal', $2, 'x', $3) returning id",
        [fx.orgAId, randomUUID(), userId],
      );
      return r.rows[0]!.id;
    });
    await seedAsAdmin(async (client) => {
      await client.query("delete from auth.users where id = $1", [userId]);
    });
    const after = await seedAsAdmin(async (client) => {
      const r = await client.query("select id, created_by, body, deleted_at from public.notes where id = $1", [
        noteId,
      ]);
      return r.rows[0];
    });
    expect(after).toBeDefined();
    expect(after.created_by).toBeNull();
    expect(after.body).toBe("x");
    expect(after.deleted_at).toBeNull();
  });
});

describe("notes: indexes", () => {
  it("notes_org_active_idx and notes_org_related_idx exist", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'public' and tablename = 'notes'",
      );
      return r.rows.map((row) => row.indexname);
    });
    expect(rows).toEqual(expect.arrayContaining(["notes_org_active_idx", "notes_org_related_idx"]));
  });
});

describe("notes: updated_at trigger", () => {
  it("advances updated_at when a note row is updated", async () => {
    const inserted = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.notes (organization_id, related_to_type, related_to_id, body) values ($1, 'deal', $2, 'x') returning id, updated_at",
        [fx.orgAId, randomUUID()],
      );
      return r.rows[0];
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await seedAsAdmin(async (client) => {
      const r = await client.query("update public.notes set body = $1 where id = $2 returning updated_at", [
        "y",
        inserted.id,
      ]);
      return r.rows[0];
    });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(inserted.updated_at).getTime());
  });
});

describe("tags: basic schema and defaults", () => {
  it("a tag can be created with just organization_id and name", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.tags (organization_id, name) values ($1, $2) returning organization_id, name, color, deleted_at",
        [fx.orgAId, "Hot Lead"],
      );
      return r.rows[0];
    });
    expect(row.organization_id).toBe(fx.orgAId);
    expect(row.name).toBe("Hot Lead");
    expect(row.color).toBeNull();
    expect(row.deleted_at).toBeNull();
  });

  it("name is required", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.tags (organization_id) values ($1)", [fx.orgAId]);
      }),
    ).rejects.toThrow(/null value in column "name"/i);
  });

  it("color is nullable and accepts a free-form value", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const r = await client.query(
        "insert into public.tags (organization_id, name, color) values ($1, $2, $3) returning color",
        [fx.orgAId, "Colored Tag", "#ff0000"],
      );
      return r.rows[0];
    });
    expect(row.color).toBe("#ff0000");
  });
});

describe("tags: case-insensitive active-name uniqueness per organization", () => {
  it("rejects a duplicate active name differing only by case within the same organization", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query("insert into public.tags (organization_id, name) values ($1, 'Priority')", [fx.orgAId]);
        await client.query("insert into public.tags (organization_id, name) values ($1, 'PRIORITY')", [fx.orgAId]);
      }),
    ).rejects.toThrow(/tags_org_active_name_idx|duplicate key/i);
  });

  it("allows the name to be reused once the prior tag with that name is soft-deleted", async () => {
    const secondId = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const first = await client.query<{ id: string }>(
        "insert into public.tags (organization_id, name) values ($1, 'Reusable') returning id",
        [fx.orgAId],
      );
      await client.query("update public.tags set deleted_at = now() where id = $1", [first.rows[0]!.id]);
      const second = await client.query<{ id: string }>(
        "insert into public.tags (organization_id, name) values ($1, 'Reusable') returning id",
        [fx.orgAId],
      );
      return second.rows[0]!.id;
    });
    expect(secondId).toBeTruthy();
  });

  it("two different organizations can each have a tag with the same name", async () => {
    await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      await client.query("insert into public.tags (organization_id, name) values ($1, 'Shared Name')", [fx.orgAId]);
    });
    await withTenantContext({ organizationId: fx.orgBId }, async (client) => {
      await client.query("insert into public.tags (organization_id, name) values ($1, 'Shared Name')", [fx.orgBId]);
    });
  });
});

describe("tags: unique(organization_id, id)", () => {
  it("the composite unique constraint exists (required by taggings_tag_org_fk)", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ conname: string }>(
        `select conname from pg_constraint
         where conrelid = 'public.tags'::regclass and contype = 'u'`,
      );
      return r.rows.map((row) => row.conname);
    });
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("tags: FK organization_id", () => {
  it("rejects a tag for a non-existent organization", async () => {
    await expect(
      seedAsAdmin(async (client) => {
        await client.query("insert into public.tags (organization_id, name) values ($1, 'Orphan Tag')", [
          randomUUID(),
        ]);
      }),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("tags: updated_at trigger", () => {
  it("advances updated_at when a tag row is updated", async () => {
    const inserted = await seedAsAdmin(async (client) => {
      const r = await client.query(
        "insert into public.tags (organization_id, name) values ($1, 'Timestamp Tag') returning id, updated_at",
        [fx.orgAId],
      );
      return r.rows[0];
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await seedAsAdmin(async (client) => {
      const r = await client.query("update public.tags set color = $1 where id = $2 returning updated_at", [
        "#00ff00",
        inserted.id,
      ]);
      return r.rows[0];
    });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(inserted.updated_at).getTime());
  });
});

describe("taggings: basic schema and defaults", () => {
  it("a tagging can be created with tag_id, taggable_type, and taggable_id", async () => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const tagId = await seedTag(client, fx.orgAId, "Taggings Basic Tag");
      const r = await client.query(
        "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3) returning organization_id, tag_id, taggable_type, taggable_id, created_at",
        [fx.orgAId, tagId, randomUUID()],
      );
      return r.rows[0];
    });
    expect(row.organization_id).toBe(fx.orgAId);
    expect(row.taggable_type).toBe("contact");
    expect(row.created_at).toBeTruthy();
  });

  it("taggable_id is required", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const tagId = await seedTag(client, fx.orgAId, "Taggings Required Tag");
        await client.query(
          "insert into public.taggings (organization_id, tag_id, taggable_type) values ($1, $2, 'contact')",
          [fx.orgAId, tagId],
        );
      }),
    ).rejects.toThrow(/null value in column "taggable_id"/i);
  });

  it("has no deleted_at column — physical delete is the only removal mechanism", async () => {
    const columns = await seedAsAdmin(async (client) => {
      const r = await client.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'taggings'",
      );
      return r.rows.map((row) => row.column_name);
    });
    expect(columns).not.toContain("deleted_at");
    expect(columns).not.toContain("updated_at");
  });
});

describe("taggings: taggable_type CHECK constraint", () => {
  it.each(["company", "contact", "deal"])("accepts taggable_type=%s", async (taggableType) => {
    const row = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const tagId = await seedTag(client, fx.orgAId, `Taggings Type Tag ${taggableType}`);
      const r = await client.query(
        "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, $3, $4) returning taggable_type",
        [fx.orgAId, tagId, taggableType, randomUUID()],
      );
      return r.rows[0];
    });
    expect(row.taggable_type).toBe(taggableType);
  });

  it("rejects an unrecognized taggable_type", async () => {
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const tagId = await seedTag(client, fx.orgAId, "Taggings Bad Type Tag");
        await client.query(
          "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'campaign', $3)",
          [fx.orgAId, tagId, randomUUID()],
        );
      }),
    ).rejects.toThrow(/violates check constraint/i);
  });
});

describe("taggings: taggings_tag_org_fk (tenant-safety, ON DELETE CASCADE)", () => {
  it("rejects a tagging whose tag belongs to a different organization", async () => {
    const tagInOrgB = await seedAsAdmin(async (client) => seedTag(client, fx.orgBId, "Cross Org Tag"));
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        await client.query(
          "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3)",
          [fx.orgAId, tagInOrgB, randomUUID()],
        );
      }),
    ).rejects.toThrow(/taggings_tag_org_fk|foreign key/i);
  });

  it("cascade-deletes a tagging when its tag is physically deleted", async () => {
    const { tagId, taggingId } = await seedAsAdmin(async (client) => {
      const tagId = await seedTag(client, fx.orgAId, "Cascade Delete Tag");
      const tagging = await client.query<{ id: string }>(
        "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'deal', $3) returning id",
        [fx.orgAId, tagId, randomUUID()],
      );
      return { tagId, taggingId: tagging.rows[0]!.id };
    });
    await seedAsAdmin(async (client) => {
      await client.query("delete from public.tags where id = $1", [tagId]);
    });
    const after = await seedAsAdmin(async (client) => {
      const r = await client.query("select id from public.taggings where id = $1", [taggingId]);
      return r.rows;
    });
    expect(after).toEqual([]);
  });
});

describe("taggings: unique(tag_id, taggable_type, taggable_id)", () => {
  it("rejects a duplicate (tag, target) pair", async () => {
    const targetId = randomUUID();
    await expect(
      withTenantContext({ organizationId: fx.orgAId }, async (client) => {
        const tagId = await seedTag(client, fx.orgAId, "Duplicate Pair Tag");
        await client.query(
          "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3)",
          [fx.orgAId, tagId, targetId],
        );
        await client.query(
          "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3)",
          [fx.orgAId, tagId, targetId],
        );
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("allows the same target to be tagged with two different tags", async () => {
    const targetId = randomUUID();
    const rows = await withTenantContext({ organizationId: fx.orgAId }, async (client) => {
      const tagOne = await seedTag(client, fx.orgAId, "Multi Tag One");
      const tagTwo = await seedTag(client, fx.orgAId, "Multi Tag Two");
      await client.query(
        "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3)",
        [fx.orgAId, tagOne, targetId],
      );
      await client.query(
        "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3)",
        [fx.orgAId, tagTwo, targetId],
      );
      const r = await client.query("select tag_id from public.taggings where taggable_id = $1", [targetId]);
      return r.rows;
    });
    expect(rows).toHaveLength(2);
  });
});

describe("taggings: FK organization_id", () => {
  it("rejects a tagging for a non-existent organization", async () => {
    const tagId = await seedAsAdmin(async (client) => seedTag(client, fx.orgAId, "Orphan Org Tagging Tag"));
    await expect(
      seedAsAdmin(async (client) => {
        await client.query(
          "insert into public.taggings (organization_id, tag_id, taggable_type, taggable_id) values ($1, $2, 'contact', $3)",
          [randomUUID(), tagId, randomUUID()],
        );
      }),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("taggings: indexes", () => {
  it("taggings_org_taggable_idx and taggings_org_tag_idx exist", async () => {
    const rows = await seedAsAdmin(async (client) => {
      const r = await client.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'public' and tablename = 'taggings'",
      );
      return r.rows.map((row) => row.indexname);
    });
    expect(rows).toEqual(expect.arrayContaining(["taggings_org_taggable_idx", "taggings_org_tag_idx"]));
  });
});
