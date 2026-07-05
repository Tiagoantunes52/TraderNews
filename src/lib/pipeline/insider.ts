import { db } from "@/lib/db";
import { getInsiderSentiment } from "@/lib/finnhub";
import { processWithBudget } from "@/lib/concurrency";
import { getInsiderTxns, isInsiderEligible } from "@/lib/insider-sources";
import { summarizeInsider, detectInsiderClusterBuy, detectInsiderFlowShift, detectCsuiteBuy } from "@/lib/insider-detect";
import { reportError } from "@/lib/observability";
import {
  STAGE_BUDGET_MS,
  dateStr,
  processAlerts,
  startOfUtcDay,
  watchedStocksWhere,
  type BatchStageResult,
  type PendingAlert,
  type StageOptions,
} from "./shared";

// Insider stage makes 2 Finnhub calls per stock (transactions + sentiment), so a
// gentler concurrency keeps clear of the rate limit. Backfill = trailing window
// fetched each run; the per-day summary guard makes steady-state re-fetches cheap.
const INSIDER_CONCURRENCY = Number(process.env.PIPELINE_INSIDER_CONCURRENCY) || 2;
const INSIDER_BACKFILL_DAYS = Number(process.env.INSIDER_BACKFILL_DAYS) || 90;

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
