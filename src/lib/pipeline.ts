import { db } from "@/lib/db";
import { getMarketNews, getStockNews, getEarningsCalendar } from "@/lib/finnhub";
import { getMarketauxStockNews } from "@/lib/marketaux";
import { getAlphaVantageNews, parseAlphaVantageDate } from "@/lib/alphavantage";
import { getTiingoNews, toTiingoTicker } from "@/lib/tiingo";
import { getYahooRssNews } from "@/lib/yahoo-rss";
import { getPolygonStockNews } from "@/lib/polygon";
import { analyzeSentiment, type SentimentArticle } from "@/lib/llm";
import { getTiingoDailyPrices } from "@/lib/tiingo-prices";
import { calcSMA, calcRSI, calcVolatility, calcMomentum, calcVolumeRatio, calcQuantScore, calcEMA, calcMACD, calcBollingerBands, calcATR, scoreToSignal } from "@/lib/indicators";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Sector ETF map for US equities — used to compute sector-relative strength
const SECTOR_ETF: Record<string, string> = {
  // Technology
  AAPL:"XLK", MSFT:"XLK", NVDA:"XLK", AMD:"XLK", INTC:"XLK", ORCL:"XLK", CRM:"XLK", ADBE:"XLK", QCOM:"XLK",
  // Communication Services (GOOGL appears in both Tech and Comm — last key wins; we use XLC)
  META:"XLC", NFLX:"XLC", GOOGL:"XLC", GOOG:"XLC", VZ:"XLC", T:"XLC", DIS:"XLC",
  // Consumer Discretionary
  AMZN:"XLY", TSLA:"XLY", HD:"XLY", MCD:"XLY", NKE:"XLY", SBUX:"XLY",
  // Consumer Staples
  PG:"XLP", KO:"XLP", PEP:"XLP", WMT:"XLP", COST:"XLP", PM:"XLP",
  // Financials
  JPM:"XLF", BAC:"XLF", GS:"XLF", MS:"XLF", C:"XLF", WFC:"XLF", BRK_B:"XLF",
  // Healthcare
  JNJ:"XLV", UNH:"XLV", PFE:"XLV", ABBV:"XLV", MRK:"XLV", LLY:"XLV",
  // Industrials
  BA:"XLI", CAT:"XLI", GE:"XLI", HON:"XLI", UPS:"XLI",
  // Energy
  XOM:"XLE", CVX:"XLE", COP:"XLE", SLB:"XLE",
  // Utilities
  NEE:"XLU", DUK:"XLU", SO:"XLU",
  // Real Estate
  AMT:"XLRE", PLD:"XLRE", EQIX:"XLRE",
  // Materials
  LIN:"XLB", APD:"XLB", NEM:"XLB",
};

export type PipelineResult = {
  articles: { fetched: number; saved: number };
  tags: number;
  sentiments: number;
  quants: number;
  estimates: number;
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
  const result: PipelineResult = { articles: { fetched: 0, saved: 0 }, tags: 0, sentiments: 0, quants: 0, estimates: 0, errors: [] };

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
  // stockId → [{score, relevance}] — collected to compute relevance-weighted mean
  const avSentimentScores = new Map<string, { score: number; relevance: number }[]>();

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

        // Collect per-article sentiment scores for upsert into ArticleStock
        const links: Array<{ articleId: string; stockId: string; sentimentScore: number }> = [];
        for (const article of news.filter((a) => a.url && a.title)) {
          const articleId = urlToId.get(article.url);
          if (!articleId) continue;

          for (const ts of article.ticker_sentiment) {
            const stock = batch.find((s) => s.ticker === ts.ticker);
            if (!stock) continue;

            const sentimentScore = parseFloat(ts.ticker_sentiment_score);
            links.push({ articleId, stockId: stock.id, sentimentScore: Number.isNaN(sentimentScore) ? 0 : sentimentScore });

            const relevance = parseFloat(ts.relevance_score);
            if (!Number.isNaN(sentimentScore) && !Number.isNaN(relevance) && relevance > 0) {
              const bucket = avSentimentScores.get(stock.id) ?? [];
              bucket.push({ score: sentimentScore, relevance });
              avSentimentScores.set(stock.id, bucket);
            }
          }
        }

        // Upsert individual article-stock links with per-article sentiment score
        for (const { articleId, stockId, sentimentScore } of links) {
          await db.articleStock.upsert({
            where: { articleId_stockId: { articleId, stockId } },
            create: { articleId, stockId, sentimentScore },
            update: { sentimentScore },
          });
        }
        result.tags += links.length;

        await sleep(1000);
      } catch (e) {
        result.errors.push(`Alpha Vantage news failed for [${tickers.join(",")}]: ${String(e)}`);
      }
    }
  }

  // Per-stock sentiment metadata for step 5 blending
  const stockSentimentMeta = new Map<string, { articleCount: number; velocityRatio: number | null }>();

  // 3. LLM sentiment for all watched stocks, blended with Alpha Vantage scores where available.
  // Fetch extra headlines to account for duplicates after dedup.
  for (const stock of stocks) {
    try {
      // Per-day dedup guard: skip if we already have a sentiment entry for today
      const todayUTC = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
      if (await db.sentiment.count({ where: { stockId: stock.id, date: { gte: todayUTC } } }) > 0) {
        result.sentiments++;
        continue;
      }

      const recentArticles = await db.article.findMany({
        where: {
          articleStock: { some: { stockId: stock.id } },
          publishedAt: { gte: from },
        },
        orderBy: { publishedAt: "desc" },
        take: 20,
        select: { headline: true, publishedAt: true, source: true },
      });

      if (recentArticles.length === 0) continue;

      // Deduplicate by normalised headline; keep the most recent occurrence
      const uniqueArticles: SentimentArticle[] = [
        ...new Map(
          recentArticles.map((a) => [normalizeHeadline(a.headline), a])
        ).values(),
      ].slice(0, 10);

      const articleCount = uniqueArticles.length;
      const avgArticleAgeHours = articleCount > 0
        ? uniqueArticles.reduce((s, a) => s + (Date.now() - a.publishedAt.getTime()) / 3_600_000, 0) / articleCount
        : null;

      // Article velocity: last-24h count vs daily average over the 7-day window
      const yesterday = new Date(to.getTime() - 86_400_000);
      const last24hCount = await db.article.count({
        where: { articleStock: { some: { stockId: stock.id } }, publishedAt: { gte: yesterday } },
      });
      const articleVelocityRatio = articleCount > 0 ? last24hCount / (articleCount / 7) : null;

      stockSentimentMeta.set(stock.id, { articleCount, velocityRatio: articleVelocityRatio });

      const sentiment = await analyzeSentiment(stock.ticker, uniqueArticles);

      const avEntries = avSentimentScores.get(stock.id);
      let avWeightedScore: number | null = null;
      if (avEntries && avEntries.length > 0) {
        const totalWeight = avEntries.reduce((s, e) => s + e.relevance, 0);
        avWeightedScore = totalWeight > 0
          ? avEntries.reduce((s, e) => s + e.score * e.relevance, 0) / totalWeight
          : avEntries.reduce((s, e) => s + e.score, 0) / avEntries.length;
      }

      const score = avWeightedScore != null
        ? (sentiment.score + avWeightedScore) / 2
        : sentiment.score;

      await db.sentiment.create({
        data: { stockId: stock.id, score, summary: sentiment.summary, articleCount, avgArticleAgeHours },
      });

      result.sentiments++;
    } catch (e) {
      result.errors.push(`Sentiment failed for ${stock.ticker}: ${String(e)}`);
    }
  }

  // 4. Quantitative analysis — fetch 60 days of price history and compute indicators
  const from60 = new Date(to.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Fetch SPY as benchmark for relative strength
  let spyChange7d: number | null = null;
  try {
    const spyPrices = await getTiingoDailyPrices("SPY", from60);
    if (spyPrices.length >= 8) spyChange7d = calcMomentum(spyPrices.map(p => p.close), 7);
  } catch { /* benchmark failure doesn't block per-stock analysis */ }

  // Fetch next 30-day earnings calendar (one API call for all stocks)
  const earningsTo = new Date(to.getTime() + 30 * 24 * 60 * 60 * 1000);
  const earningsByTicker = new Map<string, Date>();
  try {
    const calendar = await getEarningsCalendar(dateStr(to), dateStr(earningsTo));
    for (const event of calendar) {
      if (!earningsByTicker.has(event.symbol)) {
        earningsByTicker.set(event.symbol, new Date(event.date));
      }
    }
  } catch { /* earnings fetch failure doesn't block quant */ }

  // Collect unique sector ETFs needed for the current watchlist (US stocks only)
  const neededEtfs = new Set<string>();
  for (const s of usStocks) {
    const etf = SECTOR_ETF[s.ticker];
    if (etf) neededEtfs.add(etf);
  }

  // Fetch sector ETF 7-day returns
  const sectorChange7d = new Map<string, number>(); // ETF ticker → 7d return
  for (const etf of neededEtfs) {
    try {
      const etfPrices = await getTiingoDailyPrices(etf, from60);
      if (etfPrices.length >= 8) {
        const change = calcMomentum(etfPrices.map(p => p.close), 7);
        if (change != null) sectorChange7d.set(etf, change);
      }
    } catch { /* sector ETF failure doesn't block */ }
  }

  // Per-stock quant metadata for step 5 blending
  const stockQuantMeta = new Map<string, { quantScore: number; volatility30d: number | null; daysToEarnings: number | null }>();

  for (const stock of stocks) {
    try {
      // Per-day dedup guard
      const todayUTC = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
      if (await db.quantAnalysis.count({ where: { stockId: stock.id, date: { gte: todayUTC } } }) > 0) {
        result.quants++;
        continue;
      }

      const prices = await getTiingoDailyPrices(stock.ticker, from60);
      if (prices.length < 2) continue; // insufficient data — skip gracefully

      const closes = prices.map((p) => p.close);
      const volumes = prices.map((p) => p.volume);
      const highs = prices.map((p) => p.high);
      const lows = prices.map((p) => p.low);
      const isCrypto = stock.ticker.endsWith("-USD");

      const price = closes[closes.length - 1];
      const change1d = calcMomentum(closes, 1);
      const change7d = calcMomentum(closes, 7);
      const change30d = calcMomentum(closes, 30);
      const rsi14 = calcRSI(closes);
      const sma20 = calcSMA(closes, 20);
      const sma50 = calcSMA(closes, 50);
      const volatility30d = calcVolatility(closes);
      const volumeRatio10d = calcVolumeRatio(volumes);

      const macdResult = calcMACD(closes);
      const macdHistogram = macdResult?.histogram ?? null;
      const high60d = Math.max(...closes);
      const low60d = Math.min(...closes);
      const priceVs60dHigh = price != null ? ((price - high60d) / high60d) * 100 : null;
      const priceVs60dLow = price != null ? ((price - low60d) / low60d) * 100 : null;
      const relativeStr7d = change7d != null && spyChange7d != null ? change7d - spyChange7d : null;

      // Bollinger Bands
      const bollingerResult = calcBollingerBands(closes);
      const bollingerWidth = bollingerResult?.width ?? null;
      const bollingerPctB = bollingerResult?.percentB ?? null;

      // ATR(14)
      const atr14 = calcATR(highs, lows, closes);
      const atrPct = atr14 != null && price != null ? (atr14 / price) * 100 : null;

      // Earnings date proximity (skip crypto — Finnhub only covers equities)
      const nextEarningsDate = !isCrypto ? (earningsByTicker.get(stock.ticker) ?? null) : null;
      const daysToEarnings = nextEarningsDate
        ? Math.ceil((nextEarningsDate.getTime() - to.getTime()) / (24 * 60 * 60 * 1000))
        : null;

      // Sector-relative strength (US equities only)
      const sectorEtf = SECTOR_ETF[stock.ticker];
      const sectorReturn = sectorEtf ? sectorChange7d.get(sectorEtf) ?? null : null;
      const relativeStrSector7d = change7d != null && sectorReturn != null
        ? change7d - sectorReturn
        : null;

      const score = calcQuantScore({ rsi14, change7d, sma20, price, volatility30d, volumeRatio10d, isCrypto, macdHistogram, relativeStr7d, bollingerPctB });

      await db.quantAnalysis.create({
        data: { stockId: stock.id, price, change1d, change7d, change30d, rsi14, sma20, sma50, volatility30d, volumeRatio10d, macdHistogram, priceVs60dHigh, priceVs60dLow, relativeStr7d, bollingerWidth, bollingerPctB, atr14, atrPct, nextEarningsDate, daysToEarnings, relativeStrSector7d, score },
      });

      stockQuantMeta.set(stock.id, { quantScore: score, volatility30d: volatility30d ?? null, daysToEarnings });

      result.quants++;
      await sleep(500);
    } catch (e) {
      result.errors.push(`Quant failed for ${stock.ticker}: ${String(e)}`);
    }
  }

  // 5. Combined estimate — blend latest sentiment + quant scores for each stock
  for (const stock of stocks) {
    try {
      // Per-day dedup guard
      const todayUTC = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
      if (await db.stockEstimate.count({ where: { stockId: stock.id, date: { gte: todayUTC } } }) > 0) {
        result.estimates++;
        continue;
      }

      const latestSentiment = await db.sentiment.findFirst({
        where: { stockId: stock.id },
        orderBy: { date: "desc" },
        select: { score: true },
      });

      if (!latestSentiment) continue;

      const latestQuant = await db.quantAnalysis.findFirst({
        where: { stockId: stock.id },
        orderBy: { date: "desc" },
        select: { score: true },
      });

      const sentimentScore = latestSentiment.score;
      const quantScore = latestQuant?.score ?? null;

      // Dynamic blending based on article count and volatility
      const meta = stockSentimentMeta.get(stock.id);
      const articleCount = meta?.articleCount ?? 0;
      const vol = stockQuantMeta.get(stock.id)?.volatility30d ?? null;
      const daysToEarnings = stockQuantMeta.get(stock.id)?.daysToEarnings ?? null;

      const sentWeight = Math.min(0.30 + (articleCount / 15) * 0.30, 0.60);
      const quantWeight = 1 - sentWeight;
      const volPenalty = vol != null ? Math.min(Math.max((vol - 0.35) / 0.40, 0), 0.20) : 0;
      const adjQuantWeight = Math.max(quantWeight - volPenalty, 0.10);
      const adjSentWeight = 1 - adjQuantWeight;

      const combinedScore = quantScore != null
        ? clamp(sentimentScore * adjSentWeight + quantScore * adjQuantWeight, -1, 1)
        : sentimentScore;

      // Confidence and warnings
      let confidence = 0.5;
      const warnings: string[] = [];
      if (articleCount < 3) { confidence -= 0.2; warnings.push(`Low article count (${articleCount})`); }
      if (quantScore == null) { confidence -= 0.15; warnings.push("No price data — sentiment only"); }
      if (vol != null && vol > 0.60) { confidence -= 0.10; warnings.push("High volatility — quant signals dampened"); }
      if (quantScore != null && sentimentScore * quantScore < 0) {
        confidence -= 0.15;
        warnings.push("Signal disagreement between sentiment and quant");
      }
      if (daysToEarnings != null && daysToEarnings <= 5) {
        confidence -= 0.10;
        warnings.push(`Earnings in ${daysToEarnings} day(s) — signals may be unreliable`);
      }
      confidence = Math.max(0.1, Math.min(1.0, confidence + (articleCount >= 10 ? 0.15 : 0)));

      // Sentiment delta vs 7 days ago
      const sevenDaysAgo = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
      const oldEstimate = await db.stockEstimate.findFirst({
        where: { stockId: stock.id, date: { lte: sevenDaysAgo } },
        orderBy: { date: "desc" },
        select: { combinedScore: true },
      });
      const sentimentDelta = oldEstimate ? combinedScore - oldEstimate.combinedScore : null;

      const articleVelocityRatio = meta?.velocityRatio ?? null;

      await db.stockEstimate.create({
        data: {
          stockId: stock.id,
          sentimentScore,
          quantScore,
          combinedScore,
          signal: scoreToSignal(combinedScore),
          confidence,
          dataWarnings: warnings,
          sentimentDelta,
          articleVelocityRatio,
        },
      });

      result.estimates++;
    } catch (e) {
      result.errors.push(`Estimate failed for ${stock.ticker}: ${String(e)}`);
    }
  }

  return result;
}
