// Pure analytics for the signal-validation / calibration harness (issue #55).
//
// No DB, no network — the `calibrate` pipeline stage fetches rows and feeds them
// here; keeping the math pure is what makes it testable, and getting it *correct*
// is the whole point. The Model QA + Investment Researcher reviews flagged three
// ways this kind of study lies, all fixed here at the source:
//
//   1. Same-bar look-ahead — never anchor a return at the price the signal was
//      computed from. Decisions use data through day T; execution AND measurement
//      start at the next available bar (T+1). See `computeForwardReturns`.
//   2. No transaction cost — a daily strategy's edge dies in frictions. Every
//      return is reported NET of a round-trip cost. See `roundTripCost`.
//   3. Overlapping windows — consecutive daily h-period returns share h−1 future
//      days, inflating significance 3–5×. Significance is computed on the
//      non-overlapping subset. See `nonOverlapping` / `effectiveSampleSize`.
//
// Horizons are counted in *available price points* for the stock, so each asset
// runs on its own calendar (crypto trades weekends, equities don't) automatically.

import {
  spearman,
  wilsonInterval,
  sharpe,
  sortino,
  maxDrawdown,
  brierScore,
  baseRateBrier,
  linearRegression,
  tStatOneSample,
} from "@/lib/stats";

/** Buckets ordered from most bearish to most bullish — for monotonicity checks. */
export const BUCKET_ORDER = ["STRONG_SELL", "SELL", "NEUTRAL", "BUY", "STRONG_BUY"] as const;
export type Bucket = (typeof BUCKET_ORDER)[number];

/** One daily close for a stock. `date` is a sortable UTC day key (YYYY-MM-DD). */
export type PricePoint = { date: string; price: number };

/** A single day's estimate — the decision made on `date` (day T). */
export type EstimatePoint = {
  date: string;
  sentimentScore: number;
  quantScore: number | null;
  combinedScore: number;
  signal: string;
  confidence: number;
};

/** A realized, T+1-anchored, net-of-cost forward-return observation. */
export type Observation = {
  stockId: string;
  decisionDate: string; // day T — when the signal was formed
  entryDate: string; // T+1 — first bar after the decision (execution)
  exitDate: string; // entry + horizon
  entryIndex: number; // index into the stock's price series (for de-overlapping)
  rawReturn: number; // gross forward return
  netReturn: number; // after round-trip transaction cost
  signal: string;
  sentimentScore: number;
  quantScore: number | null;
  combinedScore: number;
  confidence: number;
};

/**
 * Net return of a long round-trip after a per-side cost (basis points). The buy
 * pays up `c` and the sell receives down `c`, so a `raw` gross return becomes
 * `(1+raw)(1−c)/(1+c) − 1`. Commission-free ≠ cost-free: spread + slippage are
 * the real tax on a daily-rebalanced book, so nothing is reported gross.
 */
export function roundTripCost(rawReturn: number, costBpsPerSide: number): number {
  const c = costBpsPerSide / 10_000;
  return ((1 + rawReturn) * (1 - c)) / (1 + c) - 1;
}

/**
 * Join one stock's estimates to its price series and produce T+1-anchored,
 * net-of-cost forward returns at `horizonDays`.
 *
 * For each estimate on day T: the entry is the FIRST price strictly after T
 * (next available bar — never the signal's own bar), and the exit is `horizonDays`
 * bars later. Estimates without a future entry, or without enough forward bars to
 * reach the exit, are dropped (no peeking, no partial windows).
 *
 * `prices` must be sorted ascending by date with one point per day.
 */
export function computeForwardReturns(
  stockId: string,
  estimates: EstimatePoint[],
  prices: PricePoint[],
  opts: { horizonDays: number; costBpsPerSide?: number }
): Observation[] {
  const { horizonDays } = opts;
  const costBps = opts.costBpsPerSide ?? 0;
  if (horizonDays < 1 || prices.length === 0) return [];

  const out: Observation[] = [];
  for (const est of estimates) {
    // First bar strictly after the decision day = T+1 execution.
    const entryIndex = prices.findIndex((p) => p.date > est.date);
    if (entryIndex === -1) continue;
    const exitIndex = entryIndex + horizonDays;
    if (exitIndex >= prices.length) continue;

    const entry = prices[entryIndex];
    const exit = prices[exitIndex];
    if (entry.price <= 0) continue;

    const rawReturn = exit.price / entry.price - 1;
    out.push({
      stockId,
      decisionDate: est.date,
      entryDate: entry.date,
      exitDate: exit.date,
      entryIndex,
      rawReturn,
      netReturn: roundTripCost(rawReturn, costBps),
      signal: est.signal,
      sentimentScore: est.sentimentScore,
      quantScore: est.quantScore,
      combinedScore: est.combinedScore,
      confidence: est.confidence,
    });
  }
  return out;
}

/**
 * The non-overlapping subset: per stock, keep observations whose entries are at
 * least `horizonDays` bars apart, so no two share a forward day. This is the set
 * to compute significance (IC t-stats, hit-rate CIs) on — the full overlapping
 * set is fine for point estimates but makes p-values lie.
 */
export function nonOverlapping(obs: Observation[], horizonDays: number): Observation[] {
  const byStock = new Map<string, Observation[]>();
  for (const o of obs) {
    const arr = byStock.get(o.stockId);
    if (arr) arr.push(o);
    else byStock.set(o.stockId, [o]);
  }
  const kept: Observation[] = [];
  for (const arr of byStock.values()) {
    const sorted = [...arr].sort((a, b) => a.entryIndex - b.entryIndex);
    let lastKept = -Infinity;
    for (const o of sorted) {
      if (o.entryIndex - lastKept >= horizonDays) {
        kept.push(o);
        lastKept = o.entryIndex;
      }
    }
  }
  return kept;
}

/** Count of independent (non-overlapping) observations — the honest sample size. */
export function effectiveSampleSize(obs: Observation[], horizonDays: number): number {
  return nonOverlapping(obs, horizonDays).length;
}

export type BucketStat = {
  bucket: Bucket;
  count: number;
  meanReturn: number | null; // mean NET forward return for the bucket
  winRate: number | null; // fraction with net return > 0
  winRateLo: number | null; // Wilson 95% lower bound
  winRateHi: number | null; // Wilson 95% upper bound
};

/**
 * Per-bucket mean net return + win-rate (with Wilson CIs). The headline read is
 * whether mean return rises monotonically STRONG_SELL → STRONG_BUY — a clean
 * gradient is more convincing at small N than a single IC number.
 *
 * Pass the non-overlapping subset for the win-rate CIs to be honest.
 */
export function bucketStats(obs: Observation[]): BucketStat[] {
  return BUCKET_ORDER.map((bucket) => {
    const rows = obs.filter((o) => o.signal === bucket);
    const n = rows.length;
    if (n === 0) {
      return { bucket, count: 0, meanReturn: null, winRate: null, winRateLo: null, winRateHi: null };
    }
    const wins = rows.filter((o) => o.netReturn > 0).length;
    const w = wilsonInterval(wins, n);
    return {
      bucket,
      count: n,
      meanReturn: rows.reduce((s, o) => s + o.netReturn, 0) / n,
      winRate: wins / n,
      winRateLo: w?.lo ?? null,
      winRateHi: w?.hi ?? null,
    };
  });
}

/**
 * Is the per-bucket mean-return gradient monotonically non-decreasing from
 * STRONG_SELL to STRONG_BUY? Empty buckets are skipped (a missing bucket doesn't
 * break the gradient). Needs at least 2 populated buckets to mean anything.
 */
export function isMonotonic(stats: BucketStat[]): boolean {
  const ordered = BUCKET_ORDER.map((b) => stats.find((s) => s.bucket === b)?.meanReturn ?? null).filter(
    (v): v is number => v != null
  );
  if (ordered.length < 2) return false;
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i] < ordered[i - 1]) return false;
  }
  return true;
}

/** Which estimate score to rank for an IC. */
export type ScoreKey = "combinedScore" | "sentimentScore" | "quantScore";

/**
 * Information coefficient: Spearman rank correlation between a score and the
 * realized NET forward return. Rows where the score is null (e.g. quantScore on a
 * sentiment-only stock) are dropped. Pass the non-overlapping subset for an
 * honest reading. Null below `minPairs`.
 */
export function informationCoefficient(
  obs: Observation[],
  key: ScoreKey,
  minPairs = 5
): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const o of obs) {
    const score = o[key];
    if (score == null) continue;
    xs.push(score);
    ys.push(o.netReturn);
  }
  return spearman(xs, ys, minPairs);
}

/**
 * Net-of-cost edge of the trades the book actually takes: the entry-signal
 * (BUY/STRONG_BUY) observations. Returns the mean net return, its one-sample
 * t-stat, and N. Pass the non-overlapping subset so the t-stat is a valid
 * significance test. This — not the gross sim equity Sharpe — is the gate's
 * risk-adjusted edge measure, because it's genuinely net of modeled costs.
 */
export function entrySignalEdge(obs: Observation[]): {
  n: number;
  meanNet: number | null;
  tStat: number | null;
} {
  const rets = obs.filter((o) => o.signal === "BUY" || o.signal === "STRONG_BUY").map((o) => o.netReturn);
  if (rets.length === 0) return { n: 0, meanNet: null, tStat: null };
  return {
    n: rets.length,
    meanNet: rets.reduce((s, v) => s + v, 0) / rets.length,
    tStat: tStatOneSample(rets),
  };
}

// ── Transaction-cost model ────────────────────────────────────────────────────
// Per-side cost in basis points, by asset class, ATR-scaled. Commission-free
// fills still pay the spread; thin names and crypto pay much more, and wider
// recent ranges (higher ATR) mean worse fills. These are deliberately
// conservative priors — the gate re-checks edge at 2× this (see cost stress).
export const COST_BPS = { liquidEquity: 5, equity: 20, crypto: 40 } as const;

/**
 * Per-side transaction cost (bps) for one stock. `isCrypto` and `atrPct` come
 * straight from the market taxonomy + `QuantAnalysis`; `isLiquid` is an optional
 * future refinement (defaults to the mid equity tier). ATR scales the base by
 * `clamp(atrPct / typical, 0.5, 3)`.
 */
export function costBpsForStock(opts: {
  isCrypto?: boolean;
  isLiquid?: boolean;
  atrPct?: number | null;
}): number {
  const isCrypto = opts.isCrypto ?? false;
  const base = isCrypto ? COST_BPS.crypto : opts.isLiquid ? COST_BPS.liquidEquity : COST_BPS.equity;
  const typical = isCrypto ? 4 : 2; // typical ATR% for the class
  const atr = opts.atrPct;
  const factor = atr != null && atr > 0 ? Math.max(0.5, Math.min(3, atr / typical)) : 1;
  return base * factor;
}

// ── Confidence calibration (reliability diagram) ──────────────────────────────

export type ReliabilityBin = {
  lo: number; // bin lower edge (confidence)
  hi: number; // bin upper edge
  count: number;
  meanConfidence: number | null; // x of the reliability point
  hitRate: number | null; // y of the reliability point (empirical accuracy)
  hitRateLo: number | null; // Wilson 95% bounds
  hitRateHi: number | null;
};

export type Reliability = {
  bins: ReliabilityBin[];
  brier: number | null; // Brier score of confidence vs directional outcome
  baseRateBrier: number | null; // no-skill benchmark; confidence is useful only if brier < this
  n: number; // directional observations used (NEUTRAL excluded)
};

/**
 * Directional outcome of an observation, or null when there's no directional call
 * to score: a BUY/STRONG_BUY is "right" if the net return is positive, a
 * SELL/STRONG_SELL if it's negative. NEUTRAL has no direction → excluded.
 */
function directionalOutcome(o: Observation): boolean | null {
  if (o.signal === "BUY" || o.signal === "STRONG_BUY") return o.netReturn > 0;
  if (o.signal === "SELL" || o.signal === "STRONG_SELL") return o.netReturn < 0;
  return null;
}

/**
 * Reliability diagram + Brier scores for the `confidence` field, treating it as a
 * forecast P(directional call correct). If the Brier score doesn't beat the
 * base-rate benchmark, confidence carries no usable information and sizing should
 * fall back to equal-weight (per the Model QA review). Pass the non-overlapping
 * subset for honest bin CIs.
 */
export function reliabilityDiagram(obs: Observation[], binCount = 5): Reliability {
  const confidences: number[] = [];
  const outcomes: boolean[] = [];
  for (const o of obs) {
    const outcome = directionalOutcome(o);
    if (outcome == null) continue;
    confidences.push(Math.max(0, Math.min(1, o.confidence)));
    outcomes.push(outcome);
  }

  const bins: ReliabilityBin[] = [];
  for (let b = 0; b < binCount; b++) {
    const lo = b / binCount;
    const hi = (b + 1) / binCount;
    const idxs: number[] = [];
    for (let i = 0; i < confidences.length; i++) {
      const c = confidences[i];
      // Last bin is inclusive of the upper edge so confidence === 1 lands somewhere.
      if (c >= lo && (c < hi || (b === binCount - 1 && c <= hi))) idxs.push(i);
    }
    const count = idxs.length;
    if (count === 0) {
      bins.push({ lo, hi, count: 0, meanConfidence: null, hitRate: null, hitRateLo: null, hitRateHi: null });
      continue;
    }
    const wins = idxs.filter((i) => outcomes[i]).length;
    const w = wilsonInterval(wins, count);
    bins.push({
      lo,
      hi,
      count,
      meanConfidence: idxs.reduce((s, i) => s + confidences[i], 0) / count,
      hitRate: wins / count,
      hitRateLo: w?.lo ?? null,
      hitRateHi: w?.hi ?? null,
    });
  }

  return {
    bins,
    brier: brierScore(confidences, outcomes),
    baseRateBrier: baseRateBrier(outcomes),
    n: outcomes.length,
  };
}

// ── Portfolio-level metrics (from an equity curve) ────────────────────────────

/** Simple period-over-period returns from an equity curve. */
export function equityCurveReturns(equity: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    if (prev > 0) out.push(equity[i] / prev - 1);
  }
  return out;
}

export type PortfolioMetrics = {
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  totalReturn: number | null;
  days: number;
};

/**
 * Risk-adjusted metrics for a book from its daily equity snapshots. These are the
 * portfolio-level numbers (not per-position), which is what we'd actually risk
 * money on. `periodsPerYear` defaults to 252 trading days.
 */
export function portfolioMetrics(equity: number[], periodsPerYear = 252): PortfolioMetrics {
  const rets = equityCurveReturns(equity);
  const totalReturn = equity.length >= 2 && equity[0] > 0 ? equity[equity.length - 1] / equity[0] - 1 : null;
  return {
    sharpe: sharpe(rets, periodsPerYear),
    sortino: sortino(rets, periodsPerYear),
    maxDrawdown: maxDrawdown(equity),
    totalReturn,
    days: equity.length,
  };
}

/**
 * Regress a book's returns on the (date-aligned) benchmark's. Returns market
 * exposure (beta), the per-period intercept (alpha), and the annualized alpha —
 * the excess SPY doesn't explain. Arrays must already be aligned by date.
 */
export function alphaBeta(
  bookReturns: number[],
  benchmarkReturns: number[],
  periodsPerYear = 252,
  minPairs = 5
): { alpha: number; beta: number; alphaAnnualized: number } | null {
  const fit = linearRegression(benchmarkReturns, bookReturns, minPairs);
  if (!fit) return null;
  return { alpha: fit.alpha, beta: fit.beta, alphaAnnualized: fit.alpha * periodsPerYear };
}

/**
 * Effective number of independent bets given `n` positions with average pairwise
 * correlation `avgCorr`: `n / (1 + (n−1)·ρ)`. A watchlist of co-moving tech names
 * (or several crypto positions) collapses to far fewer real bets than its count —
 * so "diversified across 8 names" can be one beta bet wearing eight hats.
 */
export function effectiveBets(n: number, avgCorr: number): number {
  if (n <= 1) return n;
  const rho = Math.max(0, Math.min(1, avgCorr));
  return n / (1 + (n - 1) * rho);
}

// ── Go-live gate ──────────────────────────────────────────────────────────────
// Pre-registered, out-of-sample, net-of-cost. Defaults to INSUFFICIENT_DATA until
// there's enough history to certify anything — which, given how little has
// accumulated, is the expected (and correct) near-term verdict.
//
// WHERE THIS IS ENFORCED, AND WHY NOT IN THE ORDER PATH
// The gate is deliberately advisory: nothing in the order path consults it. That reads
// like an oversight and isn't, so before "fixing" it, note what wiring it in would do.
//
// This app can only trade paper — `baseUrl()` in lib/alpaca-trading.ts refuses any
// non-paper Alpaca host outright, with no environment override. The gate's subject is
// whether the strategy has earned REAL money, and real money is already unreachable by
// a stronger mechanism than a status check: a code-level boundary rather than a value
// that has to be computed correctly and then respected.
//
// Meanwhile the gate reads INSUFFICIENT_DATA (it needs `minMonths` of track record).
// Blocking paper orders on it would stop the paper book trading — and the paper book is
// the only thing generating the history the gate needs. The gate would permanently
// prevent itself from ever being satisfiable.
//
// So: the gate reports, the endpoint boundary enforces. If live trading is ever wanted,
// the gate becomes its precondition — and that is a deliberate, reviewed change to the
// boundary, which is exactly the ceremony such a change deserves.

/**
 * Which book the gate certifies.
 *
 * The broker's book whenever one exists, and a sim book only before any broker history
 * does. This used to always pick a SIM book — one that never paid a spread, never missed
 * a fill and never had an order rest unfilled for a month. Those are exactly the points
 * where sim and broker diverge, and the divergence is one-sided: the sim books trades
 * the broker could not execute, and the ones it could not execute were disproportionately
 * the winners. Certifying "ready for real money" against the simulation measures the one
 * thing such a decision must not rely on.
 *
 * A SHORT live history deliberately does not fall back to the sim: it is judged as the
 * short live history it is and fails the gate on coverage, which is the right answer.
 * Two snapshots is simply the minimum for a return series to exist at all.
 */
export function selectGatedBook(input: { liveSnapshots: number; rmSnapshots: number }): {
  book: string;
  isLive: boolean;
} {
  if (input.liveSnapshots >= 2) return { book: "ALPACA", isLive: true };
  return { book: input.rmSnapshots > 0 ? "SIM_COMBINED_RM" : "SIM_COMBINED", isLive: false };
}

export const GATE_THRESHOLDS = {
  minMonths: 6,
  minTrades: 30, // non-overlapping round-trips in the gated book
  minEdgeTStat: 2, // net-of-cost per-trade edge must be positive and significant
  minAlphaTStat: 2,
  maxDrawdownVsSpy: 1.5, // book maxDD must be ≤ this × SPY maxDD
} as const;

export type GateInput = {
  monthsCoverage: number;
  effectiveTrades: number;
  hadSpyDrawdown: boolean;
  edgeMean: number | null; // net-of-cost mean return of entry-signal trades
  edgeTStat: number | null;
  alphaTStat: number | null;
  maxDrawdown: number | null;
  spyMaxDrawdown: number | null;
  monotone: boolean;
  brier: number | null;
  baseRateBrier: number | null;
  survivesCostStress: boolean | null;
};

export type GateCheck = { label: string; pass: boolean | null; detail: string };
export type GateStatus = "GO" | "NO_GO" | "INSUFFICIENT_DATA";
export type GateResult = { status: GateStatus; checks: GateCheck[] };

/**
 * Evaluate the pre-registered go-live gate. Coverage/sample thresholds gate first:
 * below them the verdict is INSUFFICIENT_DATA regardless of how good the numbers
 * look (you can't certify on three months of one bull regime). Above them, every
 * condition must pass for GO; a null input (a metric we couldn't compute) counts
 * as not-yet-confirmed and blocks GO.
 */
export function evaluateGate(g: GateInput): GateResult {
  const t = GATE_THRESHOLDS;
  const checks: GateCheck[] = [];

  const coverageOk = g.monthsCoverage >= t.minMonths;
  checks.push({
    label: `≥ ${t.minMonths} months of history`,
    pass: coverageOk,
    detail: `${g.monthsCoverage.toFixed(1)} months`,
  });
  const tradesOk = g.effectiveTrades >= t.minTrades;
  checks.push({
    label: `≥ ${t.minTrades} non-overlapping trades`,
    pass: tradesOk,
    detail: `${g.effectiveTrades} trades`,
  });

  // Hard data floor — without it, nothing below is trustworthy.
  if (!coverageOk || !tradesOk) {
    return { status: "INSUFFICIENT_DATA", checks };
  }

  checks.push({
    label: "OOS window includes a SPY drawdown",
    pass: g.hadSpyDrawdown,
    detail: g.hadSpyDrawdown ? "≥1 non-bull stretch observed" : "only bull regime so far",
  });
  checks.push({
    label: `Net-of-cost edge t-stat ≥ ${t.minEdgeTStat}`,
    pass:
      g.edgeMean == null || g.edgeTStat == null
        ? null
        : g.edgeMean > 0 && g.edgeTStat >= t.minEdgeTStat,
    detail:
      g.edgeTStat == null || g.edgeMean == null
        ? "not computed"
        : `mean ${(g.edgeMean * 100).toFixed(2)}%, t=${g.edgeTStat.toFixed(2)}`,
  });
  checks.push({
    label: `Alpha vs SPY t-stat ≥ ${t.minAlphaTStat}`,
    pass: g.alphaTStat == null ? null : g.alphaTStat >= t.minAlphaTStat,
    detail: g.alphaTStat == null ? "not computed" : g.alphaTStat.toFixed(2),
  });
  const ddOk =
    g.maxDrawdown != null && g.spyMaxDrawdown != null
      ? g.maxDrawdown <= t.maxDrawdownVsSpy * g.spyMaxDrawdown
      : null;
  checks.push({
    label: `Max drawdown ≤ ${t.maxDrawdownVsSpy}× SPY`,
    pass: ddOk,
    detail:
      g.maxDrawdown == null || g.spyMaxDrawdown == null
        ? "not computed"
        : `${(g.maxDrawdown * 100).toFixed(1)}% vs SPY ${(g.spyMaxDrawdown * 100).toFixed(1)}%`,
  });
  checks.push({
    label: "Monotone bucket gradient",
    pass: g.monotone,
    detail: g.monotone ? "STRONG_SELL→STRONG_BUY rises" : "non-monotone",
  });
  const calibOk =
    g.brier != null && g.baseRateBrier != null ? g.brier < g.baseRateBrier : null;
  checks.push({
    label: "Confidence beats base-rate (Brier)",
    pass: calibOk,
    detail:
      g.brier == null || g.baseRateBrier == null
        ? "not computed"
        : `Brier ${g.brier.toFixed(3)} vs base ${g.baseRateBrier.toFixed(3)}`,
  });
  checks.push({
    label: "Survives 2× cost stress",
    pass: g.survivesCostStress,
    detail: g.survivesCostStress == null ? "not computed" : g.survivesCostStress ? "yes" : "no",
  });

  const status: GateStatus = checks.every((c) => c.pass === true) ? "GO" : "NO_GO";
  return { status, checks };
}
