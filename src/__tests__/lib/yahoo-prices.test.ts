import { describe, it, expect, afterEach, vi } from "vitest";
import { getYahooDailyPrices } from "@/lib/yahoo-prices";

function chartResponse(currency: string, close: number[], high: number[], low: number[]) {
  return {
    chart: {
      result: [
        {
          timestamp: close.map((_, i) => 1_717_200_000 + i * 86_400),
          meta: { currency },
          indicators: {
            quote: [{ close, high, low, volume: close.map(() => 1000) }],
            adjclose: [{ adjclose: close }],
          },
        },
      ],
    },
  };
}

function mockFetch(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe("getYahooDailyPrices", () => {
  afterEach(() => vi.restoreAllMocks());

  it("normalizes GBp (pence) to GBP by dividing by 100", async () => {
    mockFetch(chartResponse("GBp", [13214, 13300], [13250, 13350], [13100, 13200]));
    const prices = await getYahooDailyPrices("AZN.L", new Date());
    expect(prices).toHaveLength(2);
    expect(prices[0].close).toBeCloseTo(132.14, 5);
    expect(prices[0].high).toBeCloseTo(132.5, 5);
    expect(prices[0].low).toBeCloseTo(131.0, 5);
    expect(prices[1].close).toBeCloseTo(133.0, 5);
  });

  it("leaves non-pence currencies (EUR) unchanged", async () => {
    mockFetch(chartResponse("EUR", [52.68, 53.1], [53.0, 53.5], [52.0, 52.9]));
    const prices = await getYahooDailyPrices("ITX.MC", new Date());
    expect(prices[0].close).toBeCloseTo(52.68, 5);
    expect(prices[0].high).toBeCloseTo(53.0, 5);
  });

  it("leaves USD unchanged", async () => {
    mockFetch(chartResponse("USD", [306.31], [307], [305]));
    const prices = await getYahooDailyPrices("AAPL", new Date());
    expect(prices[0].close).toBeCloseTo(306.31, 5);
  });

  it("skips gap days with null close", async () => {
    const body = {
      chart: {
        result: [
          {
            timestamp: [1, 2, 3],
            meta: { currency: "USD" },
            indicators: {
              quote: [{ close: [10, null, 12], high: [11, null, 13], low: [9, null, 11], volume: [1, 2, 3] }],
              adjclose: [{ adjclose: [10, null, 12] }],
            },
          },
        ],
      },
    };
    mockFetch(body);
    const prices = await getYahooDailyPrices("AAPL", new Date());
    expect(prices).toHaveLength(2);
  });

  it("returns [] on 404", async () => {
    mockFetch({}, 404);
    expect(await getYahooDailyPrices("NOPE", new Date())).toEqual([]);
  });

  // Yahoo serves `adjclose` separately from the RAW `quote` open/high/low. Mixing the
  // two bases is invisible over a 60-day indicator window but corrupts every bar
  // before a corporate action, which is exactly the history a fill model reads.
  describe("split/dividend adjustment", () => {
    // Bar as Yahoo actually returns it: raw O/H/L/C plus a separately adjusted close.
    function splitResponse(
      raw: { open: number; high: number; low: number; close: number; volume: number },
      adjClose: number,
      currency = "USD"
    ) {
      return {
        chart: {
          result: [
            {
              timestamp: [1_717_200_000],
              meta: { currency },
              indicators: {
                quote: [{ close: [raw.close], open: [raw.open], high: [raw.high], low: [raw.low], volume: [raw.volume] }],
                adjclose: [{ adjclose: [adjClose] }],
              },
            },
          ],
        },
      };
    }

    it("puts open/high/low on the adjusted close's basis across a 2:1 split", async () => {
      // Raw session: 102 / 104 / 98 / 100. Post-split the close adjusts to 50, so
      // every other leg must halve too.
      mockFetch(splitResponse({ open: 102, high: 104, low: 98, close: 100, volume: 1000 }, 50));
      const [bar] = await getYahooDailyPrices("AAPL", new Date());
      expect(bar.close).toBeCloseTo(50, 5);
      expect(bar.open).toBeCloseTo(51, 5);
      expect(bar.high).toBeCloseTo(52, 5);
      expect(bar.low).toBeCloseTo(49, 5);
      // Price halves, share count doubles — Tiingo's adjVolume convention.
      expect(bar.volume).toBeCloseTo(2000, 5);
    });

    it("keeps the bar internally consistent — low <= close <= high", async () => {
      // The regression that matters. Unadjusted, this bar reports low 98 against a
      // close of 50: a fabricated 96% gap that a stop model reads as a stop-out on
      // every pre-split bar.
      mockFetch(splitResponse({ open: 102, high: 104, low: 98, close: 100, volume: 1000 }, 50));
      const [bar] = await getYahooDailyPrices("AAPL", new Date());
      expect(bar.low).toBeLessThanOrEqual(bar.close);
      expect(bar.high).toBeGreaterThanOrEqual(bar.close);
    });

    it("leaves an unadjusted bar untouched (ratio 1, no over-correction)", async () => {
      mockFetch(splitResponse({ open: 102, high: 104, low: 98, close: 100, volume: 1000 }, 100));
      const [bar] = await getYahooDailyPrices("AAPL", new Date());
      expect(bar.open).toBeCloseTo(102, 5);
      expect(bar.high).toBeCloseTo(104, 5);
      expect(bar.low).toBeCloseTo(98, 5);
      expect(bar.volume).toBeCloseTo(1000, 5);
    });

    it("applies a fractional dividend adjustment to every leg", async () => {
      // adjClose 99 vs raw 100 → ratio 0.99.
      mockFetch(splitResponse({ open: 102, high: 104, low: 98, close: 100, volume: 1000 }, 99));
      const [bar] = await getYahooDailyPrices("AAPL", new Date());
      expect(bar.open).toBeCloseTo(100.98, 5);
      expect(bar.high).toBeCloseTo(102.96, 5);
      expect(bar.low).toBeCloseTo(97.02, 5);
    });

    it("adjusts and converts pence together, in that order", async () => {
      // GBp listing across a 2:1 split: ratio 0.5 then /100.
      mockFetch(splitResponse({ open: 13300, high: 13400, low: 13100, close: 13200, volume: 500 }, 6600, "GBp"));
      const [bar] = await getYahooDailyPrices("AZN.L", new Date());
      expect(bar.close).toBeCloseTo(66, 5);
      expect(bar.open).toBeCloseTo(66.5, 5);
      expect(bar.high).toBeCloseTo(67, 5);
      expect(bar.low).toBeCloseTo(65.5, 5);
    });

    it("falls back to the adjusted close when a leg is missing, without scaling it twice", async () => {
      const body = {
        chart: {
          result: [
            {
              timestamp: [1_717_200_000],
              meta: { currency: "USD" },
              indicators: {
                quote: [{ close: [100], open: [null], high: [null], low: [null], volume: [1000] }],
                adjclose: [{ adjclose: [50] }],
              },
            },
          ],
        },
      };
      mockFetch(body);
      const [bar] = await getYahooDailyPrices("AAPL", new Date());
      expect(bar.open).toBeCloseTo(50, 5);
      expect(bar.high).toBeCloseTo(50, 5);
      expect(bar.low).toBeCloseTo(50, 5);
    });
  });
});
