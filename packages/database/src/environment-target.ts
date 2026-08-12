/**
 * Environment-separation guard (M1.9, docs/13-Technical-Design-Review.md
 * §M1.9 "environment-separation adversarial test").
 *
 * Pure, deterministic, no network I/O: given a deployment context and the
 * two Supabase-related targets a Preview deployment resolves at runtime
 * (the Auth project via NEXT_PUBLIC_SUPABASE_URL, the Postgres project via
 * DATABASE_URL), decides whether they are consistent with the expected
 * staging project. This is a repository-level invariant check, not proof
 * that a real Vercel Preview deployment is correctly configured — see
 * docs/13-Technical-Design-Review.md §M1.9 for what this guard does and
 * does not prove, and why CI cannot exercise the real-Vercel-values case.
 *
 * Fails closed: any missing or unparseable target in a "preview" context is
 * a FAIL, never a skip. "production" and "development" contexts are never
 * forced to match staging — this guard's only job is preventing Preview
 * from silently resolving to Production, not validating every environment.
 */

export type DeploymentContext = "production" | "preview" | "development";

/**
 * The staging Supabase project ref. A project ref is a public identifier
 * (it appears in the project's own supabase.co URL and in any Transaction
 * Pooler connection string's username) — not a credential, so committing it
 * here carries no secret-exposure risk. It is the single source of truth
 * this guard checks Preview's resolved targets against; if the staging
 * project is ever recreated, update this one constant (and the deployment's
 * real env vars) together.
 */
export const EXPECTED_STAGING_PROJECT_REF = "damunjcpwxthdjaonatb";

export interface EnvironmentTargetInputs {
  context: DeploymentContext;
  supabaseAuthUrl: string | undefined;
  databaseUrl: string | undefined;
}

export interface EnvironmentTargetResult {
  ok: boolean;
  reason?: string;
}

/**
 * Extracts the project ref from a Supabase Auth URL of the form
 * `https://<project-ref>.supabase.co`. Returns null for anything else
 * (malformed URL, wrong host suffix, local Supabase's non-supabase.co URL)
 * rather than guessing.
 */
export function extractSupabaseAuthProjectRef(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(parsed.hostname);
  return match?.[1] ?? null;
}

/**
 * Extracts the project ref from a Supabase Transaction Pooler DATABASE_URL.
 * The pooler's username convention is `postgres.<project-ref>` (ADR-004: the
 * app connects only through Supavisor, never a direct connection) — the
 * project ref lives in connection *metadata*, never in the password, so
 * this never touches or returns anything password-shaped. Returns null for
 * a direct connection, a local connection, or anything else that isn't a
 * pooler URL in the expected shape.
 */
export function extractDatabaseProjectRef(databaseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return null;
  }
  const username = decodeURIComponent(parsed.username);
  const match = /^postgres\.([a-z0-9]+)$/.exec(username);
  return match?.[1] ?? null;
}

/**
 * Decides whether a deployment's resolved targets are safe. Only ever
 * enforces anything for context === "preview" (requirement: production must
 * never be evaluated as though it were preview; local development uses its
 * own local Supabase stack and is out of scope for this guard).
 */
export function verifyEnvironmentTarget(inputs: EnvironmentTargetInputs): EnvironmentTargetResult {
  if (inputs.context !== "preview") {
    return { ok: true };
  }

  if (!inputs.supabaseAuthUrl) {
    return { ok: false, reason: "Preview deployment is missing its Supabase Auth URL target." };
  }
  if (!inputs.databaseUrl) {
    return { ok: false, reason: "Preview deployment is missing its DATABASE_URL target." };
  }

  const authRef = extractSupabaseAuthProjectRef(inputs.supabaseAuthUrl);
  if (!authRef) {
    return {
      ok: false,
      reason: "Preview Supabase Auth target is not a recognized supabase.co project URL.",
    };
  }

  const dbRef = extractDatabaseProjectRef(inputs.databaseUrl);
  if (!dbRef) {
    return {
      ok: false,
      reason: "Preview database target is not a recognized Supabase Transaction Pooler connection string.",
    };
  }

  if (authRef !== EXPECTED_STAGING_PROJECT_REF) {
    return { ok: false, reason: "Preview Supabase Auth target does not match the expected staging project." };
  }
  if (dbRef !== EXPECTED_STAGING_PROJECT_REF) {
    return { ok: false, reason: "Preview database target does not match the expected staging project." };
  }

  return { ok: true };
}
