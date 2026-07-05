import { db } from "@/lib/db";
import { getCryptoFearGreed } from "@/lib/crypto-fng";
import { analyzeSentiment, type SentimentArticle } from "@/lib/llm";
import { blendSentiment } from "@/lib/sentiment-blend";
import { normalizeHeadline } from "@/lib/normalize";
import { processWithBudget } from "@/lib/concurrency";
import { STAGE_BUDGET_MS, startOfUtcDay, universeWhere, type BatchStageResult, type StageOptions } from "./shared";

const SENTIMENT_CONCURRENCY = Number(process.env.PIPELINE_SENTIMENT_CONCURRENCY) || 3;

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
    where: { ...universeWhere(), sentiments: { none: { date: { gte: todayUTC } } } },
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
