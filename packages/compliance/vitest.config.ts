import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Same reasoning as packages/database/vitest.config.ts: these are
    // integration tests sharing one real local Postgres instance, not
    // isolated per-file fixtures — file-level parallelism (vitest's
    // default) lets one file's writes race another file's fixtures/cleanup
    // (CI #144: a cross-file/cross-package deadlock on public.audit_logs,
    // docs/13-Technical-Design-Review.md "CI #144"). Serial execution
    // trades speed for correctness here, which is the right trade for a
    // suite this size. Defense-in-depth alongside the transaction-scoped
    // chaos-test fix in contact-erasure.test.ts — that fix removes the
    // cross-package leak entirely; this setting removes the remaining
    // within-package file-race surface.
    fileParallelism: false,
  },
});
