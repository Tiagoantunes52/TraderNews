import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isPaperTradingConfigured,
  getAccount,
  getPositions,
  submitMarketOrder,
  getOrder,
  getOrderByClientOrderId,
  submitEntryWithStop,
  submitTrailingStop,
  submitStopSell,
  cancelOrder,
  getOpenOrders,
  getClock,
  getAccountSummary,
  getPortfolioPositions,
  getPortfolioHistory,
  getAccountActivities,
  getCalendar,
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

  describe("client_order_id (durable order intents)", () => {
    const bodyOf = (mockFetch: ReturnType<typeof vi.fn>) =>
      JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);

    it("sends the caller's key on every submission path", async () => {
      for (const submit of [
        () => submitMarketOrder({ symbol: "AAPL", side: "buy", notional: 100, clientOrderId: "k1" }),
        () => submitEntryWithStop({ symbol: "AAPL", qty: 2, limitPrice: 10, stopPrice: 9, clientOrderId: "k1" }),
        () => submitTrailingStop({ symbol: "AAPL", qty: 2, trailPercent: 5, clientOrderId: "k1" }),
        () => submitStopSell({ symbol: "AAPL", qty: 2, stopPrice: 9, clientOrderId: "k1" }),
      ]) {
        const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: "o1", status: "new" }));
        vi.stubGlobal("fetch", mockFetch);
        await submit();
        expect(bodyOf(mockFetch).client_order_id).toBe("k1");
      }
    });

    it("omits the field entirely when no key is given", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: "o1", status: "new" }));
      vi.stubGlobal("fetch", mockFetch);
      await submitMarketOrder({ symbol: "AAPL", side: "buy", notional: 100 });
      expect(bodyOf(mockFetch)).not.toHaveProperty("client_order_id");
    });

    it("resolves an unconfirmed intent: found at the broker", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: "real-id", status: "filled" }));
      vi.stubGlobal("fetch", mockFetch);
      const order = await getOrderByClientOrderId("k1");
      expect(order?.id).toBe("real-id");
      expect(mockFetch.mock.calls[0][0]).toContain("/v2/orders:by_client_order_id?client_order_id=k1");
    });

    it("resolves an unconfirmed intent: 404 means it never landed", async () => {
      // Distinct from an error — only a definite 404 may mark an intent abandoned,
      // because guessing would hide a live order sitting at the broker.
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response));
      expect(await getOrderByClientOrderId("k1")).toBeNull();
    });

    it("throws on a transport/server error rather than reporting 'not found'", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as Response));
      await expect(getOrderByClientOrderId("k1")).rejects.toThrow(/500/);
    });
  });

  describe("live-endpoint safety boundary", () => {
    // ALPACA_PAPER_BASE_URL was the only thing between this app and real money:
    // nothing validated the endpoint, and isPaperTradingConfigured() only checks that
    // the vars exist, not that they belong to a paper account.
    it("refuses the live Alpaca trading host", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({}));
      vi.stubGlobal("fetch", mockFetch);
      process.env.ALPACA_PAPER_BASE_URL = "https://api.alpaca.markets";
      await expect(getAccount()).rejects.toThrow(/Refusing to trade against a live Alpaca host/);
      expect(mockFetch).not.toHaveBeenCalled(); // refused before any request left the process
    });

    it("refuses any non-paper alpaca.markets host, including on writes", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({}));
      vi.stubGlobal("fetch", mockFetch);
      process.env.ALPACA_PAPER_BASE_URL = "https://broker-api.alpaca.markets";
      await expect(submitMarketOrder({ symbol: "AAPL", side: "buy", notional: 100 })).rejects.toThrow(
        /Refusing to trade against a live Alpaca host/
      );
      await expect(cancelOrder("abc")).rejects.toThrow(/Refusing to trade against a live Alpaca host/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("allows the paper host and non-Alpaca stub hosts (tests need the latter)", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ equity: "1", cash: "1" }));
      vi.stubGlobal("fetch", mockFetch);
      process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
      await expect(getAccount()).resolves.toBeTruthy();
      process.env.ALPACA_PAPER_BASE_URL = "http://localhost:9999";
      await expect(getAccount()).resolves.toBeTruthy();
    });

    it("rejects a malformed override rather than silently falling back", async () => {
      vi.stubGlobal("fetch", vi.fn());
      process.env.ALPACA_PAPER_BASE_URL = "not-a-url";
      await expect(getAccount()).rejects.toThrow(/not a valid URL/);
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
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response)
        .mockResolvedValueOnce(jsonResponse({ id: "o9", status: "canceled" }));
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

    it("cancelOrder waits for the order to actually settle before returning", async () => {
      // A 204 on the DELETE only means the request was accepted — Alpaca still shows
      // the order (and its held shares) as "pending_cancel" for a beat afterward. A
      // caller that resubmits into those shares the instant cancelOrder resolves must
      // not race that settlement, so cancelOrder should keep polling until the order
      // reaches a terminal status.
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response)
        .mockResolvedValueOnce(jsonResponse({ id: "o9", status: "pending_cancel" }))
        .mockResolvedValueOnce(jsonResponse({ id: "o9", status: "canceled" }));
      vi.stubGlobal("fetch", mockFetch);
      await cancelOrder("o9");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("cancelOrder keeps waiting through a transient read failure, then settles", async () => {
      // A 5xx on the status poll means we could not READ the order — it says nothing
      // about whether the cancel settled. Treating it as "gone" (the original fix did)
      // hands the caller a false all-clear and reopens the 403 race precisely when the
      // broker is flaky, which is when races are most likely.
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response)
        .mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as Response)
        .mockResolvedValueOnce(jsonResponse({ id: "o9", status: "canceled" }));
      // 3 fetchWithRetry attempts burn the 500s, then the canceled read lands.
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" } as Response)
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" } as Response)
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" } as Response)
        .mockResolvedValueOnce(jsonResponse({ id: "o9", status: "canceled" }));
      vi.stubGlobal("fetch", mockFetch);
      await expect(cancelOrder("o9")).resolves.toBeUndefined();
    });

    it("cancelOrder returns as soon as the order 404s — nothing left holding shares", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "not found" } as Response);
      vi.stubGlobal("fetch", mockFetch);
      await expect(cancelOrder("o9")).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(2); // no pointless polling after a 404
    });

    it("cancelOrder throws rather than silently giving up when the order never settles", async () => {
      // Resolving here would promise the caller the shares are free when we never saw
      // that happen; its resubmit would then be rejected 403 and read as an order-
      // contents bug. Resolving means settled, throwing means unconfirmed — never both.
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response)
        .mockResolvedValue(jsonResponse({ id: "o9", status: "pending_cancel" }));
      vi.stubGlobal("fetch", mockFetch);
      await expect(cancelOrder("o9")).rejects.toThrow(/did not settle/);
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

  describe("getAccountActivities() — full-history pagination", () => {
    const fill = (id: string, side = "buy") => ({
      id,
      symbol: "AAPL",
      side,
      qty: "1",
      price: "100",
      transaction_time: "2026-07-01T15:00:00Z",
    });

    it("pages via page_token until a short page, concatenating all fills", async () => {
      // Page 1 is full (pageSize=2) → must request page 2 with the last id as token.
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([fill("a1"), fill("a2")]))
        .mockResolvedValueOnce(jsonResponse([fill("a3", "sell")]));
      vi.stubGlobal("fetch", mockFetch);
      const fills = await getAccountActivities(2);
      expect(fills).toHaveLength(3);
      expect(fills[2].side).toBe("sell");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://paper-api.alpaca.markets/v2/account/activities/FILL?direction=desc&page_size=2"
      );
      expect(mockFetch.mock.calls[1][0]).toBe(
        "https://paper-api.alpaca.markets/v2/account/activities/FILL?direction=desc&page_size=2&page_token=a2"
      );
    });

    it("stops after one request when the first page is short", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse([fill("a1")]));
      vi.stubGlobal("fetch", mockFetch);
      expect(await getAccountActivities(100)).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("stops when a full page carries no id to continue from (no infinite loop)", async () => {
      const noId = { symbol: "AAPL", side: "buy", qty: "1", price: "100", transaction_time: "t" };
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse([noId, noId]));
      vi.stubGlobal("fetch", mockFetch);
      expect(await getAccountActivities(2)).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("respects the maxPages bound", async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse([fill("x"), fill("y")]));
      vi.stubGlobal("fetch", mockFetch);
      const fills = await getAccountActivities(2, 3);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(fills).toHaveLength(6);
    });
  });

  describe("getCalendar()", () => {
    it("returns trading-day keys for the date range", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse([{ date: "2026-07-01" }, { date: "2026-07-02" }, { date: "2026-07-06" }])
      );
      vi.stubGlobal("fetch", mockFetch);
      const days = await getCalendar(new Date("2026-07-01T12:00:00Z"), new Date("2026-07-06T12:00:00Z"));
      expect(days).toEqual(["2026-07-01", "2026-07-02", "2026-07-06"]);
      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://paper-api.alpaca.markets/v2/calendar?start=2026-07-01&end=2026-07-06"
      );
    });
  });
});
