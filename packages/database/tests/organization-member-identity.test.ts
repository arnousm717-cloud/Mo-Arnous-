import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminPool, seedAsAdmin } from "./helpers";
import { withTenantContext } from "../src/tenant-context";
import { closePool } from "../src/pool";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Milestone 2.2-P0: get_organization_member_identities(). Resolves the
 * Companies/Contacts (and later Deals) owner-display limitation without
 * broadening public.users' own self-scoped RLS (id = auth.uid(), M1.2,
 * unchanged by this migration) — mirrors the exact
 * _validate_contact_erasure/_validate_user_erasure discipline:
 * organization_id is an explicit parameter, never trusted as the
 * security boundary alone; the caller's own active membership in that
 * exact organization is independently re-verified via auth.uid() on
 * every call.
 */

interface MemberIdentityRow {
  user_id: string;
  email: string;
  full_name: string | null;
}

async function createAuthUser(label: string, fullName?: string): Promise<string> {
  const userId = randomUUID();
  await seedAsAdmin(async (client) => {
    await client.query(
      "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)",
      [
        userId,
        `org-member-identity-${label}-${userId}@example.test`,
        fullName ? JSON.stringify({ full_name: fullName }) : "{}",
      ],
    );
  });
  return userId;
}

async function createOrgWithOwner(userId: string, name: string): Promise<string> {
  const result = await withTenantContext({ userId }, async (client) => {
    const r = await client.query("select * from public.create_organization_with_owner($1, $2, $3)", [
      name,
      `org-member-identity-${randomUUID()}`,
      userId,
    ]);
    return r.rows[0];
  });
  return result.organization_id as string;
}

async function roleIdFor(key: string): Promise<string> {
  return seedAsAdmin(async (client) => {
    const r = await client.query<{ id: string }>("select id from public.roles where key = $1", [key]);
    const row = r.rows[0];
    if (!row) throw new Error(`no seeded role for key ${key}`);
    return row.id;
  });
}

async function addMembership(userId: string, organizationId: string, roleKey: string, status = "active"): Promise<void> {
  const roleId = await roleIdFor(roleKey);
  await seedAsAdmin(async (client) => {
    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, $4)",
      [userId, organizationId, roleId, status],
    );
  });
}

async function callAsUser(userId: string, organizationId: string): Promise<MemberIdentityRow[]> {
  return withTenantContext({ userId }, async (client) => {
    const r = await client.query<MemberIdentityRow>(
      "select * from public.get_organization_member_identities($1)",
      [organizationId],
    );
    return r.rows;
  });
}

afterAll(async () => {
  await adminPool.end();
  await closePool();
});

describe("get_organization_member_identities: authorized calls", () => {
  it("an active org member can call the function and sees other active members of their own organization", async () => {
    const owner = await createAuthUser("owner", "Owner Person");
    const organizationId = await createOrgWithOwner(owner, "Member Identity Org");
    const teammate = await createAuthUser("teammate", "Teammate Person");
    await addMembership(teammate, organizationId, "org_member");

    const rows = await callAsUser(owner, organizationId);
    const ids = rows.map((r) => r.user_id);
    expect(ids).toContain(owner);
    expect(ids).toContain(teammate);
  });

  it("returns the correct user_id/email/full_name values", async () => {
    const owner = await createAuthUser("values-owner", "Values Owner");
    const organizationId = await createOrgWithOwner(owner, "Member Identity Values Org");
    const teammate = await createAuthUser("values-teammate", "Values Teammate");
    await addMembership(teammate, organizationId, "org_member");

    const rows = await callAsUser(owner, organizationId);
    const teammateRow = rows.find((r) => r.user_id === teammate);
    expect(teammateRow?.full_name).toBe("Values Teammate");
    expect(teammateRow?.email).toContain("org-member-identity-values-teammate-");
  });

  it("excludes a removed membership from the results", async () => {
    const owner = await createAuthUser("removed-owner");
    const organizationId = await createOrgWithOwner(owner, "Member Identity Removed Org");
    const removed = await createAuthUser("removed-member");
    await addMembership(removed, organizationId, "org_member", "removed");

    const rows = await callAsUser(owner, organizationId);
    expect(rows.map((r) => r.user_id)).not.toContain(removed);
  });

  it("does not expose any public.users column beyond user_id/email/full_name", async () => {
    const owner = await createAuthUser("shape-owner");
    const organizationId = await createOrgWithOwner(owner, "Member Identity Shape Org");

    const rows = await callAsUser(owner, organizationId);
    expect(Object.keys(rows[0]!).sort()).toEqual(["email", "full_name", "user_id"]);
  });
});

describe("get_organization_member_identities: adversarial / tenant isolation", () => {
  it("a caller cannot enumerate another organization's members", async () => {
    const ownerA = await createAuthUser("cross-org-a");
    const orgA = await createOrgWithOwner(ownerA, "Member Identity Cross Org A");
    const ownerB = await createAuthUser("cross-org-b");
    const orgB = await createOrgWithOwner(ownerB, "Member Identity Cross Org B");
    const teammateB = await createAuthUser("cross-org-b-teammate");
    await addMembership(teammateB, orgB, "org_member");

    await expect(callAsUser(ownerA, orgB)).rejects.toThrow(/does not have an active membership/);

    // orgA referenced only to keep the fixture's isolation intent explicit.
    expect(orgA).toBeTruthy();
  });

  it("a caller without any active membership in the target organization is rejected", async () => {
    const owner = await createAuthUser("no-membership-owner");
    const organizationId = await createOrgWithOwner(owner, "Member Identity No Membership Org");
    const outsider = await createAuthUser("no-membership-outsider");

    await expect(callAsUser(outsider, organizationId)).rejects.toThrow(/does not have an active membership/);
  });

  it("a caller whose own membership in the target org has been removed is rejected, even though it once existed", async () => {
    const owner = await createAuthUser("demoted-owner");
    const organizationId = await createOrgWithOwner(owner, "Member Identity Demoted Org");
    const member = await createAuthUser("demoted-member");
    await addMembership(member, organizationId, "org_member");
    await seedAsAdmin(async (client) => {
      await client.query("update public.memberships set status = 'removed' where user_id = $1 and organization_id = $2", [
        member,
        organizationId,
      ]);
    });

    await expect(callAsUser(member, organizationId)).rejects.toThrow(/does not have an active membership/);
  });

  it("an unauthenticated call (no resolvable auth.uid()) is rejected", async () => {
    const owner = await createAuthUser("unauth-owner");
    const organizationId = await createOrgWithOwner(owner, "Member Identity Unauth Org");

    await expect(
      withTenantContext({}, async (client) => {
        await client.query("select * from public.get_organization_member_identities($1)", [organizationId]);
      }),
    ).rejects.toThrow(/caller must be authenticated/);
  });

  it("a nonexistent organization id produces no active-membership match — rejected the same as any other unauthorized org", async () => {
    const owner = await createAuthUser("nonexistent-org-owner");
    await createOrgWithOwner(owner, "Member Identity Nonexistent Org Setup");

    await expect(callAsUser(owner, randomUUID())).rejects.toThrow(/does not have an active membership/);
  });
});

describe("get_organization_member_identities: privilege posture", () => {
  it("anon and PUBLIC have zero EXECUTE; authenticated has EXECUTE", async () => {
    const client = await adminPool.connect();
    try {
      const r = await client.query(`
        select
          has_function_privilege('anon', 'public.get_organization_member_identities(uuid)', 'EXECUTE') as anon_can_execute,
          has_function_privilege('authenticated', 'public.get_organization_member_identities(uuid)', 'EXECUTE') as authenticated_can_execute,
          has_function_privilege('public', 'public.get_organization_member_identities(uuid)', 'EXECUTE') as public_can_execute
      `);
      expect(r.rows[0].anon_can_execute).toBe(false);
      expect(r.rows[0].public_can_execute).toBe(false);
      expect(r.rows[0].authenticated_can_execute).toBe(true);
    } finally {
      client.release();
    }
  });

  it("is SECURITY DEFINER with search_path locked to public", async () => {
    const client = await adminPool.connect();
    try {
      const r = await client.query(
        "select prosecdef, proconfig from pg_proc where proname = 'get_organization_member_identities'",
      );
      expect(r.rows[0].prosecdef).toBe(true);
      expect(r.rows[0].proconfig).toContain("search_path=public");
    } finally {
      client.release();
    }
  });
});

describe("public.users' own RLS remains unchanged", () => {
  it("a user still cannot SELECT another user's row directly from public.users (self-scoped RLS intact)", async () => {
    const owner = await createAuthUser("rls-unchanged-owner");
    const organizationId = await createOrgWithOwner(owner, "Member Identity RLS Unchanged Org");
    const teammate = await createAuthUser("rls-unchanged-teammate");
    await addMembership(teammate, organizationId, "org_member");

    const rows = await withTenantContext({ userId: owner }, async (client) => {
      const r = await client.query("select * from public.users where id = $1", [teammate]);
      return r.rows;
    });
    // users_select_own (id = auth.uid()) is untouched by this migration —
    // a direct query for a teammate's row still returns nothing, proving
    // the new function is the only path to this data, not a side-effect
    // RLS change.
    expect(rows).toHaveLength(0);
  });
});
