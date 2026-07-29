import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { getLatestTrades, isLiveQuotesEnabled, isMarketDataConfigured } from "@/lib/alpaca-quotes";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe("alpaca-quotes", () => {
  beforeEach(() => {
    process.env.ALPACA_API_KEY_ID = "data-id";
    process.env.ALPACA_API_SECRET_KEY = "data-secret";
  });
  afterEach(() => {
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
    delete process.env.PAPER_LIVE_QUOTES;
    vi.unstubAllGlobals();
  });

  describe("gates", () => {
    it("is off unless explicitly enabled — this changes every price the stage uses", () => {
      expect(isLiveQuotesEnabled()).toBe(false);
      process.env.PAPER_LIVE_QUOTES = "0";
      expect(isLiveQuotesEnabled()).toBe(false);
      process.env.PAPER_LIVE_QUOTES = "1";
      expect(isLiveQuotesEnabled()).toBe(true);
    });

    it("reads the market-data keys, not the paper trading keys", () => {
      expect(isMarketDataConfigured()).toBe(true);
      delete process.env.ALPACA_API_SECRET_KEY;
      expect(isMarketDataConfigured()).toBe(false);
    });
  });

  describe("getLatestTrades()", () => {
    it("maps symbols to their last trade price", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ trades: { AAPL: { p: 190.25 }, MSFT: { p: 401.1 } } })));
      const { prices, errors } = await getLatestTrades(["AAPL", "MSFT"]);
      expect(prices.get("AAPL")).toBe(190.25);
      expect(prices.get("MSFT")).toBe(401.1);
      expect(errors).toEqual([]);
    });

    it("omits symbols with a missing or non-positive price rather than marking a book at zero", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(ok({ trades: { A: { p: 0 }, B: { p: -1 }, C: {}, D: null, E: { p: 12 } } }))
      );
      const { prices } = await getLatestTrades(["A", "B", "C", "D", "E"]);
      expect([...prices.keys()]).toEqual(["E"]);
    });

    it("chunks large symbol lists", async () => {
      const mockFetch = vi.fn().mockResolvedValue(ok({ trades: {} }));
      vi.stubGlobal("fetch", mockFetch);
      await getLatestTrades(Array.from({ length: 250 }, (_, i) => `T${i}`));
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("reports an HTTP failure without throwing, and still uses the other chunks", async () => {
      // A quote feed must never be able to stop the stage from managing open positions.
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "slow down" } as Response)
        .mockResolvedValueOnce(ok({ trades: { LATE: { p: 5 } } }));
      vi.stubGlobal("fetch", mockFetch);
      const { prices, errors } = await getLatestTrades(Array.from({ length: 150 }, (_, i) => `T${i}`));
      expect(errors[0]).toMatch(/429/);
      expect(prices.get("LATE")).toBe(5);
    });

    it("never throws when the transport dies", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
      const { prices, errors } = await getLatestTrades(["AAPL"]);
      expect(prices.size).toBe(0);
      expect(errors[0]).toMatch(/ECONNRESET/);
    });

    it("makes no request for an empty symbol list", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);
      const { prices } = await getLatestTrades([]);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(prices.size).toBe(0);
    });

    // A dash-form class share (`BRK-B`) is not an Alpaca symbol: the endpoint 400s the
    // WHOLE request on it ("invalid symbol"), so one bad name silently dropped up to 100
    // others back to stored closes.
    it("asks for class shares in Alpaca's dot form", async () => {
      const mockFetch = vi.fn().mockResolvedValue(ok({ trades: {} }));
      vi.stubGlobal("fetch", mockFetch);
      await getLatestTrades(["AAPL", "BRK-B"]);
      const url = String(mockFetch.mock.calls[0][0]);
      expect(decodeURIComponent(url)).toContain("BRK.B");
      expect(decodeURIComponent(url)).not.toContain("BRK-B");
    });

    it("keys the reply back to the caller's stored ticker form", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ trades: { "BRK.B": { p: 415.2 } } })));
      const { prices } = await getLatestTrades(["BRK-B"]);
      expect(prices.get("BRK-B")).toBe(415.2);
      expect(prices.has("BRK.B")).toBe(false);
    });

    it("does not pin a feed — an explicit one would 403 an unentitled account", async () => {
      const mockFetch = vi.fn().mockResolvedValue(ok({ trades: {} }));
      vi.stubGlobal("fetch", mockFetch);
      await getLatestTrades(["AAPL"]);
      expect(mockFetch.mock.calls[0][0]).not.toContain("feed=");
    });
  });
});
