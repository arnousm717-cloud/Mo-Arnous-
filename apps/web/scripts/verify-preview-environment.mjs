// Real Vercel Preview build-gate (M1.9 environment-separation guard).
//
// Runs before `next build` (see this package's "build" script). Inside a
// genuine Vercel build, VERCEL_ENV / NEXT_PUBLIC_SUPABASE_URL / DATABASE_URL
// are the actual values that deployment will run with — unlike
// packages/database/tests/environment-target.test.ts, which only proves
// verifyEnvironmentTarget()'s logic against synthetic inputs. This script is
// what turns that logic into a real, fail-closed gate on an actual Preview
// build. See docs/13-Technical-Design-Review.md §M1.9 for the full
// distinction between the two.
//
// Reuses verifyEnvironmentTarget() directly — no parsing/validation logic is
// duplicated here. Fails the build (non-zero exit) only when VERCEL_ENV is
// "preview" and either target doesn't resolve to the expected staging
// project. Production and any non-Vercel build (local dev, `pnpm build` in
// CI, where VERCEL_ENV is unset) are always let through unchanged.
//
// Never logs DATABASE_URL, a password, an anon key, a service-role key, or
// any connection string — only verifyEnvironmentTarget()'s own safe,
// pre-written reason strings are ever printed.

// Imports the leaf module directly, not the package's index.ts barrel —
// the barrel's own internal imports are extensionless (bundler-resolved,
// fine for tsc/Next.js/vitest) and Node's native TS loader can't resolve
// those without a bundler in front of it. Same precedent as
// packages/database/scripts/issue-api-key.mjs, which imports
// "../../auth/src/api-keys.ts" directly for the same reason.
import { pathToFileURL } from "node:url";
import { verifyEnvironmentTarget } from "../../../packages/database/src/environment-target.ts";

/**
 * Maps Vercel's own VERCEL_ENV values onto our DeploymentContext. Anything
 * that isn't exactly "production" or "preview" (unset locally, "development"
 * on Vercel itself, or any other value) is treated as "development" —
 * verifyEnvironmentTarget() never enforces anything for that context.
 */
export function resolveDeploymentContext(vercelEnv) {
  if (vercelEnv === "production" || vercelEnv === "preview") {
    return vercelEnv;
  }
  return "development";
}

/**
 * Pure wrapper around verifyEnvironmentTarget() for a process.env-shaped
 * object — kept separate from main() so tests can call this directly
 * without triggering process.exit.
 */
export function checkPreviewEnvironment(env) {
  return verifyEnvironmentTarget({
    context: resolveDeploymentContext(env.VERCEL_ENV),
    supabaseAuthUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    databaseUrl: env.DATABASE_URL,
  });
}

function main() {
  const result = checkPreviewEnvironment(process.env);
  if (!result.ok) {
    console.error(`Environment-separation guard failed: ${result.reason}`);
    process.exit(1);
  }
}

// Only run as a build-time side effect when executed directly
// (`node scripts/verify-preview-environment.mjs`), never on import — this
// lets tests import checkPreviewEnvironment()/resolveDeploymentContext()
// without triggering process.exit, and lets an adversarial test spawn this
// file as a real subprocess to prove the exit code itself. Compared via
// pathToFileURL (not a raw `file://${...}` template) because a plain
// template mismatches whenever the repository path itself needs URL
// escaping (e.g. a space in a directory name) — process.argv[1] is a plain
// filesystem path, import.meta.url is already percent-encoded.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
