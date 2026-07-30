// Data layer for the signal research harness. Reads `PriceBar` and nothing else; all
// the judgement lives in the pure `signal-research.ts`, mirroring how
// `calibration-data.ts` sits under `calibration.ts`.
//
// Price bars only, deliberately. Sentiment and combined scores exist for ~50 sessions,
// which is far too few for a train/test verdict to mean anything — those stay covered
// by `signal-health.ts` in the daily review, which reports them without pretending to
// judge them. Everything here gets the full ~1,190 sessions.

import { db } from "@/lib/db";
import type { Bar } from "@/lib/signal-research";

export type LoadOptions = {
  /** Earliest session to load. Omit for everything in the table. */
  from?: Date;
  /** Restrict to these tickers (the benchmark is always included). */
  tickers?: string[];
  benchmarkTicker?: string;
};

/**
 * Load the bar corpus.
 *
 * One query, ordered by date, because the whole table is ~127k rows / ~27 MB — small
 * enough that paging would add failure modes without buying anything.
 */
export async function loadBars(opts: LoadOptions = {}): Promise<Bar[]> {
  const benchmark = opts.benchmarkTicker ?? "SPY";
  const rows = await db.priceBar.findMany({
    where: {
      ...(opts.from ? { date: { gte: opts.from } } : {}),
      ...(opts.tickers ? { stock: { ticker: { in: [...new Set([...opts.tickers, benchmark])] } } } : {}),
    },
    select: {
      stockId: true,
      date: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      stock: { select: { ticker: true } },
    },
    orderBy: { date: "asc" },
  });

  return rows.map((r) => ({
    stockId: r.stockId,
    ticker: r.stock.ticker,
    session: r.date.toISOString().slice(0, 10),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}
