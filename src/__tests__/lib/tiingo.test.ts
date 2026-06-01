import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { toTiingoTicker, getTiingoNews } from "@/lib/tiingo";

// ── toTiingoTicker ───────────────────────────────────────────────────────────

describe("toTiingoTicker()", () => {
  it("converts crypto tickers to concatenated lowercase", () => {
    expect(toTiingoTicker("BTC-USD")).toBe("btcusd");
    expect(toTiingoTicker("ETH-USD")).toBe("ethusd");
    expect(toTiingoTicker("SOL-USD")).toBe("solusd");
  });

  it("leaves US equity tickers unchanged", () => {
    expect(toTiingoTicker("AAPL")).toBe("AAPL");
    expect(toTiingoTicker("MSFT")).toBe("MSFT");
  });

  it("leaves international tickers unchanged", () => {
    expect(toTiingoTicker("EGL.LS")).toBe("EGL.LS");
    expect(toTiingoTicker("HSBA.L")).toBe("HSBA.L");
    expect(toTiingoTicker("BMW.DE")).toBe("BMW.DE");
  });
});

// ── getTiingoNews ────────────────────────────────────────────────────────────

const SAMPLE_ARTICLE = {
  id: 1,
  title: "Apple Reports Record Revenue",
  url: "https://example.com/apple-revenue",
  publishedDate: "2024-06-01T12:00:00+00:00",
  description: "Apple hit a new high in Q2.",
  source: "Reuters",
  tickers: ["AAPL"],
};

describe("getTiingoNews()", () => {
  beforeEach(() => { process.env.TIINGO_API_KEY = "test-key"; });
  afterEach(() => {
    delete process.env.TIINGO_API_KEY;
    vi.unstubAllGlobals();
  });

  it("throws when API key is not set", async () => {
    delete process.env.TIINGO_API_KEY;
    await expect(getTiingoNews(["AAPL"], new Date())).rejects.toThrow("TIINGO_API_KEY not set");
  });

  it("returns articles on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [SAMPLE_ARTICLE],
    }));
    const articles = await getTiingoNews(["AAPL"], new Date("2024-05-01"));
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Apple Reports Record Revenue");
  });

  it("throws on non-ok HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    }));
    await expect(getTiingoNews(["AAPL"], new Date())).rejects.toThrow("Tiingo error: 401");
  });

  it("sends Authorization: Token header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", mockFetch);
    await getTiingoNews(["AAPL"], new Date());
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect((options.headers as Record<string, string>)["Authorization"]).toBe("Token test-key");
  });

  it("sends correct query params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", mockFetch);
    await getTiingoNews(["AAPL", "MSFT"], new Date("2024-06-01T00:00:00Z"));
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("tickers=AAPL%2CMSFT");
    expect(calledUrl).toContain("startDate=2024-06-01");
    expect(calledUrl).toContain("limit=100");
  });
});
