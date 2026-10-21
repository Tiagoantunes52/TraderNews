import { db } from "@/lib/db";
import { getCryptoFearGreed } from "@/lib/crypto-fng";
import { analyzeSentiment, LlmResponseError, type SentimentArticle, type SentimentResult } from "@/lib/llm";
import { blendSentiment } from "@/lib/sentiment-blend";
import { normalizeHeadline } from "@/lib/normalize";
import { processWithBudget } from "@/lib/concurrency";
import { startOfUtcDay, universeWhere, type BatchStageResult, type StageOptions } from "./shared";

// Each unit of concurrency is one LLM call the invocation is *idle* waiting on —
// not CPU — so this is the cheap lever, and the one that actually sets throughput:
// tickers per invocation = budget x concurrency / latency. At 3, a ~30s model
// drains ~18 of 110 names per call and the stage needs a dozen polls. At 12 it
// clears the universe in ~2. The ceiling above ~10 is no longer the LLM but pg's
// default pool max in `lib/db` — each worker runs two short queries around its
// call, so they queue for milliseconds against a 30s wait; well past that, raise
// the pool with it.
export const SENTIMENT_CONCURRENCY = Number(process.env.PIPELINE_SENTIMENT_CONCURRENCY) || 12;

// This stage gets its own budget rather than the shared STAGE_BUDGET_MS (240s):
// it is the only one holding a call open for REQUEST_TIMEOUT_MS, and budget +
// timeout must clear the routes' 300s maxDuration — see the invariant on
// REQUEST_TIMEOUT_MS. 180 + 60 = 240 leaves 60s of headroom; the old 240 + 60 sat
// exactly on the limit with none.
export const SENTIMENT_BUDGET_MS = Number(process.env.PIPELINE_SENTIMENT_BUDGET_MS) || 180_000;

// ── Failed LLM calls ────────────────────────────────────────────────────────
//
// A failed call (timeout, HTTP error, empty or unparseable reply) is written as a
// `failed` Sentiment row — never as a score — so that:
//   • the stock leaves this run's worklist. Before, a timeout produced NO row, so the
//     stock stayed on the worklist and was re-attempted on every poll; under a broad
//     LLM outage the stage could never report `done` and would hold the 20-minute
//     pipeline job until it timed out, starving quant/estimate/paper behind it.
//   • retries are bounded and spaced: at most one attempt per pipeline run (the
//     backoff outlasts the job's 20-minute timeout, and runs are ~3h apart) and
//     MAX_ATTEMPTS per UTC day. A later run gets another try, which is the retry that
//     helps — failures cluster in time (model overload), so the next poll seconds later
//     usually fails the same way.
//   • the daily review can count them.
// Every reader filters `failed: false`; the estimate carries the last real read forward.
export const SENTIMENT_MAX_ATTEMPTS_PER_DAY = 3;
export const SENTIMENT_RETRY_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Should this stock be (re)attempted now, given the failed attempts it has already
 * made today? Only called for stocks with no successful read today.
 */
export function shouldAttemptSentiment(failedToday: Date[], now: Date): boolean {
  if (failedToday.length === 0) return true;
  if (failedToday.length >= SENTIMENT_MAX_ATTEMPTS_PER_DAY) return false;
  const last = Math.max(...failedToday.map((d) => d.getTime()));
  return now.getTime() - last >= SENTIMENT_RETRY_BACKOFF_MS;
}

/** What a failed row says about itself — kept short; the full error goes to `errors`. */
export function llmFailureSummary(e: unknown): string {
  if (e instanceof LlmResponseError) return `LLM call failed: ${e.reason}`;
  const name = (e as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return "LLM call failed: timed out.";
  const msg = e instanceof Error ? e.message : String(e);
  return `LLM call failed: ${msg}`.slice(0, 200);
}

// ── Stage 2: Sentiment ──────────────────────────────────────────────────────
//
// LLM sentiment for each watched stock that doesn't yet have a real reading dated
// today (and hasn't used up its attempts — see above), blended with Alpha Vantage
// scores (read back from ArticleStock) and a crypto Fear & Greed prior. Runs with
// bounded concurrency under a time budget.
export async function runSentimentStage(opts: StageOptions = {}): Promise<BatchStageResult> {
  const errors: string[] = [];
  let created = 0;
  let failed = 0;

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

  const candidates = await db.stock.findMany({
    where: { ...universeWhere(), sentiments: { none: { date: { gte: todayUTC }, failed: false } } },
    select: {
      id: true,
      ticker: true,
      sentiments: { where: { date: { gte: todayUTC }, failed: true }, select: { date: true } },
    },
  });
  const worklist = candidates
    .filter((s) => shouldAttemptSentiment(s.sentiments.map((r) => r.date), to))
    .map(({ id, ticker }) => ({ id, ticker }));

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

        let sentiment: SentimentResult;
        try {
          sentiment = await analyzeSentiment(stock.ticker, uniqueArticles);
        } catch (e) {
          // Not a reading — recorded so retries stay bounded and the review can count
          // it. `score` is a required column, so it holds a placeholder 0 that no reader
          // sees (they all filter `failed: false`); confidence is left null rather than
          // the old 0.1 so nothing can mistake it for a low-conviction opinion.
          await db.sentiment.create({
            data: {
              stockId: stock.id,
              score: 0,
              failed: true,
              summary: llmFailureSummary(e),
              confidence: null,
              articleCount,
              avgArticleAgeHours,
            },
          });
          failed++;
          errors.push(`Sentiment LLM call failed for ${stock.ticker}: ${String(e)}`);
          return;
        }

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
        // Caught (not rethrown) so one bad stock doesn't abort the pool. These are
        // non-LLM faults (a DB read, the failed-row write itself); the stock produces
        // no row and reappears in the next invocation's worklist.
        errors.push(`Sentiment failed for ${stock.ticker}: ${String(e)}`);
      }
    },
    { concurrency: opts.concurrency ?? SENTIMENT_CONCURRENCY, deadline: Date.now() + (opts.budgetMs ?? SENTIMENT_BUDGET_MS) }
  );

  if (failed > 0) {
    errors.unshift(
      `${failed} of ${outcome.processed} LLM sentiment call(s) failed this invocation and were recorded as failed rows ` +
        `(not scores); those names keep their last real reading until a later run succeeds.`
    );
  }

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
