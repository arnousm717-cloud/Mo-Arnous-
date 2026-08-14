import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePool } from "@ai-revenue-os/database";
import { adminPool, createOrgWithRole } from "./crm-api-fixtures";
import { listActiveOwnerOptions } from "../app/_shared/owner-options";
import { withResolvedOwnerFallback, resolveOwnerLabel } from "../app/_shared/owner-option";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.2-P0. Covers the shared owner-options module's own pure/
 * near-pure logic — the human-readable-label strategy (full_name
 * preferred, email fallback), and the two safe-fallback helpers used by
 * both Companies and Contacts. get_organization_member_identities()'
 * own security posture (cross-org isolation, active-only, EXECUTE
 * grants, public.users RLS unchanged) is covered exhaustively in
 * packages/database/tests/organization-member-identity.test.ts — not
 * duplicated here. Companies/Contacts' own create/edit logic and
 * server-side RBAC re-check are unchanged by this step and remain
 * covered by the existing, unmodified companies-console.test.ts/
 * contacts-console.test.ts suites (112/112 passing).
 */

async function addMemberWithIdentity(
  organizationId: string,
  roleKey: string,
  options: { fullName?: string | null } = {},
): Promise<string> {
  const userId = randomUUID();
  const client = await adminPool.connect();
  try {
    await client.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [
      userId,
      `owner-options-${userId}@example.test`,
      options.fullName !== undefined && options.fullName !== null ? JSON.stringify({ full_name: options.fullName }) : "{}",
    ]);
    const role = await client.query<{ id: string }>("select id from public.roles where key = $1", [roleKey]);
    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, organizationId, role.rows[0]!.id],
    );
  } finally {
    client.release();
  }
  return userId;
}

afterAll(async () => {
  await closePool();
});

describe("listActiveOwnerOptions(): display-label strategy", () => {
  it("prefers full_name when present and non-empty", async () => {
    const admin = await createOrgWithRole("org_admin", "label-fullname-admin");
    const teammate = await addMemberWithIdentity(admin.organizationId, "org_member", { fullName: "Jane Teammate" });

    const options = await listActiveOwnerOptions(admin);
    const found = options.find((o) => o.userId === teammate);
    expect(found?.label).toBe("Jane Teammate");
    expect(found?.label).not.toBe(teammate);
  });

  it("falls back to email when full_name is null", async () => {
    const admin = await createOrgWithRole("org_admin", "label-null-admin");
    const teammate = await addMemberWithIdentity(admin.organizationId, "org_member", { fullName: null });

    const options = await listActiveOwnerOptions(admin);
    const found = options.find((o) => o.userId === teammate);
    expect(found?.label).toContain(`owner-options-${teammate}@example.test`);
  });

  it("falls back to email when full_name is empty/whitespace-only", async () => {
    const admin = await createOrgWithRole("org_admin", "label-empty-admin");
    const teammate = await addMemberWithIdentity(admin.organizationId, "org_member", { fullName: "   " });

    const options = await listActiveOwnerOptions(admin);
    const found = options.find((o) => o.userId === teammate);
    expect(found?.label).toContain(`owner-options-${teammate}@example.test`);
  });

  it("never returns a raw uuid as the label for any resolvable member", async () => {
    const admin = await createOrgWithRole("org_admin", "label-no-uuid-admin");
    const options = await listActiveOwnerOptions(admin);
    for (const option of options) {
      expect(option.label).not.toBe(option.userId);
    }
  });
});

describe("withResolvedOwnerFallback()", () => {
  it("returns the options unchanged when the current owner is already present", () => {
    const options = [{ userId: "a", label: "A" }];
    expect(withResolvedOwnerFallback(options, "a")).toEqual(options);
  });

  it("returns the options unchanged when there is no current owner", () => {
    const options = [{ userId: "a", label: "A" }];
    expect(withResolvedOwnerFallback(options, null)).toEqual(options);
  });

  it("adds a safe synthetic entry, never a raw-uuid label, when the current owner is missing", () => {
    const options = [{ userId: "a", label: "A" }];
    const result = withResolvedOwnerFallback(options, "missing-id");
    expect(result).toHaveLength(2);
    const added = result.find((o) => o.userId === "missing-id");
    expect(added?.label).toBe("Unknown member");
    expect(added?.label).not.toBe("missing-id");
  });
});

describe("resolveOwnerLabel()", () => {
  it("returns null when ownerId itself is null (no-owner case)", () => {
    expect(resolveOwnerLabel([{ userId: "a", label: "A" }], null)).toBeNull();
  });

  it("returns the matched label when present", () => {
    expect(resolveOwnerLabel([{ userId: "a", label: "Alpha" }], "a")).toBe("Alpha");
  });

  it("returns the generic safe fallback, never the raw id, when unresolved", () => {
    const label = resolveOwnerLabel([{ userId: "a", label: "Alpha" }], "missing-id");
    expect(label).toBe("Unknown member");
    expect(label).not.toBe("missing-id");
  });
});
