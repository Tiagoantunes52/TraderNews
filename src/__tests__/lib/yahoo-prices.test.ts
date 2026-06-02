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
});
