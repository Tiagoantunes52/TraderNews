import { describe, it, expect } from "vitest";
import { isCrossOriginMutation } from "@/lib/csrf";

const HOST = "tradernews.app";

describe("isCrossOriginMutation (#23 CSRF origin check)", () => {
  it("blocks a cross-origin POST to a mutating API route", () => {
    expect(
      isCrossOriginMutation("POST", "/api/watchlist", "https://evil.example", HOST),
    ).toBe(true);
  });

  it("blocks cross-origin DELETE and PATCH too", () => {
    expect(isCrossOriginMutation("DELETE", "/api/markets", "https://evil.example", HOST)).toBe(true);
    expect(isCrossOriginMutation("PATCH", "/api/settings/alerts", "https://evil.example", HOST)).toBe(true);
  });

  it("allows a same-origin mutation (Origin host matches Host)", () => {
    expect(
      isCrossOriginMutation("POST", "/api/watchlist", `https://${HOST}`, HOST),
    ).toBe(false);
  });

  it("ignores the scheme/port-less comparison — only the host matters", () => {
    // Origin carries scheme; we compare host only, so https origin vs bare host matches.
    expect(isCrossOriginMutation("POST", "/api/markets", `https://${HOST}`, HOST)).toBe(false);
  });

  it("allows non-mutating verbs regardless of origin", () => {
    expect(isCrossOriginMutation("GET", "/api/stocks/search", "https://evil.example", HOST)).toBe(false);
    expect(isCrossOriginMutation("HEAD", "/api/watchlist", "https://evil.example", HOST)).toBe(false);
    expect(isCrossOriginMutation("OPTIONS", "/api/watchlist", "https://evil.example", HOST)).toBe(false);
  });

  it("allows requests with no Origin header (server-to-server / curl)", () => {
    expect(isCrossOriginMutation("POST", "/api/watchlist", null, HOST)).toBe(false);
  });

  it("never blocks the secret-authed pipeline routes (no browser Origin)", () => {
    expect(isCrossOriginMutation("POST", "/api/pipeline/news", "https://evil.example", HOST)).toBe(false);
    expect(isCrossOriginMutation("POST", "/api/pipeline/run", null, HOST)).toBe(false);
  });

  it("does not gate non-API paths", () => {
    expect(isCrossOriginMutation("POST", "/dashboard/watchlist", "https://evil.example", HOST)).toBe(false);
  });

  it("blocks a malformed Origin (can't prove same-origin)", () => {
    expect(isCrossOriginMutation("POST", "/api/watchlist", "null", HOST)).toBe(true);
    expect(isCrossOriginMutation("POST", "/api/watchlist", "not a url", HOST)).toBe(true);
  });
});
