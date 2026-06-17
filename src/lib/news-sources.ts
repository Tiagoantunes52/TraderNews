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
import { getAlpacaNews } from "@/lib/alpaca";
import { getYahooRssNews } from "@/lib/yahoo-rss";
import { getGoogleNews } from "@/lib/google-news";
import { normalizeUrl, isHttpUrl } from "@/lib/normalize";

// `name` (company name) is needed by name-keyed sources like Google News; it's
// optional so ticker-only callers/tests keep working.
export type SourceStock = { id: string; ticker: string; name?: string };

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

// Per-iteration isolation: adapters fetch per ticker/batch, so one unit failing
// (after fetchWithRetry's own retries) shouldn't discard the whole provider's
// coverage for the run. Return whatever was collected; only re-throw when every
// unit failed and nothing came back, so a genuine outage still surfaces as a
// provider-level error in aggregateNews.
export function partialOrThrow(out: AggregatedArticle[], failures: number, lastError: unknown): AggregatedArticle[] {
  if (out.length === 0 && failures > 0) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return out;
}

// ── Adapters ────────────────────────────────────────────────────────────────

/** Finnhub /company-news — US tickers only, ~60 req/min. */
export const finnhubSource: NewsSource = {
  name: "Finnhub",
  configured: () => !!process.env.FINNHUB_API_KEY,
  async fetch(stocks, since) {
    const out: AggregatedArticle[] = [];
    const to = new Date();
    let failures = 0;
    let lastError: unknown;
    for (const stock of stocks.filter((s) => isUsTicker(s.ticker))) {
      try {
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
      } catch (e) {
        failures++;
        lastError = e;
      }
      await sleep(1100);
    }
    return partialOrThrow(out, failures, lastError);
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
    let failures = 0;
    let lastError: unknown;
    for (let i = 0; i < nonUs.length; i += BATCH) {
      const batch = nonUs.slice(i, i + BATCH);
      try {
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
      } catch (e) {
        failures++;
        lastError = e;
      }
      await sleep(1000);
    }
    return partialOrThrow(out, failures, lastError);
  },
};

/**
 * Tiingo news — all tickers, batched.
 * The News API is a separate paid Tiingo add-on (the free/price tier returns 403
 * "You do not have permission to access the News API"), so it stays OFF unless
 * TIINGO_NEWS=1 is set — otherwise it 403s every run and clutters the error log.
 * Tiingo *price* access (a different module) is unaffected by this flag.
 */
export const tiingoSource: NewsSource = {
  name: "Tiingo",
  configured: () => !!process.env.TIINGO_API_KEY && process.env.TIINGO_NEWS === "1",
  async fetch(stocks, since) {
    const out: AggregatedArticle[] = [];
    const BATCH = 5;
    let failures = 0;
    let lastError: unknown;
    for (let i = 0; i < stocks.length; i += BATCH) {
      const batch = stocks.slice(i, i + BATCH);
      const tickerMap = new Map(batch.map((s) => [toTiingoTicker(s.ticker).toLowerCase(), s]));
      try {
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
      } catch (e) {
        failures++;
        lastError = e;
      }
      await sleep(1000);
    }
    return partialOrThrow(out, failures, lastError);
  },
};

/**
 * Alpaca News (Benzinga-sourced) — US equities only, free on the Basic plan.
 * Articles arrive already symbol-tagged, so tickers are read straight off each
 * article's `symbols` (intersected with the batched watchlist) — no headline
 * matching. Supplements Finnhub/Yahoo for US names; international stays on the
 * other sources. Alpaca accepts many symbols per request, so this batches wide.
 */
export const alpacaSource: NewsSource = {
  name: "Alpaca",
  configured: () => !!process.env.ALPACA_API_KEY_ID && !!process.env.ALPACA_API_SECRET_KEY,
  async fetch(stocks, since) {
    const out: AggregatedArticle[] = [];
    const us = stocks.filter((s) => isUsTicker(s.ticker));
    const BATCH = 10;
    let failures = 0;
    let lastError: unknown;
    for (let i = 0; i < us.length; i += BATCH) {
      const batch = us.slice(i, i + BATCH);
      const watched = new Map(batch.map((s) => [s.ticker, s]));
      try {
        const news = await getAlpacaNews([...watched.keys()], since);
        for (const a of news) {
          if (!a.url || !a.headline) continue;
          const tickers = a.symbols.filter((sym) => watched.has(sym));
          if (tickers.length === 0) continue; // tagged only with unwatched symbols
          out.push(
            article({
              headline: a.headline,
              summary: a.summary || null,
              url: a.url,
              source: a.source ? a.source[0].toUpperCase() + a.source.slice(1) : "Benzinga",
              publishedAt: new Date(a.created_at),
              provider: "Alpaca",
              stockTickers: [...new Set(tickers)],
            })
          );
        }
      } catch (e) {
        failures++;
        lastError = e;
      }
      await sleep(350);
    }
    return partialOrThrow(out, failures, lastError);
  },
};

/** Yahoo Finance RSS — free, keyless, any ticker globally. */
export const yahooRssSource: NewsSource = {
  name: "Yahoo RSS",
  configured: () => true,
  async fetch(stocks) {
    const out: AggregatedArticle[] = [];
    let failures = 0;
    let lastError: unknown;
    for (const stock of stocks) {
      try {
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
      } catch (e) {
        failures++;
        lastError = e;
      }
      await sleep(300);
    }
    return partialOrThrow(out, failures, lastError);
  },
};

/**
 * Google News RSS — local-language coverage for non-US (European) tickers,
 * keyed by company name in the exchange's locale. Keyless. This is the main
 * coverage source for Euronext / XETRA / BME / etc. names that the US-centric
 * providers and Yahoo RSS miss. US tickers are intentionally skipped (already
 * well covered) to keep request volume down and avoid noisy name collisions.
 */
export const googleNewsSource: NewsSource = {
  name: "Google News",
  configured: () => true,
  async fetch(stocks, since) {
    const out: AggregatedArticle[] = [];
    let failures = 0;
    let lastError: unknown;
    const targets = stocks.filter((s) => isNonUsTicker(s.ticker) && s.name);
    for (const stock of targets) {
      try {
        const news = await getGoogleNews(stock.name!, stock.ticker, since);
        for (const a of news) {
          out.push(
            article({
              headline: a.title,
              summary: null,
              url: a.url,
              source: a.source,
              publishedAt: a.publishedAt,
              provider: "Google News",
              stockTickers: [stock.ticker],
            })
          );
        }
      } catch (e) {
        failures++;
        lastError = e;
      }
      await sleep(400);
    }
    return partialOrThrow(out, failures, lastError);
  },
};

// Polygon.io was removed: its US-ticker news fully overlaps Finnhub + Yahoo RSS
// (which both cover the same tickers) yet its free tier forces 12s/request pacing
// (5 req/min), making it the single largest contributor to pipeline wall-time for
// no unique coverage. Finnhub + Yahoo replace it at a fraction of the cost.

/** Alpha Vantage — all tickers, batched; carries per-ticker sentiment scores. */
export const alphaVantageSource: NewsSource = {
  name: "Alpha Vantage",
  configured: () => !!process.env.ALPHAVANTAGE_API_KEY,
  async fetch(stocks, since) {
    const out: AggregatedArticle[] = [];
    const BATCH = 5;
    let failures = 0;
    let lastError: unknown;
    for (let i = 0; i < stocks.length; i += BATCH) {
      const batch = stocks.slice(i, i + BATCH);
      try {
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
      } catch (e) {
        failures++;
        lastError = e;
      }
      await sleep(1000);
    }
    return partialOrThrow(out, failures, lastError);
  },
};

export const DEFAULT_SOURCES: NewsSource[] = [
  finnhubSource,
  marketauxSource,
  tiingoSource,
  alpacaSource,
  yahooRssSource,
  alphaVantageSource,
  googleNewsSource,
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
    // Drop anything that isn't an http(s) link before it can be stored/rendered —
    // an untrusted feed could inject a javascript:/data: URL (#18).
    if (!isHttpUrl(a.url)) continue;
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
 *
 * Sources run concurrently: each adapter paces itself internally against its own
 * provider's rate limit, so overlapping them makes the stage's wall-time the
 * slowest single source rather than the sum of all of them. Failures stay
 * isolated — one source throwing never discards another's results.
 */
export async function aggregateNews(
  stocks: SourceStock[],
  since: Date,
  sources: NewsSource[] = DEFAULT_SOURCES
): Promise<AggregateResult> {
  const collected: AggregatedArticle[] = [];
  const perProvider: Record<string, number> = {};
  const errors: string[] = [];

  const settled = await Promise.allSettled(
    sources.map((source) => {
      if (!source.configured()) {
        return Promise.reject(new SourceSkipped());
      }
      return source.fetch(stocks, since);
    })
  );

  // allSettled preserves input order, so zip results back to their source.
  settled.forEach((res, i) => {
    const source = sources[i];
    if (res.status === "fulfilled") {
      perProvider[source.name] = (perProvider[source.name] ?? 0) + res.value.length;
      collected.push(...res.value);
    } else if (res.reason instanceof SourceSkipped) {
      errors.push(`${source.name} skipped: not configured`);
    } else {
      errors.push(`${source.name} failed: ${String(res.reason)}`);
    }
  });

  return {
    articles: mergeArticles(collected),
    fetched: collected.length,
    perProvider,
    errors,
  };
}

/** Sentinel rejection used to distinguish "not configured" from a real failure. */
class SourceSkipped extends Error {}
