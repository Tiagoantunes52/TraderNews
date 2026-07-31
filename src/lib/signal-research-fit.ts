// Fitting the blend — estimate term weights from data instead of declaring them.
//
// ── Why this is separate from the harness ───────────────────────────────────────
//
// The harness MEASURES; this module FITS. Keeping them apart is what makes the result
// readable: a fitted candidate is pasted into `signal-research-variants.ts` as plain
// constants, so `Candidate.score` stays a pure per-row function that cannot reach the
// data it was fitted on. The fit runs on TRAIN sessions only (`scripts/signal-research-fit.ts`
// enforces that), the weights are frozen into a diff, and only then does the holdout see
// them. A fitter wired directly into the harness would refit per period and quietly
// report an in-sample number as an out-of-sample one.
//
// ── Why Fama-MacBeth ────────────────────────────────────────────────────────────
//
// One cross-sectional regression per session, then average the coefficients and take the
// t-stat ACROSS sessions. Same reason the harness takes its t-stat across sessions:
// ~105 names moving together on one day are nowhere near 105 independent observations,
// and a pooled panel regression would report standard errors roughly 10x too small.
// The per-session coefficient series is the unit of evidence.
//
// ── What a fit here can and cannot claim ────────────────────────────────────────
//
// It cannot claim the weights are right — only that they are the train-period least-
// squares answer for the terms it was given. The transforms feeding those terms (the
// clamps, the +/-20% momentum normaliser, the RSI regime flip) are still unfitted
// constants; refitting the weights on top of them is the smallest honest step, not the
// last one.
//
// Pure.

import { tStatOneSample } from "@/lib/stats";
import {
  crossSectionalIc,
  regimeOf,
  type FeatureRow,
  type IcStat,
  type MarketRegime,
  type RegimeBoundaries,
} from "@/lib/signal-research";

/** Mean and spread of one term over the fitting period. */
export type Standardizer = { mean: number; sd: number };

/** A term extractor: the row's terms, any of which may be absent. */
export type Terms = Record<string, number | null>;

export type FitResult = {
  /** Fitted weight per term, on standardized units. */
  weights: Record<string, number>;
  /** t-stat of each weight across sessions — the honest significance. */
  tStats: Record<string, number | null>;
  /** Standardizers used, so scoring can reproduce the units exactly. */
  standardizers: Record<string, Standardizer>;
  /** Sessions that yielded a solvable cross-section. */
  sessions: number;
  /** Rows used, after dropping any with a missing term. */
  observations: number;
  /** Rows dropped for a missing term — large numbers mean the fit studied a subset. */
  dropped: number;
};

// ── Linear algebra ───────────────────────────────────────────────────────────

/**
 * Solve `A x = b` by Gaussian elimination with partial pivoting.
 *
 * Returns null on a singular system rather than NaNs: a session where one term is
 * constant across every name (a flat volume ratio, say) is genuinely uninformative, and
 * it should drop out of the coefficient series rather than poison the average.
 */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const x = M.map((row, i) => row[n] / row[i]);
  return x.every(Number.isFinite) ? x : null;
}

/** OLS coefficients for `y ~ X`, where `X` already carries its intercept column. */
export function olsCoefficients(X: number[][], y: number[]): number[] | null {
  const p = X[0]?.length ?? 0;
  if (p === 0 || X.length <= p) return null; // fewer observations than parameters
  const XtX = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Xty = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = a; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
  return solveLinear(XtX, Xty);
}

// ── Standardization ──────────────────────────────────────────────────────────

/**
 * Mean and sd per term over the whole fitting period.
 *
 * Period-wide rather than per-session on purpose: these become FROZEN CONSTANTS in the
 * candidate, and a per-session standardizer could not be reproduced at scoring time
 * without handing the candidate its whole cross-section. Period constants keep
 * `Candidate.score` a per-row function, which is what keeps the harness honest.
 *
 * This is also the direct fix for "the nominal weights are fiction": once every term is
 * in sd units, a weight of 0.3 actually buys 30% of the influence.
 */
export function standardizersFor(rows: Terms[], keys: readonly string[]): Record<string, Standardizer> {
  const out: Record<string, Standardizer> = {};
  for (const k of keys) {
    const vs = rows.map((r) => r[k]).filter((v): v is number => v != null && Number.isFinite(v));
    const m = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
    const variance = vs.length > 1 ? vs.reduce((a, b) => a + (b - m) ** 2, 0) / (vs.length - 1) : 0;
    // A degenerate term gets sd 1 so standardizing is a no-op rather than a division by
    // zero; its fitted weight will come back at ~0 anyway.
    out[k] = { mean: m, sd: variance > 0 ? Math.sqrt(variance) : 1 };
  }
  return out;
}

const z = (v: number, s: Standardizer) => (v - s.mean) / s.sd;

// ── The fit ──────────────────────────────────────────────────────────────────

export type FitOptions = {
  /** Names required on a session before its cross-section is regressed. */
  minNames?: number;
};

/**
 * Fama-MacBeth: regress forward return on the standardized terms within each session,
 * then average the coefficients across sessions.
 *
 * Rows missing ANY term are dropped rather than mean-filled — filling would invent a
 * neutral reading for a term that is simply unknown, and the harness's whole complaint
 * about this codebase is defaults masquerading as facts.
 */
export function fitFamaMacBeth<T extends { session: string }>(
  rows: T[],
  extract: (row: T) => Terms,
  ret: (row: T) => number,
  keys: readonly string[],
  opts: FitOptions = {}
): FitResult {
  const minNames = opts.minNames ?? 10;

  const prepared: { session: string; terms: number[]; y: number }[] = [];
  let dropped = 0;
  const complete: Terms[] = [];
  for (const row of rows) {
    const t = extract(row);
    const vals = keys.map((k) => t[k]);
    if (vals.some((v) => v == null || !Number.isFinite(v))) {
      dropped++;
      continue;
    }
    complete.push(t);
    prepared.push({ session: row.session, terms: vals as number[], y: ret(row) });
  }

  const standardizers = standardizersFor(complete, keys);

  const bySession = new Map<string, { terms: number[]; y: number }[]>();
  for (const p of prepared) {
    const list = bySession.get(p.session);
    if (list) list.push(p);
    else bySession.set(p.session, [p]);
  }

  // One coefficient vector per session; the series is what gets averaged and t-tested.
  const series: number[][] = [];
  for (const [, group] of bySession) {
    if (group.length < minNames) continue;
    const X = group.map((g) => [1, ...g.terms.map((v, i) => z(v, standardizers[keys[i]]))]);
    const beta = olsCoefficients(X, group.map((g) => g.y));
    if (beta) series.push(beta.slice(1)); // drop the intercept — it is the session's mean move
  }

  const weights: Record<string, number> = {};
  const tStats: Record<string, number | null> = {};
  keys.forEach((k, i) => {
    const col = series.map((b) => b[i]);
    weights[k] = col.length ? col.reduce((a, b) => a + b, 0) / col.length : 0;
    tStats[k] = col.length > 1 ? tStatOneSample(col) : null;
  });

  return {
    weights,
    tStats,
    standardizers,
    sessions: series.length,
    observations: prepared.length,
    dropped,
  };
}

// ── Scoring with fitted weights ──────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Score a row from frozen weights and standardizers.
 *
 * Missing terms are excluded and the surviving weights rescaled, exactly as the shipped
 * `blend` does — otherwise a name with no MACD would score systematically nearer zero
 * than one with it, which is a data-availability artefact, not a signal.
 *
 * The output is rescaled by the total absolute weight and clamped to [-1, 1] so it lands
 * on the same scale `scoreToSignal` cuts at. Rank order within a session is unaffected by
 * that rescaling, so cross-sectional IC does not depend on it — only the bucket
 * assignment does, which is the point of matching the scale.
 */
export function scoreWithWeights(
  terms: Terms,
  weights: Record<string, number>,
  standardizers: Record<string, Standardizer>
): number | null {
  let sum = 0;
  let total = 0;
  for (const [k, w] of Object.entries(weights)) {
    const v = terms[k];
    const s = standardizers[k];
    if (v == null || !Number.isFinite(v) || s == null) continue;
    sum += w * z(v, s);
    total += Math.abs(w);
  }
  if (total === 0) return null;
  return clamp(sum / total, -1, 1);
}

// ── Fitting the regime boundaries ────────────────────────────────────────────
//
// ADX 25 / ADX 20 / RSI 30-70 are textbook numbers. Nobody here fitted them, which makes
// them exactly the kind of constant this investigation keeps finding at the bottom of a
// failure. Fitting them is legitimate — and it is also the single most overfittable thing
// in the whole harness, because a grid search over four cut-points will always find a
// partition that flatters the data it searched.
//
// Two defences, both structural rather than advisory:
//
// 1. NESTED SELECTION. The grid is scored on an INNER VALIDATION slice of train that the
//    per-regime weights were never fitted on. Boundaries chosen on the same rows that
//    fitted the weights would be chosen for fitting noise, and the real holdout would be
//    the first thing to notice.
// 2. THE GRID SIZE IS REPORTED. `noiseThreshold(trials)` for a ~116-point grid is |t| ~ 3.1,
//    so a winner is read against what searching 116 partitions produces on its own.
//
// The holdout is still touched exactly once, after both the boundaries and the weights
// are frozen into constants.

/** Sessions a regime must have in the fitting slice before its weights mean anything. */
export const MIN_SESSIONS_PER_REGIME = 30;

/**
 * The pre-registered search grid.
 *
 * `rsiHi` is pinned to `100 - rsiLo` rather than searched independently: RSI is symmetric
 * around 50 by construction, an asymmetric band would need a reason nobody has, and it
 * halves the parameters being searched. `adxCalm <= adxTrend` is enforced because the
 * reverse is not a partition, it is an overlap.
 */
export const ADX_TREND_GRID = [20, 22.5, 25, 27.5, 30, 35] as const;
export const ADX_CALM_GRID = [12.5, 15, 17.5, 20, 22.5] as const;
export const RSI_LO_GRID = [25, 30, 35, 40] as const;

export function boundaryGrid(): RegimeBoundaries[] {
  const out: RegimeBoundaries[] = [];
  for (const adxTrend of ADX_TREND_GRID) {
    for (const adxCalm of ADX_CALM_GRID) {
      if (adxCalm > adxTrend) continue;
      for (const rsiLo of RSI_LO_GRID) out.push({ adxTrend, adxCalm, rsiLo, rsiHi: 100 - rsiLo });
    }
  }
  return out;
}

export type RegimeFit = { w: Record<string, number>; std: Record<string, Standardizer>; sessions: number };

/** Per-regime weights under one set of boundaries, fitted on `rows`. */
export function fitByRegime(
  rows: FeatureRow[],
  boundaries: RegimeBoundaries,
  extract: (f: FeatureRow) => Terms,
  ret: (f: FeatureRow) => number,
  keys: readonly string[],
  opts: FitOptions = {}
): Partial<Record<MarketRegime, RegimeFit>> {
  const groups = new Map<MarketRegime, FeatureRow[]>();
  for (const f of rows) {
    const r = regimeOf(f, boundaries);
    const list = groups.get(r);
    if (list) list.push(f);
    else groups.set(r, [f]);
  }
  const out: Partial<Record<MarketRegime, RegimeFit>> = {};
  for (const [regime, group] of groups) {
    const fit = fitFamaMacBeth(group, extract, ret, keys, opts);
    out[regime] = { w: fit.weights, std: fit.standardizers, sessions: fit.sessions };
  }
  return out;
}

/** Score rows with a per-regime weight set. Null where the regime has no fit. */
export function scoreByRegime(
  f: FeatureRow,
  boundaries: RegimeBoundaries,
  fits: Partial<Record<MarketRegime, RegimeFit>>,
  extract: (f: FeatureRow) => Terms
): number | null {
  const fit = fits[regimeOf(f, boundaries)];
  return fit ? scoreWithWeights(extract(f), fit.w, fit.std) : null;
}

export type BoundaryTrial = {
  boundaries: RegimeBoundaries;
  /** IC on the inner validation slice — the selection criterion. */
  validation: IcStat;
  /** Sessions per regime in the FITTING slice; a thin regime is why a trial is rejected. */
  regimeSessions: Partial<Record<MarketRegime, number>>;
  /** False when some regime is too thin to fit; such a trial is never selected. */
  usable: boolean;
};

/**
 * Score every boundary set in the grid by nested validation.
 *
 * Weights are fitted on `fitRows`; boundaries are ranked by IC on `validateRows`, which
 * the weights never saw. Returns the whole ranking, not just the winner — a grid whose
 * top ten are all within noise of each other is telling you the boundary does not matter,
 * and that is only visible if the runner-up numbers survive.
 */
export function selectBoundaries(
  fitRows: FeatureRow[],
  validateRows: FeatureRow[],
  extract: (f: FeatureRow) => Terms,
  ret: (f: FeatureRow) => number,
  keys: readonly string[],
  grid: RegimeBoundaries[] = boundaryGrid(),
  opts: FitOptions & { minSessionsPerRegime?: number } = {}
): BoundaryTrial[] {
  const minSessions = opts.minSessionsPerRegime ?? MIN_SESSIONS_PER_REGIME;
  const trials: BoundaryTrial[] = [];

  for (const boundaries of grid) {
    const fits = fitByRegime(fitRows, boundaries, extract, ret, keys, opts);
    const regimeSessions: Partial<Record<MarketRegime, number>> = {};
    for (const [regime, fit] of Object.entries(fits)) regimeSessions[regime as MarketRegime] = fit.sessions;
    const usable = Object.values(fits).every((f) => f.sessions >= minSessions);

    const scored: { session: string; score: number; ret: number }[] = [];
    for (const f of validateRows) {
      const s = scoreByRegime(f, boundaries, fits, extract);
      if (s != null && Number.isFinite(s)) scored.push({ session: f.session, score: s, ret: ret(f) });
    }
    trials.push({ boundaries, validation: crossSectionalIc(scored), regimeSessions, usable });
  }

  return trials.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    return (b.validation.mean ?? -Infinity) - (a.validation.mean ?? -Infinity);
  });
}
