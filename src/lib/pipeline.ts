import { db } from "@/lib/db";
import { getMarketNews, getEarningsCalendar } from "@/lib/finnhub";
import { getEtfProfile } from "@/lib/alphavantage";
import { getCryptoFearGreed } from "@/lib/crypto-fng";
import { isEtf } from "@/lib/etf";
import { analyzeSentiment, type SentimentArticle } from "@/lib/llm";
import { getDailyPrices } from "@/lib/price-sources";
import { calcSMA, calcRSI, calcVolatility, calcMomentum, calcVolumeRatio, calcQuantScore, calcEMA, calcMACD, calcBollingerBands, calcATR, scoreToSignal } from "@/lib/indicators";
import { SECTOR_ETF } from "@/lib/sectors";
import { normalizeUrl, normalizeHeadline } from "@/lib/normalize";
import { aggregateNews } from "@/lib/news-sources";
import { detectSignalChange, detectVelocitySpike, detectRsiCross, type AlertDraft } from "@/lib/alerts";
import { isEmailConfigured, sendEmail, buildAlertEmail } from "@/lib/email";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export type PipelineResult = {
  articles: { fetched: number; saved: number };
  tags: number;
  sentiments: number;
  quants: number;
  estimates: number;
  alerts: number;
  errors: string[];
};

type PendingAlert = { stockId: string; ticker: string; draft: AlertDraft };

/**
 * Persist new alert events and email watchers (one digest per recipient).
 * Only users with alertEmails enabled and an email on file are notified.
 */
async function processAlerts(pending: PendingAlert[], result: PipelineResult): Promise<void> {
  if (pending.length === 0) return;

  await db.alert.createMany({
    data: pending.map((p) => ({
      stockId: p.stockId,
      type: p.draft.type,
      title: p.draft.title,
      message: p.draft.message,
      value: p.draft.value,
    })),
  });
  result.alerts += pending.length;

  if (!isEmailConfigured()) return;

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
    if (!res.ok) result.errors.push(`Alert email to ${email} failed: ${res.error}`);
  }
}

function dateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

export async function runPipeline(): Promise<PipelineResult> {
  const result: PipelineResult = { articles: { fetched: 0, saved: 0 }, tags: 0, sentiments: 0, quants: 0, estimates: 0, alerts: 0, errors: [] };

  // Alert events detected during quant/estimate steps, processed after the loops.
  const pendingAlerts: PendingAlert[] = [];

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

  // US tickers (no dot-exchange suffix, no crypto) — used later by the quant step.
  const usStocks = stocks.filter((s) => !s.ticker.includes(".") && !s.ticker.endsWith("-USD"));

  // Stock-specific news — one centralised pass across every configured source.
  // Sources fall back independently (one failing never blocks the others) and
  // supplement each other; results are merged by URL before a single dedupe-save.
  const tickerToStock = new Map(stocks.map((s) => [s.ticker, s]));

  // stockId → [{score, relevance}] from Alpha Vantage, for relevance-weighted blending
  const avSentimentScores = new Map<string, { score: number; relevance: number }[]>();

  if (stocks.length > 0) {
    const agg = await aggregateNews(stocks, from);
    result.articles.fetched += agg.fetched;
    result.errors.push(...agg.errors);

    const { saved, urlToId } = await saveArticlesWithDedup(agg.articles, from);
    result.articles.saved += saved;

    const plainLinks: Array<{ articleId: string; stockId: string }> = [];
    const sentimentLinks: Array<{ articleId: string; stockId: string; sentimentScore: number }> = [];

    for (const art of agg.articles) {
      const articleId = urlToId.get(art.url);
      if (!articleId) continue;

      // Links carrying a precomputed per-article sentiment score (Alpha Vantage)
      const scored = new Set<string>();
      for (const s of art.sentiment) {
        const stock = tickerToStock.get(s.ticker);
        if (!stock) continue;
        sentimentLinks.push({ articleId, stockId: stock.id, sentimentScore: s.score });
        scored.add(s.ticker);
        if (s.relevance > 0) {
          const bucket = avSentimentScores.get(stock.id) ?? [];
          bucket.push({ score: s.score, relevance: s.relevance });
          avSentimentScores.set(stock.id, bucket);
        }
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
      result.tags += plainLinks.length;
    }
    for (const { articleId, stockId, sentimentScore } of sentimentLinks) {
      await db.articleStock.upsert({
        where: { articleId_stockId: { articleId, stockId } },
        create: { articleId, stockId, sentimentScore },
        update: { sentimentScore },
      });
    }
    result.tags += sentimentLinks.length;
  }

  // Per-stock sentiment metadata for step 5 blending
  const stockSentimentMeta = new Map<string, { articleCount: number; velocityRatio: number | null }>();

  // Market-wide crypto Fear & Greed — fetched once, blended into crypto sentiment.
  let cryptoFngScore: number | null = null;
  try {
    const fng = await getCryptoFearGreed();
    cryptoFngScore = fng?.score ?? null;
  } catch (e) {
    result.errors.push(`Crypto Fear & Greed failed: ${String(e)}`);
  }

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

      // Blend the LLM score with any available external signals: Alpha Vantage
      // per-article sentiment (equities) and crypto Fear & Greed (crypto).
      const isCrypto = stock.ticker.endsWith("-USD");
      const signals = [sentiment.score];
      if (avWeightedScore != null) signals.push(avWeightedScore);
      if (isCrypto && cryptoFngScore != null) signals.push(cryptoFngScore);
      const score = signals.reduce((a, b) => a + b, 0) / signals.length;

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
    const { prices: spyPrices } = await getDailyPrices("SPY", from60);
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
      const { prices: etfPrices } = await getDailyPrices(etf, from60);
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

      // Previous RSI (before we insert today's) for crossing detection
      const prevQuant = await db.quantAnalysis.findFirst({
        where: { stockId: stock.id },
        orderBy: { date: "desc" },
        select: { rsi14: true },
      });

      const { prices, errors: priceErrors } = await getDailyPrices(stock.ticker, from60);
      result.errors.push(...priceErrors);
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

      const rsiAlert = detectRsiCross(stock.ticker, prevQuant?.rsi14 ?? null, rsi14);
      if (rsiAlert) pendingAlerts.push({ stockId: stock.id, ticker: stock.ticker, draft: rsiAlert });

      result.quants++;
      await sleep(500);
    } catch (e) {
      result.errors.push(`Quant failed for ${stock.ticker}: ${String(e)}`);
    }
  }

  // 4b. ETF profiles — holdings, sector weights, expense ratio (Alpha Vantage).
  // Refreshed at most weekly to respect AV's tight free-tier request budget.
  if (process.env.ALPHAVANTAGE_API_KEY) {
    const staleBefore = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    for (const stock of stocks.filter((s) => isEtf(s.ticker))) {
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
        result.errors.push(`ETF profile failed for ${stock.ticker}: ${String(e)}`);
      }
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

      // Previous signal (before inserting today's) for signal-change detection
      const prevEstimate = await db.stockEstimate.findFirst({
        where: { stockId: stock.id },
        orderBy: { date: "desc" },
        select: { signal: true },
      });

      const signal = scoreToSignal(combinedScore);

      await db.stockEstimate.create({
        data: {
          stockId: stock.id,
          sentimentScore,
          quantScore,
          combinedScore,
          signal,
          confidence,
          dataWarnings: warnings,
          sentimentDelta,
          articleVelocityRatio,
        },
      });

      const signalAlert = detectSignalChange(stock.ticker, prevEstimate?.signal, signal);
      if (signalAlert) pendingAlerts.push({ stockId: stock.id, ticker: stock.ticker, draft: signalAlert });

      const velocityAlert = detectVelocitySpike(stock.ticker, articleVelocityRatio);
      if (velocityAlert) pendingAlerts.push({ stockId: stock.id, ticker: stock.ticker, draft: velocityAlert });

      result.estimates++;
    } catch (e) {
      result.errors.push(`Estimate failed for ${stock.ticker}: ${String(e)}`);
    }
  }

  // 6. Alerts — persist detected events and notify watchers by email
  try {
    await processAlerts(pendingAlerts, result);
  } catch (e) {
    result.errors.push(`Alert processing failed: ${String(e)}`);
  }

  return result;
}
