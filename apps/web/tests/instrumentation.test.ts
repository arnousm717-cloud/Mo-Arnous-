import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureRequestError = vi.fn();
const flush = vi.fn();
const lastEventId = vi.fn();

vi.mock("@sentry/nextjs", () => ({
  captureRequestError: (...args: unknown[]) => captureRequestError(...args),
  flush: (...args: unknown[]) => flush(...args),
  lastEventId: (...args: unknown[]) => lastEventId(...args),
}));

const errorContext = { routerKind: "App Router", routePath: "/api/v1/health", routeType: "route" } as const;
const requestInfo = { path: "/api/v1/health", method: "GET", headers: {} };

describe("instrumentation.onRequestError", () => {
  beforeEach(() => {
    captureRequestError.mockReset();
    flush.mockReset();
    flush.mockResolvedValue(true);
    lastEventId.mockReset();
    lastEventId.mockReturnValue("test-event-id-123");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("never throws, even when Sentry.captureRequestError itself throws", async () => {
    captureRequestError.mockImplementation(() => {
      throw new Error("sentry capture failed");
    });
    const { onRequestError } = await import("../instrumentation");

    await expect(
      onRequestError(new Error("original route error"), requestInfo, errorContext),
    ).resolves.toBeUndefined();
  });

  // Regression test for a real production bug (M1.8): on a Vercel Node.js
  // Serverless Function, @sentry/nextjs's own automatic post-response flush
  // silently no-ops (its vercelWaitUntil() only acts when
  // `typeof EdgeRuntime === "string"`, which is only true in Vercel Edge
  // Runtime) — the event gets captured but never delivered before the
  // function freezes. Awaiting flush() explicitly here is the fix; this
  // test guards against that await ever being silently dropped again.
  it("awaits Sentry.flush() with a bounded timeout after capturing the error", async () => {
    const { onRequestError } = await import("../instrumentation");

    await onRequestError(new Error("original route error"), requestInfo, errorContext);

    expect(captureRequestError).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(2000);
  });

  it("never throws, even when Sentry.flush() itself throws", async () => {
    flush.mockImplementation(() => {
      throw new Error("flush failed");
    });
    const { onRequestError } = await import("../instrumentation");

    await expect(
      onRequestError(new Error("original route error"), requestInfo, errorContext),
    ).resolves.toBeUndefined();
  });

  it("never throws, even when Sentry.flush() rejects", async () => {
    flush.mockRejectedValue(new Error("flush timed out"));
    const { onRequestError } = await import("../instrumentation");

    await expect(
      onRequestError(new Error("original route error"), requestInfo, errorContext),
    ).resolves.toBeUndefined();
  });
});
