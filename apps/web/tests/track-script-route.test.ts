import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { GET } from "../app/track/script/route";
import { TRACKER_GLOBAL_NAME, TRACKER_SCRIPT_SOURCE } from "../app/track/script/tracker-source";

/**
 * Milestone 3.1D — GET /track/script route-level coverage. Proves the
 * served response is a real, standalone, browser-executable JavaScript
 * document (Design Resolution Audit Section 2's hard requirement), not
 * merely that the route returns 200. See track-script-helpers.test.ts
 * and track-script-adapter.test.ts for the tracker's own runtime
 * behavior once loaded.
 */

describe("GET /track/script — response shape", () => {
  it("returns 200 with the exact tracker source as the body", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(TRACKER_SCRIPT_SOURCE);
  });

  it("sets a JavaScript content-type", async () => {
    const res = await GET();
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
  });

  it("sets a sensible cache-control header", async () => {
    const res = await GET();
    const cc = res.headers.get("cache-control");
    expect(cc).toBeTruthy();
    expect(cc).toContain("public");
    expect(cc).toContain("max-age=");
  });

  it("sets no CORS headers — script-tag loading is not CORS-governed", async () => {
    const res = await GET();
    for (const [name] of res.headers.entries()) {
      expect(name.toLowerCase().startsWith("access-control-")).toBe(false);
    }
  });

  it("body is non-empty", async () => {
    const res = await GET();
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100);
  });
});

describe("GET /track/script — no OPTIONS export, no DB dependency", () => {
  it("route module declares no OPTIONS export", async () => {
    const mod = (await import("../app/track/script/route")) as Record<string, unknown>;
    expect(mod.OPTIONS).toBeUndefined();
  });

  it("route.ts source imports no database/auth/compliance/intelligence package", () => {
    const source = readFileSync(join(__dirname, "../app/track/script/route.ts"), "utf-8");
    expect(source).not.toMatch(/@ai-revenue-os\/(database|auth|compliance|intelligence)/);
  });

  it("route.ts source performs no db/pool/client access", () => {
    const source = readFileSync(join(__dirname, "../app/track/script/route.ts"), "utf-8");
    expect(source.toLowerCase()).not.toContain("pool");
    expect(source.toLowerCase()).not.toContain("client.query");
  });
});

describe("GET /track/script — served body is valid standalone JavaScript", () => {
  it("contains no TypeScript type/interface/enum syntax", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\binterface\s+\w+/);
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\benum\s+\w+/);
    // A colon-based type annotation would appear as `name: Type` right
    // after a function parameter — the tracker never declares one since
    // it is hand-authored plain JS; object literal property colons
    // (e.g. `method: 'POST'`) are expected and fine, so this checks for
    // the specific `): ReturnType` / `(param: Type)` shapes instead of
    // banning every colon in the file.
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\)\s*:\s*[A-Za-z_]/);
  });

  it("contains no import/export/require statements", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\bimport\s/);
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\bexport\s/);
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\brequire\s*\(/);
  });

  it("contains no Node-only globals", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\bprocess\./);
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\b__dirname\b/);
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\bmodule\.exports\b/);
  });

  it("parses and executes as standalone JavaScript in an isolated vm context", () => {
    const sandbox: Record<string, unknown> = {
      document: { currentScript: null, referrer: "" },
      location: { href: "https://customer.example.com/", origin: "https://customer.example.com", pathname: "/" },
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
      fetch: () => Promise.resolve({ status: 204, headers: { get: () => null } }),
      localStorage: makeStubStorage(),
      sessionStorage: makeStubStorage(),
      URL,
      console,
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    expect(() => new vm.Script(TRACKER_SCRIPT_SOURCE, { filename: "tracker.js" }).runInContext(context)).not.toThrow();
  });

  it("initializes the documented global after execution (even with no valid script element -> inert)", () => {
    const sandbox: Record<string, unknown> = {
      document: { currentScript: null, referrer: "" },
      location: { href: "https://customer.example.com/", origin: "https://customer.example.com", pathname: "/" },
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
      fetch: () => Promise.resolve({ status: 204, headers: { get: () => null } }),
      localStorage: makeStubStorage(),
      sessionStorage: makeStubStorage(),
      URL,
      console,
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    new vm.Script(TRACKER_SCRIPT_SOURCE, { filename: "tracker.js" }).runInContext(context);
    const global = sandbox[TRACKER_GLOBAL_NAME] as { __aiRevenueOsInitialized?: boolean; consent?: unknown; track?: unknown };
    expect(global).toBeDefined();
    expect(global.__aiRevenueOsInitialized).toBe(true);
    expect(typeof global.consent).toBe("function");
    expect(typeof global.track).toBe("function");
  });

  it("reads the site key from the executing script element's data-site-key attribute", () => {
    const calls: unknown[] = [];
    const scriptEl = {
      src: "https://platform.example.com/track/script",
      getAttribute: (name: string) => (name === "data-site-key" ? "11111111-1111-4111-8111-111111111111" : null),
    };
    const sandbox: Record<string, unknown> = {
      document: { currentScript: scriptEl, referrer: "" },
      location: { href: "https://customer.example.com/", origin: "https://customer.example.com", pathname: "/" },
      crypto: { randomUUID: () => "22222222-2222-4222-8222-222222222222" },
      fetch: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ status: 204, headers: { get: () => null } });
      },
      localStorage: makeStubStorage(),
      sessionStorage: makeStubStorage(),
      URL,
      console,
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    new vm.Script(TRACKER_SCRIPT_SOURCE, { filename: "tracker.js" }).runInContext(context);
    const global = sandbox[TRACKER_GLOBAL_NAME] as { consent: (status: string) => void };
    global.consent("granted");
    expect(calls.length).toBeGreaterThan(0);
    const [, init] = calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { siteKey: string };
    expect(body.siteKey).toBe("11111111-1111-4111-8111-111111111111");
  });
});

function makeStubStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}
