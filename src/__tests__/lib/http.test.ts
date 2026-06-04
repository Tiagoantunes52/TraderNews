import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithRetry } from "@/lib/http";

afterEach(() => vi.restoreAllMocks());

function res(status: number): Response {
  return new Response(status === 204 ? null : "body", { status });
}

describe("fetchWithRetry", () => {
  it("returns the response on first success", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(res(200));
    const r = await fetchWithRetry("https://x.test", {}, { retryDelayMs: 0 });
    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries on a transport rejection ('fetch failed') and then succeeds", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(res(200));
    const r = await fetchWithRetry("https://x.test", {}, { retryDelayMs: 0 });
    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting attempts on persistent transport failure", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchWithRetry("https://x.test", {}, { attempts: 3, retryDelayMs: 0 })).rejects.toThrow("fetch failed");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("retries on 5xx and returns the eventual success", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200));
    const r = await fetchWithRetry("https://x.test", {}, { retryDelayMs: 0 });
    expect(r.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx (e.g. 403 permission, 429 rate limit)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(res(403));
    const r = await fetchWithRetry("https://x.test", {}, { retryDelayMs: 0 });
    expect(r.status).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1); // returned for the caller's own !res.ok handling
  });

  it("returns the last 5xx response when retries are exhausted", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(res(500));
    const r = await fetchWithRetry("https://x.test", {}, { attempts: 2, retryDelayMs: 0 });
    expect(r.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("passes through init and attaches an abort signal", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(res(200));
    await fetchWithRetry("https://x.test", { headers: { "X-Test": "1" } }, { retryDelayMs: 0 });
    const init = spy.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)["X-Test"]).toBe("1");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
