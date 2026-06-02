// Centralised news aggregation.
//
// Each provider is wrapped as a NewsSource adapter. `aggregateNews` runs every
// configured source over the stocks it supports, isolating failures (one source
// going down never blocks the others — fallback) and merging the results by URL
// so multiple providers supplement each other's coverage (and sentiment hints).
//
// Adapters own their own batching and rate-limit pacing.

import { getStockNews } from "@/lib/finnhub";
import { getMarketauxStockNews } from "@/lib/marketaux";
import { getAlphaVantageNews, parseAlphaVantageDate } from "@/lib/alphavantage";
import { getTiingoNews, toTiingoTicker } from "@/lib/tiingo";
import { getYahooRssNews } from "@/lib/yahoo-rss";
import { getPolygonStockNews } from "@/lib/polygon";
import { normalizeUrl } from "@/lib/normalize";

export type SourceStock = { id: string; ticker: string };

export type ArticleSentiment = { ticker: string; score: number; relevance: number };

export type AggregatedArticle = {
  headline: string;
  summary: string | null;
  url: string;
  source: string; // publisher name
  publishedAt: Date;
  provider: string; // which adapter produced it
  stockTickers: string[]; // watchlist tickers this article is linked to
  sentiment: ArticleSentiment[]; // per-ticker precomputed sentiment (Alpha Vantage)
};

export type NewsSource = {
  name: string;
  /** True when the source is usable (e.g. API key present). */
  configured(): boolean;
  /** Fetch for whichever subset of `stocks` this source supports. */
  fetch(stocks: SourceStock[], since: Date): Promise<AggregatedArticle[]>;
};

export type AggregateResult = {
  articles: AggregatedArticle[]; // merged + URL-deduped
  fetched: number; // total raw articles seen across sources (pre-merge)
  perProvider: Record<string, number>; // raw count contributed per provider
  errors: string[]; // per-source failures and skips (non-fatal)
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dateStr = (d: Date) => d.toISOString().split("T")[0];

const isUsTicker = (t: string) => !t.includes(".") && !t.endsWith("-USD");
const isNonUsTicker = (t: string) => t.includes(".");

function article(partial: Omit<AggregatedArticle, "sentiment"> & { sentiment?: ArticleSentiment[] }): AggregatedArticle {
  return { sentiment: [], ...partial };
}

// ── Adapters ────────────────────────────────────────────────────────────────

/** Finnhub /company-news — US tickers only, ~60 req/min. */
export const finnhubSource: NewsSource = {
  name: "Finnhub",
  configured: () => !!process.env.FINNHUB_API_KEY,
  async fetch(stocks, since) {
    const out: AggregatedArticle[] = [];
    const to = new Date();
    for (const stock of stocks.filter((s) => isUsTicker(s.ticker))) {
      const news = await getStockNews(stock.ticker, dateStr(since), dateStr(to));
      for (const a of news) {
        if (!a.url || !a.headline) continue;
        out.push(
          article({
            headline: a.headline,
            summary: a.summary ?? null,
            url: a.url,
            source: a.source,
            publishedAt: new Date(a.datetime * 1000),
            provider: "Finnhub",
            stockTickers: [stock.ticker],
          })
        );
      }
      await sleep(1100);
    }
    return out;
  },
};

/** Marketaux — non-US tickers (Finnhub free tier doesn't cover these). */
export const marketauxSource: NewsSource = {
  name: "Marketaux",
  configured: () => !!process.env.MARKETAUX_API_KEY,
  async fetch(stocks, since) {
    const out: AggregatedArticle[] = [];
    const nonUs = stocks.filter((s) => isNonUsTicker(s.ticker));
    const BATCH = 5;
    for (let i = 0; i < nonUs.length; i += BATCH) {
      const batch = nonUs.slice(i, i + BATCH);
      const news = await getMarketauxStockNews(batch.map((s) => s.ticker), since);
      for (const a of news) {
        if (!a.url || !a.title) continue;
        const tickers = a.entities
          .map((e) => batch.find((s) => s.ticker === e.symbol)?.ticker)
          .filter((t): t is string => !!t);
        out.push(
          article({
            headline: a.title,
            summary: a.description ?? null,
            url: a.url,
            source: a.source,
            publishedAt: new Date(a.published_at),
            provider: "Marketaux",
            stockTickers: [...new Set(tickers)],
          })
        );
      }
      await sleep(1000);
    }
    return out;
  },
};

/** Tiingo news — all tickers, batched. */
export const tiingoSource: NewsSource = {
  name: "Tiingo",
  configured: () => !!process.env.TIINGO_API_KEY,
  async fetch(stocks, since) {
    const out: AggregatedArticle[] = [];
    const BATCH = 5;
    for (let i = 0; i < stocks.length; i += BATCH) {
      const batch = stocks.slice(i, i + BATCH);
      const tickerMap = new Map(batch.map((s) => [toTiingoTicker(s.ticker).toLowerCase(), s]));
      const news = await getTiingoNews([...tickerMap.keys()], since);
      for (const a of news) {
        if (!a.url || !a.title) continue;
        const tickers = a.tickers
          .map((t) => tickerMap.get(t.toLowerCase())?.ticker)
          .filter((t): t is string => !!t);
        out.push(
          article({
            headline: a.title,
            summary: a.description ?? null,
            url: a.url,
            source: a.source,
            publishedAt: new Date(a.publishedDate),
            provider: "Tiingo",
            stockTickers: [...new Set(tickers)],
          })
        );
      }
      await sleep(1000);
    }
    return out;
  },
};

/** Yahoo Finance RSS — free, keyless, any ticker globally. */
export const yahooRssSource: NewsSource = {
  name: "Yahoo RSS",
  configured: () => true,
  async fetch(stocks) {
    const out: AggregatedArticle[] = [];
    for (const stock of stocks) {
      const news = await getYahooRssNews(stock.ticker);
      for (const a of news) {
        if (!a.url || !a.title) continue;
        out.push(
          article({
            headline: a.title,
            summary: a.description,
            url: a.url,
            source: "Yahoo Finance",
            publishedAt: a.publishedAt,
            provider: "Yahoo RSS",
            stockTickers: [stock.ticker],
          })
        );
      }
      await sleep(300);
    }
    return out;
  },
};

/** Polygon.io — US tickers, free tier 5 req/min. */
export const polygonSource: NewsSource = {
  name: "Polygon",
  configured: () => !!process.env.POLYGON_API_KEY,
  async fetch(stocks, since) {
    const out: AggregatedArticle[] = [];
    for (const stock of stocks.filter((s) => isUsTicker(s.ticker))) {
      const news = await getPolygonStockNews(stock.ticker, since);
      for (const a of news) {
        if (!a.article_url || !a.title) continue;
        out.push(
          article({
            headline: a.title,
            summary: a.description ?? null,
            url: a.article_url,
            source: a.publisher.name,
            publishedAt: new Date(a.published_utc),
            provider: "Polygon",
            stockTickers: [stock.ticker],
          })
        );
      }
      await sleep(12_000); // 5 req/min
    }
    return out;
  },
};

/** Alpha Vantage — all tickers, batched; carries per-ticker sentiment scores. */
export const alphaVantageSource: NewsSource = {
  name: "Alpha Vantage",
  configured: () => !!process.env.ALPHAVANTAGE_API_KEY,
  async fetch(stocks, since) {
    const out: AggregatedArticle[] = [];
    const BATCH = 5;
    for (let i = 0; i < stocks.length; i += BATCH) {
      const batch = stocks.slice(i, i + BATCH);
      const news = await getAlphaVantageNews(batch.map((s) => s.ticker), since);
      for (const a of news) {
        if (!a.url || !a.title) continue;
        const sentiment: ArticleSentiment[] = [];
        for (const ts of a.ticker_sentiment) {
          const stock = batch.find((s) => s.ticker === ts.ticker);
          if (!stock) continue;
          const score = parseFloat(ts.ticker_sentiment_score);
          const relevance = parseFloat(ts.relevance_score);
          sentiment.push({
            ticker: stock.ticker,
            score: Number.isNaN(score) ? 0 : score,
            relevance: Number.isNaN(relevance) ? 0 : relevance,
          });
        }
        out.push(
          article({
            headline: a.title,
            summary: a.summary || null,
            url: a.url,
            source: a.source,
            publishedAt: parseAlphaVantageDate(a.time_published),
            provider: "Alpha Vantage",
            stockTickers: sentiment.map((s) => s.ticker),
            sentiment,
          })
        );
      }
      await sleep(1000);
    }
    return out;
  },
};

export const DEFAULT_SOURCES: NewsSource[] = [
  finnhubSource,
  marketauxSource,
  tiingoSource,
  yahooRssSource,
  polygonSource,
  alphaVantageSource,
];

// ── Merge ─────────────────────────────────────────────────────────────────

/**
 * Merge per-provider articles by canonical URL: union the linked tickers and
 * concatenate sentiment hints, keeping the first-seen article's metadata.
 * (Cross-source headline duplicates are collapsed later by saveArticlesWithDedup.)
 */
export function mergeArticles(all: AggregatedArticle[]): AggregatedArticle[] {
  const byUrl = new Map<string, AggregatedArticle>();
  for (const a of all) {
    const key = normalizeUrl(a.url);
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, { ...a, stockTickers: [...a.stockTickers], sentiment: [...a.sentiment] });
      continue;
    }
    existing.stockTickers = [...new Set([...existing.stockTickers, ...a.stockTickers])];
    existing.sentiment = [...existing.sentiment, ...a.sentiment];
    if (a.provider !== existing.provider && !existing.provider.includes(a.provider)) {
      existing.provider = `${existing.provider}+${a.provider}`;
    }
  }
  return [...byUrl.values()];
}

/**
 * Run every configured source over `stocks`, isolating failures, and return the
 * merged article set. Unconfigured sources are recorded as non-fatal skips.
 */
export async function aggregateNews(
  stocks: SourceStock[],
  since: Date,
  sources: NewsSource[] = DEFAULT_SOURCES
): Promise<AggregateResult> {
  const collected: AggregatedArticle[] = [];
  const perProvider: Record<string, number> = {};
  const errors: string[] = [];

  for (const source of sources) {
    if (!source.configured()) {
      errors.push(`${source.name} skipped: not configured`);
      continue;
    }
    try {
      const articles = await source.fetch(stocks, since);
      perProvider[source.name] = (perProvider[source.name] ?? 0) + articles.length;
      collected.push(...articles);
    } catch (e) {
      errors.push(`${source.name} failed: ${String(e)}`);
    }
  }

  return {
    articles: mergeArticles(collected),
    fetched: collected.length,
    perProvider,
    errors,
  };
}
