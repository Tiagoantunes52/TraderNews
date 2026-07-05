// Portfolio-level risk controls (issue #56, Phase 0.5). Pure + unit-tested.
//
// Per-position stops (lib/paper-trading.ts) protect each *name*; this layer protects
// the *book*. A correlated crash gaps through every per-position stop at once, so
// "8 positions" can really be one tech-beta bet wearing eight hats. We therefore:
//
//   • cap gross exposure (Σ position notional ÷ equity),
//   • cap single-name and single-correlation-cluster concentration,
//   • halt new buys via an account-level drawdown kill-switch, de-risking the gross
//     cap as drawdown deepens (so we step down before the hard halt).
//
// No DB / network here — the pipeline supplies the current book state and these
// helpers answer "may I open this position?". Ships dark behind PAPER_RISK_LIMITS=1.

import { pearson } from "@/lib/stats";

// Env reader that respects an explicit 0 (so a "disabled" knob isn't silently
// swapped for its default the way `Number(x) || def` would). Mirrors paper-trading.
function numEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export type RiskLimits = {
  maxGrossExposurePct: number; // Σ position notional ÷ equity (1.0 = fully invested, no leverage)
  maxPositions: number; // hard cap on concurrent open names
  maxPositionPct: number; // single-name notional ÷ equity
  maxClusterPct: number; // single correlation-cluster notional ÷ equity
  maxClusterPositions: number; // names per cluster (0 disables)
  killSwitchDrawdownPct: number; // halt ALL new buys above this drawdown from peak equity
  deriskStartDrawdownPct: number; // drawdown where the gross-cap step-down begins
  peakWindowDays: number; // rolling window (days) for the peak the drawdown is measured from (0 = all-time)
  regimeMaWindow: number; // SPY moving-average window (closes) for the regime filter (0 disables)
  regimeRiskOffGrossFrac: number; // fraction of the gross cap allowed while SPY < its MA
};

// Conservative long-only defaults: near-fully-invested ceiling, ~12 names, no single
// name above 15% or correlation cluster above 40% of equity, halt at a 20% drawdown
// with the gross cap ramping down from an 8% drawdown.
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxGrossExposurePct: 0.95,
  maxPositions: 12,
  maxPositionPct: 0.15,
  maxClusterPct: 0.4,
  maxClusterPositions: 5,
  killSwitchDrawdownPct: 0.2,
  deriskStartDrawdownPct: 0.08,
  // Rolling, not all-time: an all-time peak never resets, so one bad stretch would
  // halt new buys FOREVER (nothing new can open, so equity can never recover to a
  // peak it can only drift away from). 90 days ≈ a quarter to work it off.
  peakWindowDays: 90,
  // Regime filter (issue #58): long-only books make most of their drawdown in bear
  // markets — while SPY sits below its MA, only half the gross cap may deploy.
  // Neutral (full cap) until enough SPY history exists to compute the MA.
  regimeMaWindow: 200,
  regimeRiskOffGrossFrac: 0.5,
};

/** The active limits, each field overridable by its PAPER_* env var (no redeploy). */
export function riskLimits(): RiskLimits {
  return {
    maxGrossExposurePct: numEnv("PAPER_MAX_GROSS_PCT", DEFAULT_RISK_LIMITS.maxGrossExposurePct),
    maxPositions: numEnv("PAPER_MAX_POSITIONS", DEFAULT_RISK_LIMITS.maxPositions),
    maxPositionPct: numEnv("PAPER_MAX_POSITION_PCT", DEFAULT_RISK_LIMITS.maxPositionPct),
    maxClusterPct: numEnv("PAPER_MAX_CLUSTER_PCT", DEFAULT_RISK_LIMITS.maxClusterPct),
    maxClusterPositions: numEnv("PAPER_MAX_CLUSTER_POSITIONS", DEFAULT_RISK_LIMITS.maxClusterPositions),
    killSwitchDrawdownPct: numEnv("PAPER_KILL_SWITCH_DD_PCT", DEFAULT_RISK_LIMITS.killSwitchDrawdownPct),
    deriskStartDrawdownPct: numEnv("PAPER_DERISK_START_DD_PCT", DEFAULT_RISK_LIMITS.deriskStartDrawdownPct),
    peakWindowDays: numEnv("PAPER_PEAK_WINDOW_DAYS", DEFAULT_RISK_LIMITS.peakWindowDays),
    regimeMaWindow: numEnv("PAPER_REGIME_MA_WINDOW", DEFAULT_RISK_LIMITS.regimeMaWindow),
    regimeRiskOffGrossFrac: numEnv("PAPER_REGIME_RISKOFF_GROSS_FRAC", DEFAULT_RISK_LIMITS.regimeRiskOffGrossFrac),
  };
}

/** Gate for the portfolio-level controls (caps + kill-switch). Ship-dark default. */
export function isRiskLimitsEnabled(): boolean {
  return process.env.PAPER_RISK_LIMITS === "1";
}

/** The single risk bucket every crypto name collapses into (they move together). */
export const CRYPTO_CLUSTER = "CRYPTO";

/** Crypto sleeve detection — same `-USD` convention used across the app. */
export function isCryptoTicker(ticker: string): boolean {
  return ticker.endsWith("-USD");
}

// ── Correlation clustering ───────────────────────────────────────────────────
// On a ~10-name watchlist the real number of independent bets is ~3–5: tech
// mega-caps move together, crypto moves together. We group names whose realized
// returns are highly correlated so the cluster cap limits *correlated* exposure,
// not just per-ticker exposure. Crypto is forced into one bucket regardless of the
// sample (its co-movement is structural, and histories are often short/noisy).

/** Pearson correlation of two return series aligned on their shared dates. */
export function pairCorrelation(
  a: Map<string, number>,
  b: Map<string, number>,
  minOverlap = 5
): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [date, av] of a) {
    const bv = b.get(date);
    if (bv != null) {
      xs.push(av);
      ys.push(bv);
    }
  }
  return pearson(xs, ys, minOverlap);
}

/**
 * Assign every ticker a correlation-cluster key. Equities are grouped by
 * single-linkage union over pairs with correlation ≥ `threshold` (deterministic:
 * the cluster id is the lexicographically smallest ticker in the group). Crypto
 * names all map to `CRYPTO`. A name with too little overlap to correlate stays a
 * singleton (its own ticker as the key).
 *
 * `returnsByTicker`: ticker → (dateKey → daily return). Pure; the caller builds the
 * return maps from price history.
 */
export function correlationClusters(
  returnsByTicker: Map<string, Map<string, number>>,
  opts: { threshold?: number; minOverlap?: number } = {}
): Map<string, string> {
  const threshold = opts.threshold ?? 0.7;
  const minOverlap = opts.minOverlap ?? 5;

  const result = new Map<string, string>();
  const equities: string[] = [];
  for (const ticker of returnsByTicker.keys()) {
    if (isCryptoTicker(ticker)) result.set(ticker, CRYPTO_CLUSTER);
    else equities.push(ticker);
  }

  // Union-find over equities: union any pair correlated at/above the threshold.
  const parent = new Map<string, string>(equities.map((t) => [t, t]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path-compress so repeated finds stay cheap.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the lexicographically smaller root so cluster ids are stable.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (let i = 0; i < equities.length; i++) {
    for (let j = i + 1; j < equities.length; j++) {
      const corr = pairCorrelation(returnsByTicker.get(equities[i])!, returnsByTicker.get(equities[j])!, minOverlap);
      if (corr != null && corr >= threshold) union(equities[i], equities[j]);
    }
  }
  for (const t of equities) result.set(t, find(t));
  return result;
}

/** Resolve a ticker's cluster key, falling back to crypto-bucket / its own ticker. */
export function clusterKeyFor(ticker: string, clusters: Map<string, string>): string {
  return clusters.get(ticker) ?? (isCryptoTicker(ticker) ? CRYPTO_CLUSTER : ticker);
}

// ── Drawdown / de-risking ────────────────────────────────────────────────────

/**
 * Current drawdown from the running peak, as a fraction in [0, 1]. Peak is the max
 * equity ever observed in `equityCurve` (including the latest point), so a fresh
 * high reads 0. Empty/degenerate curves read 0.
 */
export function currentDrawdown(equityCurve: number[]): number {
  if (equityCurve.length === 0) return 0;
  const peak = Math.max(...equityCurve);
  if (peak <= 0) return 0;
  const current = equityCurve[equityCurve.length - 1];
  return Math.max(0, (peak - current) / peak);
}

/**
 * Fraction of the gross-exposure cap still allowed at a given drawdown, in [0, 1].
 * Full cap below `deriskStart`, linearly ramped to 0 at the kill-switch level, and
 * 0 at/above it. This steps gross exposure *down* as losses deepen — the buffer
 * before the hard halt — rather than slamming from 100% to 0.
 */
export function deriskMultiplier(drawdown: number, limits: RiskLimits = DEFAULT_RISK_LIMITS): number {
  const { deriskStartDrawdownPct: start, killSwitchDrawdownPct: kill } = limits;
  if (drawdown <= start) return 1;
  if (drawdown >= kill || kill <= start) return 0;
  return Math.max(0, Math.min(1, 1 - (drawdown - start) / (kill - start)));
}

// ── Regime filter (issue #58) ────────────────────────────────────────────────

/**
 * Gross-cap multiplier from the market regime: 1 (risk-on) while SPY holds at or
 * above its moving average, `riskOffFrac` below it. Null price/MA (not enough SPY
 * history yet, or the filter disabled) reads as risk-on — the filter must never
 * *tighten* on missing data, only on an observed downtrend.
 */
export function regimeMultiplier(
  spyPrice: number | null | undefined,
  spyMa: number | null | undefined,
  riskOffFrac: number
): number {
  if (spyPrice == null || spyMa == null || spyMa <= 0) return 1;
  return spyPrice >= spyMa ? 1 : Math.max(0, Math.min(1, riskOffFrac));
}

// ── The buy gate ─────────────────────────────────────────────────────────────

export type RiskBlockReason =
  | "KILL_SWITCH"
  | "GROSS_CAP"
  | "MAX_POSITIONS"
  | "PER_NAME_CAP"
  | "CLUSTER_CAP"
  | "MAX_CLUSTER_POSITIONS";

export type BookExposure = {
  equity: number; // current book equity ($)
  peakEquity: number; // max equity to date ($) — drives the kill-switch / de-risk
  positions: { cluster: string; notional: number }[]; // current open positions
};

export type BuyCandidate = { cluster: string; notional: number };

export type BuyDecision = { allowed: boolean; reason: RiskBlockReason | null };

/**
 * Decide whether a candidate buy may open, given the book's current exposure.
 * Checks run worst-first so the returned `reason` is the most serious breach:
 *
 *   1. KILL_SWITCH        — drawdown ≥ killSwitchDrawdownPct (halt all new buys)
 *   2. GROSS_CAP          — deployed + candidate > maxGross × deriskMult × equity
 *   3. MAX_POSITIONS      — already at the position-count cap
 *   4. PER_NAME_CAP       — candidate alone exceeds maxPositionPct × equity
 *   5. CLUSTER_CAP        — cluster deployed + candidate > maxClusterPct × equity
 *   6. MAX_CLUSTER_POSITIONS — cluster already at its name-count cap
 *
 * Pure: the caller mutates a running `BookExposure` between candidates so multiple
 * opens in one run respect each other. `regimeMult` scales the gross cap down in
 * a risk-off regime (see regimeMultiplier); 1 = regime-neutral.
 */
export function evaluateBuy(
  book: BookExposure,
  candidate: BuyCandidate,
  limits: RiskLimits = DEFAULT_RISK_LIMITS,
  regimeMult = 1
): BuyDecision {
  const { equity } = book;
  if (equity <= 0 || candidate.notional <= 0) return { allowed: false, reason: "GROSS_CAP" };

  const dd =
    book.peakEquity > 0 ? Math.max(0, (book.peakEquity - book.equity) / book.peakEquity) : 0;

  // 1. Kill-switch — drawdown blew past the limit; no new risk until we recover.
  if (dd >= limits.killSwitchDrawdownPct) return { allowed: false, reason: "KILL_SWITCH" };

  // 2. Gross-exposure cap, de-risked as drawdown deepens and in risk-off regimes.
  const deployed = book.positions.reduce((s, p) => s + p.notional, 0);
  const grossCap = limits.maxGrossExposurePct * deriskMultiplier(dd, limits) * regimeMult * equity;
  if (deployed + candidate.notional > grossCap) return { allowed: false, reason: "GROSS_CAP" };

  // 3. Position-count cap.
  if (book.positions.length >= limits.maxPositions) return { allowed: false, reason: "MAX_POSITIONS" };

  // 4. Per-name cap.
  if (candidate.notional > limits.maxPositionPct * equity) return { allowed: false, reason: "PER_NAME_CAP" };

  // 5 & 6. Per-cluster notional + name-count caps.
  const clusterPositions = book.positions.filter((p) => p.cluster === candidate.cluster);
  const clusterDeployed = clusterPositions.reduce((s, p) => s + p.notional, 0);
  if (clusterDeployed + candidate.notional > limits.maxClusterPct * equity) {
    return { allowed: false, reason: "CLUSTER_CAP" };
  }
  if (limits.maxClusterPositions > 0 && clusterPositions.length >= limits.maxClusterPositions) {
    return { allowed: false, reason: "MAX_CLUSTER_POSITIONS" };
  }

  return { allowed: true, reason: null };
}
