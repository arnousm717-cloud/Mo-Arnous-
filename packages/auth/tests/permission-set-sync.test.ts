import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@ai-revenue-os/database";
import { PERMISSION_MATRIX } from "../src/permissions";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * roles.permission_set (migration 20260807135700) is a DERIVED SNAPSHOT of
 * PERMISSION_MATRIX, never a second source of truth — this is what makes
 * that true in practice rather than just in a comment: if the migration
 * and the TS matrix ever drift apart, this test fails, and the fix is
 * always "update the migration to match permissions.ts," never the
 * reverse. can() itself never queries this column — it's a readable
 * reference only (same role the seed migration's own M1.2 comment already
 * assigned it, now actually populated).
 */
describe("roles.permission_set matches packages/auth/src/permissions.ts's PERMISSION_MATRIX exactly", () => {
  afterAll(async () => {
    await closePool();
  });

  it("every seeded role's DB permission_set is identical to its TS matrix entry", async () => {
    const pool = getPool();
    const result = await pool.query<{ key: string; permission_set: Record<string, boolean> }>(
      "select key, permission_set from public.roles order by key",
    );

    expect(result.rows).toHaveLength(Object.keys(PERMISSION_MATRIX).length);

    for (const row of result.rows) {
      const expected = PERMISSION_MATRIX[row.key as keyof typeof PERMISSION_MATRIX];
      expect(expected, `unexpected role key in database: ${row.key}`).toBeDefined();
      expect(row.permission_set, `permission_set mismatch for role ${row.key}`).toEqual(expected);
    }
  });

  it("every role defined in the TS matrix has a corresponding seeded row", async () => {
    const pool = getPool();
    const result = await pool.query<{ key: string }>("select key from public.roles");
    const dbKeys = new Set(result.rows.map((r) => r.key));

    for (const roleKey of Object.keys(PERMISSION_MATRIX)) {
      expect(dbKeys.has(roleKey), `TS matrix has role "${roleKey}" with no matching seeded roles row`).toBe(true);
    }
  });
});
