/**
 * Pearson correlation coefficient between two equal-length series.
 * Returns null when there are fewer than `minPairs` points or either
 * series has zero variance (correlation undefined).
 */
export function pearson(xs: number[], ys: number[], minPairs = 5): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < minPairs) return null;

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;

  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }

  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

// ── Calibration primitives (issue #55) ───────────────────────────────────────
// Pure, deterministic building blocks for the signal-validation harness. The
// Model QA review flagged these as the parts that "must be right or the whole
// exercise is worthless", so each is small, single-purpose, and unit-tested.

/** Arithmetic mean, or null for an empty series. */
export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Sample standard deviation (n−1 denominator). Null below 2 points. */
export function sampleStdev(xs: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = xs.reduce((s, v) => s + v, 0) / n;
  const ss = xs.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(ss / (n - 1));
}

/**
 * Fractional (1-based) ranks with tied values sharing their average rank — the
 * standard tie handling for Spearman. `[1, 2, 2, 3]` → `[1, 2.5, 2.5, 4]`.
 */
export function ranks(xs: number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avgRank = (i + j + 2) / 2; // mean of 1-based ranks (i+1)…(j+1)
    for (let k = i; k <= j; k++) out[order[k][1]] = avgRank;
    i = j + 1;
  }
  return out;
}

/**
 * Spearman rank correlation — Pearson on the rank-transformed series. Measures
 * monotonic (not just linear) association, which is what we want for "does a
 * higher score rank a higher forward return?". Null below `minPairs` or when a
 * series is all ties (zero rank variance).
 */
export function spearman(xs: number[], ys: number[], minPairs = 5): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < minPairs) return null;
  return pearson(ranks(xs.slice(0, n)), ranks(ys.slice(0, n)), minPairs);
}

/**
 * Wilson score interval for a binomial proportion — the right CI for hit-rate at
 * small N (unlike the normal approximation, it stays within [0, 1] and doesn't
 * collapse to a point at 0% / 100%). Returns the point estimate and bounds, or
 * null for n ≤ 0 / out-of-range successes.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96
): { p: number; lo: number; hi: number } | null {
  if (n <= 0 || successes < 0 || successes > n) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

/**
 * Brier score: mean squared error of probabilistic predictions against 0/1
 * outcomes. Lower is better; 0 is perfect. Null for an empty/length-0 series.
 */
export function brierScore(probs: number[], outcomes: (number | boolean)[]): number | null {
  const n = Math.min(probs.length, outcomes.length);
  if (n === 0) return null;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const o = outcomes[i] ? 1 : 0;
    const d = probs[i] - o;
    s += d * d;
  }
  return s / n;
}

/**
 * Brier score of the no-skill predictor that always forecasts the base rate.
 * Equals p̄(1−p̄). A confidence field only carries information if its Brier score
 * beats this benchmark — otherwise position-sizing on it is sizing on noise.
 */
export function baseRateBrier(outcomes: (number | boolean)[]): number | null {
  const n = outcomes.length;
  if (n === 0) return null;
  const pbar = outcomes.reduce<number>((s, o) => s + (o ? 1 : 0), 0) / n;
  return pbar * (1 - pbar);
}

/**
 * Annualized Sharpe ratio from a series of per-period returns (fractions).
 * `periodsPerYear` defaults to 252 (trading days). Uses sample stdev; null below
 * 2 points or with zero volatility (Sharpe undefined).
 */
export function sharpe(
  returns: number[],
  periodsPerYear = 252,
  riskFreePerPeriod = 0
): number | null {
  if (returns.length < 2) return null;
  const excess = returns.map((r) => r - riskFreePerPeriod);
  const m = excess.reduce((s, v) => s + v, 0) / excess.length;
  const sd = sampleStdev(excess);
  if (sd == null || sd === 0) return null;
  return (m / sd) * Math.sqrt(periodsPerYear);
}

/**
 * Annualized Sortino ratio — like Sharpe but penalizing only downside deviation
 * (RMS of below-target returns, full-n denominator). Null below 2 points or when
 * no return falls below target (no downside ⇒ undefined).
 */
export function sortino(
  returns: number[],
  periodsPerYear = 252,
  targetPerPeriod = 0
): number | null {
  const n = returns.length;
  if (n < 2) return null;
  const m = returns.reduce((s, v) => s + v, 0) / n - targetPerPeriod;
  let downsideSq = 0;
  for (const r of returns) {
    const d = Math.min(0, r - targetPerPeriod);
    downsideSq += d * d;
  }
  const dd = Math.sqrt(downsideSq / n);
  if (dd === 0) return null;
  return (m / dd) * Math.sqrt(periodsPerYear);
}

/**
 * Ordinary least-squares fit of `ys` on `xs` → slope (beta) and intercept (alpha).
 * Used to regress a book's returns on the benchmark's: beta is market exposure,
 * alpha is the per-period excess the market doesn't explain. Null below `minPairs`
 * or when `xs` has zero variance.
 */
export function linearRegression(
  xs: number[],
  ys: number[],
  minPairs = 5
): { alpha: number; beta: number } | null {
  const n = Math.min(xs.length, ys.length);
  if (n < minPairs) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    cov += dx * (ys[i] - my);
    vx += dx * dx;
  }
  if (vx === 0) return null;
  const beta = cov / vx;
  return { beta, alpha: my - beta * mx };
}

/**
 * Maximum drawdown of an equity curve, as a positive fraction (0.25 = a 25% peak-
 * to-trough decline). 0 for a monotonically rising curve; null for an empty curve.
 */
export function maxDrawdown(equity: number[]): number | null {
  if (equity.length === 0) return null;
  let peak = equity[0];
  let maxDd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}
