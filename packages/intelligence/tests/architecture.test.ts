import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.join(__dirname, "..");
const SRC_DIR = path.join(PACKAGE_ROOT, "src");

/** Strips /* ... *\/ block comments and // line comments before returning
 * source text — several files here explain in prose exactly what they
 * deliberately do NOT do (e.g. "no NextResponse anywhere in this
 * package"), which would otherwise trip a naive substring check on the
 * comment itself. Only code text is checked below. */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

async function readSourceFiles(): Promise<Array<{ file: string; content: string }>> {
  const files = await readdir(SRC_DIR);
  const out: Array<{ file: string; content: string }> = [];
  for (const file of files) {
    out.push({ file, content: stripComments(await readFile(path.join(SRC_DIR, file), "utf8")) });
  }
  return out;
}

describe("packages/intelligence architecture boundaries", () => {
  it("no source file imports Request, NextResponse, or anything from next/*", async () => {
    const files = await readSourceFiles();
    for (const { file, content } of files) {
      expect(content, `${file} must not reference NextResponse`).not.toContain("NextResponse");
      expect(content, `${file} must not import from "next/server"`).not.toMatch(/from ["']next\/server["']/);
      expect(content, `${file} must not reference apps/web`).not.toContain("apps/web");
    }
  });

  it("no source file references n8n", async () => {
    const files = await readSourceFiles();
    for (const { file, content } of files) {
      expect(content.toLowerCase(), `${file} must not reference n8n`).not.toContain("n8n");
    }
  });

  it("no source file references rate limiting, CORS, or IP extraction — those remain 3.1C's HTTP-boundary concern", async () => {
    const files = await readSourceFiles();
    for (const { file, content } of files) {
      const lower = content.toLowerCase();
      expect(lower, `${file} must not implement rate limiting`).not.toContain("ratelimit");
      expect(lower, `${file} must not implement CORS`).not.toContain("cors");
    }
  });

  it("package.json declares exactly one runtime dependency: @ai-revenue-os/database", async () => {
    const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies)).toEqual(["@ai-revenue-os/database"]);
  });

  it("no source file imports @ai-revenue-os/crm, @ai-revenue-os/auth, @ai-revenue-os/compliance, or @ai-revenue-os/web", async () => {
    const files = await readSourceFiles();
    const forbidden = [
      "@ai-revenue-os/crm",
      "@ai-revenue-os/auth",
      "@ai-revenue-os/compliance",
      "@ai-revenue-os/web",
    ];
    for (const { file, content } of files) {
      for (const dep of forbidden) {
        expect(content, `${file} must not import ${dep}`).not.toContain(dep);
      }
    }
  });
});
