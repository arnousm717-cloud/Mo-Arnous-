import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPreviewEnvironment, resolveDeploymentContext } from "../scripts/verify-preview-environment.mjs";
import { EXPECTED_STAGING_PROJECT_REF } from "../../../packages/database/src/environment-target";

/**
 * Two layers, matching docs/13-Technical-Design-Review.md §M1.9's
 * distinction:
 *
 * 1. In-process unit tests against checkPreviewEnvironment()/
 *    resolveDeploymentContext() — fast, but only prove the wrapper's own
 *    logic (env-var reading + context mapping), same synthetic-input
 *    caveat as packages/database/tests/environment-target.test.ts.
 * 2. A real subprocess test (below, "the build-gate as a real command")
 *    that actually spawns scripts/verify-preview-environment.mjs the same
 *    way apps/web's own `build` script does, and asserts on its real exit
 *    code and stderr — this is the M1.9 adversarial proof that the gate
 *    has teeth as an actual command, not just as an importable function.
 *
 * Neither layer touches a real Vercel deployment or real Vercel env vars —
 * every value below is synthetic (see docs/13 for why that's an honest,
 * explicitly-scoped limit, not a gap being hidden).
 */

const STAGING_AUTH_URL = `https://${EXPECTED_STAGING_PROJECT_REF}.supabase.co`;
const STAGING_DB_URL = `postgresql://postgres.${EXPECTED_STAGING_PROJECT_REF}:hunter2@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`;
const PRODUCTION_REF = "abcdefghijklmnopqrst";
const PRODUCTION_AUTH_URL = `https://${PRODUCTION_REF}.supabase.co`;
const PRODUCTION_DB_URL = `postgresql://postgres.${PRODUCTION_REF}:s3cr3t@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`;

describe("resolveDeploymentContext", () => {
  it("maps VERCEL_ENV=production to production", () => {
    expect(resolveDeploymentContext("production")).toBe("production");
  });
  it("maps VERCEL_ENV=preview to preview", () => {
    expect(resolveDeploymentContext("preview")).toBe("preview");
  });
  it("maps an unset VERCEL_ENV (local dev, non-Vercel CI) to development", () => {
    expect(resolveDeploymentContext(undefined)).toBe("development");
  });
  it("maps Vercel's own 'development' value, and anything unrecognized, to development", () => {
    expect(resolveDeploymentContext("development")).toBe("development");
    expect(resolveDeploymentContext("something-unexpected")).toBe("development");
  });
});

describe("checkPreviewEnvironment", () => {
  it("preview + staging targets -> ok", () => {
    const result = checkPreviewEnvironment({
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_SUPABASE_URL: STAGING_AUTH_URL,
      DATABASE_URL: STAGING_DB_URL,
    });
    expect(result.ok).toBe(true);
  });

  it("preview + Auth pointing at production -> fails", () => {
    const result = checkPreviewEnvironment({
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_AUTH_URL,
      DATABASE_URL: STAGING_DB_URL,
    });
    expect(result.ok).toBe(false);
  });

  it("preview + DATABASE_URL pointing at production -> fails", () => {
    const result = checkPreviewEnvironment({
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_SUPABASE_URL: STAGING_AUTH_URL,
      DATABASE_URL: PRODUCTION_DB_URL,
    });
    expect(result.ok).toBe(false);
  });

  it("preview + missing NEXT_PUBLIC_SUPABASE_URL -> fails closed", () => {
    const result = checkPreviewEnvironment({ VERCEL_ENV: "preview", DATABASE_URL: STAGING_DB_URL });
    expect(result.ok).toBe(false);
  });

  it("preview + missing DATABASE_URL -> fails closed", () => {
    const result = checkPreviewEnvironment({ VERCEL_ENV: "preview", NEXT_PUBLIC_SUPABASE_URL: STAGING_AUTH_URL });
    expect(result.ok).toBe(false);
  });

  it("production context is not held to the staging-ref requirement", () => {
    const result = checkPreviewEnvironment({
      VERCEL_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_AUTH_URL,
      DATABASE_URL: PRODUCTION_DB_URL,
    });
    expect(result.ok).toBe(true);
  });

  it("local/development (no VERCEL_ENV) is unaffected even with no Supabase env vars at all", () => {
    const result = checkPreviewEnvironment({});
    expect(result.ok).toBe(true);
  });
});

describe("the build-gate as a real command (adversarial, subprocess-level)", () => {
  const scriptPath = fileURLToPath(new URL("../scripts/verify-preview-environment.mjs", import.meta.url));

  function run(overrides: {
    VERCEL_ENV?: string | undefined;
    NEXT_PUBLIC_SUPABASE_URL?: string | undefined;
    DATABASE_URL?: string | undefined;
  }) {
    // Starts from a clean copy of the real environment with exactly these
    // three keys removed, then re-adds only the ones explicitly given —
    // guarantees a deterministic input regardless of whatever the test
    // runner's own process.env happens to already contain.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.VERCEL_ENV;
    delete env.NEXT_PUBLIC_SUPABASE_URL;
    delete env.DATABASE_URL;
    if (overrides.VERCEL_ENV !== undefined) env.VERCEL_ENV = overrides.VERCEL_ENV;
    if (overrides.NEXT_PUBLIC_SUPABASE_URL !== undefined) env.NEXT_PUBLIC_SUPABASE_URL = overrides.NEXT_PUBLIC_SUPABASE_URL;
    if (overrides.DATABASE_URL !== undefined) env.DATABASE_URL = overrides.DATABASE_URL;
    return spawnSync(process.execPath, [scriptPath], { cwd: path.dirname(scriptPath), env, encoding: "utf8" });
  }

  it("preview + correct staging targets -> exits 0", () => {
    const result = run({
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_SUPABASE_URL: STAGING_AUTH_URL,
      DATABASE_URL: STAGING_DB_URL,
    });
    expect(result.status).toBe(0);
  });

  it("preview + Auth pointing at production -> exits non-zero (the M1.9 adversarial regression)", () => {
    // This is the exact scenario the TDR names: Preview silently resolving
    // to Production. Proven here as a real process exit code, not just a
    // function return value.
    const result = run({
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_AUTH_URL,
      DATABASE_URL: STAGING_DB_URL,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Environment-separation guard failed/);
  });

  it("preview + DATABASE_URL pointing at production -> exits non-zero", () => {
    const result = run({
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_SUPABASE_URL: STAGING_AUTH_URL,
      DATABASE_URL: PRODUCTION_DB_URL,
    });
    expect(result.status).not.toBe(0);
  });

  it("preview + missing DATABASE_URL -> exits non-zero", () => {
    const result = run({ VERCEL_ENV: "preview", NEXT_PUBLIC_SUPABASE_URL: STAGING_AUTH_URL, DATABASE_URL: undefined });
    expect(result.status).not.toBe(0);
  });

  it("production context -> exits 0 even though its own targets are (correctly) not staging", () => {
    const result = run({
      VERCEL_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_AUTH_URL,
      DATABASE_URL: PRODUCTION_DB_URL,
    });
    expect(result.status).toBe(0);
  });

  it("no VERCEL_ENV at all (local `next build`) -> exits 0, unaffected", () => {
    const result = run({ VERCEL_ENV: undefined, NEXT_PUBLIC_SUPABASE_URL: undefined, DATABASE_URL: undefined });
    expect(result.status).toBe(0);
  });

  it("failure output never contains a password, connection string, or key", () => {
    const result = run({
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_AUTH_URL,
      DATABASE_URL: PRODUCTION_DB_URL,
    });
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).not.toMatch(/hunter2|s3cr3t|postgresql:\/\//);
  });
});
