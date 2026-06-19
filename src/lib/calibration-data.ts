// Data layer for the signal-validation harness (issue #55). Reads the tables the
// pipeline already fills and runs them through the pure analytics in
// `lib/calibration.ts`. Server-only (DB + a SPY price fetch); the math it calls is
// unit-tested separately, so this stays a thin orchestration layer like pipeline.ts.

import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { getDailyPrices } from "@/lib/price-sources";
import { spearman, maxDrawdown, neweyWestRegression, pearson } from "@/lib/stats";
import {
  computeForwardReturns,
  nonOverlapping,
  effectiveSampleSize,
  bucketStats,
  isMonotonic,
  informationCoefficient,
  reliabilityDiagram,
  portfolioMetrics,
  entrySignalEdge,
  effectiveBets,
  costBpsForStock,
  evaluateGate,
  type EstimatePoint,
  type PricePoint,
  type Observation,
  type BucketStat,
  type Reliability,
  type PortfolioMetrics,
  type GateResult,
  type GateStatus,
} from "@/lib/calibration";

// Forward-return horizons (in trading bars). 5d is the pre-registered gate horizon:
// short enough to accrue trades on a young dataset, long enough to be a real hold.
export const HORIZONS = [1, 5, 20] as const;
export const PRIMARY_HORIZON = 5;
export type Horizon = (typeof HORIZONS)[number];

const dayKey = (d: Date | string): string =>
  (typeof d === "string" ? d : d.toISOString()).slice(0, 10);

const isCryptoTicker = (ticker: string) => ticker.endsWith("-USD");

export type ComponentIC = { key: string; label: string; ic: number | null; note: string };

export type HorizonReport = {
  horizon: Horizon;
  totalObservations: number;
  effectiveSample: number; // non-overlapping count — the honest N
  buckets: BucketStat[];
  monotone: boolean;
  ic: { combined: number | null; sentiment: number | null; quant: number | null };
  componentIc: ComponentIC[];
  reliability: Reliability;
};

export type CalibrationReport = {
  generatedAt: string;
  stockCount: number;
  estimateCount: number;
  firstDate: string | null;
  lastDate: string | null;
  monthsCoverage: number;
  horizons: HorizonReport[];
  gatedBook: string;
  gatedStrategy: string;
  closedTrades: number;
  book: PortfolioMetrics | null;
  spy: { totalReturn: number | null; maxDrawdown: number | null; available: boolean };
  // Equal-weight buy-and-hold of the watchlist — isolates timing skill from ticker selection.
  watchlistReturn: number | null;
  // Concentration: how many independent bets the watchlist really is.
  breadth: { stocks: number; avgCorrelation: number | null; effectiveBets: number | null };
  alpha: { alpha: number; beta: number; alphaAnnualized: number; alphaT: number | null } | null;
  // Net-of-cost per-trade edge at the gate horizon, base cost and 2× cost-stress.
  edge: { n: number; meanNet: number | null; tStat: number | null; meanNetStressed: number | null };
  gate: GateResult;
};

// Per-stock decision-day indicator values, for the per-component IC. Keyed by
// `${stockId}|${dayKey}` so an observation can look up the indicators that formed
// its signal. (T+1 anchoring means using the decision-day indicator value is safe —
// the return is measured from the next bar, so there's no same-bar leak.)
type IndicatorRow = {
  rsi14: number | null;
  momentum: number | null; // relativeStr7d ?? change7d (the quant blend's momentum input)
  macdHistogram: number | null;
  bollingerPctB: number | null;
  volumeRatio10d: number | null;
};

const COMPONENT_DEFS: { key: keyof IndicatorRow; label: string; note: string }[] = [
  { key: "rsi14", label: "RSI(14)", note: "negative IC ⇒ mean-reversion works (low RSI → up)" },
  { key: "momentum", label: "7d momentum", note: "positive IC ⇒ trend-following works" },
  { key: "macdHistogram", label: "MACD hist.", note: "positive IC ⇒ trend confirmation works" },
  { key: "bollingerPctB", label: "Bollinger %B", note: "positive IC ⇒ position-in-band predicts" },
  { key: "volumeRatio10d", label: "Volume ratio", note: "confirmation factor" },
];

function componentIC(
  obs: Observation[],
  indicators: Map<string, IndicatorRow>
): ComponentIC[] {
  return COMPONENT_DEFS.map(({ key, label, note }) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const o of obs) {
      const row = indicators.get(`${o.stockId}|${o.decisionDate}`);
      const v = row?.[key];
      if (v == null) continue;
      xs.push(v);
      ys.push(o.netReturn);
    }
    return { key, label, ic: spearman(xs, ys), note };
  });
}

/**
 * Build the full calibration report from existing tables. Read-only; safe to call
 * on each page load. Network (SPY benchmark) is best-effort — a failure degrades
 * the alpha/benchmark section, never the whole report.
 */
export async function loadCalibrationReport(): Promise<CalibrationReport> {
  const [stocks, estimates, quant] = await Promise.all([
    db.stock.findMany({ select: { id: true, ticker: true } }),
    db.stockEstimate.findMany({
      select: {
        stockId: true,
        date: true,
        sentimentScore: true,
        quantScore: true,
        combinedScore: true,
        signal: true,
        confidence: true,
      },
      orderBy: { date: "asc" },
    }),
    db.quantAnalysis.findMany({
      select: {
        stockId: true,
        date: true,
        price: true,
        atrPct: true,
        rsi14: true,
        change7d: true,
        relativeStr7d: true,
        macdHistogram: true,
        bollingerPctB: true,
        volumeRatio10d: true,
      },
      orderBy: { date: "asc" },
    }),
  ]);

  const tickerById = new Map(stocks.map((s) => [s.id, s.ticker]));

  // Per-stock price series (one point per UTC day; last write wins) + latest ATR%.
  const pricesByStock = new Map<string, Map<string, number>>();
  const latestAtrByStock = new Map<string, number | null>();
  const indicators = new Map<string, IndicatorRow>();
  for (const q of quant) {
    if (q.price != null && q.price > 0) {
      let m = pricesByStock.get(q.stockId);
      if (!m) pricesByStock.set(q.stockId, (m = new Map()));
      m.set(dayKey(q.date), q.price);
    }
    if (q.atrPct != null) latestAtrByStock.set(q.stockId, q.atrPct);
    indicators.set(`${q.stockId}|${dayKey(q.date)}`, {
      rsi14: q.rsi14,
      momentum: q.relativeStr7d ?? q.change7d,
      macdHistogram: q.macdHistogram,
      bollingerPctB: q.bollingerPctB,
      volumeRatio10d: q.volumeRatio10d,
    });
  }

  // Per-stock estimate series (one per UTC day; last write wins, so the final
  // version of an intraday-recomputed estimate is used — T+1 entry keeps it honest).
  const estByStock = new Map<string, Map<string, EstimatePoint>>();
  for (const e of estimates) {
    let m = estByStock.get(e.stockId);
    if (!m) estByStock.set(e.stockId, (m = new Map()));
    m.set(dayKey(e.date), {
      date: dayKey(e.date),
      sentimentScore: e.sentimentScore,
      quantScore: e.quantScore,
      combinedScore: e.combinedScore,
      signal: e.signal,
      confidence: e.confidence,
    });
  }

  const toSortedPrices = (m: Map<string, number>): PricePoint[] =>
    [...m.entries()].map(([date, price]) => ({ date, price })).sort((a, b) => a.date.localeCompare(b.date));

  // Build the net-of-cost observations across all stocks for one horizon. `costMult`
  // doubles the per-stock cost for the gate's 2× cost-stress check.
  const buildObservations = (horizon: number, costMult = 1): Observation[] => {
    const all: Observation[] = [];
    for (const [stockId, estMap] of estByStock) {
      const priceMap = pricesByStock.get(stockId);
      if (!priceMap) continue;
      const ticker = tickerById.get(stockId) ?? "";
      const costBps =
        costMult *
        costBpsForStock({ isCrypto: isCryptoTicker(ticker), atrPct: latestAtrByStock.get(stockId) ?? null });
      const ests = [...estMap.values()].sort((a, b) => a.date.localeCompare(b.date));
      all.push(...computeForwardReturns(stockId, ests, toSortedPrices(priceMap), { horizonDays: horizon, costBpsPerSide: costBps }));
    }
    return all;
  };

  // Observations per horizon, across all stocks, net of per-stock cost.
  const horizons: HorizonReport[] = HORIZONS.map((horizon) => {
    const all = buildObservations(horizon);
    // Non-overlapping subset is the honest set for CIs / IC significance.
    const indep = nonOverlapping(all, horizon);
    const buckets = bucketStats(indep);
    return {
      horizon,
      totalObservations: all.length,
      effectiveSample: effectiveSampleSize(all, horizon),
      buckets,
      monotone: isMonotonic(buckets),
      ic: {
        combined: informationCoefficient(indep, "combinedScore"),
        sentiment: informationCoefficient(indep, "sentimentScore"),
        quant: informationCoefficient(indep, "quantScore"),
      },
      componentIc: componentIC(indep, indicators),
      reliability: reliabilityDiagram(indep),
    };
  });

  // Net-of-cost per-trade edge at the gate horizon, base + 2× cost-stress.
  const primaryIndep = nonOverlapping(buildObservations(PRIMARY_HORIZON), PRIMARY_HORIZON);
  const primaryEdge = entrySignalEdge(primaryIndep);
  const stressedEdge = entrySignalEdge(nonOverlapping(buildObservations(PRIMARY_HORIZON, 2), PRIMARY_HORIZON));
  const edge = {
    n: primaryEdge.n,
    meanNet: primaryEdge.meanNet,
    tStat: primaryEdge.tStat,
    meanNetStressed: stressedEdge.meanNet,
  };

  // Equal-weight watchlist buy-and-hold + concentration breadth.
  const perStockSorted = [...pricesByStock.values()].map(toSortedPrices).filter((p) => p.length >= 2);
  const ewReturns = perStockSorted.map((p) => p[p.length - 1].price / p[0].price - 1);
  const watchlistReturn = ewReturns.length ? ewReturns.reduce((s, v) => s + v, 0) / ewReturns.length : null;

  // Average pairwise correlation of daily returns → effective number of bets.
  const retSeries = perStockSorted.map((p) => {
    const m = new Map<string, number>();
    for (let i = 1; i < p.length; i++) if (p[i - 1].price > 0) m.set(p[i].date, p[i].price / p[i - 1].price - 1);
    return m;
  });
  let corrSum = 0;
  let corrPairs = 0;
  for (let a = 0; a < retSeries.length; a++) {
    for (let b = a + 1; b < retSeries.length; b++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [date, r] of retSeries[a]) {
        const r2 = retSeries[b].get(date);
        if (r2 != null) {
          xs.push(r);
          ys.push(r2);
        }
      }
      const c = pearson(xs, ys);
      if (c != null) {
        corrSum += c;
        corrPairs++;
      }
    }
  }
  const avgCorrelation = corrPairs > 0 ? corrSum / corrPairs : null;
  const breadth = {
    stocks: perStockSorted.length,
    avgCorrelation,
    effectiveBets: avgCorrelation != null ? effectiveBets(perStockSorted.length, avgCorrelation) : null,
  };

  // Coverage window.
  const allDates = estimates.map((e) => dayKey(e.date)).sort();
  const firstDate = allDates[0] ?? null;
  const lastDate = allDates[allDates.length - 1] ?? null;
  const monthsCoverage =
    firstDate && lastDate
      ? (new Date(lastDate).getTime() - new Date(firstDate).getTime()) / (1000 * 60 * 60 * 24 * 30.44)
      : 0;

  // Pre-registered gated book: COMBINED_RM if it has been run, else COMBINED.
  const rmSnaps = await db.paperEquitySnapshot.count({ where: { book: "SIM_COMBINED_RM" } });
  const gatedBook = rmSnaps > 0 ? "SIM_COMBINED_RM" : "SIM_COMBINED";
  const gatedStrategy = rmSnaps > 0 ? "COMBINED_RM" : "COMBINED";

  const [snaps, closedTrades] = await Promise.all([
    db.paperEquitySnapshot.findMany({
      where: { book: gatedBook },
      select: { date: true, equity: true },
      orderBy: { date: "asc" },
    }),
    db.simPosition.count({ where: { strategy: gatedStrategy, status: "CLOSED" } }),
  ]);

  const bookEquity = snaps.map((s) => s.equity);
  const book = bookEquity.length >= 2 ? portfolioMetrics(bookEquity) : null;

  // SPY benchmark — best-effort; align daily returns by date for alpha/beta.
  let spy: CalibrationReport["spy"] = { totalReturn: null, maxDrawdown: null, available: false };
  let alpha: CalibrationReport["alpha"] = null;
  let spyMaxDd: number | null = null;
  if (firstDate) {
    try {
      const since = new Date(`${firstDate}T00:00:00.000Z`);
      const { prices: spyPrices } = await getDailyPrices("SPY", since);
      if (spyPrices.length >= 2) {
        const spyByDay = new Map(spyPrices.map((p) => [dayKey(p.date), p.close]));
        const spyCloses = [...spyByDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, c]) => c);
        spyMaxDd = maxDrawdown(spyCloses);
        spy = {
          totalReturn: spyCloses.length >= 2 ? spyCloses[spyCloses.length - 1] / spyCloses[0] - 1 : null,
          maxDrawdown: spyMaxDd,
          available: true,
        };
        // Align book & SPY returns on shared snapshot dates.
        const bookRet: number[] = [];
        const spyRet: number[] = [];
        for (let i = 1; i < snaps.length; i++) {
          const d0 = dayKey(snaps[i - 1].date);
          const d1 = dayKey(snaps[i].date);
          const s0 = spyByDay.get(d0);
          const s1 = spyByDay.get(d1);
          if (s0 != null && s1 != null && s0 > 0 && snaps[i - 1].equity > 0) {
            bookRet.push(snaps[i].equity / snaps[i - 1].equity - 1);
            spyRet.push(s1 / s0 - 1);
          }
        }
        // Regress book on SPY with HAC (Newey-West) SEs so the alpha t-stat isn't
        // overstated by autocorrelated daily returns.
        const fit = neweyWestRegression(spyRet, bookRet);
        if (fit) alpha = { alpha: fit.alpha, beta: fit.beta, alphaAnnualized: fit.alpha * 252, alphaT: fit.alphaT };
      }
    } catch {
      // benchmark unavailable — leave alpha/spy as the unavailable defaults
    }
  }

  const primaryHorizon = horizons.find((h) => h.horizon === PRIMARY_HORIZON);
  const gate = evaluateGate({
    monthsCoverage,
    effectiveTrades: closedTrades,
    hadSpyDrawdown: spyMaxDd != null && spyMaxDd >= 0.05,
    edgeMean: edge.meanNet,
    edgeTStat: edge.tStat,
    alphaTStat: alpha?.alphaT ?? null,
    maxDrawdown: book?.maxDrawdown ?? null,
    spyMaxDrawdown: spyMaxDd,
    monotone: primaryHorizon?.monotone ?? false,
    brier: primaryHorizon?.reliability.brier ?? null,
    baseRateBrier: primaryHorizon?.reliability.baseRateBrier ?? null,
    // Edge must stay positive when the modeled cost is doubled.
    survivesCostStress: edge.meanNetStressed == null ? null : edge.meanNetStressed > 0,
  });

  return {
    generatedAt: new Date().toISOString(),
    stockCount: estByStock.size,
    estimateCount: estimates.length,
    firstDate,
    lastDate,
    monthsCoverage,
    horizons,
    gatedBook,
    gatedStrategy,
    closedTrades,
    book,
    spy,
    watchlistReturn,
    breadth,
    alpha,
    edge,
    gate,
  };
}

const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Promote a report's headline fields into the snapshot row's columns (pure). */
export function snapshotInput(report: CalibrationReport, date: Date) {
  const primary = report.horizons.find((h) => h.horizon === PRIMARY_HORIZON);
  return {
    date,
    gateStatus: report.gate.status,
    gatedBook: report.gatedBook,
    monthsCoverage: report.monthsCoverage,
    closedTrades: report.closedTrades,
    edgeMean: report.edge.meanNet,
    edgeTStat: report.edge.tStat,
    alphaTStat: report.alpha?.alphaT ?? null,
    combinedIc: primary?.ic.combined ?? null,
  };
}

export type CalibrateStageResult = {
  stage: "calibrate";
  status: GateStatus | null;
  done: true;
  errors: string[];
};

/**
 * Pipeline stage: snapshot the calibration report for today's UTC day. Idempotent
 * (upsert by date) like the other stages, so the extra 3-hourly runs just refresh
 * the same row. Read-only beyond its own snapshot — a failure is reported, never
 * thrown, so it can't sink the rest of the pipeline.
 */
export async function runCalibrateStage(): Promise<CalibrateStageResult> {
  const errors: string[] = [];
  let status: GateStatus | null = null;
  try {
    const report = await loadCalibrationReport();
    status = report.gate.status;
    const today = startOfUtcDay(new Date());
    const row = snapshotInput(report, today);
    const reportJson = report as unknown as Prisma.InputJsonValue;
    await db.calibrationSnapshot.upsert({
      where: { date: today },
      create: { ...row, report: reportJson },
      update: { ...row, report: reportJson },
    });
  } catch (e) {
    errors.push(`calibrate failed: ${String(e)}`);
  }
  return { stage: "calibrate", status, done: true, errors };
}
