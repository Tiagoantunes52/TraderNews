import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getPolygonStockNews } from "@/lib/polygon";

const SAMPLE_ARTICLE = {
  id: "abc123",
  title: "Tesla Misses Delivery Estimates",
  article_url: "https://example.com/tesla-deliveries",
  published_utc: "2024-06-01T12:00:00Z",
  description: "Tesla delivered fewer cars than expected.",
  publisher: { name: "Reuters" },
  tickers: ["TSLA"],
};

describe("getPolygonStockNews()", () => {
  beforeEach(() => { process.env.POLYGON_API_KEY = "test-key"; });
  afterEach(() => {
    delete process.env.POLYGON_API_KEY;
    vi.unstubAllGlobals();
  });

  it("throws when API key is not set", async () => {
    delete process.env.POLYGON_API_KEY;
    await expect(getPolygonStockNews("TSLA", new Date())).rejects.toThrow("POLYGON_API_KEY not set");
  });

  it("returns results on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [SAMPLE_ARTICLE] }),
    }));
    const articles = await getPolygonStockNews("TSLA", new Date("2024-05-01"));
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Tesla Misses Delivery Estimates");
  });

  it("returns empty array when results field is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(await getPolygonStockNews("TSLA", new Date())).toEqual([]);
  });

  it("throws on non-ok HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    }));
    await expect(getPolygonStockNews("TSLA", new Date())).rejects.toThrow("Polygon error: 403");
  });

  it("sends correct query params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    vi.stubGlobal("fetch", mockFetch);
    await getPolygonStockNews("TSLA", new Date("2024-06-01T00:00:00Z"));
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("ticker=TSLA");
    expect(calledUrl).toContain("published_utc.gte=2024-06-01");
    expect(calledUrl).toContain("order=desc");
    expect(calledUrl).toContain("limit=50");
  });
});
