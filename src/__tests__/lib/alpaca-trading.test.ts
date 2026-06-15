import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isPaperTradingConfigured,
  getAccount,
  getPositions,
  submitMarketOrder,
  getOrder,
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
      { symbol: "AAPL", qty: 3, unrealizedPl: 12.5 },
      { symbol: "MSFT", qty: 1, unrealizedPl: -4 },
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
});
