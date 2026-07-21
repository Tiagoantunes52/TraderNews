import { db } from "@/lib/db";
import { processWithBudget } from "@/lib/concurrency";
import { getCongressTrades, isCongressConfigured, isCongressEligible } from "@/lib/congress-trades";
import { STAGE_BUDGET_MS, watchedStocksWhere, type StageOptions } from "./shared";

// Congress disclosures lag the trade by up to 45 days (STOCK Act), so a wide
// trailing window keeps newly-disclosed older trades in view. AInvest's free tier
// throttles hard (status 4014), so the stage runs serially (concurrency 1) and the
// source paces + backs off per request; the 45-day lag makes the latency a non-issue.
const CONGRESS_CONCURRENCY = Number(process.env.PIPELINE_CONGRESS_CONCURRENCY) || 1;
const CONGRESS_BACKFILL_DAYS = Number(process.env.CONGRESS_BACKFILL_DAYS) || 180;

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
