import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyMigrationSql } from "../src/migration-safety";

/**
 * M1.9 destructive-migration-blocking test (docs/13-Technical-Design-
 * Review.md §M1.9). Pure logic, no database — classifyMigrationSql() does
 * no I/O of its own; the one exception is the regression suite at the
 * bottom of this file, which reads (never executes) this repo's own real
 * migration files from disk to prove the classifier doesn't misfire
 * against already-shipped history.
 */

const OVERRIDE = "-- migration-safety: destructive-override\n-- migration-safety-reason: reviewed and intentional for this test\n";

describe("classifyMigrationSql — safe operations", () => {
  const cases: Array<[string, string]> = [
    ["CREATE TABLE", "create table public.widgets (id uuid primary key, name text not null);"],
    ["ADD COLUMN", "alter table public.widgets add column description text;"],
    ["CREATE INDEX", "create index widgets_name_idx on public.widgets (name);"],
    ["CREATE POLICY", "create policy widgets_select_own on public.widgets for select using (true);"],
    [
      "CREATE OR REPLACE FUNCTION",
      "create or replace function public.noop() returns void language sql as $$ select 1; $$;",
    ],
    ["DROP CONSTRAINT", "alter table public.widgets drop constraint widgets_name_fkey;"],
    ["ALTER COLUMN DROP NOT NULL", "alter table public.widgets alter column name drop not null;"],
    [
      "REFERENCES ON DELETE CASCADE",
      "create table public.parts (id uuid primary key, widget_id uuid references public.widgets (id) on delete cascade);",
    ],
    [
      "REFERENCES ON UPDATE CASCADE",
      "create table public.parts (id uuid primary key, widget_id uuid references public.widgets (id) on update cascade);",
    ],
  ];

  it.each(cases)("%s is safe", (_label, sql) => {
    const result = classifyMigrationSql(sql);
    expect(result.malformed).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.safe).toBe(true);
  });
});

describe("classifyMigrationSql — blocked without override", () => {
  const cases: Array<[string, string, string]> = [
    ["DROP TABLE", "drop table public.widgets;", "drop-table"],
    ["DROP COLUMN", "alter table public.widgets drop column name;", "drop-column"],
    ["DROP TYPE", "drop type public.widget_status;", "drop-type"],
    ["DROP SCHEMA", "drop schema public;", "drop-schema"],
    ["TRUNCATE", "truncate public.widgets;", "truncate"],
    ["DROP TABLE ... CASCADE", "drop table public.widgets cascade;", "drop-cascade"],
    ["ALTER COLUMN ... TYPE", "alter table public.widgets alter column id type bigint;", "alter-column-type"],
    ["RENAME COLUMN", "alter table public.widgets rename column name to title;", "rename"],
    ["table RENAME TO", "alter table public.widgets rename to gadgets;", "rename"],
    ["top-level DELETE", "delete from public.widgets;", "unconditional-delete"],
  ];

  it.each(cases)("%s is blocked (category: %s)", (_label, sql, expectedCategory) => {
    const result = classifyMigrationSql(sql);
    expect(result.malformed).toBe(false);
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.category === expectedCategory)).toBe(true);
  });

  it("scoped top-level DELETE ... WHERE is blocked as scoped-delete, not unconditional-delete", () => {
    const result = classifyMigrationSql("delete from public.widgets where id = 'x';");
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.category === "scoped-delete")).toBe(true);
    expect(result.findings.some((f) => f.category === "unconditional-delete")).toBe(false);
  });
});

describe("classifyMigrationSql — false-positive protection", () => {
  it("destructive words inside a -- comment do not trigger a finding", () => {
    const result = classifyMigrationSql(
      "-- we used to DROP TABLE public.widgets here, replaced by a safer migration\ncreate table public.widgets (id uuid primary key);",
    );
    expect(result.safe).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("destructive words inside a /* block comment */ do not trigger a finding", () => {
    const result = classifyMigrationSql(
      "/* DROP TABLE public.widgets was considered and rejected */\ncreate table public.widgets (id uuid primary key);",
    );
    expect(result.safe).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("destructive SQL text inside single-quoted data does not trigger a finding", () => {
    const result = classifyMigrationSql(
      "insert into public.audit_log_seed (note) values ('an admin ran DROP TABLE widgets by mistake once');",
    );
    expect(result.safe).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("destructive SQL inside a $$ function body does not trigger a finding", () => {
    // The real shape of this repo's GDPR erasure function: a DELETE
    // statement that only ever executes later, under application-layer
    // authorization — not at migration-apply time.
    const result = classifyMigrationSql(
      "create or replace function public.execute_user_erasure(p_dsr_id uuid, p_actor uuid) returns void language plpgsql as $$ begin delete from auth.users where id = p_actor; end; $$;",
    );
    expect(result.safe).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("destructive SQL inside a $tag$ function body does not trigger a finding", () => {
    const result = classifyMigrationSql(
      "create or replace function public.dangerous_if_called() returns void language plpgsql as $body$ begin truncate public.widgets; end; $body$;",
    );
    expect(result.safe).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("REVOKE TRUNCATE (a privilege name, not a command) does not trigger truncate", () => {
    // Real regression: packages/database/supabase/migrations/
    // 20260811100000_revoke_dangerous_default_table_privileges.sql revokes
    // the TRUNCATE privilege — the word appears as a GRANT/REVOKE
    // privilege name, never as the TRUNCATE command itself.
    const result = classifyMigrationSql(
      "revoke truncate, references, trigger on all tables in schema public from authenticated, anon;",
    );
    expect(result.findings.some((f) => f.category === "truncate")).toBe(false);
    expect(result.safe).toBe(true);
  });

  it("ON DELETE CASCADE / ON UPDATE CASCADE FK clauses never trigger drop-cascade", () => {
    const result = classifyMigrationSql(
      "create table public.parts (id uuid primary key, widget_id uuid references public.widgets (id) on delete cascade, owner_id uuid references public.owners (id) on update cascade);",
    );
    expect(result.findings.some((f) => f.category === "drop-cascade")).toBe(false);
  });
});

describe("classifyMigrationSql — multi-statement files", () => {
  it("safe + safe -> pass", () => {
    const result = classifyMigrationSql(
      "create table public.a (id uuid primary key); create table public.b (id uuid primary key);",
    );
    expect(result.safe).toBe(true);
  });

  it("safe + destructive -> fail", () => {
    const result = classifyMigrationSql("create table public.a (id uuid primary key); drop table public.old_a;");
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.category === "drop-table")).toBe(true);
  });

  it("destructive + safe -> fail", () => {
    const result = classifyMigrationSql("drop table public.old_a; create table public.a (id uuid primary key);");
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.category === "drop-table")).toBe(true);
  });
});

describe("classifyMigrationSql — malformed SQL fails closed", () => {
  it("unterminated single-quoted string -> unsafe", () => {
    const result = classifyMigrationSql("insert into public.widgets (name) values ('unterminated;");
    expect(result.malformed).toBe(true);
    expect(result.safe).toBe(false);
    expect(result.malformedReason).toMatch(/single-quoted string/);
  });

  it("unterminated dollar-quoted body -> unsafe", () => {
    const result = classifyMigrationSql("create function public.f() returns void language sql as $$ select 1;");
    expect(result.malformed).toBe(true);
    expect(result.safe).toBe(false);
    expect(result.malformedReason).toMatch(/dollar-quoted body/);
  });

  it("unterminated block comment -> unsafe", () => {
    const result = classifyMigrationSql("/* this comment never closes\ncreate table public.widgets (id uuid);");
    expect(result.malformed).toBe(true);
    expect(result.safe).toBe(false);
    expect(result.malformedReason).toMatch(/block comment/);
  });

  it("malformed SQL cannot be rescued by an override — there is nothing safe to trust it against", () => {
    const result = classifyMigrationSql(`${OVERRIDE}insert into public.widgets (name) values ('unterminated;`);
    expect(result.safe).toBe(false);
    expect(result.overridePresent).toBe(false);
  });
});

describe("classifyMigrationSql — override behavior", () => {
  it("valid marker + reason pair allows an otherwise-destructive migration, with the finding still recorded", () => {
    const result = classifyMigrationSql(`${OVERRIDE}drop table public.widgets;`);
    expect(result.safe).toBe(true);
    expect(result.overridePresent).toBe(true);
    expect(result.overrideReason).toBe("reviewed and intentional for this test");
    expect(result.findings.some((f) => f.category === "drop-table")).toBe(true);
  });

  it("marker without a reason line does not override — fails", () => {
    const result = classifyMigrationSql("-- migration-safety: destructive-override\ndrop table public.widgets;");
    expect(result.safe).toBe(false);
    expect(result.overridePresent).toBe(false);
  });

  it("marker with an empty reason does not override — fails", () => {
    const result = classifyMigrationSql(
      "-- migration-safety: destructive-override\n-- migration-safety-reason:\ndrop table public.widgets;",
    );
    expect(result.safe).toBe(false);
    expect(result.overridePresent).toBe(false);
  });

  it("marker with a whitespace-only reason does not override — fails", () => {
    const result = classifyMigrationSql(
      "-- migration-safety: destructive-override\n-- migration-safety-reason:    \ndrop table public.widgets;",
    );
    expect(result.safe).toBe(false);
    expect(result.overridePresent).toBe(false);
  });

  it("a reason line without the marker line does not override — blocks normally", () => {
    const result = classifyMigrationSql(
      "-- migration-safety-reason: this alone should not be enough\ndrop table public.widgets;",
    );
    expect(result.safe).toBe(false);
    expect(result.overridePresent).toBe(false);
  });

  it("a marker inside a string literal (not a real comment) does not grant an override", () => {
    const result = classifyMigrationSql(
      "insert into public.notes (body) values ('-- migration-safety: destructive-override'); drop table public.widgets;",
    );
    expect(result.safe).toBe(false);
    expect(result.overridePresent).toBe(false);
  });
});

describe("classifyMigrationSql — regression against every real migration in this repo", () => {
  const migrationsDir = path.resolve(__dirname, "../supabase/migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("found at least one real migration file to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s is classified as safe (no override needed)", (file) => {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    const result = classifyMigrationSql(sql);
    expect(result.malformed, `${file} could not be parsed: ${result.malformedReason}`).toBe(false);
    expect(
      result.safe,
      `${file} was flagged as destructive: ${JSON.stringify(result.findings)}`,
    ).toBe(true);
    expect(result.overridePresent, `${file} required an override it should not need`).toBe(false);
  });
});
