// Signal research harness — does a candidate score RANK NAMES correctly, out of sample?
//
// ── What this can and cannot support ────────────────────────────────────────────
//
// **Cannot:** say that a change makes money. There are no fills, no sizing, no exit
// ladder, no position caps and no cash accounting here. A score that ranks well can
// still lose after a limit order fails to fill on the names that ran (see
// OPEN-FINDINGS.md — that is precisely how the sim books' apparent edge evaporated).
// A `PASSES` verdict is grounds to PROPOSE a change with evidence, never to ship one.
//
// **Can:** compare two scores' ranking power over 119k stock-days with a real
// train/test split, which is exactly the question `calcQuantScore` currently fails.
//
// ── Why this exists ─────────────────────────────────────────────────────────────
//
// `calcQuantScore` is anti-predictive out of sample: split at 2025-01, its BUY bucket
// went from beating the universe by +0.50pp per 5 days (t=6.54) to trailing by 0.38pp
// (t=-3.42). That study ran in throwaway scripts and is now unreproducible. It also
// killed a plausible one-line fix — the RSI regime flip scored t=+2.58 in sample and
// 0.35 in the holdout — which is the whole argument for making the discipline permanent
// rather than the conclusion.
//
// ── The methodological point ────────────────────────────────────────────────────
//
// IC is computed CROSS-SECTIONALLY PER SESSION and the t-stat is taken ACROSS SESSIONS.
// Pooling every stock-day into one correlation treats ~105 names moving together as ~105
// independent observations and inflates N by roughly 100x, which turns noise into
// significance. `calibration.ts`'s `informationCoefficient` pools; that is fine for the
// point estimate it reports, and wrong for a significance test.
//
// Pure. `signal-research-data.ts` does the I/O.

import {
  calcSMA,
  calcRSI,
  calcATR,
  calcADX,
  calcMACD,
  calcBollingerBands,
  calcVolatility,
  calcVolumeRatio,
  calcMomentum,
  scoreToSignal,
} from "@/lib/indicators";
import { spearman, tStatOneSample, wilsonInterval } from "@/lib/stats";
import { BUCKET_ORDER, isMonotonic, type Bucket, type BucketStat } from "@/lib/calibration";

// ── Inputs ───────────────────────────────────────────────────────────────────

export type Bar = {
  stockId: string;
  ticker: string;
  /** `YYYY-MM-DD`, the session. Sortable; the only ordering key used. */
  session: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export const HORIZONS = [1, 5, 10] as const;
export type Horizon = (typeof HORIZONS)[number];

/**
 * Bars of history required before a session is eligible.
 *
 * 60 is the same window the quant stage fetches, and it clears every indicator's
 * warm-up including ADX's 2x14. Anything shorter would emit rows whose ADX is null and
 * whose regime is therefore unknowable — the harness would silently study a different,
 * smaller universe than it reports.
 */
export const WARMUP_BARS = 60;

export type MarketRegime = "TREND_BULL" | "TREND_BEAR" | "MEAN_REVERTING" | "UNCLASSIFIED";

/**
 * Point-in-time features for one (stock, session).
 *
 * Every field is computed from bars at or before `session`. `forward` is the only
 * exception and is the thing being predicted — it is never an input to a candidate,
 * which is why `Candidate.score` receives the row minus its forward returns.
 */
export type FeatureRow = {
  stockId: string;
  ticker: string;
  session: string;
  close: number;
  sma20: number | null;
  rsi14: number | null;
  atr14: number | null;
  adx14: number | null;
  macdHist: number | null;
  bollPctB: number | null;
  vol30: number | null;
  volRatio10: number | null;
  change7d: number | null;
  change30d: number | null;
  /** 7-day return minus SPY's, the input `calcQuantScore` prefers over `change7d`. */
  relStr7d: number | null;
  marketRegime: MarketRegime;
  forward: Record<`h${Horizon}`, number>;
};

/** What a candidate sees: features without the answer. */
export type ScoreInput = Omit<FeatureRow, "forward">;

export type Candidate = {
  id: string;
  /** One sentence, pre-registered. See signal-research-variants.ts. */
  hypothesis: string;
  score: (f: ScoreInput) => number | null;
  /**
   * CONTROL ONLY: score directly from the forward return, which `ScoreInput` otherwise
   * makes unreachable. Exists so the plumbing control can exist at all, and is a flag
   * rather than a cast so that `grep oracle` finds every score that reads the answer.
   * Never set this on a hypothesis.
   */
  oracle?: true;
  /**
   * A CONTROL, not a hypothesis. Its job is to fail loudly if the harness is broken, so
   * it gets a `CONTROL` verdict rather than being judged as a candidate, and it is
   * excluded from `k` when computing the noise threshold.
   */
  control?: true;
};

// ── Market regime ────────────────────────────────────────────────────────────

/**
 * Market-wide regime from SPY. Deliberately NOT per-name.
 *
 * Tested both ways over the full corpus: per-name regimes showed nothing (TRENDING
 * t=1.01, MEAN_REVERTING t=-0.81), while market-wide showed significant effects with
 * opposite signs (MEAN_REVERTING t=+2.90, TREND_BEAR t=-3.75). The aggregate t of -0.07
 * was two real effects cancelling. Same data, same score, opposite conclusion — so this
 * choice is load-bearing and should not be "simplified" to a per-name read.
 *
 * ADX 20-25 is left UNCLASSIFIED rather than forced into a neighbour: the conventional
 * cuts leave a gap, and inventing a rule to close it would be a parameter nobody fitted.
 */
export function classifyMarketRegime(
  adx: number | null,
  close: number,
  sma20: number | null,
  rsi: number | null
): MarketRegime {
  if (adx == null || sma20 == null || rsi == null) return "UNCLASSIFIED";
  if (adx > 25) return close >= sma20 ? "TREND_BULL" : "TREND_BEAR";
  if (adx < 20 && rsi >= 30 && rsi <= 70) return "MEAN_REVERTING";
  return "UNCLASSIFIED";
}

const bySession = (a: { session: string }, b: { session: string }) => a.session.localeCompare(b.session);

/** Group bars per stock, each list sorted ascending by session. */
function seriesByStock(bars: Bar[]): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const b of bars) {
    const list = out.get(b.stockId);
    if (list) list.push(b);
    else out.set(b.stockId, [b]);
  }
  for (const list of out.values()) list.sort(bySession);
  return out;
}

// ── Feature construction ─────────────────────────────────────────────────────

/**
 * Build the point-in-time feature table.
 *
 * Every indicator reads `series.slice(i - WARMUP_BARS + 1, i + 1)` — bars at or before
 * the session, never after. Forward returns index by POSITION in the stock's own bar
 * series, not by calendar arithmetic: five trading days is not five days, and a holiday
 * would otherwise silently shorten the horizon for one name and not another.
 *
 * A session is emitted only if the longest horizon has fully elapsed, so no row carries
 * a partial forward window.
 */
export function buildFeatures(bars: Bar[], benchmarkTicker = "SPY"): FeatureRow[] {
  const stocks = seriesByStock(bars);
  const maxHorizon = Math.max(...HORIZONS);

  // Benchmark: 7-day return and the market regime, both keyed by session.
  const benchmark = [...stocks.values()].find((s) => s[0]?.ticker === benchmarkTicker) ?? [];
  const benchChange7d = new Map<string, number>();
  const regimeBySession = new Map<string, MarketRegime>();
  for (let i = 0; i < benchmark.length; i++) {
    if (i >= 7) {
      const prev = benchmark[i - 7].close;
      if (prev > 0) benchChange7d.set(benchmark[i].session, ((benchmark[i].close - prev) / prev) * 100);
    }
    if (i < WARMUP_BARS) continue;
    const w = benchmark.slice(i - WARMUP_BARS + 1, i + 1);
    const closes = w.map((b) => b.close);
    regimeBySession.set(
      benchmark[i].session,
      classifyMarketRegime(
        calcADX(w.map((b) => b.high), w.map((b) => b.low), closes),
        benchmark[i].close,
        calcSMA(closes, 20),
        calcRSI(closes)
      )
    );
  }

  const out: FeatureRow[] = [];
  for (const [, series] of stocks) {
    if (series[0]?.ticker === benchmarkTicker) continue; // the benchmark is not a candidate name
    for (let i = WARMUP_BARS; i < series.length - maxHorizon; i++) {
      const bar = series[i];
      const w = series.slice(i - WARMUP_BARS + 1, i + 1);
      const closes = w.map((b) => b.close);
      const highs = w.map((b) => b.high);
      const lows = w.map((b) => b.low);
      const volumes = w.map((b) => b.volume);
      if (bar.close <= 0) continue;

      const change7d = calcMomentum(closes, 7);
      const bench = benchChange7d.get(bar.session);
      const forward = {} as Record<`h${Horizon}`, number>;
      for (const h of HORIZONS) forward[`h${h}`] = (series[i + h].close - bar.close) / bar.close;

      out.push({
        stockId: bar.stockId,
        ticker: bar.ticker,
        session: bar.session,
        close: bar.close,
        sma20: calcSMA(closes, 20),
        rsi14: calcRSI(closes),
        atr14: calcATR(highs, lows, closes),
        adx14: calcADX(highs, lows, closes),
        macdHist: calcMACD(closes)?.histogram ?? null,
        bollPctB: calcBollingerBands(closes)?.percentB ?? null,
        vol30: calcVolatility(closes),
        volRatio10: calcVolumeRatio(volumes),
        change7d,
        change30d: calcMomentum(closes, 30),
        relStr7d: change7d != null && bench != null ? change7d - bench : null,
        marketRegime: regimeBySession.get(bar.session) ?? "UNCLASSIFIED",
        forward,
      });
    }
  }
  // Stable order regardless of Map iteration, so `JSON.stringify` equality is a valid
  // determinism check.
  out.sort((a, b) => a.session.localeCompare(b.session) || a.stockId.localeCompare(b.stockId));
  return out;
}

// ── Cross-sectional excess ───────────────────────────────────────────────────

/**
 * Return minus the universe mean on the same session.
 *
 * The subtraction is the point: a signal that loses ground in a rising market shows a
 * healthy raw return and a negative excess, and only the second one is about the signal.
 *
 * NOTE: `signal-health.ts` computes the same quantity for the daily review. The two are
 * deliberately NOT shared — that module is production and this one is a research script
 * — and a test asserts they agree on a common fixture so they cannot drift.
 */
export function excessBySession<T extends { session: string }>(
  rows: T[],
  ret: (r: T) => number
): Map<T, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const r of rows) {
    const acc = sums.get(r.session) ?? { total: 0, n: 0 };
    acc.total += ret(r);
    acc.n++;
    sums.set(r.session, acc);
  }
  const out = new Map<T, number>();
  for (const r of rows) {
    const acc = sums.get(r.session)!;
    out.set(r, ret(r) - acc.total / acc.n);
  }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/**
 * Expected max |t| across `k` independent candidates under the null.
 *
 * sqrt(2 ln k) is the standard asymptotic for the maximum of k standard normals. With
 * six pre-registered candidates that is ~1.9 — i.e. a best-of-six |t| of 2.0 is barely
 * distinguishable from noise, which is exactly the number a reader needs in front of
 * them before celebrating one.
 */
export function noiseThreshold(k: number): number {
  return k > 1 ? Math.sqrt(2 * Math.log(k)) : 0;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/** Names needed on a session before its cross-sectional IC means anything. */
export const MIN_NAMES_PER_SESSION = 10;
/** Sessions needed for one name before its time-series IC means anything. */
export const MIN_SESSIONS_PER_NAME = 30;

export type IcStat = { mean: number | null; tStat: number | null; groups: number };

export type PeriodStats = {
  label: string;
  sessions: number;
  observations: number;
  /** Per-session IC across names, t-stat taken ACROSS SESSIONS. The headline. */
  crossSectional: IcStat;
  /** Per-name IC across time, t-stat across names. */
  timeSeries: IcStat;
  /** BUY + STRONG_BUY excess over the universe — what actually opens positions. */
  entry: { n: number; meanExcess: number; tStat: number | null };
  buckets: BucketStat[];
  monotonic: boolean;
  byRegime: { regime: MarketRegime; sessions: number; ic: IcStat }[];
};

export type FoldStat = { label: string; ic: IcStat };

export type Verdict = "CONTROL" | "PASSES" | "WEAK" | "FAILS" | "INSUFFICIENT";

export type CandidateReport = {
  id: string;
  hypothesis: string;
  horizon: Horizon;
  train: PeriodStats;
  holdout: PeriodStats;
  folds: FoldStat[];
  verdict: Verdict;
};

const REGIMES: MarketRegime[] = ["TREND_BULL", "TREND_BEAR", "MEAN_REVERTING", "UNCLASSIFIED"];

function icAcross<K>(
  rows: { key: K; x: number; y: number }[],
  minPerGroup: number
): IcStat {
  const groups = new Map<K, { xs: number[]; ys: number[] }>();
  for (const r of rows) {
    const g = groups.get(r.key) ?? { xs: [], ys: [] };
    g.xs.push(r.x);
    g.ys.push(r.y);
    groups.set(r.key, g);
  }
  const ics: number[] = [];
  for (const [, g] of groups) {
    if (g.xs.length < minPerGroup) continue;
    const ic = spearman(g.xs, g.ys);
    if (ic != null && Number.isFinite(ic)) ics.push(ic);
  }
  return { mean: ics.length ? mean(ics) : null, tStat: ics.length > 1 ? tStatOneSample(ics) : null, groups: ics.length };
}

/**
 * Score one candidate over one period.
 *
 * Buckets are measured on EXCESS, not raw return — `bucketStats` in `calibration.ts`
 * works on its own `Observation` shape and on net-of-cost raw returns, so the stats are
 * computed here while `BUCKET_ORDER`, `BucketStat` and `isMonotonic` are reused. A
 * gradient in raw returns mostly reflects the market; a gradient in excess is the signal.
 */
export function evaluatePeriod(
  label: string,
  features: FeatureRow[],
  candidate: Candidate,
  horizon: Horizon
): PeriodStats {
  const ret = (f: FeatureRow) => f.forward[`h${horizon}`];
  const scoreOf = candidate.oracle ? ret : candidate.score;
  const scored = features
    .map((f) => ({ f, score: scoreOf(f) }))
    .filter((r): r is { f: FeatureRow; score: number } => r.score != null && Number.isFinite(r.score));

  const excess = excessBySession(scored.map((r) => r.f), ret);
  const rows = scored.map((r) => ({ ...r, excess: excess.get(r.f)! }));

  const crossSectional = icAcross(
    rows.map((r) => ({ key: r.f.session, x: r.score, y: ret(r.f) })),
    MIN_NAMES_PER_SESSION
  );
  const timeSeries = icAcross(
    rows.map((r) => ({ key: r.f.stockId, x: r.score, y: ret(r.f) })),
    MIN_SESSIONS_PER_NAME
  );

  const byBucket = new Map<string, number[]>();
  const entryExcess: number[] = [];
  for (const r of rows) {
    const label2 = scoreToSignal(r.score);
    const list = byBucket.get(label2);
    if (list) list.push(r.excess);
    else byBucket.set(label2, [r.excess]);
    if (label2 === "BUY" || label2 === "STRONG_BUY") entryExcess.push(r.excess);
  }

  const buckets: BucketStat[] = BUCKET_ORDER.map((bucket: Bucket) => {
    const v = byBucket.get(bucket) ?? [];
    if (v.length === 0) {
      return { bucket, count: 0, meanReturn: null, winRate: null, winRateLo: null, winRateHi: null };
    }
    const wins = v.filter((x) => x > 0).length;
    const w = wilsonInterval(wins, v.length);
    return {
      bucket,
      count: v.length,
      meanReturn: mean(v),
      winRate: wins / v.length,
      winRateLo: w?.lo ?? null,
      winRateHi: w?.hi ?? null,
    };
  });

  return {
    label,
    sessions: new Set(rows.map((r) => r.f.session)).size,
    observations: rows.length,
    crossSectional,
    timeSeries,
    entry: {
      n: entryExcess.length,
      meanExcess: entryExcess.length ? mean(entryExcess) : 0,
      tStat: entryExcess.length > 1 ? tStatOneSample(entryExcess) : null,
    },
    buckets,
    monotonic: isMonotonic(buckets),
    byRegime: REGIMES.map((regime) => {
      const sub = rows.filter((r) => r.f.marketRegime === regime);
      return {
        regime,
        sessions: new Set(sub.map((r) => r.f.session)).size,
        ic: icAcross(sub.map((r) => ({ key: r.f.session, x: r.score, y: ret(r.f) })), MIN_NAMES_PER_SESSION),
      };
    }),
  };
}

// ── Splits ───────────────────────────────────────────────────────────────────

/** Everything strictly before `date` is train; the rest is holdout. */
export function splitFixed(features: FeatureRow[], date: string): { train: FeatureRow[]; holdout: FeatureRow[] } {
  return {
    train: features.filter((f) => f.session < date),
    holdout: features.filter((f) => f.session >= date),
  };
}

/**
 * `k` contiguous folds by session, oldest first.
 *
 * Splits on SESSIONS rather than rows so every fold spans the same amount of calendar,
 * not the same number of observations — a fold covering more names would otherwise look
 * longer than it is. Contiguous and ordered because these are time series: a shuffled
 * k-fold would train on the future to predict the past.
 */
export function splitRolling(features: FeatureRow[], k: number): { label: string; rows: FeatureRow[] }[] {
  const sessions = [...new Set(features.map((f) => f.session))].sort();
  if (k < 1 || sessions.length < k) return [];
  const size = Math.floor(sessions.length / k);
  const out: { label: string; rows: FeatureRow[] }[] = [];
  for (let i = 0; i < k; i++) {
    const from = sessions[i * size];
    const to = i === k - 1 ? sessions[sessions.length - 1] : sessions[(i + 1) * size - 1];
    out.push({ label: `${from}→${to}`, rows: features.filter((f) => f.session >= from && f.session <= to) });
  }
  return out;
}

const sign = (v: number | null | undefined) => (v == null ? 0 : v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * Verdict from the fixed split, with the rolling folds as a consistency check.
 *
 * `FAILS` on a sign flip is deliberately harsher than "not significant": a score whose
 * ranking reverses out of sample is worse than one with no edge, because it is actively
 * choosing the wrong names. That is `baseline`'s current state.
 */
export function verdictFor(train: PeriodStats, holdout: PeriodStats, folds: FoldStat[]): Verdict {
  const t0 = train.crossSectional.mean;
  const t1 = holdout.crossSectional.mean;
  const tstat = holdout.crossSectional.tStat;
  if (t0 == null || t1 == null || holdout.crossSectional.groups < 2) return "INSUFFICIENT";
  if (sign(t0) !== 0 && sign(t1) !== sign(t0)) return "FAILS";

  const consistent = folds.filter((f) => sign(f.ic.mean) === sign(t1)).length;
  const enough = folds.length === 0 || consistent >= Math.ceil((folds.length * 3) / 4);
  return tstat != null && Math.abs(tstat) >= 2 && enough ? "PASSES" : "WEAK";
}

// ── Reporting ────────────────────────────────────────────────────────────────

/** Did the controls behave? If not, nothing else in the run may be read. */
export function controlsOk(reports: CandidateReport[]): { ok: boolean; detail: string } {
  const oracle = reports.find((r) => r.id === "oracle");
  const mom30 = reports.find((r) => r.id === "mom30");
  const problems: string[] = [];
  for (const period of ["train", "holdout"] as const) {
    const ic = oracle?.[period].crossSectional.mean;
    if (oracle && (ic == null || Math.abs(ic - 1) > 1e-9)) {
      problems.push(`oracle ${period} IC ${ic?.toFixed(6) ?? "null"} ≠ 1.000000`);
    }
  }
  const mt = mom30?.train.crossSectional.tStat;
  if (mom30 && (mt == null || mt < 1.5)) {
    problems.push(`mom30 train t=${mt?.toFixed(2) ?? "null"} — a known effect is not being detected`);
  }
  return { ok: problems.length === 0, detail: problems.join("; ") };
}

const ic = (s: IcStat) =>
  s.mean == null ? "        —      " : `${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(4)}(${(s.tStat ?? NaN).toFixed(2)})`.padEnd(16);
const bps = (v: number) => `${v >= 0 ? "+" : ""}${(v * 10_000).toFixed(1)}bps`;

export function formatReport(reports: CandidateReport[], k = reports.length): string {
  const L: string[] = [];
  const ctl = controlsOk(reports);
  const first = reports[0];

  L.push(`═══ signal research — horizon ${first?.horizon ?? "?"} sessions ═══`);
  L.push(
    `train ${first?.train.sessions ?? 0} sessions / ${(first?.train.observations ?? 0).toLocaleString()} obs   ` +
      `holdout ${first?.holdout.sessions ?? 0} sessions / ${(first?.holdout.observations ?? 0).toLocaleString()} obs`
  );
  L.push("");

  if (!ctl.ok) {
    L.push("!!! CONTROL BROKEN — every number below is void until this is fixed:");
    L.push(`    ${ctl.detail}`);
    L.push("");
  }

  L.push("VERDICT (cross-sectional IC, t across sessions)");
  L.push("candidate              TRAIN           HOLDOUT         entry excess    verdict");
  for (const r of reports) {
    L.push(
      `${r.id.padEnd(22)}${ic(r.train.crossSectional)}${ic(r.holdout.crossSectional)}` +
        `${bps(r.holdout.entry.meanExcess).padEnd(16)}${r.verdict}`
    );
  }

  if (first?.folds.length) {
    L.push("", `ROBUSTNESS (rolling, ${first.folds.length} folds — sign consistency vs holdout)`);
    for (const r of reports) {
      const signs = r.folds.map((f) => (f.ic.tStat ?? 0).toFixed(1).padStart(5)).join(" ");
      const agree = r.folds.filter((f) => sign(f.ic.mean) === sign(r.holdout.crossSectional.mean)).length;
      L.push(`${r.id.padEnd(22)}${signs}   → sign holds ${agree}/${r.folds.length}`);
    }
  }

  L.push("", "HOLDOUT BY MARKET REGIME (cross-sectional IC)");
  L.push("candidate              TREND_BULL      TREND_BEAR      MEAN_REVERT     UNCLASSIFIED");
  for (const r of reports) {
    L.push(`${r.id.padEnd(22)}${r.holdout.byRegime.map((g) => ic(g.ic)).join("")}`);
  }

  L.push("", "HYPOTHESES (pre-registered)");
  for (const r of reports) L.push(`  ${r.id}: ${r.hypothesis}`);

  L.push(
    "",
    `k=${k} candidates → noise threshold |t| ≈ ${noiseThreshold(k).toFixed(2)}. A best-of-${k} result at or below that is what noise alone produces.`,
    "This harness models NO fills, sizing, exits, caps or cash. It cannot say a change makes money.",
    "Caveats: survivorship bias (today's watchlist tested back to 2021 inflates momentum-family results);",
    "close-to-close returns ignore fills and costs, which only makes any result worse."
  );
  return L.join("\n");
}

export type EvaluateOptions = {
  splitDate: string;
  folds?: number;
  horizon?: Horizon;
};

/** Score one candidate: fixed split for the verdict, rolling folds for robustness. */
export function evaluate(features: FeatureRow[], candidate: Candidate, opts: EvaluateOptions): CandidateReport {
  const horizon = opts.horizon ?? 5;
  const { train, holdout } = splitFixed(features, opts.splitDate);
  const trainStats = evaluatePeriod("train", train, candidate, horizon);
  const holdoutStats = evaluatePeriod("holdout", holdout, candidate, horizon);
  const folds = splitRolling(features, opts.folds ?? 0).map((f) => ({
    label: f.label,
    ic: evaluatePeriod(f.label, f.rows, candidate, horizon).crossSectional,
  }));
  return {
    id: candidate.id,
    hypothesis: candidate.hypothesis,
    horizon,
    train: trainStats,
    holdout: holdoutStats,
    folds,
    verdict: candidate.control ? "CONTROL" : verdictFor(trainStats, holdoutStats, folds),
  };
}
