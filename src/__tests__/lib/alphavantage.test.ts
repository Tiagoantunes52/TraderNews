import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseAlphaVantageDate, getAlphaVantageNews } from "@/lib/alphavantage";

// ── parseAlphaVantageDate ────────────────────────────────────────────────────

describe("parseAlphaVantageDate()", () => {
  it("parses a standard timestamp correctly", () => {
    const d = parseAlphaVantageDate("20240601T120000");
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(5); // June = 5
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(12);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
  });

  it("parses midnight", () => {
    const d = parseAlphaVantageDate("20240101T000000");
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it("parses end-of-day seconds", () => {
    const d = parseAlphaVantageDate("20241231T235959");
    expect(d.getUTCHours()).toBe(23);
    expect(d.getUTCMinutes()).toBe(59);
    expect(d.getUTCSeconds()).toBe(59);
  });
});

// ── getAlphaVantageNews ──────────────────────────────────────────────────────

const SAMPLE_ARTICLE = {
  title: "Apple Beats Earnings",
  url: "https://example.com/apple-earnings",
  time_published: "20240601T120000",
  summary: "Apple reported strong Q2 results.",
  source: "Reuters",
  ticker_sentiment: [{ ticker: "AAPL", relevance_score: "0.9", ticker_sentiment_score: "0.3", ticker_sentiment_label: "Somewhat-Bullish" }],
};

describe("getAlphaVantageNews()", () => {
  beforeEach(() => { process.env.ALPHAVANTAGE_API_KEY = "test-key"; });
  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    vi.unstubAllGlobals();
  });

  it("throws when API key is not set", async () => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    await expect(getAlphaVantageNews(["AAPL"], new Date())).rejects.toThrow("ALPHAVANTAGE_API_KEY not set");
  });

  it("returns articles from the feed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ feed: [SAMPLE_ARTICLE] }),
    }));
    const articles = await getAlphaVantageNews(["AAPL"], new Date("2024-05-01"));
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Apple Beats Earnings");
  });

  it("returns empty array when feed is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }));
    const articles = await getAlphaVantageNews(["AAPL"], new Date());
    expect(articles).toEqual([]);
  });

  it("throws on non-ok HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));
    await expect(getAlphaVantageNews(["AAPL"], new Date())).rejects.toThrow("Alpha Vantage error: 429");
  });

  it("throws when response contains Note (rate limit sentinel)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ Note: "Thank you for using Alpha Vantage! Our standard API rate limit..." }),
    }));
    await expect(getAlphaVantageNews(["AAPL"], new Date())).rejects.toThrow("rate limit reached");
  });

  it("throws when response contains Information (invalid key)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ Information: "Invalid API key." }),
    }));
    await expect(getAlphaVantageNews(["AAPL"], new Date())).rejects.toThrow("Alpha Vantage: Invalid API key.");
  });

  it("sends time_from in YYYYMMDDTHHMM format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ feed: [] }) });
    vi.stubGlobal("fetch", mockFetch);
    await getAlphaVantageNews(["AAPL"], new Date("2024-06-01T12:30:00Z"));
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("time_from=20240601T1230");
  });
});
