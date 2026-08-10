import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logRequest, withRequestLogging } from "../app/api/v1/_shared/logger";

describe("logRequest", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits a single JSON line containing only the allowed fields", () => {
    logRequest("info", {
      method: "GET",
      route: "/api/v1/organizations",
      status: 200,
      durationMs: 12,
      actorId: "user-123",
      organizationId: "org-456",
      message: "request completed",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);

    expect(Object.keys(parsed).sort()).toEqual(
      [
        "timestamp",
        "level",
        "method",
        "route",
        "status",
        "durationMs",
        "actorId",
        "organizationId",
        "message",
      ].sort(),
    );
    expect(parsed.method).toBe("GET");
    expect(parsed.route).toBe("/api/v1/organizations");
    expect(parsed.status).toBe(200);
  });

  it("strips any field not on the explicit allowlist, even if the caller's object includes one", () => {
    const fields = {
      method: "POST",
      route: "/api/v1/consent",
      status: 201,
      durationMs: 5,
      message: "ok",
      // Not part of StructuredLogFields — simulates a caller bypassing the
      // type system (e.g. spreading a wider object). Must never reach output.
      body: { email: "someone@example.com", password: "hunter2" },
    } as unknown as Parameters<typeof logRequest>[1];

    logRequest("info", fields);

    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("body");
    expect(line).not.toContain("hunter2");
  });

  it("redacts secret-shaped content in the message field before logging", () => {
    logRequest("error", {
      method: "POST",
      route: "/api/v1/organizations",
      status: 500,
      durationMs: 3,
      message: "failed for arnousm717@gmail.com using arev_live_aaaaaaaaaa",
    });

    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("arnousm717@gmail.com");
    expect(line).not.toContain("arev_live_aaaaaaaaaa");
    expect(line).toContain("[REDACTED]");
  });

  it("never throws, even if console.log itself throws (fail-open)", () => {
    logSpy.mockImplementation(() => {
      throw new Error("sink unavailable");
    });

    expect(() =>
      logRequest("info", {
        method: "GET",
        route: "/api/v1/health",
        status: 200,
        durationMs: 1,
        message: "ok",
      }),
    ).not.toThrow();
  });

  it("never throws on a circular-reference payload that JSON.stringify would reject", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      logRequest("error", {
        method: "GET",
        route: "/api/v1/health",
        status: 500,
        durationMs: 1,
        message: "boom",
        // errorType isn't typed as accepting an object, but a thrown value's
        // shape can't always be trusted at a boundary like this — the
        // fail-open guarantee must hold regardless.
        errorType: circular as unknown as string,
      }),
    ).not.toThrow();
  });
});

describe("withRequestLogging", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("returns the wrapped handler's real response unchanged on success", async () => {
    const handler = async () => Response.json({ ok: true }, { status: 200 });
    const wrapped = withRequestLogging("GET", "/api/v1/health", handler);

    const response = await wrapped();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.status).toBe(200);
    expect(parsed.level).toBe("info");
  });

  it("logs at error level for a 5xx response without altering the response", async () => {
    const handler = async () => Response.json({ error: "boom" }, { status: 500 });
    const wrapped = withRequestLogging("POST", "/api/v1/organizations", handler);

    const response = await wrapped();

    expect(response.status).toBe(500);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.level).toBe("error");
  });

  it("logs the failure and still re-throws when the handler itself throws", async () => {
    const handler = async () => {
      throw new TypeError("unexpected failure");
    };
    const wrapped = withRequestLogging("GET", "/api/v1/organizations", handler);

    await expect(wrapped()).rejects.toThrow("unexpected failure");
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.status).toBe(500);
    expect(parsed.errorType).toBe("TypeError");
  });

  it("does not change the real result even if the logging call itself throws (fail-open)", async () => {
    logSpy.mockImplementation(() => {
      throw new Error("sink unavailable");
    });
    const handler = async () => Response.json({ ok: true }, { status: 200 });
    const wrapped = withRequestLogging("GET", "/api/v1/health", handler);

    const response = await wrapped();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("passes through the handler's own arguments unchanged", async () => {
    const handler = vi.fn(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
      const { id } = await ctx.params;
      return Response.json({ id, url: request.url });
    });
    const wrapped = withRequestLogging("GET", "/api/v1/data-subject-requests/[id]", handler);

    const request = new Request("https://example.com/api/v1/data-subject-requests/abc");
    const response = await wrapped(request, { params: Promise.resolve({ id: "abc" }) });

    expect(await response.json()).toEqual({ id: "abc", url: "https://example.com/api/v1/data-subject-requests/abc" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
