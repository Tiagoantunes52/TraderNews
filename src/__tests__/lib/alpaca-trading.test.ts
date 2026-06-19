import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isPaperTradingConfigured,
  getAccount,
  getPositions,
  submitMarketOrder,
  getOrder,
  submitEntryWithStop,
  submitTrailingStop,
  submitStopSell,
  cancelOrder,
  getOpenOrders,
  getClock,
  getAccountSummary,
  getPortfolioPositions,
  getPortfolioHistory,
} from "@/lib/alpaca-trading";

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("alpaca-trading client", () => {
  beforeEach(() => {
    process.env.ALPACA_PAPER_API_KEY_ID = "paper-id";
    process.env.ALPACA_PAPER_API_SECRET_KEY = "paper-secret";
  });
  afterEach(() => {
    delete process.env.ALPACA_PAPER_API_KEY_ID;
    delete process.env.ALPACA_PAPER_API_SECRET_KEY;
    delete process.env.ALPACA_PAPER_BASE_URL;
    vi.unstubAllGlobals();
  });

  describe("isPaperTradingConfigured()", () => {
    it("is true only when both paper keys are present", () => {
      expect(isPaperTradingConfigured()).toBe(true);
      delete process.env.ALPACA_PAPER_API_SECRET_KEY;
      expect(isPaperTradingConfigured()).toBe(false);
    });
  });

  it("hits the paper base URL with both auth headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ equity: "100000", cash: "50000" }));
    vi.stubGlobal("fetch", mockFetch);
    await getAccount();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe("https://paper-api.alpaca.markets/v2/account");
    const headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["APCA-API-KEY-ID"]).toBe("paper-id");
    expect(headers["APCA-API-SECRET-KEY"]).toBe("paper-secret");
  });

  it("parses account numerics from Alpaca's string fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ equity: "101234.56", cash: "789.01" })));
    expect(await getAccount()).toEqual({ equity: 101234.56, cash: 789.01 });
  });

  it("parses positions, signing qty and rolling up unrealized P&L", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          { symbol: "AAPL", qty: "3", unrealized_pl: "12.5" },
          { symbol: "MSFT", qty: "1", unrealized_pl: "-4" },
        ])
      )
    );
    const positions = await getPositions();
    expect(positions).toEqual([
      { symbol: "AAPL", qty: 3, unrealizedPl: 12.5, avgEntryPrice: null, currentPrice: null },
      { symbol: "MSFT", qty: 1, unrealizedPl: -4, avgEntryPrice: null, currentPrice: null },
    ]);
  });

  it("parses avg entry + current price when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse([{ symbol: "AAPL", qty: "3", unrealized_pl: "12.5", avg_entry_price: "100.2", current_price: "104.5" }]))
    );
    expect(await getPositions()).toEqual([
      { symbol: "AAPL", qty: 3, unrealizedPl: 12.5, avgEntryPrice: 100.2, currentPrice: 104.5 },
    ]);
  });

  describe("submitMarketOrder()", () => {
    it("sends a notional market buy, tif=day", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: "o1", status: "accepted" }));
      vi.stubGlobal("fetch", mockFetch);
      const order = await submitMarketOrder({ symbol: "AAPL", side: "buy", notional: 500.5 });
      expect(order).toEqual({ id: "o1", status: "accepted", filledQty: null, filledAvgPrice: null, filledAt: null });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://paper-api.alpaca.markets/v2/orders");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ symbol: "AAPL", side: "buy", type: "market", time_in_force: "day", notional: "500.50" });
    });

    it("sends a qty market sell-to-close", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: "o2", status: "accepted" }));
      vi.stubGlobal("fetch", mockFetch);
      await submitMarketOrder({ symbol: "MSFT", side: "sell", qty: 4 });
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.side).toBe("sell");
      expect(body.qty).toBe("4");
      expect(body.notional).toBeUndefined();
    });

    it("rejects when neither or both of notional/qty are given", async () => {
      vi.stubGlobal("fetch", vi.fn());
      await expect(submitMarketOrder({ symbol: "AAPL", side: "buy" })).rejects.toThrow(/exactly one/);
      await expect(
        submitMarketOrder({ symbol: "AAPL", side: "buy", notional: 100, qty: 1 })
      ).rejects.toThrow(/exactly one/);
    });

    it("throws on a non-ok order response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "insufficient buying power" }));
      await expect(submitMarketOrder({ symbol: "AAPL", side: "buy", notional: 100 })).rejects.toThrow("Alpaca order error: 422");
    });
  });

  describe("getOrder()", () => {
    it("maps fill fields, tolerating unfilled orders", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({ id: "o3", status: "filled", filled_qty: "2", filled_avg_price: "51.25", filled_at: "2026-06-15T14:00:00Z" })
        )
      );
      expect(await getOrder("o3")).toEqual({
        id: "o3",
        status: "filled",
        filledQty: 2,
        filledAvgPrice: 51.25,
        filledAt: "2026-06-15T14:00:00Z",
      });
    });
  });

  it("throws when a credential is missing at call time", async () => {
    delete process.env.ALPACA_PAPER_API_SECRET_KEY;
    vi.stubGlobal("fetch", vi.fn());
    await expect(getAccount()).rejects.toThrow(/ALPACA_PAPER_API_KEY_ID/);
  });

  it("honours an overridden base URL", async () => {
    process.env.ALPACA_PAPER_BASE_URL = "https://example.test";
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", mockFetch);
    await getPositions();
    expect(mockFetch.mock.calls[0][0]).toBe("https://example.test/v2/positions");
  });

  describe("broker-enforced protective orders", () => {
    it("submitEntryWithStop sends a marketable-limit OTO buy with a GTC stop leg", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ id: "parent1", status: "accepted", legs: [{ id: "stop1", type: "stop" }] })
      );
      vi.stubGlobal("fetch", mockFetch);
      const res = await submitEntryWithStop({ symbol: "AAPL", qty: 3, limitPrice: 100.49, stopPrice: 92.1 });
      expect(res).toEqual({
        order: { id: "parent1", status: "accepted", filledQty: null, filledAvgPrice: null, filledAt: null },
        stopOrderId: "stop1",
      });
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://paper-api.alpaca.markets/v2/orders");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        symbol: "AAPL",
        qty: "3",
        side: "buy",
        type: "limit",
        limit_price: "100.49",
        time_in_force: "gtc",
        order_class: "oto",
        stop_loss: { stop_price: "92.10" },
      });
    });

    it("submitEntryWithStop tolerates a response with no legs", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "p2", status: "accepted" })));
      const res = await submitEntryWithStop({ symbol: "AAPL", qty: 1, limitPrice: 10, stopPrice: 9 });
      expect(res.stopOrderId).toBeNull();
    });

    it("submitTrailingStop sends a GTC trailing_stop sell with trail_percent", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: "t1", status: "accepted" }));
      vi.stubGlobal("fetch", mockFetch);
      await submitTrailingStop({ symbol: "AAPL", qty: 3, trailPercent: 12 });
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ symbol: "AAPL", qty: "3", side: "sell", type: "trailing_stop", trail_percent: "12.00", time_in_force: "gtc" });
    });

    it("submitStopSell sends a GTC stop sell", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: "s1", status: "accepted" }));
      vi.stubGlobal("fetch", mockFetch);
      await submitStopSell({ symbol: "AAPL", qty: 2, stopPrice: 88.5 });
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ symbol: "AAPL", qty: "2", side: "sell", type: "stop", stop_price: "88.50", time_in_force: "gtc" });
    });

    it("cancelOrder DELETEs by id and tolerates 404/422", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
      vi.stubGlobal("fetch", mockFetch);
      await cancelOrder("o9");
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://paper-api.alpaca.markets/v2/orders/o9");
      expect(init.method).toBe("DELETE");
      // already-gone statuses don't throw
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "" } as Response));
      await expect(cancelOrder("o9")).resolves.toBeUndefined();
      // a real error still throws
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as Response));
      await expect(cancelOrder("o9")).rejects.toThrow("Alpaca cancel error: 500");
    });

    it("getOpenOrders filters by symbol and parses the protective order shape", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse([{ id: "stop1", symbol: "AAPL", type: "stop", side: "sell", qty: "3", stop_price: "92.1", trail_percent: null }])
      );
      vi.stubGlobal("fetch", mockFetch);
      const orders = await getOpenOrders("AAPL");
      expect(mockFetch.mock.calls[0][0]).toBe("https://paper-api.alpaca.markets/v2/orders?status=open&symbols=AAPL");
      expect(orders).toEqual([
        { id: "stop1", symbol: "AAPL", type: "stop", side: "sell", qty: 3, stopPrice: 92.1, trailPercent: null },
      ]);
    });

    it("getClock parses is_open + next_close", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ is_open: true, next_close: "2026-06-17T20:00:00Z" })));
      expect(await getClock()).toEqual({ isOpen: true, nextClose: "2026-06-17T20:00:00Z" });
    });
  });

  describe("holdings views (Portfolio page)", () => {
    it("getAccountSummary parses the full account snapshot", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({
            equity: "101234.56",
            last_equity: "100000",
            cash: "5000",
            buying_power: "20000",
            long_market_value: "96234.56",
          })
        )
      );
      expect(await getAccountSummary()).toEqual({
        equity: 101234.56,
        lastEquity: 100000,
        cash: 5000,
        buyingPower: 20000,
        longMarketValue: 96234.56,
      });
    });

    it("getPortfolioPositions maps detail fields incl. fractional P&L", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse([
            {
              symbol: "AAPL",
              qty: "3",
              avg_entry_price: "100",
              current_price: "110",
              market_value: "330",
              cost_basis: "300",
              unrealized_pl: "30",
              unrealized_plpc: "0.1",
              unrealized_intraday_pl: "5",
              change_today: "0.015",
            },
          ])
        )
      );
      expect(await getPortfolioPositions()).toEqual([
        {
          symbol: "AAPL",
          qty: 3,
          avgEntryPrice: 100,
          currentPrice: 110,
          marketValue: 330,
          costBasis: 300,
          unrealizedPl: 30,
          unrealizedPlpc: 0.1,
          unrealizedIntradayPl: 5,
          changeToday: 0.015,
        },
      ]);
    });

    it("getPortfolioHistory hits the right URL and converts timestamps", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({ timestamp: [1700000000, 1700086400], equity: [100000, 100500], base_value: 100000 })
      );
      vi.stubGlobal("fetch", mockFetch);
      const { points, baseValue } = await getPortfolioHistory();
      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://paper-api.alpaca.markets/v2/account/portfolio/history?period=1M&timeframe=1D"
      );
      expect(baseValue).toBe(100000);
      expect(points).toEqual([
        { t: new Date(1700000000 * 1000).toISOString(), equity: 100000 },
        { t: new Date(1700086400 * 1000).toISOString(), equity: 100500 },
      ]);
    });

    it("getPortfolioHistory drops null-equity gap points", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({ timestamp: [1700000000, 1700086400, 1700172800], equity: [100000, null, 100500], base_value: 100000 })
        )
      );
      const { points } = await getPortfolioHistory();
      expect(points.map((p) => p.equity)).toEqual([100000, 100500]);
    });

    it("getPortfolioHistory honours custom period + timeframe", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ timestamp: [], equity: [] }));
      vi.stubGlobal("fetch", mockFetch);
      const { points, baseValue } = await getPortfolioHistory("1A", "1H");
      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://paper-api.alpaca.markets/v2/account/portfolio/history?period=1A&timeframe=1H"
      );
      expect(points).toEqual([]);
      expect(baseValue).toBeNull();
    });
  });
});
