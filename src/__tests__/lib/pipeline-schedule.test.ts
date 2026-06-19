import { describe, it, expect } from "vitest";
import { nextDailyRefresh, nextPerformanceRefresh } from "@/lib/pipeline-schedule";

describe("nextDailyRefresh()", () => {
  it("returns the next 00:00 UTC", () => {
    expect(nextDailyRefresh(new Date("2026-06-19T10:30:00.000Z")).toISOString()).toBe(
      "2026-06-20T00:00:00.000Z"
    );
  });

  it("rolls to tomorrow when called exactly at midnight UTC", () => {
    expect(nextDailyRefresh(new Date("2026-06-19T00:00:00.000Z")).toISOString()).toBe(
      "2026-06-20T00:00:00.000Z"
    );
  });

  it("crosses month boundaries", () => {
    expect(nextDailyRefresh(new Date("2026-06-30T23:59:59.000Z")).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z"
    );
  });
});

describe("nextPerformanceRefresh()", () => {
  it("targets 20:00 UTC on a summer (EDT) weekday before the close", () => {
    // 2026-06-19 is a Friday in EDT.
    expect(nextPerformanceRefresh(new Date("2026-06-19T10:00:00.000Z")).toISOString()).toBe(
      "2026-06-19T20:00:00.000Z"
    );
  });

  it("targets 21:00 UTC on a winter (EST) weekday before the close", () => {
    // 2026-01-15 is a Thursday in EST.
    expect(nextPerformanceRefresh(new Date("2026-01-15T10:00:00.000Z")).toISOString()).toBe(
      "2026-01-15T21:00:00.000Z"
    );
  });

  it("skips to Monday's close after a Friday close", () => {
    // Friday 2026-06-19 20:00 UTC is the close; next is Monday 2026-06-22.
    expect(nextPerformanceRefresh(new Date("2026-06-19T20:00:00.000Z")).toISOString()).toBe(
      "2026-06-22T20:00:00.000Z"
    );
  });

  it("skips the weekend entirely", () => {
    // Saturday 2026-06-20 → next weekday close is Monday 2026-06-22 (EDT).
    expect(nextPerformanceRefresh(new Date("2026-06-20T12:00:00.000Z")).toISOString()).toBe(
      "2026-06-22T20:00:00.000Z"
    );
  });

  it("is always a strictly-future weekday close at 20:00 or 21:00 UTC", () => {
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 400; i++) {
      const from = new Date(start + i * 17 * 60 * 60 * 1000); // step ~17h across a year
      const next = nextPerformanceRefresh(from);
      expect(next.getTime()).toBeGreaterThan(from.getTime());
      const dow = next.getUTCDay();
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
      expect([20, 21]).toContain(next.getUTCHours());
      expect(next.getUTCMinutes()).toBe(0);
    }
  });
});
