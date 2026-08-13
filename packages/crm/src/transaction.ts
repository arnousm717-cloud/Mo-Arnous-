import type { PoolClient } from "pg";
import { withTenantContext, type RequestContext } from "@ai-revenue-os/database";

/**
 * Runs `fn` against `existingClient` if supplied — the caller (e.g. the
 * 2.1F-A idempotency helper) already owns an open, correctly tenant-scoped
 * transaction and wants this mutation to run inside it, not a separate
 * one, so reservation + mutation + response persistence stay atomic — or
 * opens a fresh withTenantContext transaction otherwise, the ordinary,
 * backward-compatible path every existing caller/test already uses
 * unchanged. Shared by companies.ts and contacts.ts's create/update
 * functions — genuine duplication, not speculative sharing (Milestone
 * 2.1F-A). No HTTP concept enters packages/crm here: PoolClient is a
 * database-layer type this package already imports internally.
 */
export async function runInClientOrTransaction<T>(
  ctx: RequestContext & { organizationId: string },
  existingClient: PoolClient | undefined,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (existingClient) {
    return fn(existingClient);
  }
  return withTenantContext(ctx, fn);
}
