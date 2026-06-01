import { db } from "@/lib/db";
import { getMarketNews, getStockNews } from "@/lib/finnhub";
import { getMarketauxStockNews } from "@/lib/marketaux";
import { getAlphaVantageNews, parseAlphaVantageDate } from "@/lib/alphavantage";
import { getTiingoNews, toTiingoTicker } from "@/lib/tiingo";
import { getYahooRssNews } from "@/lib/yahoo-rss";
import { getPolygonStockNews } from "@/lib/polygon";
import { analyzeSentiment } from "@/lib/llm";

export type PipelineResult = {
  articles: { fetched: number; saved: number };
  tags: number;
  sentiments: number;
  errors: string[];
};

function dateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip query params, fragments, and trailing slashes — canonical form
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

export function normalizeHeadline(headline: string): string {
  return headline.toLowerCase().replace(/\s+/g, " ").trim();
}

type ArticleData = {
  headline: string;
  summary: string | null;
  url: string;
  source: string;
  publishedAt: Date;
};

// Saves articles to the DB, deduplicating by:
//   1. Normalized URL (strips tracking params from the same article)
//   2. Exact headline match within the time window (cross-source syndication)
// Returns { saved: count of net-new articles, urlToId: original-url → articleId }
// The urlToId map covers all inputs including those resolved to an existing article.
async function saveArticlesWithDedup(
  articles: ArticleData[],
  since: Date
): Promise<{ saved: number; urlToId: Map<string, string> }> {
  if (articles.length === 0) return { saved: 0, urlToId: new Map() };

  // Normalize URLs on input
  const normalized = articles.map((a) => ({ ...a, url: normalizeUrl(a.url) }));

  // Within-batch dedup by headline — keep the first occurrence per headline.
  // Track which headline resolves to which (winner) normalized URL for later lookup.
  const headlineToWinnerUrl = new Map<string, string>();
  const deduped: ArticleData[] = [];
  for (const a of normalized) {
    const key = normalizeHeadline(a.headline);
    if (!headlineToWinnerUrl.has(key)) {
      headlineToWinnerUrl.set(key, a.url);
      deduped.push(a);
    }
  }

  // Single query: find existing articles by URL or by headline (within window)
  const existing = await db.article.findMany({
    where: {
      OR: [
        { url: { in: deduped.map((a) => a.url) } },
        { headline: { in: deduped.map((a) => a.headline) }, publishedAt: { gte: since } },
      ],
    },
    select: { id: true, url: true, headline: true },
  });
  const existingByUrl = new Map(existing.map((e) => [e.url, e.id]));
  const existingByHeadline = new Map(existing.map((e) => [normalizeHeadline(e.headline), e.id]));

  // Only create articles that are genuinely new
  const toCreate = deduped.filter(
    (a) => !existingByUrl.has(a.url) && !existingByHeadline.has(normalizeHeadline(a.headline))
  );

  if (toCreate.length > 0) {
    await db.article.createMany({ data: toCreate, skipDuplicates: true });
  }

  const created =
    toCreate.length > 0
      ? await db.article.findMany({
          where: { url: { in: toCreate.map((a) => a.url) } },
          select: { id: true, url: true },
        })
      : [];
  const createdByUrl = new Map(created.map((e) => [e.url, e.id]));

  // Build result map: original-api-url → articleId
  // For within-batch headline dupes, resolve through the winner's URL.
  const urlToId = new Map<string, string>();
  for (const original of articles) {
    const normUrl = normalizeUrl(original.url);
    const normHeadline = normalizeHeadline(original.headline);
    const winnerUrl = headlineToWinnerUrl.get(normHeadline)!;
    const id =
      createdByUrl.get(winnerUrl) ??
      existingByUrl.get(winnerUrl) ??
      existingByUrl.get(normUrl) ??
      existingByHeadline.get(normHeadline);
    if (id) urlToId.set(original.url, id);
  }

  return { saved: toCreate.length, urlToId };
}

export async function runPipeline(): Promise<PipelineResult> {
  const result: PipelineResult = { articles: { fetched: 0, saved: 0 }, tags: 0, sentiments: 0, errors: [] };

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

  // 1. Fetch and store general market news (for the news feed, not linked to stocks)
  try {
    const general = await getMarketNews("general");
    result.articles.fetched += general.length;

    const articles = general
      .filter((a) => a.url && a.headline)
      .map((a) => ({
        headline: a.headline,
        summary: a.summary ?? null,
        url: a.url,
        source: a.source,
        publishedAt: new Date(a.datetime * 1000),
      }));

    const { saved } = await saveArticlesWithDedup(articles, from);
    result.articles.saved += saved;
  } catch (e) {
    result.errors.push(`General news fetch failed: ${String(e)}`);
  }

  // 2. Fetch stock-specific news only for stocks users are watching
  const stocks = await db.stock.findMany({
    select: { id: true, ticker: true },
    where: { userStocks: { some: {} } },
  });

  // Finnhub free tier only supports /company-news for US tickers (no dot-exchange suffix, no crypto)
  const usStocks = stocks.filter((s) => !s.ticker.includes(".") && !s.ticker.endsWith("-USD"));

  for (const stock of usStocks) {
    try {
      const news = await getStockNews(stock.ticker, dateStr(from), dateStr(to));
      result.articles.fetched += news.length;

      const articles = news
        .filter((a) => a.url && a.headline)
        .map((a) => ({
          headline: a.headline,
          summary: a.summary ?? null,
          url: a.url,
          source: a.source,
          publishedAt: new Date(a.datetime * 1000),
        }));

      const { saved, urlToId } = await saveArticlesWithDedup(articles, from);
      result.articles.saved += saved;

      await db.articleStock.createMany({
        data: [...urlToId.values()].map((articleId) => ({ articleId, stockId: stock.id })),
        skipDuplicates: true,
      });
      result.tags += urlToId.size;

      // Respect Finnhub free tier rate limit (60 req/min)
      await sleep(1100);
    } catch (e) {
      result.errors.push(`Stock news failed for ${stock.ticker}: ${String(e)}`);
    }
  }

  // 2b. Marketaux for non-US stocks (Finnhub free tier doesn't support these)
  const nonUsStocks = stocks.filter((s) => s.ticker.includes("."));

  if (nonUsStocks.length > 0) {
    if (!process.env.MARKETAUX_API_KEY) {
      result.errors.push("Marketaux skipped: MARKETAUX_API_KEY not set");
    } else {
      const BATCH = 5;

      for (let i = 0; i < nonUsStocks.length; i += BATCH) {
        const batch = nonUsStocks.slice(i, i + BATCH);
        const symbols = batch.map((s) => s.ticker);

        try {
          const news = await getMarketauxStockNews(symbols, from);
          result.articles.fetched += news.length;

          const articles = news
            .filter((a) => a.url && a.title)
            .map((a) => ({
              headline: a.title,
              summary: a.description ?? null,
              url: a.url,
              source: a.source,
              publishedAt: new Date(a.published_at),
            }));

          const { saved, urlToId } = await saveArticlesWithDedup(articles, from);
          result.articles.saved += saved;

          const links: Array<{ articleId: string; stockId: string }> = [];
          for (const article of news.filter((a) => a.url && a.title)) {
            const articleId = urlToId.get(article.url);
            if (!articleId) continue;
            for (const entity of article.entities) {
              const stock = batch.find((s) => s.ticker === entity.symbol);
              if (stock) links.push({ articleId, stockId: stock.id });
            }
          }

          if (links.length > 0) {
            await db.articleStock.createMany({ data: links, skipDuplicates: true });
            result.tags += links.length;
          }

          await sleep(1000);
        } catch (e) {
          result.errors.push(`Marketaux news failed for [${symbols.join(",")}]: ${String(e)}`);
        }
      }
    }
  }

  // 2c. Tiingo for all stocks (US + international, no per-article cap)
  if (!process.env.TIINGO_API_KEY) {
    result.errors.push("Tiingo skipped: TIINGO_API_KEY not set");
  } else {
    const TIINGO_BATCH = 5;

    for (let i = 0; i < stocks.length; i += TIINGO_BATCH) {
      const batch = stocks.slice(i, i + TIINGO_BATCH);
      const tickerMap = new Map(batch.map((s) => [toTiingoTicker(s.ticker).toLowerCase(), s]));
      const tickers = [...tickerMap.keys()];

      try {
        const news = await getTiingoNews(tickers, from);
        result.articles.fetched += news.length;

        const articles = news
          .filter((a) => a.url && a.title)
          .map((a) => ({
            headline: a.title,
            summary: a.description ?? null,
            url: a.url,
            source: a.source,
            publishedAt: new Date(a.publishedDate),
          }));

        const { saved, urlToId } = await saveArticlesWithDedup(articles, from);
        result.articles.saved += saved;

        const links: Array<{ articleId: string; stockId: string }> = [];
        for (const article of news.filter((a) => a.url && a.title)) {
          const articleId = urlToId.get(article.url);
          if (!articleId) continue;
          for (const ticker of article.tickers) {
            const stock = tickerMap.get(ticker.toLowerCase());
            if (stock) links.push({ articleId, stockId: stock.id });
          }
        }

        if (links.length > 0) {
          await db.articleStock.createMany({ data: links, skipDuplicates: true });
          result.tags += links.length;
        }

        await sleep(1000);
      } catch (e) {
        result.errors.push(`Tiingo failed for [${tickers.join(",")}]: ${String(e)}`);
      }
    }
  }

  // 2d. Yahoo Finance RSS for all stocks — free, no key, any ticker globally
  for (const stock of stocks) {
    try {
      const news = await getYahooRssNews(stock.ticker);
      result.articles.fetched += news.length;

      const articles = news
        .filter((a) => a.url && a.title)
        .map((a) => ({
          headline: a.title,
          summary: a.description,
          url: a.url,
          source: "Yahoo Finance",
          publishedAt: a.publishedAt,
        }));

      const { saved, urlToId } = await saveArticlesWithDedup(articles, from);
      result.articles.saved += saved;

      await db.articleStock.createMany({
        data: [...urlToId.values()].map((articleId) => ({ articleId, stockId: stock.id })),
        skipDuplicates: true,
      });
      result.tags += urlToId.size;

      await sleep(300);
    } catch (e) {
      result.errors.push(`Yahoo RSS failed for ${stock.ticker}: ${String(e)}`);
    }
  }

  // 2e. Polygon.io for US stocks — free tier, 5 req/min
  if (!process.env.POLYGON_API_KEY) {
    result.errors.push("Polygon skipped: POLYGON_API_KEY not set");
  } else {
    for (const stock of usStocks) {
      try {
        const news = await getPolygonStockNews(stock.ticker, from);
        result.articles.fetched += news.length;

        const articles = news
          .filter((a) => a.article_url && a.title)
          .map((a) => ({
            headline: a.title,
            summary: a.description ?? null,
            url: a.article_url,
            source: a.publisher.name,
            publishedAt: new Date(a.published_utc),
          }));

        const { saved, urlToId } = await saveArticlesWithDedup(articles, from);
        result.articles.saved += saved;

        await db.articleStock.createMany({
          data: [...urlToId.values()].map((articleId) => ({ articleId, stockId: stock.id })),
          skipDuplicates: true,
        });
        result.tags += urlToId.size;

        // Polygon free tier: 5 req/min
        await sleep(12_000);
      } catch (e) {
        result.errors.push(`Polygon failed for ${stock.ticker}: ${String(e)}`);
      }
    }
  }

  // 2f. Alpha Vantage for all stocks — also collects per-article sentiment scores
  const avSentimentScores = new Map<string, number[]>(); // stockId → [score, ...]

  if (!process.env.ALPHAVANTAGE_API_KEY) {
    result.errors.push("Alpha Vantage skipped: ALPHAVANTAGE_API_KEY not set");
  } else {
    const AV_BATCH = 5;

    for (let i = 0; i < stocks.length; i += AV_BATCH) {
      const batch = stocks.slice(i, i + AV_BATCH);
      const tickers = batch.map((s) => s.ticker);

      try {
        const news = await getAlphaVantageNews(tickers, from);
        result.articles.fetched += news.length;

        const articles = news
          .filter((a) => a.url && a.title)
          .map((a) => ({
            headline: a.title,
            summary: a.summary || null,
            url: a.url,
            source: a.source,
            publishedAt: parseAlphaVantageDate(a.time_published),
          }));

        const { saved, urlToId } = await saveArticlesWithDedup(articles, from);
        result.articles.saved += saved;

        const links: Array<{ articleId: string; stockId: string }> = [];
        for (const article of news.filter((a) => a.url && a.title)) {
          const articleId = urlToId.get(article.url);
          if (!articleId) continue;

          for (const ts of article.ticker_sentiment) {
            const stock = batch.find((s) => s.ticker === ts.ticker);
            if (!stock) continue;

            links.push({ articleId, stockId: stock.id });

            const score = parseFloat(ts.ticker_sentiment_score);
            if (!Number.isNaN(score)) {
              const bucket = avSentimentScores.get(stock.id) ?? [];
              bucket.push(score);
              avSentimentScores.set(stock.id, bucket);
            }
          }
        }

        if (links.length > 0) {
          await db.articleStock.createMany({ data: links, skipDuplicates: true });
          result.tags += links.length;
        }

        await sleep(1000);
      } catch (e) {
        result.errors.push(`Alpha Vantage news failed for [${tickers.join(",")}]: ${String(e)}`);
      }
    }
  }

  // 3. LLM sentiment for all watched stocks, blended with Alpha Vantage scores where available.
  // Fetch extra headlines to account for duplicates after dedup.
  for (const stock of stocks) {
    try {
      const recentArticles = await db.article.findMany({
        where: {
          articleStock: { some: { stockId: stock.id } },
          publishedAt: { gte: from },
        },
        orderBy: { publishedAt: "desc" },
        take: 20,
        select: { headline: true },
      });

      if (recentArticles.length === 0) continue;

      // Deduplicate headlines before analysis — same story from multiple sources counts once
      const uniqueHeadlines = [
        ...new Map(recentArticles.map((a) => [normalizeHeadline(a.headline), a.headline])).values(),
      ].slice(0, 10);

      const sentiment = await analyzeSentiment(stock.ticker, uniqueHeadlines);

      const avScores = avSentimentScores.get(stock.id);
      const score =
        avScores && avScores.length > 0
          ? (sentiment.score + avScores.reduce((a, b) => a + b, 0) / avScores.length) / 2
          : sentiment.score;

      await db.sentiment.create({
        data: { stockId: stock.id, score, summary: sentiment.summary },
      });

      result.sentiments++;
    } catch (e) {
      result.errors.push(`Sentiment failed for ${stock.ticker}: ${String(e)}`);
    }
  }

  return result;
}
