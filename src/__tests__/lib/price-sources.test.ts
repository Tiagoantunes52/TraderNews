import { describe, it, expect } from "vitest";
import { getDailyPrices, type PriceSource } from "@/lib/price-sources";
import type { DailyPrice } from "@/lib/tiingo-prices";

function rows(n: number): DailyPrice[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-05-${String(i + 1).padStart(2, "0")}`,
    close: 100 + i,
    volume: 1000,
    high: 101 + i,
    low: 99 + i,
  }));
}

const src = (
  name: string,
  opts: { configured?: boolean; supports?: (t: string) => boolean; fetch: PriceSource["fetch"] }
): PriceSource => ({
  name,
  configured: () => opts.configured ?? true,
  supports: opts.supports ?? (() => true),
  fetch: opts.fetch,
});

describe("getDailyPrices", () => {
  it("returns data from the first source that yields usable rows", async () => {
    const a = src("A", { fetch: async () => rows(10) });
    const b = src("B", { fetch: async () => rows(20) });
    const res = await getDailyPrices("AAPL", new Date(), [a, b]);
    expect(res.provider).toBe("A");
    expect(res.prices).toHaveLength(10);
    expect(res.errors).toEqual([]);
  });

  it("falls back when the first source returns too few points", async () => {
    const primary = src("Primary", { fetch: async () => rows(1) }); // below MIN_POINTS
    const fallback = src("Fallback", { fetch: async () => rows(30) });
    const res = await getDailyPrices("JMT.LS", new Date(), [primary, fallback]);
    expect(res.provider).toBe("Fallback");
    expect(res.prices).toHaveLength(30);
  });

  it("falls back when the first source throws, recording the error", async () => {
    const primary = src("Primary", {
      fetch: async () => {
        throw new Error("503");
      },
    });
    const fallback = src("Fallback", { fetch: async () => rows(30) });
    const res = await getDailyPrices("AAPL", new Date(), [primary, fallback]);
    expect(res.provider).toBe("Fallback");
    expect(res.errors.some((e) => e.includes("Primary prices failed") && e.includes("503"))).toBe(true);
  });

  it("skips sources that do not support the ticker", async () => {
    let primaryCalled = false;
    const primary = src("Primary", {
      supports: (t) => !t.includes("."), // US/crypto only
      fetch: async () => {
        primaryCalled = true;
        return rows(10);
      },
    });
    const fallback = src("Fallback", { fetch: async () => rows(30) });
    const res = await getDailyPrices("ENEL.MI", new Date(), [primary, fallback]);
    expect(primaryCalled).toBe(false);
    expect(res.provider).toBe("Fallback");
  });

  it("skips unconfigured sources", async () => {
    const off = src("Off", { configured: false, fetch: async () => rows(50) });
    const on = src("On", { fetch: async () => rows(10) });
    const res = await getDailyPrices("AAPL", new Date(), [off, on]);
    expect(res.provider).toBe("On");
  });

  it("returns an empty result with no provider when nothing works", async () => {
    const a = src("A", { fetch: async () => rows(1) });
    const b = src("B", {
      fetch: async () => {
        throw new Error("nope");
      },
    });
    const res = await getDailyPrices("AAPL", new Date(), [a, b]);
    expect(res.provider).toBeNull();
    expect(res.prices).toEqual([]);
    expect(res.errors).toHaveLength(1);
  });
});
