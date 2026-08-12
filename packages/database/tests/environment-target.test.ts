import { describe, expect, it } from "vitest";
import {
  EXPECTED_STAGING_PROJECT_REF,
  extractDatabaseProjectRef,
  extractSupabaseAuthProjectRef,
  verifyEnvironmentTarget,
} from "../src/environment-target";

/**
 * M1.9 environment-separation adversarial test (docs/13-Technical-Design-
 * Review.md §M1.9). Pure logic, no database — unlike this directory's other
 * test files, nothing here needs DATABASE_URL or a running Postgres, because
 * verifyEnvironmentTarget() itself does no I/O. This file proves the
 * repository-level invariant only; it cannot and does not prove a real
 * Vercel Preview deployment is correctly configured (see the module's own
 * doc comment and docs/13 §M1.9 for that distinction).
 */

const STAGING_AUTH_URL = `https://${EXPECTED_STAGING_PROJECT_REF}.supabase.co`;
const STAGING_DB_URL = `postgresql://postgres.${EXPECTED_STAGING_PROJECT_REF}:hunter2@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`;

const PRODUCTION_REF = "abcdefghijklmnopqrst";
const PRODUCTION_AUTH_URL = `https://${PRODUCTION_REF}.supabase.co`;
const PRODUCTION_DB_URL = `postgresql://postgres.${PRODUCTION_REF}:s3cr3t@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`;

const UNKNOWN_REF = "zzzunknownprojectref";
const UNKNOWN_DB_URL = `postgresql://postgres.${UNKNOWN_REF}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`;

describe("verifyEnvironmentTarget", () => {
  it("case A: preview + staging Auth + staging DB -> PASS", () => {
    const result = verifyEnvironmentTarget({
      context: "preview",
      supabaseAuthUrl: STAGING_AUTH_URL,
      databaseUrl: STAGING_DB_URL,
    });
    expect(result.ok).toBe(true);
  });

  it("case B: preview + production Auth + staging DB -> FAIL", () => {
    const result = verifyEnvironmentTarget({
      context: "preview",
      supabaseAuthUrl: PRODUCTION_AUTH_URL,
      databaseUrl: STAGING_DB_URL,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Auth target/);
  });

  it("case C: preview + staging Auth + production DB -> FAIL", () => {
    const result = verifyEnvironmentTarget({
      context: "preview",
      supabaseAuthUrl: STAGING_AUTH_URL,
      databaseUrl: PRODUCTION_DB_URL,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/database target/);
  });

  it("case D (the M1.9 adversarial regression): preview + production Auth + production DB -> FAIL", () => {
    // This is the exact scenario the M1.9 TDR names: Preview silently
    // resolving to Production for both targets at once. It must never
    // pass just because the two targets agree with each other — they also
    // have to agree with the expected staging project.
    const result = verifyEnvironmentTarget({
      context: "preview",
      supabaseAuthUrl: PRODUCTION_AUTH_URL,
      databaseUrl: PRODUCTION_DB_URL,
    });
    expect(result.ok).toBe(false);
  });

  it("case E: Auth target and DB target point at two different (neither-staging) projects -> FAIL", () => {
    const result = verifyEnvironmentTarget({
      context: "preview",
      supabaseAuthUrl: PRODUCTION_AUTH_URL,
      databaseUrl: UNKNOWN_DB_URL,
    });
    expect(result.ok).toBe(false);
  });

  it("case F: preview + missing Auth target -> FAIL CLOSED", () => {
    const result = verifyEnvironmentTarget({
      context: "preview",
      supabaseAuthUrl: undefined,
      databaseUrl: STAGING_DB_URL,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing its Supabase Auth URL/);
  });

  it("preview + missing DB target -> FAIL CLOSED", () => {
    const result = verifyEnvironmentTarget({
      context: "preview",
      supabaseAuthUrl: STAGING_AUTH_URL,
      databaseUrl: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing its DATABASE_URL/);
  });

  it("preview + malformed Supabase Auth URL -> FAIL CLOSED", () => {
    const result = verifyEnvironmentTarget({
      context: "preview",
      supabaseAuthUrl: "not-a-url",
      databaseUrl: STAGING_DB_URL,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a recognized supabase\.co/);
  });

  it("preview + malformed DATABASE_URL -> FAIL CLOSED", () => {
    const result = verifyEnvironmentTarget({
      context: "preview",
      supabaseAuthUrl: STAGING_AUTH_URL,
      databaseUrl: "not-a-connection-string",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a recognized Supabase Transaction Pooler/);
  });

  it("preview + Transaction Pooler URL -> correct project ref extracted end-to-end", () => {
    // Exercised indirectly through verifyEnvironmentTarget (case A already
    // proves this passes), and directly below via extractDatabaseProjectRef.
    expect(extractDatabaseProjectRef(STAGING_DB_URL)).toBe(EXPECTED_STAGING_PROJECT_REF);
  });

  it("local/development context is never forced to match staging", () => {
    const result = verifyEnvironmentTarget({
      context: "development",
      supabaseAuthUrl: undefined,
      databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });
    expect(result.ok).toBe(true);
  });

  it("production context is never evaluated as though it were preview", () => {
    // Even a production deployment whose targets don't match the staging
    // ref (they never would — production has its own project) must PASS:
    // this guard's only job is protecting Preview, not asserting anything
    // about what Production's own targets should be (requirement #8).
    const result = verifyEnvironmentTarget({
      context: "production",
      supabaseAuthUrl: PRODUCTION_AUTH_URL,
      databaseUrl: PRODUCTION_DB_URL,
    });
    expect(result.ok).toBe(true);
  });

  it("production context passes even with missing targets — this guard does not validate production", () => {
    const result = verifyEnvironmentTarget({
      context: "production",
      supabaseAuthUrl: undefined,
      databaseUrl: undefined,
    });
    expect(result.ok).toBe(true);
  });

  it("failure reasons never contain the password or connection-string credentials", () => {
    const scenarios = [
      verifyEnvironmentTarget({ context: "preview", supabaseAuthUrl: PRODUCTION_AUTH_URL, databaseUrl: STAGING_DB_URL }),
      verifyEnvironmentTarget({ context: "preview", supabaseAuthUrl: STAGING_AUTH_URL, databaseUrl: PRODUCTION_DB_URL }),
      verifyEnvironmentTarget({ context: "preview", supabaseAuthUrl: undefined, databaseUrl: STAGING_DB_URL }),
      verifyEnvironmentTarget({ context: "preview", supabaseAuthUrl: STAGING_AUTH_URL, databaseUrl: "not-a-connection-string" }),
    ];
    for (const result of scenarios) {
      expect(result.reason).toBeDefined();
      expect(result.reason).not.toMatch(/hunter2|s3cr3t|pw|postgresql:\/\//);
    }
  });
});

describe("extractSupabaseAuthProjectRef", () => {
  it("extracts the project ref from a well-formed Supabase Auth URL", () => {
    expect(extractSupabaseAuthProjectRef(STAGING_AUTH_URL)).toBe(EXPECTED_STAGING_PROJECT_REF);
  });

  it("returns null for a non-supabase.co host", () => {
    expect(extractSupabaseAuthProjectRef("https://example.com")).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    expect(extractSupabaseAuthProjectRef("not-a-url")).toBeNull();
  });
});

describe("extractDatabaseProjectRef", () => {
  it("extracts the project ref from a Transaction Pooler username", () => {
    expect(extractDatabaseProjectRef(STAGING_DB_URL)).toBe(EXPECTED_STAGING_PROJECT_REF);
  });

  it("returns null for a local (non-pooler) connection string", () => {
    expect(extractDatabaseProjectRef("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toBeNull();
  });

  it("returns null for a direct (non-pooler) Supabase connection string", () => {
    // ADR-004: only the pooler form is ever expected in this application —
    // a direct-connection URL is treated the same as any other unrecognized
    // shape, not specially parsed.
    expect(
      extractDatabaseProjectRef(`postgresql://postgres:pw@db.${EXPECTED_STAGING_PROJECT_REF}.supabase.co:5432/postgres`),
    ).toBeNull();
  });

  it("returns null for an unparseable connection string", () => {
    expect(extractDatabaseProjectRef("not-a-connection-string")).toBeNull();
  });
});
