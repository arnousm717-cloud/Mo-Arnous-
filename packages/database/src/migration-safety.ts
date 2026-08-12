/**
 * Migration-safety classifier (M1.9, docs/13-Technical-Design-Review.md
 * §M1.9). Pure, deterministic, offline: given a migration file's raw SQL
 * text, decides whether it contains a destructive top-level statement.
 * Never opens a connection, never makes a network request, never reads an
 * environment variable — its only input is the SQL text itself.
 *
 * Design (see docs/13 §M1.9 migration-safety audit for the full reasoning
 * and the real migration-history examples that shaped these rules):
 *
 * 1. Tokenize the raw text into comment / string / dollar-quoted / code
 *    segments. Fails closed (malformed: true) on any unterminated
 *    construct — a scanner that can't safely parse the file must never
 *    silently treat it as safe.
 * 2. Destructive-keyword matching runs ONLY against the concatenated
 *    "code" segments — comments, string literal contents, and the bodies
 *    of dollar-quoted function/procedure definitions are excluded. This
 *    is what correctly ignores the real `delete from auth.users` inside
 *    this repo's own GDPR erasure function (reviewed source that runs
 *    later under application-layer authorization, not a statement that
 *    executes the moment this migration is applied) while still catching
 *    an actual top-level `DROP TABLE ...;`.
 * 3. Matching is done per top-level statement (code text split on `;`),
 *    which is also what correctly separates a `DROP TABLE ... CASCADE`
 *    (destructive) from an unrelated `REFERENCES ... ON DELETE CASCADE`
 *    clause inside a completely different CREATE/ALTER TABLE statement —
 *    the two can never share a statement, so a per-statement CASCADE
 *    check next to a leading DROP keyword cannot be confused with an FK
 *    action clause.
 * 4. An explicit, committed override
 *    (`-- migration-safety: destructive-override` +
 *    `-- migration-safety-reason: <non-empty text>`, both required) is
 *    read only from genuine comment segments — never from string literal
 *    data — so it can't be spoofed by data that merely looks like the
 *    marker. Findings are still returned even when overridden; only the
 *    `safe` verdict changes.
 */

export type DestructiveCategory =
  | "drop-table"
  | "drop-column"
  | "drop-type"
  | "drop-schema"
  | "truncate"
  | "drop-cascade"
  | "unconditional-delete"
  | "scoped-delete"
  | "alter-column-type"
  | "rename";

export interface DestructiveFinding {
  category: DestructiveCategory;
  /** The offending statement, trimmed and truncated — never the full file, never anything beyond what was already in the committed SQL. */
  statement: string;
}

export interface ClassificationResult {
  /** false whenever CI should block: unresolved findings, or the file could not be safely parsed at all. */
  safe: boolean;
  findings: DestructiveFinding[];
  /** true only when a valid marker+reason pair was found in a genuine comment. */
  overridePresent: boolean;
  overrideReason: string | null;
  malformed: boolean;
  malformedReason: string | null;
}

type SegmentKind = "code" | "comment" | "string" | "dollar";
interface Segment {
  kind: SegmentKind;
  text: string;
}

type TokenizeResult = { ok: true; segments: Segment[] } | { ok: false; reason: string };

const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

function tokenize(sql: string): TokenizeResult {
  const segments: Segment[] = [];
  const n = sql.length;
  let i = 0;
  let codeBuf = "";

  const flushCode = () => {
    if (codeBuf.length > 0) {
      segments.push({ kind: "code", text: codeBuf });
      codeBuf = "";
    }
  };

  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    if (c === "-" && c2 === "-") {
      flushCode();
      const start = i + 2;
      let j = start;
      while (j < n && sql[j] !== "\n") j++;
      segments.push({ kind: "comment", text: sql.slice(start, j) });
      i = j;
      continue;
    }

    if (c === "/" && c2 === "*") {
      flushCode();
      const start = i + 2;
      // Postgres block comments can nest; this scanner deliberately does
      // not — it finds the FIRST "*/", which means genuinely nested
      // comments end this segment earlier than Postgres itself would.
      // That only ever causes text Postgres treats as comment to be
      // re-classified as code here — a false-positive risk, never a
      // false-negative one, which is the safe direction for a security
      // gate to err in. Not observed anywhere in this repo's real
      // migrations.
      const end = sql.indexOf("*/", start);
      if (end === -1) {
        return { ok: false, reason: "unterminated block comment" };
      }
      segments.push({ kind: "comment", text: sql.slice(start, end) });
      i = end + 2;
      continue;
    }

    if (c === "'") {
      flushCode();
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          closed = true;
          j += 1;
          break;
        }
        j++;
      }
      if (!closed) {
        return { ok: false, reason: "unterminated single-quoted string" };
      }
      segments.push({ kind: "string", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (c === "$") {
      const tagMatch = DOLLAR_TAG_RE.exec(sql.slice(i));
      if (tagMatch) {
        flushCode();
        const delimiter = tagMatch[0];
        const bodyStart = i + delimiter.length;
        const end = sql.indexOf(delimiter, bodyStart);
        if (end === -1) {
          return { ok: false, reason: "unterminated dollar-quoted body" };
        }
        segments.push({ kind: "dollar", text: sql.slice(bodyStart, end) });
        i = end + delimiter.length;
        continue;
      }
    }

    codeBuf += c;
    i++;
  }

  flushCode();
  return { ok: true, segments };
}

function extractOverride(segments: Segment[]): { present: boolean; reason: string | null } {
  const commentLines: string[] = [];
  for (const seg of segments) {
    if (seg.kind !== "comment") continue;
    for (const line of seg.text.split("\n")) {
      commentLines.push(line.trim());
    }
  }

  const hasMarker = commentLines.some((line) => line === "migration-safety: destructive-override");

  let reason: string | null = null;
  for (const line of commentLines) {
    const match = /^migration-safety-reason:\s*(.*)$/.exec(line);
    const captured = match?.[1]?.trim();
    if (captured) {
      reason = captured;
      break;
    }
  }

  return { present: hasMarker && reason !== null, reason: hasMarker ? reason : null };
}

function buildCodeText(segments: Segment[]): string {
  return segments
    .filter((s) => s.kind === "code")
    .map((s) => s.text)
    .join(" ");
}

function splitStatements(codeText: string): string[] {
  return codeText
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface StatementRule {
  category: DestructiveCategory;
  test: (statement: string) => boolean;
}

// Order matters only for readability — a statement can match multiple
// rules (e.g. "DROP TABLE foo CASCADE" is both drop-table and
// drop-cascade), and every match is reported.
const STATEMENT_RULES: StatementRule[] = [
  { category: "drop-table", test: (s) => /\bdrop\s+table\b/i.test(s) },
  { category: "drop-column", test: (s) => /\bdrop\s+column\b/i.test(s) },
  { category: "drop-type", test: (s) => /\bdrop\s+type\b/i.test(s) },
  { category: "drop-schema", test: (s) => /\bdrop\s+schema\b/i.test(s) },
  // Anchored to the start of the statement — "truncate" also appears as a
  // GRANT/REVOKE privilege name (e.g. "revoke truncate, references,
  // trigger on ..."), which removes a capability and destroys no data; a
  // real TRUNCATE command is always the statement's leading keyword.
  { category: "truncate", test: (s) => /^truncate\b/i.test(s) },
  {
    // Scoped to a statement that itself STARTS with a DROP of an object
    // type that supports CASCADE — this is what keeps it from ever
    // matching an unrelated "REFERENCES ... ON DELETE CASCADE" clause,
    // which only ever appears inside a CREATE/ALTER TABLE statement, a
    // different statement entirely once split on ";".
    category: "drop-cascade",
    test: (s) => /^drop\s+(table|type|schema|view|function)\b/i.test(s) && /\bcascade\b/i.test(s),
  },
  {
    category: "unconditional-delete",
    test: (s) => /^delete\s+from\s+\S+/i.test(s) && !/\bwhere\b/i.test(s),
  },
  {
    category: "scoped-delete",
    test: (s) => /^delete\s+from\s+\S+/i.test(s) && /\bwhere\b/i.test(s),
  },
  {
    category: "alter-column-type",
    test: (s) => /\balter\s+column\s+\S+\s+(?:set\s+data\s+)?type\b/i.test(s),
  },
  {
    category: "rename",
    test: (s) => /\brename\s+column\b/i.test(s) || /\brename\s+to\b/i.test(s),
  },
];

const MAX_REPORTED_STATEMENT_LENGTH = 200;

export function classifyMigrationSql(sql: string): ClassificationResult {
  const tokenized = tokenize(sql);
  if (!tokenized.ok) {
    return {
      safe: false,
      findings: [],
      overridePresent: false,
      overrideReason: null,
      malformed: true,
      malformedReason: tokenized.reason,
    };
  }

  const override = extractOverride(tokenized.segments);
  const codeText = buildCodeText(tokenized.segments);
  const statements = splitStatements(codeText);

  const findings: DestructiveFinding[] = [];
  for (const statement of statements) {
    for (const rule of STATEMENT_RULES) {
      if (rule.test(statement)) {
        findings.push({
          category: rule.category,
          statement: statement.length > MAX_REPORTED_STATEMENT_LENGTH
            ? `${statement.slice(0, MAX_REPORTED_STATEMENT_LENGTH)}…`
            : statement,
        });
      }
    }
  }

  return {
    safe: findings.length === 0 || override.present,
    findings,
    overridePresent: override.present,
    overrideReason: override.present ? override.reason : null,
    malformed: false,
    malformedReason: null,
  };
}
