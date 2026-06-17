import { describe, it, expect, vi, beforeEach } from "vitest";

// Only the Alpaca adapter's transport is mocked; the synthetic sources used by
// the other suites don't touch the low-level modules.
vi.mock("@/lib/alpaca", () => ({ getAlpacaNews: vi.fn() }));

import { getAlpacaNews } from "@/lib/alpaca";
import {
  mergeArticles,
  aggregateNews,
  partialOrThrow,
  alpacaSource,
  DEFAULT_SOURCES,
  type AggregatedArticle,
  type NewsSource,
  type SourceStock,
} from "@/lib/news-sources";

const mockAlpaca = vi.mocked(getAlpacaNews);

function mk(partial: Partial<AggregatedArticle> & { url: string }): AggregatedArticle {
  return {
    headline: partial.headline ?? "Headline",
    summary: partial.summary ?? null,
    url: partial.url,
    source: partial.source ?? "Src",
    publishedAt: partial.publishedAt ?? new Date("2026-06-01T00:00:00Z"),
    provider: partial.provider ?? "P1",
    stockTickers: partial.stockTickers ?? [],
    sentiment: partial.sentiment ?? [],
  };
}

const stocks: SourceStock[] = [
  { id: "s1", ticker: "AAPL" },
  { id: "s2", ticker: "JMT.LS" },
];

describe("mergeArticles", () => {
  it("dedupes by normalized URL and unions tickers", () => {
    const merged = mergeArticles([
      mk({ url: "https://x.com/a?utm=1", stockTickers: ["AAPL"], provider: "Finnhub" }),
      mk({ url: "https://x.com/a", stockTickers: ["MSFT"], provider: "Tiingo" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].stockTickers.sort()).toEqual(["AAPL", "MSFT"]);
    expect(merged[0].provider).toBe("Finnhub+Tiingo");
  });

  it("concatenates sentiment hints from multiple providers", () => {
    const merged = mergeArticles([
      mk({ url: "https://x.com/b", sentiment: [{ ticker: "AAPL", score: 0.5, relevance: 0.9 }] }),
      mk({ url: "https://x.com/b", sentiment: [{ ticker: "AAPL", score: 0.3, relevance: 0.4 }] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sentiment).toHaveLength(2);
  });

  it("keeps distinct URLs separate", () => {
    const merged = mergeArticles([
      mk({ url: "https://x.com/a" }),
      mk({ url: "https://x.com/b" }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("does not duplicate the same provider name on repeated merges", () => {
    const merged = mergeArticles([
      mk({ url: "https://x.com/c", provider: "Yahoo RSS" }),
      mk({ url: "https://x.com/c", provider: "Yahoo RSS" }),
    ]);
    expect(merged[0].provider).toBe("Yahoo RSS");
  });

  it("drops non-http(s) URLs from untrusted feeds (#18)", () => {
    const merged = mergeArticles([
      mk({ url: "https://x.com/ok" }),
      mk({ url: "javascript:alert(1)" }),
      mk({ url: "\tJavaScript:alert(2)" }), // obfuscated scheme
      mk({ url: "data:text/html,<script>1</script>" }),
      mk({ url: "not-a-url" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].url).toBe("https://x.com/ok");
  });
});

describe("DEFAULT_SOURCES", () => {
  it("no longer includes Polygon (replaced by Finnhub + Yahoo for US tickers)", () => {
    expect(DEFAULT_SOURCES.map((s) => s.name)).not.toContain("Polygon");
  });

  it("still covers Finnhub and Yahoo RSS", () => {
    const names = DEFAULT_SOURCES.map((s) => s.name);
    expect(names).toContain("Finnhub");
    expect(names).toContain("Yahoo RSS");
  });

  it("includes the Alpaca source", () => {
    expect(DEFAULT_SOURCES.map((s) => s.name)).toContain("Alpaca");
  });
});

describe("alpacaSource adapter", () => {
  const ALPACA_RAW = {
    id: 1,
    headline: "Apple climbs",
    author: "A",
    created_at: "2026-06-01T12:00:00Z",
    updated_at: "2026-06-01T12:00:00Z",
    summary: "Up on earnings.",
    url: "https://example.com/aapl",
    symbols: ["AAPL", "SPY"],
    source: "benzinga",
  };

  beforeEach(() => {
    process.env.ALPACA_API_KEY_ID = "id";
    process.env.ALPACA_API_SECRET_KEY = "secret";
    mockAlpaca.mockReset();
  });

  it("is configured only when both credentials are present", () => {
    expect(alpacaSource.configured()).toBe(true);
    delete process.env.ALPACA_API_SECRET_KEY;
    expect(alpacaSource.configured()).toBe(false);
  });

  it("queries US tickers only and never the low-level fn for non-US/crypto", async () => {
    mockAlpaca.mockResolvedValue([]);
    await alpacaSource.fetch(
      [
        { id: "1", ticker: "AAPL" },
        { id: "2", ticker: "JMT.LS" }, // non-US → excluded
        { id: "3", ticker: "BTC-USD" }, // crypto → excluded
      ],
      new Date("2026-05-01")
    );
    expect(mockAlpaca).toHaveBeenCalledTimes(1);
    expect(mockAlpaca.mock.calls[0][0]).toEqual(["AAPL"]);
  });

  it("keeps only the watched symbols an article is tagged with, and maps the publisher", async () => {
    mockAlpaca.mockResolvedValue([ALPACA_RAW]);
    const out = await alpacaSource.fetch([{ id: "1", ticker: "AAPL" }], new Date("2026-05-01"));
    expect(out).toHaveLength(1);
    expect(out[0].stockTickers).toEqual(["AAPL"]); // SPY tagged but unwatched → dropped
    expect(out[0].provider).toBe("Alpaca");
    expect(out[0].source).toBe("Benzinga"); // "benzinga" title-cased
  });

  it("drops an article tagged only with unwatched symbols", async () => {
    mockAlpaca.mockResolvedValue([{ ...ALPACA_RAW, symbols: ["TSLA"] }]);
    const out = await alpacaSource.fetch([{ id: "1", ticker: "AAPL" }], new Date("2026-05-01"));
    expect(out).toEqual([]);
  });

  it("is a no-op (no fetch) when there are no US tickers", async () => {
    const out = await alpacaSource.fetch([{ id: "1", ticker: "JMT.LS" }], new Date("2026-05-01"));
    expect(out).toEqual([]);
    expect(mockAlpaca).not.toHaveBeenCalled();
  });
});

describe("aggregateNews", () => {
  const okSource = (name: string, articles: AggregatedArticle[]): NewsSource => ({
    name,
    configured: () => true,
    fetch: async () => articles,
  });

  it("merges articles from multiple working sources", async () => {
    const a = okSource("A", [mk({ url: "https://x.com/1", stockTickers: ["AAPL"] })]);
    const b = okSource("B", [mk({ url: "https://x.com/2", stockTickers: ["JMT.LS"] })]);
    const res = await aggregateNews(stocks, new Date(), [a, b]);
    expect(res.articles).toHaveLength(2);
    expect(res.fetched).toBe(2);
    expect(res.perProvider).toEqual({ A: 1, B: 1 });
    expect(res.errors).toEqual([]);
  });

  it("isolates a failing source (fallback) — others still contribute", async () => {
    const good = okSource("Good", [mk({ url: "https://x.com/1" })]);
    const bad: NewsSource = {
      name: "Bad",
      configured: () => true,
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const res = await aggregateNews(stocks, new Date(), [bad, good]);
    expect(res.articles).toHaveLength(1);
    expect(res.errors.some((e) => e.includes("Bad failed") && e.includes("boom"))).toBe(true);
  });

  it("records unconfigured sources as non-fatal skips", async () => {
    const off: NewsSource = { name: "Off", configured: () => false, fetch: async () => [] };
    const on = okSource("On", [mk({ url: "https://x.com/1" })]);
    const res = await aggregateNews(stocks, new Date(), [off, on]);
    expect(res.articles).toHaveLength(1);
    expect(res.errors).toContain("Off skipped: not configured");
  });

  it("merges cross-source duplicates into a single article", async () => {
    const a = okSource("A", [mk({ url: "https://x.com/dup", stockTickers: ["AAPL"] })]);
    const b = okSource("B", [mk({ url: "https://x.com/dup?ref=1", stockTickers: ["MSFT"] })]);
    const res = await aggregateNews(stocks, new Date(), [a, b]);
    expect(res.articles).toHaveLength(1);
    expect(res.articles[0].stockTickers.sort()).toEqual(["AAPL", "MSFT"]);
    expect(res.fetched).toBe(2); // raw count is pre-merge
  });
});

describe("partialOrThrow (per-iteration adapter isolation)", () => {
  it("returns collected articles when some units succeeded despite failures", () => {
    const collected = [mk({ url: "https://x.com/1" })];
    // One ticker flaked but another returned data — keep the partial coverage.
    expect(partialOrThrow(collected, 1, new Error("flake"))).toBe(collected);
  });

  it("returns articles when there were no failures at all", () => {
    const collected = [mk({ url: "https://x.com/1" })];
    expect(partialOrThrow(collected, 0, undefined)).toBe(collected);
  });

  it("re-throws when every unit failed and nothing was collected (total outage)", () => {
    expect(() => partialOrThrow([], 3, new Error("boom"))).toThrow("boom");
  });

  it("returns an empty array when there were no units and no failures", () => {
    expect(partialOrThrow([], 0, undefined)).toEqual([]);
  });

  it("wraps a non-Error thrown value when re-throwing", () => {
    expect(() => partialOrThrow([], 1, "string failure")).toThrow("string failure");
  });
});
