import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getPool, closePool } from "@ai-revenue-os/database";
import { withIdempotency, hashIdempotencyKey, computeRequestFingerprint } from "../app/api/v1/_shared/idempotency";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const adminPool = getPool();

async function createOrgWithMember(): Promise<{ organizationId: string; userId: string }> {
  const userId = randomUUID();
  const client = await adminPool.connect();
  try {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      userId,
      `idem-test-${userId}@example.test`,
    ]);
    const org = await client.query<{ id: string }>(
      "insert into public.organizations (name, slug) values ($1, $2) returning id",
      ["Idempotency Test Org", `idem-test-org-${randomUUID()}`],
    );
    const organizationId = org.rows[0]!.id;
    const role = await client.query<{ id: string }>("select id from public.roles where key = 'org_admin'");
    await client.query(
      "insert into public.memberships (user_id, organization_id, role_id, status) values ($1, $2, $3, 'active')",
      [userId, organizationId, role.rows[0]!.id],
    );
    return { organizationId, userId };
  } finally {
    client.release();
  }
}

async function rowFor(organizationId: string, keyHash: string): Promise<Record<string, unknown> | undefined> {
  const client = await adminPool.connect();
  try {
    const r = await client.query(
      "select * from public.idempotency_keys where organization_id = $1 and idempotency_key_hash = $2",
      [organizationId, keyHash],
    );
    return r.rows[0];
  } finally {
    client.release();
  }
}

async function countRowsFor(organizationId: string, keyHash: string): Promise<number> {
  const client = await adminPool.connect();
  try {
    const r = await client.query(
      "select count(*)::int as n from public.idempotency_keys where organization_id = $1 and idempotency_key_hash = $2",
      [organizationId, keyHash],
    );
    return r.rows[0].n;
  } finally {
    client.release();
  }
}

async function backdateExpiry(organizationId: string, keyHash: string): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query(
      "update public.idempotency_keys set expires_at = now() - interval '1 minute' where organization_id = $1 and idempotency_key_hash = $2",
      [organizationId, keyHash],
    );
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await closePool();
});

describe("hashIdempotencyKey / computeRequestFingerprint", () => {
  it("never returns the raw input — always a fixed-length hex digest", () => {
    const raw = "my-secret-idempotency-key-value";
    const hash = hashIdempotencyKey(raw);
    expect(hash).not.toContain(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fingerprint is deterministic for equivalent body key ordering", () => {
    const fp1 = computeRequestFingerprint("POST", "/api/v1/companies", { name: "Acme", domain: "acme.test" });
    const fp2 = computeRequestFingerprint("POST", "/api/v1/companies", { domain: "acme.test", name: "Acme" });
    expect(fp1).toBe(fp2);
  });

  it("a changed payload changes the fingerprint", () => {
    const fp1 = computeRequestFingerprint("POST", "/api/v1/companies", { name: "Acme" });
    const fp2 = computeRequestFingerprint("POST", "/api/v1/companies", { name: "Acme Corp" });
    expect(fp1).not.toBe(fp2);
  });

  it("the fingerprint never contains literal PII from the body", () => {
    const fp = computeRequestFingerprint("POST", "/api/v1/contacts", {
      email: "ada@example.test",
      phone: "555-0100",
    });
    expect(fp).not.toContain("ada@example.test");
    expect(fp).not.toContain("555-0100");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("withIdempotency: first request executes once, replay returns the stored response", () => {
  it("executes the callback exactly once for a fresh key, then replays without re-executing", async () => {
    const { organizationId, userId } = await createOrgWithMember();
    const rawKey = randomUUID();
    const body = { name: "Acme" };
    const callback = vi.fn(async () => ({ status: 201, body: { company: { id: "c1", name: "Acme" } } }));

    const first = await withIdempotency(
      { userId, organizationId },
      { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
      callback,
    );
    expect(first).toEqual({ kind: "result", status: 201, body: { company: { id: "c1", name: "Acme" } } });
    expect(callback).toHaveBeenCalledTimes(1);

    const second = await withIdempotency(
      { userId, organizationId },
      { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
      callback,
    );
    expect(second).toEqual(first);
    expect(callback).toHaveBeenCalledTimes(1); // not called again
  });

  it("same key + different payload returns a conflict, callback not executed", async () => {
    const { organizationId, userId } = await createOrgWithMember();
    const rawKey = randomUUID();
    const callback = vi.fn(async () => ({ status: 201, body: { company: { id: "c1" } } }));

    await withIdempotency(
      { userId, organizationId },
      { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body: { name: "Acme" } },
      callback,
    );
    const conflict = await withIdempotency(
      { userId, organizationId },
      { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body: { name: "Different Co" } },
      callback,
    );
    expect(conflict).toEqual({ kind: "conflict" });
    expect(callback).toHaveBeenCalledTimes(1); // only the first, original call
  });

  it("the same key in a different organization is fully independent", async () => {
    const orgA = await createOrgWithMember();
    const orgB = await createOrgWithMember();
    const rawKey = randomUUID();
    const body = { name: "Acme" };

    const resultA = await withIdempotency(
      { userId: orgA.userId, organizationId: orgA.organizationId },
      { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
      async () => ({ status: 201, body: { company: { id: "in-org-a" } } }),
    );
    const resultB = await withIdempotency(
      { userId: orgB.userId, organizationId: orgB.organizationId },
      { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
      async () => ({ status: 201, body: { company: { id: "in-org-b" } } }),
    );
    expect(resultA).not.toEqual(resultB);
    if (resultA.kind === "result" && resultB.kind === "result") {
      expect(resultA.body).toEqual({ company: { id: "in-org-a" } });
      expect(resultB.body).toEqual({ company: { id: "in-org-b" } });
    }
  });
});

describe("withIdempotency: concurrency — two real independent connections", () => {
  it("simultaneous identical requests result in exactly one callback execution, both callers see the same response", async () => {
    const { organizationId, userId } = await createOrgWithMember();
    const rawKey = randomUUID();
    const body = { name: "Concurrent Co" };
    let executions = 0;

    const slowCallback = async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: 201, body: { company: { id: "concurrent-company" } } };
    };
    const fastCallback = async () => {
      executions += 1;
      return { status: 201, body: { company: { id: "should-never-be-used" } } };
    };

    const [first, second] = await Promise.all([
      withIdempotency(
        { userId, organizationId },
        { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
        slowCallback,
      ),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return withIdempotency(
          { userId, organizationId },
          { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
          fastCallback,
        );
      })(),
    ]);

    expect(executions).toBe(1);
    expect(first).toEqual(second);
    expect(await countRowsFor(organizationId, hashIdempotencyKey(rawKey))).toBe(1);
  });
});

describe("withIdempotency: rollback — an unexpected failure leaves no row, a later attempt can take over", () => {
  it("first owner's unexpected throw leaves no idempotency row; a subsequent call with the same key succeeds", async () => {
    const { organizationId, userId } = await createOrgWithMember();
    const rawKey = randomUUID();
    const body = { name: "Rollback Co" };

    await expect(
      withIdempotency(
        { userId, organizationId },
        { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
        async () => {
          throw new Error("simulated unexpected mutation failure");
        },
      ),
    ).rejects.toThrow("simulated unexpected mutation failure");

    expect(await countRowsFor(organizationId, hashIdempotencyKey(rawKey))).toBe(0);

    const retried = await withIdempotency(
      { userId, organizationId },
      { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
      async () => ({ status: 201, body: { company: { id: "succeeded-on-retry" } } }),
    );
    expect(retried).toEqual({ kind: "result", status: 201, body: { company: { id: "succeeded-on-retry" } } });
    expect(await countRowsFor(organizationId, hashIdempotencyKey(rawKey))).toBe(1);
  });

  it("concurrent owner rolls back mid-mutation; the contender takes over and the mutation completes exactly once", async () => {
    const { organizationId, userId } = await createOrgWithMember();
    const rawKey = randomUUID();
    const body = { name: "Takeover Co" };
    let successfulExecutions = 0;

    const [failing, takeover] = await Promise.allSettled([
      withIdempotency(
        { userId, organizationId },
        { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          throw new Error("simulated failure by the first owner");
        },
      ),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return withIdempotency(
          { userId, organizationId },
          { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
          async () => {
            successfulExecutions += 1;
            return { status: 201, body: { company: { id: "takeover-success" } } };
          },
        );
      })(),
    ]);

    expect(failing.status).toBe("rejected");
    expect(takeover.status).toBe("fulfilled");
    expect(successfulExecutions).toBe(1);
    expect(await countRowsFor(organizationId, hashIdempotencyKey(rawKey))).toBe(1);
    const row = await rowFor(organizationId, hashIdempotencyKey(rawKey));
    expect(row?.status).toBe("completed");
  });
});

describe("withIdempotency: expiration", () => {
  it("an expired key is reclaimed inline and reusable", async () => {
    const { organizationId, userId } = await createOrgWithMember();
    const rawKey = randomUUID();
    const body = { name: "Expiring Co" };

    await withIdempotency(
      { userId, organizationId },
      { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
      async () => ({ status: 201, body: { company: { id: "original" } } }),
    );
    await backdateExpiry(organizationId, hashIdempotencyKey(rawKey));

    const afterExpiry = await withIdempotency(
      { userId, organizationId },
      { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
      async () => ({ status: 201, body: { company: { id: "fresh-after-expiry" } } }),
    );
    expect(afterExpiry).toEqual({ kind: "result", status: 201, body: { company: { id: "fresh-after-expiry" } } });
    expect(await countRowsFor(organizationId, hashIdempotencyKey(rawKey))).toBe(1);
  });

  it("an unexpired key still replays normally", async () => {
    const { organizationId, userId } = await createOrgWithMember();
    const rawKey = randomUUID();
    const body = { name: "Still Fresh Co" };
    let executions = 0;

    const run = () =>
      withIdempotency(
        { userId, organizationId },
        { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
        async () => {
          executions += 1;
          return { status: 201, body: { company: { id: "fresh" } } };
        },
      );
    await run();
    await run();
    expect(executions).toBe(1);
  });
});

describe("withIdempotency: 4xx vs 5xx persistence behavior", () => {
  it("a deterministic 4xx-shaped result returned by the callback is persisted and replayed", async () => {
    const { organizationId, userId } = await createOrgWithMember();
    const rawKey = randomUUID();
    const body = { name: "" };
    let executions = 0;

    const run = () =>
      withIdempotency(
        { userId, organizationId },
        { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body },
        async () => {
          executions += 1;
          return { status: 400, body: { error: "name must contain at least one non-whitespace character" } };
        },
      );

    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
    expect(executions).toBe(1);

    const row = await rowFor(organizationId, hashIdempotencyKey(rawKey));
    expect(row?.status).toBe("completed");
    expect(row?.response_status).toBe(400);
  });
});

describe("withIdempotency: PII handling", () => {
  it("the raw Idempotency-Key header is never persisted anywhere in the row", async () => {
    const { organizationId, userId } = await createOrgWithMember();
    const rawKey = `super-secret-raw-key-${randomUUID()}`;
    await withIdempotency(
      { userId, organizationId },
      { rawIdempotencyKey: rawKey, method: "POST", route: "/api/v1/companies", body: { name: "Co" } },
      async () => ({ status: 201, body: { company: { id: "c1" } } }),
    );
    const row = await rowFor(organizationId, hashIdempotencyKey(rawKey));
    expect(JSON.stringify(row)).not.toContain(rawKey);
  });

  it("the stored request_fingerprint never contains literal request body content", async () => {
    const { organizationId, userId } = await createOrgWithMember();
    const rawKey = randomUUID();
    await withIdempotency(
      { userId, organizationId },
      {
        rawIdempotencyKey: rawKey,
        method: "POST",
        route: "/api/v1/contacts",
        body: { email: "leak-check@example.test" },
      },
      async () => ({ status: 201, body: { contact: { id: "c1" } } }),
    );
    const row = await rowFor(organizationId, hashIdempotencyKey(rawKey));
    expect(row?.request_fingerprint).not.toContain("leak-check@example.test");
    expect(row?.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
