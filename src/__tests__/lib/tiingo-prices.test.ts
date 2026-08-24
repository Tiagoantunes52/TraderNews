import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getTiingoDailyPrices } from "@/lib/tiingo-prices";
import { barDate } from "@/lib/price-bars";

// Tiingo returns dates as full ISO datetimes ("2026-08-22T00:00:00.000Z"). The
// DailyPrice contract carries plain session dates — barDate() and sessionDate
// both depend on it. Passing the datetime through silently rejected every
// Tiingo-served PriceBar as INVALID_DATE and nulled sessionDate for three and a
// half weeks (OPEN-FINDINGS.md, "The Tiingo date defect, 2026-08-24").

const STOCK_ROW = {
  date: "2026-08-22T00:00:00.000Z",
  close: 100,
  adjClose: 100,
  volume: 1000,
  high: 101,
  low: 99,
  open: 99.5,
};

const CRYPTO_RESPONSE = [
  {
    priceData: [{ date: "2026-08-22T00:00:00+00:00", close: 50000, volume: 10, high: 50100, low: 49900, open: 49950 }],
  },
];

describe("getTiingoDailyPrices()", () => {
  beforeEach(() => {
    process.env.TIINGO_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.TIINGO_API_KEY;
    vi.unstubAllGlobals();
  });

  it("normalizes stock dates to the plain session date", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [STOCK_ROW] }));
    const prices = await getTiingoDailyPrices("AAPL", new Date("2026-07-01"));
    expect(prices[0].date).toBe("2026-08-22");
    expect(barDate(prices[0].date)).toEqual(new Date("2026-08-22T00:00:00.000Z"));
  });

  it("normalizes crypto dates to the plain session date", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => CRYPTO_RESPONSE }));
    const prices = await getTiingoDailyPrices("BTC-USD", new Date("2026-07-01"));
    expect(prices[0].date).toBe("2026-08-22");
    expect(barDate(prices[0].date)).toEqual(new Date("2026-08-22T00:00:00.000Z"));
  });
});
