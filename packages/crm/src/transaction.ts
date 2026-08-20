/**
 * Milestone 2.5B: `runInClientOrTransaction` moved to `@ai-revenue-os/
 * database` (generalized so `packages/compliance` can adopt the identical
 * pattern without a new cross-package dependency in either direction — see
 * that package's own copy of this comment for the full rationale). Re-
 * exported here unchanged so every existing caller in this package
 * (companies.ts, contacts.ts, deals.ts, pipelines.ts, pipeline-stages.ts,
 * activities.ts, notes.ts, tags.ts) keeps working with zero changes.
 */
export { runInClientOrTransaction } from "@ai-revenue-os/database";
