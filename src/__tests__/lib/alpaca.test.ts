import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAlpacaNews } from "@/lib/alpaca";

const SAMPLE_ARTICLE = {
  id: 24843171,
  headline: "Apple Reports Record Revenue",
  author: "Jane Doe",
  created_at: "2026-06-01T12:00:00Z",
  updated_at: "2026-06-01T12:00:00Z",
  summary: "Apple hit a new high in Q2.",
  url: "https://example.com/apple-revenue",
  symbols: ["AAPL"],
  source: "benzinga",
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("getAlpacaNews()", () => {
  beforeEach(() => {
    process.env.ALPACA_API_KEY_ID = "test-id";
    process.env.ALPACA_API_SECRET_KEY = "test-secret";
  });
  afterEach(() => {
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
    vi.unstubAllGlobals();
  });

  it("throws when either credential is missing", async () => {
    delete process.env.ALPACA_API_SECRET_KEY;
    await expect(getAlpacaNews(["AAPL"], new Date())).rejects.toThrow(/ALPACA_API_KEY_ID/);
  });

  it("returns an empty array without calling fetch when no symbols are given", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    expect(await getAlpacaNews([], new Date())).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns articles on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ news: [SAMPLE_ARTICLE], next_page_token: null })));
    const articles = await getAlpacaNews(["AAPL"], new Date("2026-05-01"));
    expect(articles).toHaveLength(1);
    expect(articles[0].headline).toBe("Apple Reports Record Revenue");
    expect(articles[0].symbols).toEqual(["AAPL"]);
  });

  it("throws on a non-ok HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" }));
    await expect(getAlpacaNews(["AAPL"], new Date())).rejects.toThrow("Alpaca error: 401");
  });

  it("sends both Alpaca auth headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ news: [], next_page_token: null }));
    vi.stubGlobal("fetch", mockFetch);
    await getAlpacaNews(["AAPL"], new Date());
    const headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["APCA-API-KEY-ID"]).toBe("test-id");
    expect(headers["APCA-API-SECRET-KEY"]).toBe("test-secret");
  });

  it("sends symbols, start, limit and sort query params", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ news: [], next_page_token: null }));
    vi.stubGlobal("fetch", mockFetch);
    await getAlpacaNews(["AAPL", "MSFT"], new Date("2026-06-01T00:00:00Z"));
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("symbols=AAPL%2CMSFT");
    expect(calledUrl).toContain("start=2026-06-01T00%3A00%3A00.000Z");
    expect(calledUrl).toContain("limit=50");
    expect(calledUrl).toContain("sort=desc");
  });

  it("follows next_page_token and stops when it is null", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ news: [SAMPLE_ARTICLE], next_page_token: "tok2" }))
      .mockResolvedValueOnce(jsonResponse({ news: [{ ...SAMPLE_ARTICLE, id: 2 }], next_page_token: null }));
    vi.stubGlobal("fetch", mockFetch);
    const articles = await getAlpacaNews(["AAPL"], new Date("2026-05-01"));
    expect(articles).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((mockFetch.mock.calls[1][0] as string)).toContain("page_token=tok2");
  });

  it("stops paginating at the page cap even if a token keeps coming", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ news: [SAMPLE_ARTICLE], next_page_token: "always" }));
    vi.stubGlobal("fetch", mockFetch);
    await getAlpacaNews(["AAPL"], new Date("2026-05-01"));
    expect(mockFetch).toHaveBeenCalledTimes(5); // MAX_PAGES
  });
});
