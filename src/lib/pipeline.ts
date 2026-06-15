import { db } from "@/lib/db";
import { getMarketNews, getEarningsCalendar, getInsiderSentiment } from "@/lib/finnhub";
import { getEtfProfile } from "@/lib/alphavantage";
import { getCryptoFearGreed } from "@/lib/crypto-fng";
import { isEtf } from "@/lib/etf";
import { analyzeSentiment, type SentimentArticle } from "@/lib/llm";
import { blendSentiment } from "@/lib/sentiment-blend";
import { getDailyPrices } from "@/lib/price-sources";
import { calcSMA, calcRSI, calcVolatility, calcMomentum, calcVolumeRatio, calcQuantScore, calcMACD, calcBollingerBands, calcATR, scoreToSignal } from "@/lib/indicators";
import { SECTOR_ETF } from "@/lib/sectors";
import { normalizeUrl, normalizeHeadline } from "@/lib/normalize";
import { aggregateNews } from "@/lib/news-sources";
import { detectSignalChange, detectVelocitySpike, detectRsiCross, type AlertDraft } from "@/lib/alerts";
import { isEmailConfigured, sendEmail, buildAlertEmail } from "@/lib/email";
import { processWithBudget } from "@/lib/concurrency";
import { getInsiderTxns, isInsiderEligible } from "@/lib/insider-sources";
import { summarizeInsider, detectInsiderClusterBuy, detectInsiderFlowShift, detectCsuiteBuy } from "@/lib/insider-detect";
import { getCongressTrades, isCongressConfigured, isCongressEligible } from "@/lib/congress-trades";
import {
  STRATEGIES,
  STRATEGY_BOOK,
  deriveSignals,
  reconcilePosition,
  summarizeBook,
  confidenceNotional,
  isPaperTradeEligible,
  isEntrySignal,
} from "@/lib/paper-trading";
import {
  isPaperTradingConfigured,
  getAccount,
  getPositions,
  submitMarketOrder,
  getOrder,
} from "@/lib/alpaca-trading";
import { reportError } from "@/lib/observability";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Per-invocation work budget and per-stage concurrency. Stages stop scheduling
// new stocks once the budget elapses and report what's left so a follow-up
// invocation resumes — keeping any single serverless call well under its limit.
// All tunable via env without a redeploy.
const STAGE_BUDGET_MS = Number(process.env.PIPELINE_STAGE_BUDGET_MS) || 240_000;
const SENTIMENT_CONCURRENCY = Number(process.env.PIPELINE_SENTIMENT_CONCURRENCY) || 3;
const QUANT_CONCURRENCY = Number(process.env.PIPELINE_QUANT_CONCURRENCY) || 3;
const ESTIMATE_CONCURRENCY = Number(process.env.PIPELINE_ESTIMATE_CONCURRENCY) || 5;
// Insider stage makes 2 Finnhub calls per stock (transactions + sentiment), so a
// gentler concurrency keeps clear of the rate limit. Backfill = trailing window
// fetched each run; the per-day summary guard makes steady-state re-fetches cheap.
const INSIDER_CONCURRENCY = Number(process.env.PIPELINE_INSIDER_CONCURRENCY) || 2;
const INSIDER_BACKFILL_DAYS = Number(process.env.INSIDER_BACKFILL_DAYS) || 90;
// Congress disclosures lag the trade by up to 45 days (STOCK Act), so a wide
// trailing window keeps newly-disclosed older trades in view. AInvest's free tier
// throttles hard (status 4014), so the stage runs serially (concurrency 1) and the
// source paces + backs off per request; the 45-day lag makes the latency a non-issue.
const CONGRESS_CONCURRENCY = Number(process.env.PIPELINE_CONGRESS_CONCURRENCY) || 1;
const CONGRESS_BACKFILL_DAYS = Number(process.env.CONGRESS_BACKFILL_DAYS) || 180;

export type PipelineResult = {
  articles: { fetched: number; saved: number };
  tags: number;
  sentiments: number;
  quants: number;
  estimates: number;
  insider: number;
  alerts: number;
  errors: string[];
};

export type StageOptions = { budgetMs?: number; concurrency?: number };

export type NewsStageResult = {
  stage: "news";
  articles: { fetched: number; saved: number };
  tags: number;
  errors: string[];
  done: true;
};

/**
 * Outcome of a per-stock stage invocation.
 * `done` means the whole worklist was *attempted* this invocation (the GH Actions
 * orchestrator loops until it sees `done: true`). A stock can be attempted without
 * producing a row — e.g. it has no linked articles, or its fetch failed — in which
 * case it stays in the next worklist and is retried, but it never blocks `done`.
 */
export type BatchStageResult = {
  stage: "sentiment" | "quant" | "estimate" | "insider";
  attempted: number; // worklist items handled this invocation (incl. skips/failures)
  created: number; // DB rows actually written
  remaining: number; // worklist items deferred to a later invocation (budget hit)
  done: boolean;
  alerts: number; // alerts persisted (estimate stage only)
  errors: string[];
};

type PendingAlert = { stockId: string; ticker: string; draft: AlertDraft };

/**
 * Persist new alert events and email watchers (one digest per recipient).
 * Only users with alertEmails enabled and an email on file are notified.
 */
async function processAlerts(pending: PendingAlert[]): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = [];
  if (pending.length === 0) return { count: 0, errors };

  await db.alert.createMany({
    data: pending.map((p) => ({
      stockId: p.stockId,
      type: p.draft.type,
      title: p.draft.title,
      message: p.draft.message,
      value: p.draft.value,
    })),
  });

  if (!isEmailConfigured()) return { count: pending.length, errors };

  const stockIds = [...new Set(pending.map((p) => p.stockId))];
  const watchers = await db.userStock.findMany({
    where: { stockId: { in: stockIds }, user: { alertEmails: true, email: { not: null } } },
    select: { stockId: true, user: { select: { id: true, email: true } } },
  });

  // Group alerts per recipient so each user gets a single digest.
  const byUser = new Map<string, { email: string; drafts: AlertDraft[] }>();
  for (const w of watchers) {
    if (!w.user.email) continue;
    const entry = byUser.get(w.user.id) ?? { email: w.user.email, drafts: [] };
    for (const p of pending) {
      if (p.stockId === w.stockId) entry.drafts.push(p.draft);
    }
    byUser.set(w.user.id, entry);
  }

  for (const { email, drafts } of byUser.values()) {
    if (drafts.length === 0) continue;
    const { subject, html, text } = buildAlertEmail(drafts);
    const res = await sendEmail({ to: email, subject, html, text });
    if (!res.ok) errors.push(`Alert email to ${email} failed: ${res.error}`);
  }

  return { count: pending.length, errors };
}

function dateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** UTC midnight of the given date — the boundary for "already done today" guards. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Re-exported so existing imports from "@/lib/pipeline" keep working.
export { normalizeUrl, normalizeHeadline };

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
    // Narrow to Article columns only: callers may pass richer objects (e.g.
    // AggregatedArticle carries provider/stockTickers/sentiment), which Prisma
    // would reject as unknown arguments.
    await db.article.createMany({
      data: toCreate.map((a) => ({
        headline: a.headline,
        summary: a.summary,
        url: a.url,
        source: a.source,
        publishedAt: a.publishedAt,
      })),
      skipDuplicates: true,
    });
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

/** Watched stocks (those at least one user holds). */
function watchedStocksWhere() {
  return { userStocks: { some: {} } } as const;
}

// ── Stage 1: News ───────────────────────────────────────────────────────────
//
// Fetch general market news + stock-specific news across every configured
// source, dedupe-save, and link articles to watched stocks (persisting Alpha
// Vantage per-(article,stock) sentiment score + relevance so the later sentiment
// stage can reconstruct the relevance-weighted blend). Cheap enough to finish in
// one invocation now that Polygon's 12s/req pacing is gone and sources run
// concurrently, so this stage is always single-shot (`done: true`).
export async function runNewsStage(): Promise<NewsStageResult> {
  const errors: string[] = [];
  let fetched = 0;
  let saved = 0;
  let tags = 0;

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

  // 1. General market news (for the news feed, not linked to stocks)
  try {
    const general = await getMarketNews("general");
    fetched += general.length;

    const articles = general
      .filter((a) => a.url && a.headline)
      .map((a) => ({
        headline: a.headline,
        summary: a.summary ?? null,
        url: a.url,
        source: a.source,
        publishedAt: new Date(a.datetime * 1000),
      }));

    const r = await saveArticlesWithDedup(articles, from);
    saved += r.saved;
  } catch (e) {
    errors.push(`General news fetch failed: ${String(e)}`);
    reportError("news_general_fetch_failed", e, { stage: "news" });
  }

  // 2. Stock-specific news for watched stocks — one centralised concurrent pass.
  const stocks = await db.stock.findMany({
    select: { id: true, ticker: true, name: true },
    where: watchedStocksWhere(),
  });

  if (stocks.length > 0) {
    const tickerToStock = new Map(stocks.map((s) => [s.ticker, s]));
    const agg = await aggregateNews(stocks, from);
    fetched += agg.fetched;
    errors.push(...agg.errors);

    const r = await saveArticlesWithDedup(agg.articles, from);
    saved += r.saved;
    const urlToId = r.urlToId;

    const plainLinks: Array<{ articleId: string; stockId: string }> = [];
    const sentimentLinks: Array<{ articleId: string; stockId: string; score: number; relevance: number }> = [];

    for (const art of agg.articles) {
      const articleId = urlToId.get(art.url);
      if (!articleId) continue;

      // Links carrying a precomputed per-article sentiment score (Alpha Vantage)
      const scored = new Set<string>();
      for (const s of art.sentiment) {
        const stock = tickerToStock.get(s.ticker);
        if (!stock) continue;
        sentimentLinks.push({ articleId, stockId: stock.id, score: s.score, relevance: s.relevance });
        scored.add(s.ticker);
      }

      // Plain links for the remaining linked tickers
      for (const ticker of art.stockTickers) {
        if (scored.has(ticker)) continue;
        const stock = tickerToStock.get(ticker);
        if (stock) plainLinks.push({ articleId, stockId: stock.id });
      }
    }

    if (plainLinks.length > 0) {
      await db.articleStock.createMany({ data: plainLinks, skipDuplicates: true });
      tags += plainLinks.length;
    }
    for (const { articleId, stockId, score, relevance } of sentimentLinks) {
      await db.articleStock.upsert({
        where: { articleId_stockId: { articleId, stockId } },
        create: { articleId, stockId, sentimentScore: score, sentimentRelevance: relevance },
        update: { sentimentScore: score, sentimentRelevance: relevance },
      });
    }
    tags += sentimentLinks.length;
  }

  return { stage: "news", articles: { fetched, saved }, tags, errors, done: true };
}

// ── Stage 2: Sentiment ──────────────────────────────────────────────────────
//
// LLM sentiment for each watched stock that doesn't yet have a row dated today,
// blended with Alpha Vantage scores (read back from ArticleStock) and a crypto
// Fear & Greed prior. Runs with bounded concurrency under a time budget.
export async function runSentimentStage(opts: StageOptions = {}): Promise<BatchStageResult> {
  const errors: string[] = [];
  let created = 0;

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const todayUTC = startOfUtcDay(to);

  // Market-wide crypto Fear & Greed — fetched once per invocation.
  let cryptoFngScore: number | null = null;
  try {
    const fng = await getCryptoFearGreed();
    cryptoFngScore = fng?.score ?? null;
  } catch (e) {
    errors.push(`Crypto Fear & Greed failed: ${String(e)}`);
  }

  const worklist = await db.stock.findMany({
    where: { ...watchedStocksWhere(), sentiments: { none: { date: { gte: todayUTC } } } },
    select: { id: true, ticker: true },
  });

  const outcome = await processWithBudget(
    worklist,
    async (stock) => {
      try {
        const recentArticles = await db.article.findMany({
          where: {
            articleStock: { some: { stockId: stock.id } },
            publishedAt: { gte: from },
          },
          orderBy: { publishedAt: "desc" },
          take: 20,
          select: { headline: true, summary: true, publishedAt: true, source: true },
        });

        if (recentArticles.length === 0) return; // attempted, nothing to score

        // Deduplicate by normalised headline; keep the most recent occurrence
        const uniqueArticles: SentimentArticle[] = [
          ...new Map(recentArticles.map((a) => [normalizeHeadline(a.headline), a])).values(),
        ].slice(0, 10);

        const articleCount = uniqueArticles.length;
        const avgArticleAgeHours =
          articleCount > 0
            ? uniqueArticles.reduce((s, a) => s + (Date.now() - a.publishedAt.getTime()) / 3_600_000, 0) / articleCount
            : null;

        // Alpha Vantage per-(article,stock) sentiment, persisted by the news stage.
        const avLinks = await db.articleStock.findMany({
          where: {
            stockId: stock.id,
            sentimentScore: { not: null },
            article: { publishedAt: { gte: from } },
          },
          select: { sentimentScore: true, sentimentRelevance: true },
        });
        let avWeightedScore: number | null = null;
        let avRelevanceTotal = 0;
        if (avLinks.length > 0) {
          avRelevanceTotal = avLinks.reduce((s, e) => s + (e.sentimentRelevance ?? 0), 0);
          avWeightedScore =
            avRelevanceTotal > 0
              ? avLinks.reduce((s, e) => s + e.sentimentScore! * (e.sentimentRelevance ?? 0), 0) / avRelevanceTotal
              : avLinks.reduce((s, e) => s + e.sentimentScore!, 0) / avLinks.length;
        }

        const sentiment = await analyzeSentiment(stock.ticker, uniqueArticles);

        // Evidence-weighted blend: the LLM signal is weighted by its own confidence
        // and how many headlines it read; Alpha Vantage by reported relevance; and
        // crypto Fear & Greed enters only as a small market-wide prior.
        const isCrypto = stock.ticker.endsWith("-USD");
        const score = blendSentiment({
          llmScore: sentiment.score,
          llmConfidence: sentiment.confidence,
          articleCount,
          avScore: avWeightedScore,
          avRelevanceTotal,
          avCount: avLinks.length,
          fngScore: isCrypto ? cryptoFngScore : null,
        });

        await db.sentiment.create({
          data: {
            stockId: stock.id,
            score,
            summary: sentiment.summary,
            confidence: sentiment.confidence,
            keyDriver: sentiment.keyDriver,
            aspects: sentiment.aspects,
            articleCount,
            avgArticleAgeHours,
          },
        });

        created++;
      } catch (e) {
        // Caught (not rethrown) so one bad stock doesn't abort the pool; it simply
        // produces no row and reappears in the next invocation's worklist.
        errors.push(`Sentiment failed for ${stock.ticker}: ${String(e)}`);
      }
    },
    { concurrency: opts.concurrency ?? SENTIMENT_CONCURRENCY, deadline: Date.now() + (opts.budgetMs ?? STAGE_BUDGET_MS) }
  );

  return {
    stage: "sentiment",
    attempted: outcome.processed,
    created,
    remaining: outcome.remaining,
    done: outcome.done,
    alerts: 0,
    errors,
  };
}

// ── Stage 3: Quant ──────────────────────────────────────────────────────────
//
// Price-history indicators for each watched stock lacking today's row. Shared
// benchmarks (SPY, earnings calendar, sector ETFs) are fetched once per
// invocation; per-stock work runs with bounded concurrency under a time budget.
// ETF profiles (weekly-refreshed) are topped up best-effort if budget remains.
export async function runQuantStage(opts: StageOptions = {}): Promise<BatchStageResult> {
  const errors: string[] = [];
  let created = 0;

  const to = new Date();
  const todayUTC = startOfUtcDay(to);
  const from60 = new Date(to.getTime() - 60 * 24 * 60 * 60 * 1000);
  const deadline = Date.now() + (opts.budgetMs ?? STAGE_BUDGET_MS);

  // All watched stocks (for benchmark/sector setup), and the US subset.
  const stocks = await db.stock.findMany({ where: watchedStocksWhere(), select: { id: true, ticker: true } });
  const usStocks = stocks.filter((s) => !s.ticker.includes(".") && !s.ticker.endsWith("-USD"));

  // SPY benchmark for relative strength
  let spyChange7d: number | null = null;
  try {
    const { prices: spyPrices } = await getDailyPrices("SPY", from60);
    if (spyPrices.length >= 8) spyChange7d = calcMomentum(spyPrices.map((p) => p.close), 7);
  } catch {
    /* benchmark failure doesn't block per-stock analysis */
  }

  // Next 30-day earnings calendar (one API call for all stocks)
  const earningsTo = new Date(to.getTime() + 30 * 24 * 60 * 60 * 1000);
  const earningsByTicker = new Map<string, Date>();
  try {
    const calendar = await getEarningsCalendar(dateStr(to), dateStr(earningsTo));
    for (const event of calendar) {
      if (!earningsByTicker.has(event.symbol)) {
        earningsByTicker.set(event.symbol, new Date(event.date));
      }
    }
  } catch {
    /* earnings fetch failure doesn't block quant */
  }

  // Sector ETF 7-day returns for the US watchlist
  const neededEtfs = new Set<string>();
  for (const s of usStocks) {
    const etf = SECTOR_ETF[s.ticker];
    if (etf) neededEtfs.add(etf);
  }
  const sectorChange7d = new Map<string, number>();
  for (const etf of neededEtfs) {
    try {
      const { prices: etfPrices } = await getDailyPrices(etf, from60);
      if (etfPrices.length >= 8) {
        const change = calcMomentum(etfPrices.map((p) => p.close), 7);
        if (change != null) sectorChange7d.set(etf, change);
      }
    } catch {
      /* sector ETF failure doesn't block */
    }
  }

  const worklist = await db.stock.findMany({
    where: { ...watchedStocksWhere(), quantAnalyses: { none: { date: { gte: todayUTC } } } },
    select: { id: true, ticker: true },
  });

  const outcome = await processWithBudget(
    worklist,
    async (stock) => {
      try {
        const { prices, errors: priceErrors } = await getDailyPrices(stock.ticker, from60);
        errors.push(...priceErrors);
        if (prices.length < 2) return; // insufficient data — attempted, skip gracefully

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

        const bollingerResult = calcBollingerBands(closes);
        const bollingerWidth = bollingerResult?.width ?? null;
        const bollingerPctB = bollingerResult?.percentB ?? null;

        const atr14 = calcATR(highs, lows, closes);
        const atrPct = atr14 != null && price != null ? (atr14 / price) * 100 : null;

        // Earnings date proximity (skip crypto — Finnhub only covers equities)
        const nextEarningsDate = !isCrypto ? earningsByTicker.get(stock.ticker) ?? null : null;
        const daysToEarnings = nextEarningsDate
          ? Math.ceil((nextEarningsDate.getTime() - to.getTime()) / (24 * 60 * 60 * 1000))
          : null;

        // Sector-relative strength (US equities only)
        const sectorEtf = SECTOR_ETF[stock.ticker];
        const sectorReturn = sectorEtf ? sectorChange7d.get(sectorEtf) ?? null : null;
        const relativeStrSector7d = change7d != null && sectorReturn != null ? change7d - sectorReturn : null;

        const score = calcQuantScore({ rsi14, change7d, sma20, price, volatility30d, volumeRatio10d, isCrypto, macdHistogram, relativeStr7d, bollingerPctB });

        await db.quantAnalysis.create({
          data: { stockId: stock.id, price, change1d, change7d, change30d, rsi14, sma20, sma50, volatility30d, volumeRatio10d, macdHistogram, priceVs60dHigh, priceVs60dLow, relativeStr7d, bollingerWidth, bollingerPctB, atr14, atrPct, nextEarningsDate, daysToEarnings, relativeStrSector7d, score },
        });

        created++;
      } catch (e) {
        errors.push(`Quant failed for ${stock.ticker}: ${String(e)}`);
      }
    },
    { concurrency: opts.concurrency ?? QUANT_CONCURRENCY, deadline }
  );

  // ETF profiles — holdings, sector weights, expense ratio (Alpha Vantage).
  // Refreshed at most weekly; best-effort, only while budget remains.
  if (process.env.ALPHAVANTAGE_API_KEY) {
    const staleBefore = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    for (const stock of stocks.filter((s) => isEtf(s.ticker))) {
      if (Date.now() >= deadline) break;
      try {
        const existing = await db.etfProfile.findUnique({
          where: { stockId: stock.id },
          select: { updatedAt: true },
        });
        if (existing && existing.updatedAt > staleBefore) continue; // still fresh

        const profile = await getEtfProfile(stock.ticker);
        if (!profile) continue;

        const data = {
          netAssets: profile.netAssets,
          expenseRatio: profile.expenseRatio,
          dividendYield: profile.dividendYield,
          inceptionDate: profile.inceptionDate ? new Date(profile.inceptionDate) : null,
          sectors: profile.sectors,
          holdings: profile.holdings,
        };
        await db.etfProfile.upsert({
          where: { stockId: stock.id },
          create: { stockId: stock.id, ...data },
          update: data,
        });

        await sleep(1000);
      } catch (e) {
        errors.push(`ETF profile failed for ${stock.ticker}: ${String(e)}`);
      }
    }
  }

  return {
    stage: "quant",
    attempted: outcome.processed,
    created,
    remaining: outcome.remaining,
    done: outcome.done,
    alerts: 0,
    errors,
  };
}

// ── Stage 4: Estimate ───────────────────────────────────────────────────────
//
// Blend the latest sentiment + quant rows into a combined estimate for each
// watched stock whose today estimate is missing OR stale — i.e. a newer sentiment
// has landed since the estimate was last computed (e.g. the morning run estimated
// off yesterday's sentiment because today's hadn't arrived yet, then the real
// sentiment landed hours later). Today's estimate is refreshed in place so
// everything that reads it (the analysis page, the paper book) tracks the latest
// sentiment. All alerts (RSI extreme, signal change, velocity spike) are
// detected/persisted here so watchers get one digest.
export async function runEstimateStage(opts: StageOptions = {}): Promise<BatchStageResult> {
  const errors: string[] = [];
  let created = 0;
  const pendingAlerts: PendingAlert[] = [];

  const to = new Date();
  const todayUTC = startOfUtcDay(to);
  const sevenDaysAgo = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const yesterday = new Date(to.getTime() - 86_400_000);

  // Watched stocks whose today estimate is missing or stale. "Stale" = a sentiment
  // newer than the estimate's last computation has landed. The estimate snapshots
  // the sentiment score, so it must be recomputed when sentiment moves — otherwise
  // a delayed sentiment leaves the day's estimate (and the signal the paper book
  // trades on) frozen on the prior day's read.
  const watched = await db.stock.findMany({
    where: watchedStocksWhere(),
    select: { id: true, ticker: true },
  });
  const watchedIds = watched.map((s) => s.id);
  const [sentMax, estToday] = await Promise.all([
    db.sentiment.groupBy({ by: ["stockId"], where: { stockId: { in: watchedIds } }, _max: { date: true } }),
    db.stockEstimate.groupBy({
      by: ["stockId"],
      where: { stockId: { in: watchedIds }, date: { gte: todayUTC } },
      _max: { date: true },
    }),
  ]);
  const latestSentimentAt = new Map(sentMax.map((r) => [r.stockId, r._max.date]));
  const todayEstimateAt = new Map(estToday.map((r) => [r.stockId, r._max.date]));
  const worklist = watched.filter((s) => {
    const sAt = latestSentimentAt.get(s.id);
    if (!sAt) return false; // no sentiment yet → nothing to estimate from
    const eAt = todayEstimateAt.get(s.id);
    return !eAt || eAt.getTime() < sAt.getTime();
  });

  const outcome = await processWithBudget(
    worklist,
    async (stock) => {
      try {
        const latestSentiment = await db.sentiment.findFirst({
          where: { stockId: stock.id },
          orderBy: { date: "desc" },
          select: { score: true, confidence: true, articleCount: true },
        });
        if (!latestSentiment) return; // can't estimate without sentiment; attempted

        // Two most recent quant rows: today's (for the score) and the previous
        // one (for RSI-cross detection).
        const recentQuant = await db.quantAnalysis.findMany({
          where: { stockId: stock.id },
          orderBy: { date: "desc" },
          take: 2,
          select: { score: true, volatility30d: true, daysToEarnings: true, rsi14: true },
        });
        const latestQuant = recentQuant[0] ?? null;
        const prevRsi = recentQuant[1]?.rsi14 ?? null;

        const sentimentScore = latestSentiment.score;
        const quantScore = latestQuant?.score ?? null;
        const articleCount = latestSentiment.articleCount ?? 0;
        const vol = latestQuant?.volatility30d ?? null;
        const daysToEarnings = latestQuant?.daysToEarnings ?? null;

        // Article velocity: last-24h count vs daily average over the 7-day window.
        const last24hCount = await db.article.count({
          where: { articleStock: { some: { stockId: stock.id } }, publishedAt: { gte: yesterday } },
        });
        const articleVelocityRatio = articleCount > 0 ? last24hCount / (articleCount / 7) : null;

        // Dynamic blending based on article count and volatility
        const sentWeight = Math.min(0.3 + (articleCount / 15) * 0.3, 0.6);
        const quantWeight = 1 - sentWeight;
        const volPenalty = vol != null ? Math.min(Math.max((vol - 0.35) / 0.4, 0), 0.2) : 0;
        const adjQuantWeight = Math.max(quantWeight - volPenalty, 0.1);
        const adjSentWeight = 1 - adjQuantWeight;

        const combinedScore =
          quantScore != null ? clamp(sentimentScore * adjSentWeight + quantScore * adjQuantWeight, -1, 1) : sentimentScore;

        // Confidence: start from the model's own confidence, then apply penalties.
        let confidence = latestSentiment.confidence ?? 0.5;
        const warnings: string[] = [];
        if (articleCount < 3) {
          confidence -= 0.2;
          warnings.push(`Low article count (${articleCount})`);
        }
        if (quantScore == null) {
          confidence -= 0.15;
          warnings.push("No price data — sentiment only");
        }
        if (vol != null && vol > 0.6) {
          confidence -= 0.1;
          warnings.push("High volatility — quant signals dampened");
        }
        if (quantScore != null && sentimentScore * quantScore < 0) {
          confidence -= 0.15;
          warnings.push("Signal disagreement between sentiment and quant");
        }
        if (daysToEarnings != null && daysToEarnings <= 5) {
          confidence -= 0.1;
          warnings.push(`Earnings in ${daysToEarnings} day(s) — signals may be unreliable`);
        }
        confidence = Math.max(0.1, Math.min(1.0, confidence + (articleCount >= 10 ? 0.15 : 0)));

        // Sentiment delta vs 7 days ago
        const oldEstimate = await db.stockEstimate.findFirst({
          where: { stockId: stock.id, date: { lte: sevenDaysAgo } },
          orderBy: { date: "desc" },
          select: { combinedScore: true },
        });
        const sentimentDelta = oldEstimate ? combinedScore - oldEstimate.combinedScore : null;

        // Latest existing estimate: its signal is the baseline for signal-change
        // detection (including an intraday flip when we refresh today's row), and
        // when it's today's row we update it in place — one estimate per stock per
        // UTC day, so no stale snapshot is left behind when sentiment moves.
        const prevEstimate = await db.stockEstimate.findFirst({
          where: { stockId: stock.id },
          orderBy: { date: "desc" },
          select: { id: true, signal: true, date: true },
        });

        const signal = scoreToSignal(combinedScore);
        const data = {
          sentimentScore,
          quantScore,
          combinedScore,
          signal,
          confidence,
          dataWarnings: warnings,
          sentimentDelta,
          articleVelocityRatio,
        };

        if (prevEstimate && prevEstimate.date.getTime() >= todayUTC.getTime()) {
          // Refresh today's estimate; bump `date` to mark the recompute time so the
          // staleness check above won't re-run it until a newer sentiment lands.
          await db.stockEstimate.update({
            where: { id: prevEstimate.id },
            data: { ...data, date: new Date() },
          });
        } else {
          await db.stockEstimate.create({ data: { stockId: stock.id, ...data } });
        }
        created++;

        // All alert detection lives here so watchers get a single digest per run.
        const rsiAlert = detectRsiCross(stock.ticker, prevRsi, latestQuant?.rsi14 ?? null);
        if (rsiAlert) pendingAlerts.push({ stockId: stock.id, ticker: stock.ticker, draft: rsiAlert });

        const signalAlert = detectSignalChange(stock.ticker, prevEstimate?.signal, signal);
        if (signalAlert) pendingAlerts.push({ stockId: stock.id, ticker: stock.ticker, draft: signalAlert });

        const velocityAlert = detectVelocitySpike(stock.ticker, articleVelocityRatio);
        if (velocityAlert) pendingAlerts.push({ stockId: stock.id, ticker: stock.ticker, draft: velocityAlert });
      } catch (e) {
        errors.push(`Estimate failed for ${stock.ticker}: ${String(e)}`);
      }
    },
    { concurrency: opts.concurrency ?? ESTIMATE_CONCURRENCY, deadline: Date.now() + (opts.budgetMs ?? STAGE_BUDGET_MS) }
  );

  let alerts = 0;
  try {
    const res = await processAlerts(pendingAlerts);
    alerts = res.count;
    errors.push(...res.errors);
  } catch (e) {
    errors.push(`Alert processing failed: ${String(e)}`);
    reportError("alert_processing_failed", e, { stage: "estimate" });
  }

  return {
    stage: "estimate",
    attempted: outcome.processed,
    created,
    remaining: outcome.remaining,
    done: outcome.done,
    alerts,
    errors,
  };
}

// ── Stage 5: Insider ────────────────────────────────────────────────────────
//
// Insider (Form 4) transactions for each watched US-equity lacking today's
// summary. Persists raw transactions (idempotent via dedupKey), rolls them into
// a per-day InsiderSummary, and fires transition alerts (cluster buy, net-flow
// shift). Non-US / ETF / crypto are filtered out of the worklist — no API call,
// no error. Buy-biased and noise-filtered: only open-market P/S feed the signals.
export async function runInsiderStage(opts: StageOptions = {}): Promise<BatchStageResult> {
  const errors: string[] = [];
  let created = 0;
  const pendingAlerts: PendingAlert[] = [];

  const to = new Date();
  const todayUTC = startOfUtcDay(to);
  const since = new Date(to.getTime() - INSIDER_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  // mspr lookback — a few months so the latest monthly figure is present.
  const msprFrom = new Date(to.getTime() - 120 * 24 * 60 * 60 * 1000);

  const candidates = await db.stock.findMany({
    where: { ...watchedStocksWhere(), insiderSummaries: { none: { date: { gte: todayUTC } } } },
    select: { id: true, ticker: true },
  });
  // Insider/Form-4 data is US-equity only — drop non-US, ETFs and crypto cleanly.
  const worklist = candidates.filter((s) => isInsiderEligible(s.ticker));

  const outcome = await processWithBudget(
    worklist,
    async (stock) => {
      try {
        const { txns } = await getInsiderTxns(stock.ticker, since);

        // Persist raw transactions — idempotent via the unique dedupKey, so the
        // overlapping rolling window re-upserts as no-ops each run.
        if (txns.length > 0) {
          await db.insiderTransaction.createMany({
            data: txns.map((t) => ({
              stockId: stock.id,
              insiderName: t.insiderName,
              officerTitle: t.officerTitle,
              isOfficer: t.isOfficer,
              isDirector: t.isDirector,
              isTenPctOwner: t.isTenPctOwner,
              transactionCode: t.transactionCode,
              txnType: t.txnType,
              isPlanned: t.isPlanned,
              isDerivative: t.isDerivative,
              shares: t.shares,
              price: t.price,
              value: t.value,
              sharesAfter: t.sharesAfter,
              pctHoldingsChg: t.pctHoldingsChg,
              transactionDate: t.transactionDate,
              filingDate: t.filingDate,
              accessionId: t.accessionId,
              dedupKey: t.dedupKey,
            })),
            skipDuplicates: true,
          });
        }

        // Monthly net-flow ratio (corroborating aggregate) — optional, don't fail
        // the stock if this one call hiccups.
        let mspr: number | null = null;
        try {
          const sentiment = await getInsiderSentiment(stock.ticker, dateStr(msprFrom), dateStr(to));
          if (sentiment.length > 0) {
            const latest = sentiment.reduce((a, b) => (b.year * 12 + b.month > a.year * 12 + a.month ? b : a));
            mspr = Number.isFinite(latest.mspr) ? latest.mspr : null;
          }
        } catch (e) {
          errors.push(`Insider sentiment failed for ${stock.ticker}: ${String(e)}`);
        }

        const summary = summarizeInsider(txns, mspr, to);

        // Previous summary (most recent before today's) drives transition alerts —
        // null on the first-ever run, so cold-start backfill never emails.
        const prev = await db.insiderSummary.findFirst({
          where: { stockId: stock.id },
          orderBy: { date: "desc" },
          select: { distinctBuyers14d: true, netValue90d: true, csuiteBuyValue14d: true },
        });

        await db.insiderSummary.create({
          data: {
            stockId: stock.id,
            buyCount90d: summary.buyCount90d,
            sellCount90d: summary.sellCount90d,
            distinctBuyers90d: summary.distinctBuyers90d,
            distinctSellers90d: summary.distinctSellers90d,
            netShares90d: summary.netShares90d,
            netValue90d: summary.netValue90d,
            buyValue90d: summary.buyValue90d,
            sellValue90d: summary.sellValue90d,
            distinctBuyers14d: summary.distinctBuyers14d,
            csuiteBuyValue14d: summary.csuiteBuyValue14d,
            mspr: summary.mspr,
            convictionScore: summary.convictionScore,
            signals: summary.signals,
          },
        });
        created++;

        const clusterAlert = detectInsiderClusterBuy(stock.ticker, prev, summary);
        if (clusterAlert) pendingAlerts.push({ stockId: stock.id, ticker: stock.ticker, draft: clusterAlert });
        const flowAlert = detectInsiderFlowShift(stock.ticker, prev, summary);
        if (flowAlert) pendingAlerts.push({ stockId: stock.id, ticker: stock.ticker, draft: flowAlert });
        const csuiteAlert = detectCsuiteBuy(stock.ticker, prev, summary);
        if (csuiteAlert) pendingAlerts.push({ stockId: stock.id, ticker: stock.ticker, draft: csuiteAlert });
      } catch (e) {
        errors.push(`Insider failed for ${stock.ticker}: ${String(e)}`);
      }
    },
    { concurrency: opts.concurrency ?? INSIDER_CONCURRENCY, deadline: Date.now() + (opts.budgetMs ?? STAGE_BUDGET_MS) }
  );

  let alerts = 0;
  try {
    const res = await processAlerts(pendingAlerts);
    alerts = res.count;
    errors.push(...res.errors);
  } catch (e) {
    errors.push(`Alert processing failed: ${String(e)}`);
    reportError("alert_processing_failed", e, { stage: "insider" });
  }

  return {
    stage: "insider",
    attempted: outcome.processed,
    created,
    remaining: outcome.remaining,
    done: outcome.done,
    alerts,
    errors,
  };
}

export type CongressStageResult = {
  stage: "congress";
  fetched: number; // in-window disclosures mapped across tickers
  created: number; // rows actually inserted (dedupKey skipDuplicates)
  errors: string[];
  done: true;
};

// ── Congress trading ─────────────────────────────────────────────────────────
//
// US congressional STOCK Act disclosures (AInvest) for each watched ticker.
// Symbol-queryable, so this iterates the watchlist like the per-stock stages, but
// stays single-shot (`done: true`): the dataset is tiny and there's no per-day
// summary to drive a resumable worklist. The wall-clock budget still bounds the
// pass so a large watchlist can't blow the serverless limit — any tickers skipped
// when the budget elapses are simply caught on the next daily run (the 45-day
// disclosure lag makes that latency irrelevant). No alerts, no signal logic — an
// engagement surface, not a fast signal. Gated on AINVEST_API_KEY; a no-op without.
export async function runCongressStage(opts: StageOptions = {}): Promise<CongressStageResult> {
  const errors: string[] = [];
  let fetched = 0;
  let created = 0;

  if (!isCongressConfigured()) return { stage: "congress", fetched, created, errors, done: true };

  const to = new Date();
  const since = new Date(to.getTime() - CONGRESS_BACKFILL_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db.stock.findMany({
    where: watchedStocksWhere(),
    select: { id: true, ticker: true },
  });
  // Unlike insider data, Congress trades ETFs and class shares (SPY, BRK.B) — only
  // crypto is dropped (no congressional disclosures exist for it).
  const worklist = candidates.filter((s) => isCongressEligible(s.ticker));

  await processWithBudget(
    worklist,
    async (stock) => {
      try {
        const { trades, error } = await getCongressTrades(stock.ticker, since);
        if (error) errors.push(error);
        if (trades.length === 0) return;

        fetched += trades.length;
        // Idempotent via the unique dedupKey — the overlapping rolling window
        // re-inserts as no-ops each run.
        const res = await db.congressTrade.createMany({
          data: trades.map((t) => ({
            stockId: stock.id,
            politician: t.politician,
            party: t.party,
            state: t.state,
            owner: t.owner,
            txnType: t.txnType,
            amountRange: t.amountRange,
            transactionDate: t.transactionDate,
            disclosureDate: t.disclosureDate,
            ptrLink: t.ptrLink,
            dedupKey: t.dedupKey,
          })),
          skipDuplicates: true,
        });
        created += res.count;
      } catch (e) {
        errors.push(`Congress failed for ${stock.ticker}: ${String(e)}`);
      }
    },
    { concurrency: opts.concurrency ?? CONGRESS_CONCURRENCY, deadline: Date.now() + (opts.budgetMs ?? STAGE_BUDGET_MS) }
  );

  return { stage: "congress", fetched, created, errors, done: true };
}

export type PaperStageResult = {
  stage: "paper";
  rebalanced: boolean; // false on the same-day no-op; true once it acts
  ordersSubmitted: number; // real Alpaca paper orders placed this run
  simOpened: number; // internal sim positions opened
  simClosed: number; // internal sim positions closed
  done: true;
  errors: string[];
};

// Terminal Alpaca order states — once an order reaches one, there's nothing left
// to reconcile, so it drops out of the pending-fill recheck.
const TERMINAL_ORDER_STATUS = new Set(["filled", "canceled", "cancelled", "expired", "rejected", "done_for_day", "replaced"]);

// ── Paper trading / signal performance ───────────────────────────────────────
//
// Acts on today's estimates with simulated long-only trades and tracks hypothetical
// P&L per signal source — sentiment, quant, and the combined estimate — to measure
// which predicts best (issue #14). Two layers:
//   • SIM books (DB-only, always run): one mark-to-market book per strategy. Sizing
//     is held constant (the estimate's confidence) so only the *signal* differs.
//   • ALPACA book (only when paper keys are set): the combined signal is mirrored
//     with REAL orders on the paper account, giving a fills-included reality check.
//
// Idempotent per UTC day via the SIM_COMBINED equity snapshot: the 3-hourly
// pipeline.yml calls this after `estimate`, but it only acts on the first call each
// day. Single-shot (`done: true`); the watchlist is small enough for one pass and
// the wall-clock budget isn't needed, but errors are isolated so one bad ticker or
// an Alpaca hiccup never sinks the run. US-equities only (foreign/crypto filtered).
export async function runPaperStage(): Promise<PaperStageResult> {
  const errors: string[] = [];
  let ordersSubmitted = 0;
  let simOpened = 0;
  let simClosed = 0;

  const to = new Date();
  const todayUTC = startOfUtcDay(to);

  // Per-day idempotency guard: the SIM_COMBINED snapshot for today doubles as the
  // "already ran" marker, so repeat calls in the same day are cheap no-ops.
  const alreadyRan = await db.paperEquitySnapshot.findUnique({
    where: { book_date: { book: "SIM_COMBINED", date: todayUTC } },
    select: { id: true },
  });
  if (alreadyRan) {
    return { stage: "paper", rebalanced: false, ordersSubmitted, simOpened, simClosed, done: true, errors };
  }

  // Today's estimates for watched stocks, newest first; dedupe to one per stock.
  const estimateRows = await db.stockEstimate.findMany({
    where: { date: { gte: todayUTC }, stock: watchedStocksWhere() },
    orderBy: { date: "desc" },
    select: {
      stockId: true,
      sentimentScore: true,
      quantScore: true,
      combinedScore: true,
      confidence: true,
      stock: { select: { ticker: true } },
    },
  });
  const estimates = [...new Map(estimateRows.map((e) => [e.stockId, e])).values()].filter((e) =>
    isPaperTradeEligible(e.stock.ticker)
  );

  // Mark price = latest QuantAnalysis close per stock (already computed by the quant
  // stage). No price → the stock can't be marked/sized, so it's skipped this run.
  const stockIds = estimates.map((e) => e.stockId);
  const quantRows =
    stockIds.length > 0
      ? await db.quantAnalysis.findMany({
          where: { stockId: { in: stockIds }, price: { not: null } },
          orderBy: { date: "desc" },
          distinct: ["stockId"],
          select: { stockId: true, price: true },
        })
      : [];
  const priceByStock = new Map(quantRows.map((q) => [q.stockId, q.price!]));

  // ── Sim books (always run) ─────────────────────────────────────────────────
  // Index open positions by (stock, strategy) for O(1) reconciliation.
  const openPositions = await db.simPosition.findMany({
    where: { status: "OPEN", stockId: { in: stockIds.length > 0 ? stockIds : ["__none__"] } },
    select: { id: true, stockId: true, strategy: true, qty: true, entryPrice: true },
  });
  const openByKey = new Map(openPositions.map((p) => [`${p.stockId}|${p.strategy}`, p]));

  for (const est of estimates) {
    const price = priceByStock.get(est.stockId);
    if (price == null) continue;
    const signals = deriveSignals(est);

    for (const strategy of STRATEGIES) {
      const signal = signals[strategy];
      if (signal == null) continue; // e.g. QUANT with no quant score
      const open = openByKey.get(`${est.stockId}|${strategy}`) ?? null;
      const action = reconcilePosition(signal, price, est.confidence, open);

      try {
        if (action.type === "OPEN") {
          await db.simPosition.create({
            data: {
              stockId: est.stockId,
              strategy,
              status: "OPEN",
              qty: action.qty,
              entryDate: to,
              entryPrice: action.price,
              confidence: est.confidence,
              lastMarkDate: to,
              lastMarkPrice: action.price,
            },
          });
          simOpened++;
        } else if (action.type === "CLOSE" && open) {
          await db.simPosition.update({
            where: { id: open.id },
            data: {
              status: "CLOSED",
              exitDate: to,
              exitPrice: action.price,
              realizedPnl: action.realizedPnl,
              lastMarkDate: to,
              lastMarkPrice: action.price,
            },
          });
          simClosed++;
        } else if (action.type === "MARK" && open) {
          await db.simPosition.update({
            where: { id: open.id },
            data: { lastMarkDate: to, lastMarkPrice: action.price },
          });
        }
      } catch (e) {
        errors.push(`Sim ${strategy} failed for ${est.stock.ticker}: ${String(e)}`);
      }
    }
  }

  // Per-book equity snapshot from the full position history (cumulative realized +
  // current unrealized). Written last so the SIM_COMBINED row only lands once the
  // day's reconciliation succeeded — keeping it honest as the idempotency marker.
  for (const strategy of STRATEGIES) {
    try {
      const [closed, open] = await Promise.all([
        db.simPosition.findMany({ where: { strategy, status: "CLOSED" }, select: { realizedPnl: true } }),
        db.simPosition.findMany({
          where: { strategy, status: "OPEN" },
          select: { qty: true, entryPrice: true, lastMarkPrice: true },
        }),
      ]);
      const summary = summarizeBook(closed, open);
      const book = STRATEGY_BOOK[strategy];
      const data = {
        equity: summary.equity,
        realizedPnl: summary.realizedPnl,
        unrealizedPnl: summary.unrealizedPnl,
        openPositions: summary.openPositions,
      };
      await db.paperEquitySnapshot.upsert({
        where: { book_date: { book, date: todayUTC } },
        create: { book, date: todayUTC, ...data },
        update: data,
      });
    } catch (e) {
      errors.push(`Equity snapshot failed for ${strategy}: ${String(e)}`);
    }
  }

  // ── Alpaca book (only when paper keys are configured) ──────────────────────
  if (isPaperTradingConfigured()) {
    try {
      // Reconcile fills for orders still pending from a previous run.
      const pending = await db.paperOrder.findMany({
        where: { alpacaOrderId: { not: null } },
        orderBy: { submittedAt: "desc" },
        take: 100,
        select: { id: true, alpacaOrderId: true, status: true },
      });
      for (const o of pending) {
        if (TERMINAL_ORDER_STATUS.has(o.status)) continue;
        try {
          const remote = await getOrder(o.alpacaOrderId!);
          await db.paperOrder.update({
            where: { id: o.id },
            data: {
              status: remote.status,
              filledQty: remote.filledQty,
              filledAvgPrice: remote.filledAvgPrice,
              filledAt: remote.filledAt ? new Date(remote.filledAt) : null,
            },
          });
        } catch (e) {
          errors.push(`Order reconcile failed (${o.alpacaOrderId}): ${String(e)}`);
        }
      }

      // Desired state per stock: long when the combined signal is a buy, else flat.
      const positions = await getPositions();
      const posBySymbol = new Map(positions.map((p) => [p.symbol, p]));

      for (const est of estimates) {
        const ticker = est.stock.ticker;
        const combinedSignal = scoreToSignal(est.combinedScore);
        const held = posBySymbol.get(ticker);
        const wantLong = isEntrySignal(combinedSignal);
        try {
          if (wantLong && !held) {
            const notional = confidenceNotional(est.confidence);
            const order = await submitMarketOrder({ symbol: ticker, side: "buy", notional });
            await db.paperOrder.create({
              data: {
                stockId: est.stockId,
                side: "BUY",
                signal: combinedSignal,
                notional,
                alpacaOrderId: order.id,
                status: order.status,
              },
            });
            ordersSubmitted++;
          } else if (!wantLong && held && held.qty > 0) {
            const qty = Math.abs(held.qty);
            const order = await submitMarketOrder({ symbol: ticker, side: "sell", qty });
            await db.paperOrder.create({
              data: {
                stockId: est.stockId,
                side: "SELL",
                signal: combinedSignal,
                qty,
                alpacaOrderId: order.id,
                status: order.status,
              },
            });
            ordersSubmitted++;
          }
        } catch (e) {
          errors.push(`Alpaca order failed for ${ticker}: ${String(e)}`);
        }
      }

      // Equity straight from the paper account; unrealized rolled up from positions.
      const account = await getAccount();
      const unrealized = positions.reduce((s, p) => s + (p.unrealizedPl ?? 0), 0);
      const data = {
        equity: account.equity ?? 0,
        cash: account.cash,
        unrealizedPnl: unrealized,
        openPositions: positions.length,
      };
      await db.paperEquitySnapshot.upsert({
        where: { book_date: { book: "ALPACA", date: todayUTC } },
        create: { book: "ALPACA", date: todayUTC, realizedPnl: 0, ...data },
        update: data,
      });
    } catch (e) {
      errors.push(`Alpaca book failed: ${String(e)}`);
      reportError("paper_alpaca_book_failed", e, { stage: "paper" });
    }
  }

  return { stage: "paper", rebalanced: true, ordersSubmitted, simOpened, simClosed, done: true, errors };
}

/**
 * Run a batched stage repeatedly until it reports `done`, accumulating results.
 * Used by the all-in-one orchestrator (admin "run now" + local debug); the GH
 * Actions cron instead loops each stage's HTTP endpoint, so no single serverless
 * invocation runs longer than one budget window.
 */
async function runStageToCompletion(
  stage: (opts?: StageOptions) => Promise<BatchStageResult>,
  maxIterations = 50
): Promise<{ created: number; alerts: number; errors: string[] }> {
  let created = 0;
  let alerts = 0;
  const errors: string[] = [];
  for (let i = 0; i < maxIterations; i++) {
    const r = await stage();
    created += r.created;
    alerts += r.alerts;
    errors.push(...r.errors);
    if (r.done) break;
  }
  return { created, alerts, errors };
}

/**
 * All-in-one run: every stage to completion, in dependency order. Kept for the
 * admin trigger and the local debug script; the scheduled cron uses the per-stage
 * endpoints instead so each invocation stays within its time limit.
 */
export async function runPipeline(): Promise<PipelineResult> {
  const result: PipelineResult = { articles: { fetched: 0, saved: 0 }, tags: 0, sentiments: 0, quants: 0, estimates: 0, insider: 0, alerts: 0, errors: [] };

  const news = await runNewsStage();
  result.articles = news.articles;
  result.tags += news.tags;
  result.errors.push(...news.errors);

  const sentiment = await runStageToCompletion(runSentimentStage);
  result.sentiments = sentiment.created;
  result.errors.push(...sentiment.errors);

  const quant = await runStageToCompletion(runQuantStage);
  result.quants = quant.created;
  result.errors.push(...quant.errors);

  const estimate = await runStageToCompletion(runEstimateStage);
  result.estimates = estimate.created;
  result.alerts += estimate.alerts;
  result.errors.push(...estimate.errors);

  const insider = await runStageToCompletion(runInsiderStage);
  result.insider = insider.created;
  result.alerts += insider.alerts;
  result.errors.push(...insider.errors);

  return result;
}
