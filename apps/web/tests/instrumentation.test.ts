import { describe, expect, it, vi } from "vitest";

// Fail-open guarantee for the onRequestError hook (M1.8 requirement):
// Sentry.captureRequestError throwing must never propagate out of the
// hook, since Next.js treats this as a reporting side-channel called
// after it has already decided the actual error response.
vi.mock("@sentry/nextjs", () => ({
  captureRequestError: () => {
    throw new Error("sentry capture failed");
  },
}));

describe("instrumentation.onRequestError", () => {
  it("never throws, even when Sentry.captureRequestError itself throws", async () => {
    const { onRequestError } = await import("../instrumentation");

    await expect(
      onRequestError(
        new Error("original route error"),
        { path: "/api/v1/health", method: "GET", headers: {} },
        { routerKind: "App Router", routePath: "/api/v1/health", routeType: "route" },
      ),
    ).resolves.toBeUndefined();
  });
});
