import { randomUUID } from "node:crypto";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { TRACKER_GLOBAL_NAME, TRACKER_SCRIPT_SOURCE } from "../app/track/script/tracker-source";

/**
 * Milestone 3.1D — pure/stateless tracker behavior: site-key/UUID
 * validation, URL/referrer/UTM sanitization, the explicit track()
 * allowlist, pre-load queue command validation, and duplicate-load
 * protection. Exercised by running the exact served script (byte-
 * identical to what GET /track/script returns) inside a Node vm
 * sandbox with hand-written browser-API stubs — no jsdom/happy-dom,
 * no new dependency (Design Resolution Audit Section 17/19).
 *
 * Storage-persistence, consent-lifecycle, network-transport, and
 * response/backoff behavior are covered separately in
 * track-script-adapter.test.ts.
 */

interface FetchCall {
  url: string;
  init: { method: string; credentials: string; keepalive: boolean; headers: Record<string, string>; body: string };
}

interface Sandbox {
  window: unknown;
  document: { currentScript: unknown; referrer: string };
  location: { href: string; origin: string; pathname: string };
  crypto: { randomUUID: () => string };
  fetch: (url: string, init: FetchCall["init"]) => Promise<{ status: number; headers: { get: (name: string) => string | null } }>;
  localStorage: Storage;
  sessionStorage: Storage;
  URL: typeof URL;
  console: typeof console;
}

function makeStubStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function makeScriptEl(siteKey: string | null, src = "https://platform.example.com/track/script") {
  return {
    src,
    getAttribute: (name: string) => (name === "data-site-key" ? siteKey : null),
  };
}

interface SandboxOptions {
  siteKey?: string | null;
  scriptSrc?: string;
  noCurrentScript?: boolean;
  href?: string;
  origin?: string;
  pathname?: string;
  referrer?: string;
  preloadGlobal?: unknown;
}

function createSandbox(opts: SandboxOptions = {}) {
  const calls: FetchCall[] = [];
  const fetchImpl = (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    return Promise.resolve({ status: 204, headers: { get: () => null } });
  };
  const sandbox: Sandbox & Record<string, unknown> = {
    window: undefined,
    document: {
      currentScript: opts.noCurrentScript ? null : makeScriptEl(opts.siteKey === undefined ? randomUUID() : opts.siteKey, opts.scriptSrc),
      referrer: opts.referrer ?? "",
    },
    location: {
      href: opts.href ?? "https://customer.example.com/page",
      origin: opts.origin ?? "https://customer.example.com",
      pathname: opts.pathname ?? "/page",
    },
    crypto: { randomUUID: () => randomUUID() },
    fetch: fetchImpl,
    localStorage: makeStubStorage(),
    sessionStorage: makeStubStorage(),
    URL,
    console,
  };
  if (opts.preloadGlobal !== undefined) {
    sandbox[TRACKER_GLOBAL_NAME] = opts.preloadGlobal;
  }
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  return { context, sandbox, calls };
}

function runTracker(context: vm.Context) {
  new vm.Script(TRACKER_SCRIPT_SOURCE, { filename: "tracker.js" }).runInContext(context);
}

interface TrackerGlobal {
  __aiRevenueOsInitialized: boolean;
  consent: (status: string) => void;
  track: (eventType: string, fields?: unknown) => void;
  identify: (assertion: string) => void;
}

function getGlobal(sandbox: Record<string, unknown>): TrackerGlobal {
  return sandbox[TRACKER_GLOBAL_NAME] as TrackerGlobal;
}

describe("site key / platform origin derivation", () => {
  it("valid UUID data-site-key -> active (sends on grant)", () => {
    const { context, sandbox, calls } = createSandbox({ siteKey: randomUUID() });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("malformed data-site-key -> inert, no network request ever", () => {
    const { context, sandbox, calls } = createSandbox({ siteKey: "<script>alert(1)</script>" });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    getGlobal(sandbox).track("click");
    expect(calls.length).toBe(0);
  });

  it("missing data-site-key -> inert, no network request ever", () => {
    const { context, sandbox, calls } = createSandbox({ siteKey: null });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    expect(calls.length).toBe(0);
  });

  it("missing document.currentScript -> inert, no exception escapes", () => {
    const { context, sandbox, calls } = createSandbox({ noCurrentScript: true });
    expect(() => runTracker(context)).not.toThrow();
    expect(() => getGlobal(sandbox).consent("granted")).not.toThrow();
    expect(calls.length).toBe(0);
  });

  it("malformed script src (non-http protocol) -> inert", () => {
    const { context, sandbox, calls } = createSandbox({ siteKey: randomUUID(), scriptSrc: "data:text/javascript,evil" });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    expect(calls.length).toBe(0);
  });

  it("empty-string script src -> inert, no exception", () => {
    const { context } = createSandbox({ siteKey: randomUUID(), scriptSrc: "" });
    expect(() => runTracker(context)).not.toThrow();
  });

  it("derives endpoint from the SCRIPT's origin, never the customer page's own origin", () => {
    const { context, sandbox, calls } = createSandbox({
      siteKey: randomUUID(),
      scriptSrc: "https://platform.example.com/track/script",
      origin: "https://totally-different-customer-site.example.net",
      href: "https://totally-different-customer-site.example.net/page",
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith("https://platform.example.com")).toBe(true);
      expect(call.url.startsWith("https://totally-different-customer-site.example.net")).toBe(false);
    }
  });
});

/**
 * consent("granted") always sends the consent POST first, then the
 * automatic pageview collect POST — url/referrer/utm fields only ever
 * appear on the collect payload, never the consent payload, so tests
 * must locate it explicitly rather than assuming calls[0].
 */
function findCollectCall(calls: FetchCall[]): FetchCall {
  const call = calls.find((c) => c.url.includes("/track/collect"));
  if (!call) throw new Error("no /track/collect call was made");
  return call;
}

describe("URL / referrer / UTM sanitization", () => {
  it("current URL is origin + pathname only, never full href", () => {
    const { context, sandbox, calls } = createSandbox({
      href: "https://customer.example.com/products?id=123&email=someone@example.com&token=abc#secret-fragment",
      origin: "https://customer.example.com",
      pathname: "/products",
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const body = JSON.parse(findCollectCall(calls).init.body) as { url?: string };
    expect(body.url).toBe("https://customer.example.com/products");
    expect(body.url).not.toContain("email");
    expect(body.url).not.toContain("token");
    expect(body.url).not.toContain("secret-fragment");
    expect(body.url).not.toContain("?");
    expect(body.url).not.toContain("#");
  });

  it("valid absolute http(s) referrer is sanitized to origin + pathname", () => {
    const { context, sandbox, calls } = createSandbox({ referrer: "https://ref.example.com/path/here?q=1#f" });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const body = JSON.parse(findCollectCall(calls).init.body) as { referrer?: string };
    expect(body.referrer).toBe("https://ref.example.com/path/here");
  });

  it("malformed referrer is omitted, not sent empty", () => {
    const { context, sandbox, calls } = createSandbox({ referrer: "not a url at all" });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const body = JSON.parse(findCollectCall(calls).init.body) as { referrer?: string };
    expect(body.referrer).toBeUndefined();
  });

  it("javascript: referrer is omitted (non-http(s) scheme)", () => {
    const { context, sandbox, calls } = createSandbox({ referrer: "javascript:alert(1)" });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const body = JSON.parse(findCollectCall(calls).init.body) as { referrer?: string };
    expect(body.referrer).toBeUndefined();
  });

  it("empty referrer is omitted", () => {
    const { context, sandbox, calls } = createSandbox({ referrer: "" });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const body = JSON.parse(findCollectCall(calls).init.body) as { referrer?: string };
    expect(body.referrer).toBeUndefined();
  });

  it("only the three approved UTM parameters are read, nothing else", () => {
    const { context, sandbox, calls } = createSandbox({
      href: "https://customer.example.com/?utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_content=banner&session_token=abc123",
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const body = JSON.parse(findCollectCall(calls).init.body) as Record<string, unknown>;
    expect(body.utmSource).toBe("google");
    expect(body.utmMedium).toBe("cpc");
    expect(body.utmCampaign).toBe("spring");
    expect(JSON.stringify(body)).not.toContain("banner");
    expect(JSON.stringify(body)).not.toContain("session_token");
    expect(JSON.stringify(body)).not.toContain("abc123");
  });

  it("a UTM value longer than 255 chars is omitted, never truncated", () => {
    const longValue = "x".repeat(300);
    const { context, sandbox, calls } = createSandbox({
      href: `https://customer.example.com/?utm_source=${longValue}`,
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const body = JSON.parse(findCollectCall(calls).init.body) as Record<string, unknown>;
    expect(body.utmSource).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("xxxxxxxxxx");
  });

  it("a UTM value exactly at 255 chars is kept, not omitted", () => {
    const exactValue = "y".repeat(255);
    const { context, sandbox, calls } = createSandbox({
      href: `https://customer.example.com/?utm_source=${exactValue}`,
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const body = JSON.parse(findCollectCall(calls).init.body) as Record<string, unknown>;
    expect(body.utmSource).toBe(exactValue);
  });
});

describe("explicit track() allowlist", () => {
  it("click is accepted once granted", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    getGlobal(sandbox).track("click");
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0]!.init.body) as { eventType?: string };
    expect(body.eventType).toBe("click");
  });

  it("form_submit is accepted once granted", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    getGlobal(sandbox).track("form_submit");
    expect(calls.length).toBe(1);
  });

  it("pageview is rejected through track() — automatic-only in 3.1D", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    getGlobal(sandbox).track("pageview");
    expect(calls.length).toBe(0);
  });

  it("an unrecognized event type is rejected", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    getGlobal(sandbox).track("purchase");
    expect(calls.length).toBe(0);
  });

  it("unknown consent state drops track() calls locally", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).track("click");
    expect(calls.length).toBe(0);
  });

  it("withdrawn consent state drops track() calls locally", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    getGlobal(sandbox).consent("withdrawn");
    calls.length = 0;
    getGlobal(sandbox).track("click");
    expect(calls.length).toBe(0);
  });

  it("caller cannot override siteKey/anonymousId/anonymousSessionId/eventType via fields", () => {
    const { context, sandbox, calls } = createSandbox({ siteKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    getGlobal(sandbox).track("click", {
      siteKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      anonymousId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      anonymousSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      eventType: "form_submit",
      organizationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    expect(body.siteKey).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(body.anonymousId).not.toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(body.anonymousSessionId).not.toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(body.eventType).toBe("click");
    expect(body.organizationId).toBeUndefined();
  });

  it("only metadata is forwarded from caller-supplied fields, via an explicit allowlist", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    getGlobal(sandbox).track("click", { metadata: { buttonId: "cta-1" }, url: "https://attacker.example.com/x", deviceType: "server-farm" });
    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    expect(body.metadata).toEqual({ buttonId: "cta-1" });
    expect(body.deviceType).toBeUndefined();
    expect(body.url).not.toBe("https://attacker.example.com/x");
  });

  it("metadata is forwarded without DOM enrichment — reference passed through untouched", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    const metadata = { a: 1, nested: { b: [1, 2, 3] } };
    getGlobal(sandbox).track("click", { metadata });
    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    expect(body.metadata).toEqual(metadata);
  });

  it("metadata with __proto__-shaped own property (JSON.parse-style) is forwarded inert, causes no pollution", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    const poisoned = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as Record<string, unknown>;
    getGlobal(sandbox).track("click", { metadata: poisoned });
    expect(calls.length).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    expect((body.metadata as Record<string, unknown>).safe).toBe(1);
  });
});

describe("identify(assertion) — Milestone 3.2E", () => {
  it("before consent: no network call, regardless of assertion validity", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).identify("some.assertion");
    expect(calls.length).toBe(0);
  });

  it("after consent: sends exactly one POST /track/identify with siteKey/anonymousId/assertion", () => {
    const siteKey = randomUUID();
    const { context, sandbox, calls } = createSandbox({ siteKey });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    getGlobal(sandbox).identify("header.payload.signature");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/track/identify");
    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    expect(body.siteKey).toBe(siteKey);
    expect(typeof body.anonymousId).toBe("string");
    expect(body.assertion).toBe("header.payload.signature");
    expect(Object.keys(body).sort()).toEqual(["anonymousId", "assertion", "siteKey"]);
  });

  it("uses credentials: omit, matching every other /track/* call", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    getGlobal(sandbox).identify("a.b");
    expect(calls[0]!.init.credentials).toBe("omit");
  });

  it("a non-string or empty assertion is dropped locally, no network call", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    calls.length = 0;
    getGlobal(sandbox).identify("");
    getGlobal(sandbox).identify(null as unknown as string);
    getGlobal(sandbox).identify(undefined as unknown as string);
    getGlobal(sandbox).identify(12345 as unknown as string);
    expect(calls.length).toBe(0);
  });

  it("dropped immediately after withdrawal — same synchronous gating as track()", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    getGlobal(sandbox).consent("withdrawn");
    calls.length = 0;
    getGlobal(sandbox).identify("a.b");
    expect(calls.length).toBe(0);
  });

  it("inert (missing/malformed site key) -> identify() is a safe no-op", () => {
    const { context, sandbox, calls } = createSandbox({ siteKey: null });
    runTracker(context);
    expect(() => getGlobal(sandbox).identify("a.b")).not.toThrow();
    getGlobal(sandbox).consent("granted");
    getGlobal(sandbox).identify("a.b");
    expect(calls.length).toBe(0);
  });
});

describe("duplicate load protection", () => {
  it("second real-script execution is a complete no-op", () => {
    const { context, sandbox, calls } = createSandbox({ siteKey: randomUUID() });
    runTracker(context);
    runTracker(context); // execute the exact same source a second time in the same context.
    getGlobal(sandbox).consent("granted");
    // exactly one consent POST + one automatic pageview should result —
    // never doubled by the second execution having re-bootstrapped.
    expect(calls.length).toBe(2);
  });
});

describe("pre-load command queue", () => {
  it("replays queued consent + track commands in order, respecting consent state", () => {
    const { context, calls } = createSandbox({
      siteKey: randomUUID(),
      preloadGlobal: {
        q: [
          ["track", "click"], // before grant -> dropped
          ["consent", "granted"], // -> 1 consent POST + 1 auto pageview
          ["track", "click"], // after grant -> sent
        ],
      },
    });
    runTracker(context);
    // dropped-click (0) + granted (1 consent POST + 1 auto pageview) + sent-click (1) = 3 network calls.
    expect(calls.length).toBe(3);
    const eventTypes = calls.map((c) => {
      const body = JSON.parse(c.init.body) as Record<string, unknown>;
      return (body.status as string | undefined) ?? (body.eventType as string | undefined);
    });
    expect(eventTypes).toEqual(["granted", "pageview", "click"]);
  });

  it("replays a queued identify command after a queued consent grant, respecting consent gating", () => {
    const { context, calls } = createSandbox({
      siteKey: randomUUID(),
      preloadGlobal: {
        q: [
          ["identify", "queued.assertion"], // before grant -> dropped
          ["consent", "granted"], // -> 1 consent POST + 1 auto pageview
          ["identify", "queued.assertion"], // after grant -> sent
        ],
      },
    });
    runTracker(context);
    // dropped-identify (0) + granted (2) + sent-identify (1) = 3.
    expect(calls.length).toBe(3);
    const identifyCall = calls.find((c) => c.url.includes("/track/identify"));
    expect(identifyCall).toBeDefined();
    const body = JSON.parse(identifyCall!.init.body) as Record<string, unknown>;
    expect(body.assertion).toBe("queued.assertion");
  });

  it("invalid queued commands are dropped without throwing", () => {
    const { context, calls } = createSandbox({
      siteKey: randomUUID(),
      preloadGlobal: {
        q: [
          ["not_a_real_command", "x"],
          [],
          null,
          "not-an-array",
          ["consent", "granted"],
        ],
      },
    });
    expect(() => runTracker(context)).not.toThrow();
    expect(calls.length).toBe(2); // one consent + one auto pageview from the one valid command.
  });

  it("a huge pre-load queue is bounded — only the first MAX_QUEUE_REPLAY (50) commands are ever considered", () => {
    const q: unknown[] = [["consent", "granted"]];
    for (let i = 0; i < 500; i++) {
      q.push(["track", "click"]);
    }
    const { context, calls } = createSandbox({ siteKey: randomUUID(), preloadGlobal: { q } });
    runTracker(context);
    // 1 consent POST + 1 auto pageview + 49 replayed track calls (cap 50 total captured) = 51.
    expect(calls.length).toBe(51);
  });

  it("does not require a pre-load shim to function normally", () => {
    const { context, sandbox, calls } = createSandbox({ siteKey: randomUUID() });
    runTracker(context);
    expect(() => getGlobal(sandbox).consent("granted")).not.toThrow();
    expect(calls.length).toBe(2);
  });
});

describe("static source-level safety properties", () => {
  it("never touches document.cookie", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("document.cookie");
  });

  it("never installs a DOM event listener", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("addEventListener");
  });

  it("never mutates the DOM (innerHTML/appendChild/createElement)", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("innerHTML");
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("appendChild");
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("createElement");
  });

  it("never reads form/input/textarea/select values", () => {
    expect(TRACKER_SCRIPT_SOURCE.toLowerCase()).not.toContain(".value");
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("querySelector");
  });

  it("never uses MutationObserver", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("MutationObserver");
  });

  it("never monkey-patches fetch/XHR/history/console/Storage", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("XMLHttpRequest");
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("pushState");
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("replaceState");
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("console.");
  });

  it("never sends an Authorization header or credentials: include", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("Authorization");
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("credentials: 'include'");
    expect(TRACKER_SCRIPT_SOURCE).not.toContain('credentials: "include"');
  });

  it("never enumerates all storage contents", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toContain(".clear()");
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("Object.keys(localStorage)");
    expect(TRACKER_SCRIPT_SOURCE).not.toContain("Object.keys(sessionStorage)");
  });

  // Milestone 3.2E deliberately, narrowly adds identify(assertion) — an
  // opaque-string relay, never a structured identity API. This test's
  // own original name/scope ("no 3.2 scope creep") is updated to reflect
  // exactly that authorized, narrow addition rather than forbidding it
  // outright — setUser/traits/organizationId/userId/email remain
  // correctly forbidden: none of them appear anywhere in the script,
  // since identify() never accepts or constructs structured identity
  // fields, only relays an opaque string the host page already obtained
  // out of band.
  it("never references setUser/traits/organizationId/userId/email, and identify() is the only identity-shaped addition (Milestone 3.2E, opaque-string relay only)", () => {
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\bsetUser\b/);
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\btraits\b/);
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\borganizationId\b/);
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\buserId\b/);
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\bemail\b/i);
    expect(TRACKER_SCRIPT_SOURCE).not.toMatch(/\bcontactId\b/i);
  });
});
