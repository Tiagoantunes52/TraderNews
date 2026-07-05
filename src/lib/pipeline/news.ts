import { db } from "@/lib/db";
import { getMarketNews } from "@/lib/finnhub";
import { normalizeUrl, normalizeHeadline } from "@/lib/normalize";
import { aggregateNews } from "@/lib/news-sources";
import { reportError } from "@/lib/observability";
import { STAGE_BUDGET_MS, universeWhere, type StageOptions } from "./shared";

export type NewsStageResult = {
  stage: "news";
  articles: { fetched: number; saved: number };
  tags: number;
  errors: string[];
  // News now walks the full universe in budget-bounded chunks, so it can defer the
  // tail to a later invocation just like the per-stock stages (done:false → resume).
  done: boolean;
};

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

// News walks the universe in chunks from a persisted cursor so it resumes across
// invocations (the universe can be hundreds of names; a single pass mustn't exceed
// the serverless budget). The cursor is a stable-order offset, stored in AppSetting.
const NEWS_CURSOR_KEY = "newsCursor";
const NEWS_CHUNK = Number(process.env.PIPELINE_NEWS_CHUNK) || 25;

async function getNewsCursor(): Promise<number> {
  const row = await db.appSetting.findUnique({ where: { key: NEWS_CURSOR_KEY } });
  const n = row ? Number.parseInt(row.value, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function setNewsCursor(value: number): Promise<void> {
  const v = String(Math.max(0, Math.floor(value)));
  await db.appSetting.upsert({
    where: { key: NEWS_CURSOR_KEY },
    update: { value: v },
    create: { key: NEWS_CURSOR_KEY, value: v },
  });
}

// ── Stage 1: News ───────────────────────────────────────────────────────────
//
// Fetch general market news + stock-specific news across every configured
// source, dedupe-save, and link articles to watched stocks (persisting Alpha
// Vantage per-(article,stock) sentiment score + relevance so the later sentiment
// stage can reconstruct the relevance-weighted blend). Cheap enough to finish in
// one invocation now that Polygon's 12s/req pacing is gone and sources run
// concurrently, so this stage is always single-shot (`done: true`).
export async function runNewsStage(opts: StageOptions = {}): Promise<NewsStageResult> {
  const errors: string[] = [];
  let fetched = 0;
  let saved = 0;
  let tags = 0;

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const deadline = Date.now() + (opts.budgetMs ?? STAGE_BUDGET_MS);

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

  // 2. Stock-specific news over the FULL universe, budget-bounded + resumable.
  //    The universe can be hundreds of names, so we walk it in chunks from a
  //    persisted cursor and stop when the time budget elapses; the orchestrator
  //    re-invokes us and we resume where we left off. One full pass ⇒ done.
  const universe = await db.stock.findMany({
    select: { id: true, ticker: true, name: true },
    where: universeWhere(),
    orderBy: { id: "asc" }, // stable order so the cursor stays meaningful run-to-run
  });

  let done = true;
  if (universe.length > 0) {
    const tickerToStock = new Map(universe.map((s) => [s.ticker, s]));
    let cursor = await getNewsCursor();
    if (cursor >= universe.length) cursor = 0; // universe shrank → restart the walk
    let processed = 0;

    while (processed < universe.length) {
      if (Date.now() > deadline) {
        done = false; // budget hit mid-pass; resume from the cursor next invocation
        break;
      }
      const chunk: typeof universe = [];
      while (chunk.length < NEWS_CHUNK && processed < universe.length) {
        chunk.push(universe[cursor]);
        cursor = (cursor + 1) % universe.length;
        processed++;
      }

      const agg = await aggregateNews(chunk, from);
      fetched += agg.fetched;
      errors.push(...agg.errors);
      const r = await saveArticlesWithDedup(agg.articles, from);
      saved += r.saved;
      tags += await linkArticlesToStocks(agg.articles, r.urlToId, tickerToStock);

      await setNewsCursor(cursor);
    }
  }

  return { stage: "news", articles: { fetched, saved }, tags, errors, done };
}

/** Article type produced by the news aggregator (derived to avoid a named import). */
type AggregatedArticles = Awaited<ReturnType<typeof aggregateNews>>["articles"];

/**
 * Link saved articles to the stocks they mention, carrying Alpha Vantage's
 * per-(article,stock) sentiment score/relevance where present (upserted) and plain
 * links otherwise (createMany, skipDuplicates). Returns the number of links written.
 */
async function linkArticlesToStocks(
  articles: AggregatedArticles,
  urlToId: Map<string, string>,
  tickerToStock: Map<string, { id: string }>
): Promise<number> {
  let tags = 0;
  const plainLinks: Array<{ articleId: string; stockId: string }> = [];
  const sentimentLinks: Array<{ articleId: string; stockId: string; score: number; relevance: number }> = [];

  for (const art of articles) {
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
  // Bulk path instead of per-row upserts: diff against the existing links, then
  // createMany the new ones and update only rows whose score actually changed —
  // in the steady state (the 7-day news window re-scanned every run, with AV
  // scores static per article) that's a single read + zero writes.
  if (sentimentLinks.length > 0) {
    const existing = await db.articleStock.findMany({
      where: { articleId: { in: [...new Set(sentimentLinks.map((l) => l.articleId))] } },
      select: { articleId: true, stockId: true, sentimentScore: true, sentimentRelevance: true },
    });
    const existingByPair = new Map(existing.map((e) => [`${e.articleId}|${e.stockId}`, e]));
    const toCreate: Array<{ articleId: string; stockId: string; sentimentScore: number; sentimentRelevance: number }> = [];
    const toUpdate: typeof sentimentLinks = [];
    for (const l of sentimentLinks) {
      const ex = existingByPair.get(`${l.articleId}|${l.stockId}`);
      if (!ex) toCreate.push({ articleId: l.articleId, stockId: l.stockId, sentimentScore: l.score, sentimentRelevance: l.relevance });
      else if (ex.sentimentScore !== l.score || ex.sentimentRelevance !== l.relevance) toUpdate.push(l);
    }
    // skipDuplicates covers a concurrent run inserting the same pair between the
    // read above and this write.
    if (toCreate.length > 0) await db.articleStock.createMany({ data: toCreate, skipDuplicates: true });
    for (const { articleId, stockId, score, relevance } of toUpdate) {
      await db.articleStock.update({
        where: { articleId_stockId: { articleId, stockId } },
        data: { sentimentScore: score, sentimentRelevance: relevance },
      });
    }
    tags += sentimentLinks.length;
  }
  return tags;
}
