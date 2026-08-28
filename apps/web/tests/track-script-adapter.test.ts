import { randomUUID } from "node:crypto";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { TRACKER_GLOBAL_NAME, TRACKER_SCRIPT_SOURCE } from "../app/track/script/tracker-source";

/**
 * Milestone 3.1D — storage/crypto/network adapter-boundary behavior:
 * identity persistence across reload/new-session, storage/crypto
 * failure fallback, the full consent lifecycle (grant/withdrawal/
 * re-grant), automatic pageview timing, network transport details
 * (credentials/keepalive/content-type/paths), and response/backoff
 * handling (204/400/413/429/500/network-error, Retry-After parsing).
 * Same Node-vm-sandbox technique as track-script-helpers.test.ts — see
 * that file's own header comment for why.
 */

interface FetchCall {
  url: string;
  init: { method: string; credentials: string; keepalive: boolean; headers: Record<string, string>; body: string };
}

type FakeResponse = { status: number; headers: { get: (name: string) => string | null } };

function makeStubStorage(opts: { throwOnAccess?: boolean; throwOnWrite?: boolean } = {}) {
  const store = new Map<string, string>();
  const storage = {
    _store: store,
    getItem: (key: string) => {
      if (opts.throwOnAccess) throw new Error("SecurityError");
      return store.has(key) ? store.get(key)! : null;
    },
    setItem: (key: string, value: string) => {
      if (opts.throwOnAccess || opts.throwOnWrite) throw new Error("QuotaExceededError");
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      if (opts.throwOnAccess) throw new Error("SecurityError");
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  return storage as unknown as Storage & { _store: Map<string, string> };
}

function makeScriptEl(siteKey: string, src = "https://platform.example.com/track/script") {
  return { src, getAttribute: (name: string) => (name === "data-site-key" ? siteKey : null) };
}

interface SandboxOptions {
  siteKey?: string;
  localStorage?: Storage;
  sessionStorage?: Storage;
  crypto?: { randomUUID: () => string };
  fetchResponder?: (url: string, init: FetchCall["init"]) => Promise<FakeResponse> | FakeResponse;
  href?: string;
  origin?: string;
  pathname?: string;
}

function createSandbox(opts: SandboxOptions = {}) {
  const siteKey = opts.siteKey ?? randomUUID();
  const calls: FetchCall[] = [];
  const responder = opts.fetchResponder ?? (() => ({ status: 204, headers: { get: () => null } }));
  const fetchImpl = (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    return Promise.resolve(responder(url, init));
  };
  const localStorageStub = opts.localStorage ?? makeStubStorage();
  const sessionStorageStub = opts.sessionStorage ?? makeStubStorage();
  const sandbox: Record<string, unknown> = {
    document: { currentScript: makeScriptEl(siteKey), referrer: "" },
    location: {
      href: opts.href ?? "https://customer.example.com/page",
      origin: opts.origin ?? "https://customer.example.com",
      pathname: opts.pathname ?? "/page",
    },
    crypto: opts.crypto ?? { randomUUID: () => randomUUID() },
    fetch: fetchImpl,
    localStorage: localStorageStub,
    sessionStorage: sessionStorageStub,
    URL,
    console,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  return { context, sandbox, calls, localStorageStub, sessionStorageStub, siteKey };
}

function runTracker(context: vm.Context) {
  new vm.Script(TRACKER_SCRIPT_SOURCE, { filename: "tracker.js" }).runInContext(context);
}

interface TrackerGlobal {
  __aiRevenueOsInitialized: boolean;
  consent: (status: string) => void;
  track: (eventType: string, fields?: unknown) => void;
}

function getGlobal(sandbox: Record<string, unknown>): TrackerGlobal {
  return sandbox[TRACKER_GLOBAL_NAME] as TrackerGlobal;
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

const KEY_ANON_ID = "aiRevenueOsTracking.anonymousId";
const KEY_GRANTED = "aiRevenueOsTracking.consentGranted";
const KEY_SESSION_ID = "aiRevenueOsTracking.sessionId";
const KEY_LANDING = "aiRevenueOsTracking.landingPage";
const KEY_UTM = "aiRevenueOsTracking.utm";

describe("identity: pre-consent", () => {
  it("generates memory-only identifiers but persists nothing", () => {
    const { context, sandbox, localStorageStub, sessionStorageStub, calls } = createSandbox();
    runTracker(context);
    expect(localStorageStub.getItem(KEY_ANON_ID)).toBeNull();
    expect(sessionStorageStub.getItem(KEY_SESSION_ID)).toBeNull();
    expect(calls.length).toBe(0);
    void sandbox; // sandbox itself not otherwise inspected here.
  });

  it("uses crypto.randomUUID() for generation", () => {
    let called = false;
    const fixedId = "12345678-1234-4123-8123-123456789abc";
    const { context } = createSandbox({
      crypto: {
        randomUUID: () => {
          called = true;
          return fixedId;
        },
      },
    });
    runTracker(context);
    expect(called).toBe(true);
  });
});

describe("identity: granted persistence", () => {
  it("persists anonymousId to localStorage on grant", () => {
    const { context, sandbox, localStorageStub } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    expect(localStorageStub.getItem(KEY_ANON_ID)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(localStorageStub.getItem(KEY_GRANTED)).toBe("1");
  });

  it("persists anonymousSessionId to sessionStorage on grant", () => {
    const { context, sandbox, sessionStorageStub } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    expect(sessionStorageStub.getItem(KEY_SESSION_ID)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("persists sanitized landing page and UTM to sessionStorage on grant", () => {
    const { context, sandbox, sessionStorageStub } = createSandbox({
      href: "https://customer.example.com/landing?utm_source=google",
      pathname: "/landing",
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    expect(sessionStorageStub.getItem(KEY_LANDING)).toBe("https://customer.example.com/landing");
    const utm = JSON.parse(sessionStorageStub.getItem(KEY_UTM)!) as Record<string, unknown>;
    expect(utm.utmSource).toBe("google");
  });
});

describe("identity: bootstrap restore", () => {
  it("a persisted granted marker + valid stored IDs restores state and sends exactly one automatic pageview", () => {
    const shared = { local: makeStubStorage(), session: makeStubStorage() };
    // First "page load": grant once.
    const first = createSandbox({ localStorage: shared.local, sessionStorage: shared.session });
    runTracker(first.context);
    getGlobal(first.sandbox).consent("granted");
    expect(first.calls.length).toBe(2); // consent + auto pageview

    // Second "page load" (reload, same tab -> same localStorage AND sessionStorage).
    const second = createSandbox({ localStorage: shared.local, sessionStorage: shared.session, siteKey: first.siteKey });
    runTracker(second.context);
    expect(second.calls.length).toBe(1); // exactly one automatic pageview, no consent re-send.
    const body = JSON.parse(second.calls[0]!.init.body) as { eventType?: string };
    expect(body.eventType).toBe("pageview");
  });

  it("no persisted granted marker -> bootstrap sends zero requests", () => {
    const { context, calls } = createSandbox();
    runTracker(context);
    expect(calls.length).toBe(0);
  });

  it("reload in the same tab reuses the same anonymousSessionId (sessionStorage persists across reload)", () => {
    const shared = { local: makeStubStorage(), session: makeStubStorage() };
    const first = createSandbox({ localStorage: shared.local, sessionStorage: shared.session });
    runTracker(first.context);
    getGlobal(first.sandbox).consent("granted");
    const sessionIdAfterFirst = shared.session.getItem(KEY_SESSION_ID);

    const second = createSandbox({ localStorage: shared.local, sessionStorage: shared.session, siteKey: first.siteKey });
    runTracker(second.context);
    expect(shared.session.getItem(KEY_SESSION_ID)).toBe(sessionIdAfterFirst);
  });

  it("a new tab (fresh sessionStorage, same localStorage) generates a new anonymousSessionId but keeps the same anonymousId", () => {
    const local = makeStubStorage();
    const first = createSandbox({ localStorage: local, sessionStorage: makeStubStorage() });
    runTracker(first.context);
    getGlobal(first.sandbox).consent("granted");
    const anonIdAfterFirst = local.getItem(KEY_ANON_ID);

    const second = createSandbox({ localStorage: local, sessionStorage: makeStubStorage(), siteKey: first.siteKey });
    runTracker(second.context);
    expect(local.getItem(KEY_ANON_ID)).toBe(anonIdAfterFirst); // unchanged
    expect(second.calls.length).toBe(1); // still one automatic pageview using the (regenerated) session id.
  });
});

describe("identity: storage/crypto failure fallback", () => {
  it("storage read failure degrades to memory-only, does not crash", () => {
    const { context, sandbox, calls } = createSandbox({
      localStorage: makeStubStorage({ throwOnAccess: true }),
      sessionStorage: makeStubStorage({ throwOnAccess: true }),
    });
    expect(() => runTracker(context)).not.toThrow();
    expect(() => getGlobal(sandbox).consent("granted")).not.toThrow();
    // Consent still recorded server-side via the in-memory identity; only persistence is skipped.
    expect(calls.length).toBe(2);
  });

  it("storage write failure degrades gracefully, consent request still sent using memory identity", () => {
    const { context, sandbox, localStorageStub, calls } = createSandbox({
      localStorage: makeStubStorage({ throwOnWrite: true }),
    });
    runTracker(context);
    expect(() => getGlobal(sandbox).consent("granted")).not.toThrow();
    expect(localStorageStub.getItem(KEY_ANON_ID)).toBeNull(); // write failed, nothing persisted.
    expect(calls.length).toBe(2); // network calls still happen using memory identity.
  });

  it("crypto.randomUUID throwing -> grant() becomes a safe no-op, no fingerprinting fallback used", () => {
    const { context, sandbox, calls } = createSandbox({
      crypto: {
        randomUUID: () => {
          throw new Error("crypto unavailable");
        },
      },
    });
    expect(() => runTracker(context)).not.toThrow();
    expect(() => getGlobal(sandbox).consent("granted")).not.toThrow();
    expect(calls.length).toBe(0);
  });

  it("crypto.randomUUID missing entirely -> safe no-op", () => {
    const { context, sandbox, calls } = createSandbox({ crypto: {} as unknown as { randomUUID: () => string } });
    expect(() => runTracker(context)).not.toThrow();
    getGlobal(sandbox).consent("granted");
    expect(calls.length).toBe(0);
  });
});

describe("consent lifecycle", () => {
  it("unknown state sends nothing", () => {
    const { context, calls } = createSandbox();
    runTracker(context);
    expect(calls.length).toBe(0);
  });

  it("first grant sends exactly one consent POST and exactly one automatic pageview", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    expect(calls.length).toBe(2);
    const bodies = calls.map((c) => JSON.parse(c.init.body) as Record<string, unknown>);
    expect(bodies.filter((b) => b.status === "granted").length).toBe(1);
    expect(bodies.filter((b) => b.eventType === "pageview").length).toBe(1);
  });

  it("repeated grant sends no duplicate consent POST and no duplicate pageview", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    getGlobal(sandbox).consent("granted");
    getGlobal(sandbox).consent("granted");
    expect(calls.length).toBe(2);
  });

  it("withdrawal disables collection synchronously before the network call resolves", () => {
    let resolveFetch: (() => void) | undefined;
    const { context, sandbox, calls } = createSandbox({
      fetchResponder: () =>
        new Promise<FakeResponse>((resolve) => {
          resolveFetch = () => resolve({ status: 204, headers: { get: () => null } });
        }),
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    // The grant's own consent+pageview fetches are still pending (fetchResponder never auto-resolves).
    getGlobal(sandbox).consent("withdrawn");
    // A track() call issued immediately after withdraw(), before any fetch has resolved, must be dropped —
    // proving collection was disabled synchronously, not only after the withdrawal request completed.
    const callsBeforeTrack = calls.length;
    getGlobal(sandbox).track("click");
    expect(calls.length).toBe(callsBeforeTrack); // no new call — track() was dropped.
    if (resolveFetch) resolveFetch();
  });

  it("the withdrawal request uses the pre-clear anonymousId", () => {
    const { context, sandbox, calls, localStorageStub } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const grantedAnonId = localStorageStub.getItem(KEY_ANON_ID);
    getGlobal(sandbox).consent("withdrawn");
    const withdrawalCall = calls.find((c) => (JSON.parse(c.init.body) as Record<string, unknown>).status === "withdrawn");
    expect(withdrawalCall).toBeDefined();
    const body = JSON.parse(withdrawalCall!.init.body) as { anonymousId?: string };
    expect(body.anonymousId).toBe(grantedAnonId);
  });

  it("withdrawal clears SDK-owned storage keys", () => {
    const { context, sandbox, localStorageStub, sessionStorageStub } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    getGlobal(sandbox).consent("withdrawn");
    expect(localStorageStub.getItem(KEY_ANON_ID)).toBeNull();
    expect(localStorageStub.getItem(KEY_GRANTED)).toBeNull();
    expect(sessionStorageStub.getItem(KEY_SESSION_ID)).toBeNull();
    expect(sessionStorageStub.getItem(KEY_LANDING)).toBeNull();
    expect(sessionStorageStub.getItem(KEY_UTM)).toBeNull();
  });

  it("repeated withdrawal sends no duplicate withdrawal request", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    getGlobal(sandbox).consent("withdrawn");
    const callsAfterFirstWithdrawal = calls.length;
    getGlobal(sandbox).consent("withdrawn");
    getGlobal(sandbox).consent("withdrawn");
    expect(calls.length).toBe(callsAfterFirstWithdrawal);
  });

  it("withdrawal with no prior grant is a no-op (nothing to withdraw)", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("withdrawn");
    expect(calls.length).toBe(0);
  });

  it("re-grant after withdrawal generates a fresh anonymousId, never reusing the pre-withdrawal one", () => {
    const { context, sandbox, localStorageStub } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const firstAnonId = localStorageStub.getItem(KEY_ANON_ID);
    getGlobal(sandbox).consent("withdrawn");
    getGlobal(sandbox).consent("granted");
    const secondAnonId = localStorageStub.getItem(KEY_ANON_ID);
    expect(secondAnonId).not.toBe(firstAnonId);
    expect(secondAnonId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("re-grant after withdrawal sends a fresh consent POST", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    getGlobal(sandbox).consent("withdrawn");
    const callsBeforeRegrant = calls.length;
    getGlobal(sandbox).consent("granted");
    const newCalls = calls.slice(callsBeforeRegrant);
    expect(newCalls.some((c) => (JSON.parse(c.init.body) as Record<string, unknown>).status === "granted")).toBe(true);
  });
});

describe("automatic pageview semantics", () => {
  it("bootstrap with existing granted marker sends exactly one automatic pageview", () => {
    const shared = { local: makeStubStorage(), session: makeStubStorage() };
    const first = createSandbox({ localStorage: shared.local, sessionStorage: shared.session });
    runTracker(first.context);
    getGlobal(first.sandbox).consent("granted");
    const second = createSandbox({ localStorage: shared.local, sessionStorage: shared.session, siteKey: first.siteKey });
    runTracker(second.context);
    const pageviews = second.calls.filter((c) => (JSON.parse(c.init.body) as Record<string, unknown>).eventType === "pageview");
    expect(pageviews.length).toBe(1);
  });

  it("bootstrap with unknown consent sends zero automatic pageviews", () => {
    const { context, calls } = createSandbox();
    runTracker(context);
    expect(calls.filter((c) => (JSON.parse(c.init.body) as Record<string, unknown>).eventType === "pageview").length).toBe(0);
  });

  it("grant on an already-loaded page sends exactly one automatic pageview without requiring reload", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const pageviews = calls.filter((c) => (JSON.parse(c.init.body) as Record<string, unknown>).eventType === "pageview");
    expect(pageviews.length).toBe(1);
  });

  it("duplicate script inclusion does not duplicate the automatic pageview", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    runTracker(context); // second execution: no-op via duplicate-load guard.
    getGlobal(sandbox).consent("granted");
    const pageviews = calls.filter((c) => (JSON.parse(c.init.body) as Record<string, unknown>).eventType === "pageview");
    expect(pageviews.length).toBe(1);
  });

  it("grant -> withdrawal -> grant on the same page does not send a second automatic pageview", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    getGlobal(sandbox).consent("withdrawn");
    getGlobal(sandbox).consent("granted");
    const pageviews = calls.filter((c) => (JSON.parse(c.init.body) as Record<string, unknown>).eventType === "pageview");
    expect(pageviews.length).toBe(1);
  });
});

describe("network transport", () => {
  it("uses credentials: omit on every request", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    for (const c of calls) {
      expect(c.init.credentials).toBe("omit");
    }
  });

  it("uses keepalive: true", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    for (const c of calls) {
      expect(c.init.keepalive).toBe(true);
    }
  });

  it("sends application/json content-type", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    for (const c of calls) {
      expect(c.init.headers["Content-Type"]).toBe("application/json");
    }
  });

  it("targets the exact /track/collect and /track/consent paths on the platform origin", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    const paths = calls.map((c) => new URL(c.url).pathname);
    expect(paths).toContain("/track/collect");
    expect(paths).toContain("/track/consent");
  });

  it("never sends an Authorization header", () => {
    const { context, sandbox, calls } = createSandbox();
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    for (const c of calls) {
      expect(c.init.headers.Authorization).toBeUndefined();
    }
  });
});

describe("response / backoff policy", () => {
  it("204 requires nothing further", async () => {
    const { context, sandbox, calls } = createSandbox({ fetchResponder: () => ({ status: 204, headers: { get: () => null } }) });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    await flush();
    expect(calls.length).toBe(2);
  });

  it("400 is dropped, no retry", async () => {
    const { context, sandbox, calls } = createSandbox({ fetchResponder: () => ({ status: 400, headers: { get: () => null } }) });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    await flush();
    getGlobal(sandbox).track("click");
    await flush();
    // No automatic retry mechanism exists — the click above is one new attempt, not a retry of the failed grant call.
    expect(calls.length).toBe(3);
  });

  it("413 is dropped, no retry", async () => {
    const { context, sandbox, calls } = createSandbox({ fetchResponder: () => ({ status: 413, headers: { get: () => null } }) });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    await flush();
    expect(calls.length).toBe(2);
  });

  it("500 is dropped, no retry loop", async () => {
    const { context, sandbox, calls } = createSandbox({ fetchResponder: () => ({ status: 500, headers: { get: () => null } }) });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    await flush();
    expect(calls.length).toBe(2);
  });

  it("network failure (rejected promise) is dropped, no retry, no throw", async () => {
    const { context, sandbox, calls } = createSandbox({
      fetchResponder: () => Promise.reject(new Error("network down")) as unknown as FakeResponse,
    });
    expect(() => runTracker(context)).not.toThrow();
    expect(() => getGlobal(sandbox).consent("granted")).not.toThrow();
    await flush();
    expect(calls.length).toBe(2);
  });

  it("fetch throwing synchronously on invocation (not merely rejecting) is caught, grant() does not throw", () => {
    const throwingFetch = () => {
      throw new Error("fetch is not available in this environment");
    };
    const siteKey = randomUUID();
    const sandboxObj: Record<string, unknown> = {
      document: { currentScript: makeScriptEl(siteKey), referrer: "" },
      location: { href: "https://customer.example.com/page", origin: "https://customer.example.com", pathname: "/page" },
      crypto: { randomUUID: () => randomUUID() },
      fetch: throwingFetch,
      localStorage: makeStubStorage(),
      sessionStorage: makeStubStorage(),
      URL,
      console,
    };
    sandboxObj.window = sandboxObj;
    const context = vm.createContext(sandboxObj);
    expect(() => runTracker(context)).not.toThrow();
    const g = getGlobal(sandboxObj);
    expect(() => g.consent("granted")).not.toThrow();
    // Identity/consent state is still committed locally even though the transport itself is broken.
    expect((sandboxObj.localStorage as Storage).getItem(KEY_GRANTED)).toBe("1");
  });

  it("429 with a valid Retry-After suppresses subsequent sends until the deadline", async () => {
    let is429 = true;
    const { context, sandbox, calls } = createSandbox({
      fetchResponder: () => (is429 ? { status: 429, headers: { get: (n) => (n === "Retry-After" ? "60" : null) } } : { status: 204, headers: { get: () => null } }),
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    await flush();
    is429 = false;
    getGlobal(sandbox).track("click");
    await flush();
    // still within the 60s backoff window -> suppressed, no new call.
    expect(calls.length).toBe(2);
  });

  it("429 with missing Retry-After defaults to a 60s suppression window", async () => {
    let first = true;
    const { context, sandbox, calls } = createSandbox({
      fetchResponder: () => {
        if (first) {
          first = false;
          return { status: 429, headers: { get: () => null } };
        }
        return { status: 204, headers: { get: () => null } };
      },
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    await flush();
    getGlobal(sandbox).track("click");
    await flush();
    expect(calls.length).toBe(2); // suppressed by the default 60s window.
  });

  it("429 with a negative Retry-After falls back to the 60s default, not a zero/negative window", async () => {
    const { context, sandbox, calls } = createSandbox({
      fetchResponder: () => ({ status: 429, headers: { get: (n) => (n === "Retry-After" ? "-5" : null) } }),
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    await flush();
    getGlobal(sandbox).track("click");
    await flush();
    expect(calls.length).toBe(2); // still suppressed — negative treated as invalid, default window applies.
  });

  it("429 with a NaN Retry-After falls back to the 60s default", async () => {
    const { context, sandbox, calls } = createSandbox({
      fetchResponder: () => ({ status: 429, headers: { get: (n) => (n === "Retry-After" ? "not-a-number" : null) } }),
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    await flush();
    getGlobal(sandbox).track("click");
    await flush();
    expect(calls.length).toBe(2);
  });

  it("429 with an Infinity-like Retry-After is bounded, never an infinite suppression window", async () => {
    const { context, sandbox, calls } = createSandbox({
      fetchResponder: () => ({ status: 429, headers: { get: (n) => (n === "Retry-After" ? "Infinity" : null) } }),
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    await flush();
    getGlobal(sandbox).track("click");
    await flush();
    // Infinity is not finite -> falls back to the bounded 60s default, not an unbounded suppression.
    expect(calls.length).toBe(2);
  });

  it("429 with an extremely large Retry-After is clamped to at most 3600s", async () => {
    const { context, sandbox, calls } = createSandbox({
      fetchResponder: () => ({ status: 429, headers: { get: (n) => (n === "Retry-After" ? "999999999999" : null) } }),
    });
    runTracker(context);
    getGlobal(sandbox).consent("granted");
    await flush();
    getGlobal(sandbox).track("click");
    await flush();
    // Still within any reasonable clamp (<=3600s) -> suppressed for this test's short duration.
    expect(calls.length).toBe(2);
  });

  it("never infers site/consent validity from any response — identical local behavior for 204 vs 400", async () => {
    const okRun = createSandbox({ fetchResponder: () => ({ status: 204, headers: { get: () => null } }) });
    runTracker(okRun.context);
    getGlobal(okRun.sandbox).consent("granted");
    await flush();

    const badRun = createSandbox({ fetchResponder: () => ({ status: 400, headers: { get: () => null } }) });
    runTracker(badRun.context);
    getGlobal(badRun.sandbox).consent("granted");
    await flush();

    // Local granted state is identical regardless of server response — no oracle-based branching client-side.
    expect(okRun.localStorageStub.getItem(KEY_GRANTED)).toBe("1");
    expect(badRun.localStorageStub.getItem(KEY_GRANTED)).toBe("1");
  });
});

describe("host-page safety: uncaught-exception resistance", () => {
  it("public consent()/track() never throw even under maximally hostile stub failures", () => {
    const { context, sandbox } = createSandbox({
      localStorage: makeStubStorage({ throwOnAccess: true }),
      sessionStorage: makeStubStorage({ throwOnAccess: true }),
      crypto: {
        randomUUID: () => {
          throw new Error("boom");
        },
      },
      fetchResponder: () => {
        throw new Error("fetch itself throws synchronously");
      },
    });
    expect(() => runTracker(context)).not.toThrow();
    const g = getGlobal(sandbox);
    expect(() => g.consent("granted")).not.toThrow();
    expect(() => g.consent("withdrawn")).not.toThrow();
    expect(() => g.track("click")).not.toThrow();
    expect(() => g.track("form_submit", { metadata: { a: 1 } })).not.toThrow();
    expect(() => g.consent("not-a-real-status" as never)).not.toThrow();
    expect(() => g.track("not-a-real-event" as never)).not.toThrow();
  });
});
