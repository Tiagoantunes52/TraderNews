import { db } from "@/lib/db";
import { scoreToSignal } from "@/lib/indicators";
import { detectSignalChange, detectVelocitySpike, detectRsiCross, newsVelocityRatio } from "@/lib/alerts";
import { processWithBudget } from "@/lib/concurrency";
import { reportError } from "@/lib/observability";
import {
  STAGE_BUDGET_MS,
  processAlerts,
  startOfUtcDay,
  universeWhere,
  type BatchStageResult,
  type PendingAlert,
  type StageOptions,
} from "./shared";

const ESTIMATE_CONCURRENCY = Number(process.env.PIPELINE_ESTIMATE_CONCURRENCY) || 5;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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

  // Every stock in the universe whose today estimate is missing or stale. "Stale" =
  // a sentiment newer than the estimate's last computation has landed. The estimate
  // snapshots the sentiment score, so it must be recomputed when sentiment moves —
  // otherwise a delayed sentiment leaves the day's estimate (and the signal the
  // paper book trades on) frozen on the prior day's read.
  const universe = await db.stock.findMany({
    where: universeWhere(),
    select: { id: true, ticker: true },
  });
  const universeIds = universe.map((s) => s.id);
  const [sentMax, estToday] = await Promise.all([
    db.sentiment.groupBy({ by: ["stockId"], where: { stockId: { in: universeIds } }, _max: { date: true } }),
    db.stockEstimate.groupBy({
      by: ["stockId"],
      where: { stockId: { in: universeIds }, date: { gte: todayUTC } },
      _max: { date: true },
    }),
  ]);
  const latestSentimentAt = new Map(sentMax.map((r) => [r.stockId, r._max.date]));
  const todayEstimateAt = new Map(estToday.map((r) => [r.stockId, r._max.date]));
  const worklist = universe.filter((s) => {
    const sAt = latestSentimentAt.get(s.id);
    if (!sAt) return false; // no sentiment yet → nothing to estimate from
    const eAt = todayEstimateAt.get(s.id);
    return !eAt || eAt.getTime() < sAt.getTime();
  });
  const worklistIds = worklist.map((s) => s.id);

  // Batch the per-stock reads for the whole worklist up front — the work loop
  // below then only writes. The quant window is bounded (quant runs right before
  // this stage, so the two most recent rows are always inside it).
  const quantWindowStart = new Date(to.getTime() - 60 * 86_400_000);
  const [sentimentRows, quantRows, articleLinks24h, articleLinks7d, oldEstimateRows, prevEstimateRows] = worklistIds.length
    ? await Promise.all([
        db.sentiment.findMany({
          where: { stockId: { in: worklistIds } },
          orderBy: { date: "desc" },
          distinct: ["stockId"],
          select: { stockId: true, score: true, confidence: true, articleCount: true },
        }),
        db.quantAnalysis.findMany({
          where: { stockId: { in: worklistIds }, date: { gte: quantWindowStart } },
          orderBy: { date: "desc" },
          select: { stockId: true, score: true, volatility30d: true, daysToEarnings: true, rsi14: true },
        }),
        db.articleStock.groupBy({
          by: ["stockId"],
          where: { stockId: { in: worklistIds }, article: { publishedAt: { gte: yesterday } } },
          _count: { _all: true },
        }),
        // The velocity DENOMINATOR: how much news actually exists over the same 7-day
        // window the sentiment stage reads. It cannot come from `Sentiment.articleCount`,
        // which is the post-slice count of what the LLM was shown (capped at 10) — that
        // put an uncapped numerator over a capped denominator, pinning the divisor at a
        // constant 1.43/day for ~90% of names and making two thirds of all estimates read
        // as a news spike. Counted the same way as the 24h numerator above, so the two
        // sides are finally the same unit: `ArticleStock` links over their window.
        //
        // Not deduplicated by headline, and it does not need to be: measured 2026-09-07,
        // normalising and de-duping the 7-day corpus removes 0 of 8,613 links across all
        // 110 stocks, so a plain count is exact here and costs one aggregate instead of
        // shipping every headline to the app.
        db.articleStock.groupBy({
          by: ["stockId"],
          where: { stockId: { in: worklistIds }, article: { publishedAt: { gte: sevenDaysAgo } } },
          _count: { _all: true },
        }),
        db.stockEstimate.findMany({
          where: { stockId: { in: worklistIds }, date: { lte: sevenDaysAgo } },
          orderBy: { date: "desc" },
          distinct: ["stockId"],
          select: { stockId: true, combinedScore: true },
        }),
        db.stockEstimate.findMany({
          where: { stockId: { in: worklistIds } },
          orderBy: { date: "desc" },
          distinct: ["stockId"],
          select: { stockId: true, id: true, signal: true, date: true },
        }),
      ])
    : [[], [], [], [], [], []];
  const sentimentByStock = new Map(sentimentRows.map((r) => [r.stockId, r]));
  // Two most recent quant rows per stock: today's (for the score) and the
  // previous one (for RSI-cross detection). Rows arrive date-desc.
  const recentQuantByStock = new Map<string, typeof quantRows>();
  for (const q of quantRows) {
    const arr = recentQuantByStock.get(q.stockId);
    if (!arr) recentQuantByStock.set(q.stockId, [q]);
    else if (arr.length < 2) arr.push(q);
  }
  const count24hByStock = new Map(articleLinks24h.map((r) => [r.stockId, r._count._all]));
  const volume7dByStock = new Map(articleLinks7d.map((r) => [r.stockId, r._count._all]));
  const oldEstimateByStock = new Map(oldEstimateRows.map((r) => [r.stockId, r]));
  const prevEstimateByStock = new Map(prevEstimateRows.map((r) => [r.stockId, r]));

  const outcome = await processWithBudget(
    worklist,
    async (stock) => {
      try {
        const latestSentiment = sentimentByStock.get(stock.id);
        if (!latestSentiment) return; // can't estimate without sentiment; attempted

        const recentQuant = recentQuantByStock.get(stock.id) ?? [];
        const latestQuant = recentQuant[0] ?? null;
        const prevRsi = recentQuant[1]?.rsi14 ?? null;

        const sentimentScore = latestSentiment.score;
        const quantScore = latestQuant?.score ?? null;
        // TWO different quantities, deliberately kept apart — the field name hid the
        // distinction and one consumer paid for it:
        //   • `articleCount` — headlines the LLM ACTUALLY SCORED (deduped, capped at 10
        //     by the prompt slice). The right input wherever the question is "how much
        //     evidence produced this sentiment score", which is why `blendSentiment`
        //     weights by it too.
        //   • `newsVolume`  — how much news EXISTS for the name over the same 7-day
        //     window, uncapped. The right input wherever the question is "how newsworthy
        //     is this name right now".
        // Only `articleVelocityRatio` below actually needed the second one; the checks at
        // `< 3` and `>= 10` are equivalent under either (see their comments), and they are
        // left reading `articleCount` so the evidence-based reading stays the default.
        const articleCount = latestSentiment.articleCount ?? 0;
        const newsVolume = volume7dByStock.get(stock.id) ?? 0;
        const vol = latestQuant?.volatility30d ?? null;
        const daysToEarnings = latestQuant?.daysToEarnings ?? null;

        // Article velocity: last-24h count vs daily average over the 7-day window.
        // Both sides are `ArticleStock` link counts now — before 2026-09-07 the divisor
        // was the capped `articleCount`, so this read ≥2.5× for 56.6% of rows and raised
        // 1,791 of the 2,785 alerts in a 30-day window off a denominator that barely moved.
        const last24hCount = count24hByStock.get(stock.id) ?? 0;
        const articleVelocityRatio = newsVelocityRatio(last24hCount, newsVolume, 7);

        // Dynamic blending based on article count and volatility
        // Weighted by the evidence BEHIND the sentiment score, so `articleCount` is the
        // input it wants — the score was produced from those headlines and no others.
        //
        // The curve is nonetheless miscalibrated: it is written to reach 0.6 at 15, and
        // its input cannot exceed 10, so it tops out at 0.5 and the last third of the
        // designed range is unreachable. Rescaling it to the domain it actually has is a
        // STRATEGY change — it moves `combinedScore` for essentially every name, and
        // `combinedScore` drives COMBINED_RM's exits — so it belongs to the backtest
        // track, not to a plumbing fix. Feeding `newsVolume` here instead is NOT that fix:
        // measured 2026-09-07 it saturates 93 of 110 names at the 0.6 cap, trading one
        // near-constant for another. See OPEN-FINDINGS.md, "articleCount counts the LLM
        // prompt".
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
        // Equivalent under either quantity: the slice only binds from 10 upward, so
        // `articleCount < 3` holds exactly when `newsVolume < 3`. The cap can never hide
        // a thin evidence base, which is what this penalty is for.
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
        // Also equivalent: `articleCount` reaches 10 exactly when the window held 10 or
        // more, so this boolean already fires on "newsworthy" and not merely on "the slice
        // capped". What the cap costs it is DEGREE — 10 articles and 736 are the same to a
        // threshold test — which only matters if this ever becomes graduated.
        confidence = Math.max(0.1, Math.min(1.0, confidence + (articleCount >= 10 ? 0.15 : 0)));

        // Sentiment delta vs 7 days ago
        const oldEstimate = oldEstimateByStock.get(stock.id) ?? null;
        const sentimentDelta = oldEstimate ? combinedScore - oldEstimate.combinedScore : null;

        // Latest existing estimate: its signal is the baseline for signal-change
        // detection (including an intraday flip when we refresh today's row), and
        // when it's today's row we update it in place — one estimate per stock per
        // UTC day, so no stale snapshot is left behind when sentiment moves.
        const prevEstimate = prevEstimateByStock.get(stock.id) ?? null;

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
