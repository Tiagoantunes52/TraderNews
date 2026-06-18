import { describe, it, expect } from "vitest";
import { enforceRateLimit, isRateLimitConfigured } from "@/lib/rate-limit";

// The test env has no Upstash credentials, so the limiter is unconfigured. The
// safety contract is "fail open": never block a request when Upstash is absent or
// down. (The enabled path is exercised by Upstash's own library + a configured env.)
describe("rate-limit (unconfigured = fail open)", () => {
  it("reports as not configured without Upstash env vars", () => {
    expect(isRateLimitConfigured()).toBe(false);
  });

  it("allows the request (returns null) for every bucket when unconfigured", async () => {
    expect(await enforceRateLimit("search", "user-1")).toBeNull();
    expect(await enforceRateLimit("mutation", "user-1")).toBeNull();
  });
});
