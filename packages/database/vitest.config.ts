import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These are integration tests sharing one real local Postgres instance,
    // not isolated per-file fixtures — file-level parallelism (vitest's
    // default) lets one file's cleanup (DELETE ... WHERE true) race another
    // file's in-flight fixtures. Serial execution trades speed for
    // correctness here, which is the right trade for a suite this size.
    fileParallelism: false,
  },
});
