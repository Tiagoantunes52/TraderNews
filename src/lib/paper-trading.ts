// Pure simulation mechanics for signal-performance tracking (issue #14).
//
// No network, no DB — every function here is deterministic and unit-tested. The
// pipeline stage (runPaperStage) reads estimates + prices, asks these helpers what
// to do, and persists the result. Keeping the *decisions* here (entry/exit, sizing,
// P&L, reconciliation) mirrors how lib/signals.ts centralises the classify logic.
//
// The premise: act on the app's own daily signals with simulated long-only trades
// and track hypothetical P&L per signal *source* — sentiment, quant, and the
// combined estimate — to see which is the better predictor. Sizing is held constant
// across strategies (the estimate's confidence) so only the signal differs.

import { scoreToSignal } from "@/lib/indicators";
import { marketNamesForTicker } from "@/lib/market-utils";

// Each signal source runs as a "pure" book (signal-only entry/exit — the clean
// attribution baseline) and a "risk-managed" (_RM) variant that layers a price-aware
// exit ladder on top (stop-loss, trailing stop, confirmed-signal exit, min-hold,
// time-stop) plus a stricter entry (deadband + confidence floor). Keeping the pure
// books untouched means they stay an honest answer to "which raw signal predicts
// best?", while the _RM books measure the marginal value of the risk overlay. The
// _RM books only run when PAPER_RISK_BOOKS=1 (ship-dark default).
export type Strategy =
  | "SENTIMENT"
  | "QUANT"
  | "COMBINED"
  | "SENTIMENT_RM"
  | "QUANT_RM"
  | "COMBINED_RM";
export type SimBook =
  | "SIM_SENTIMENT"
  | "SIM_QUANT"
  | "SIM_COMBINED"
  | "SIM_SENTIMENT_RM"
  | "SIM_QUANT_RM"
  | "SIM_COMBINED_RM";
export type Book = "ALPACA" | SimBook;

/** The three pure (signal-only) strategies — the attribution baseline. */
export const STRATEGIES: Strategy[] = ["SENTIMENT", "QUANT", "COMBINED"];
/** The three risk-managed variants (only run when PAPER_RISK_BOOKS=1). */
export const RM_STRATEGIES: Strategy[] = ["SENTIMENT_RM", "QUANT_RM", "COMBINED_RM"];
/** Every strategy — used by views that render whatever books have data. */
export const ALL_STRATEGIES: Strategy[] = [...STRATEGIES, ...RM_STRATEGIES];

/** Each internal strategy maps to its equity-curve book. */
export const STRATEGY_BOOK: Record<Strategy, SimBook> = {
  SENTIMENT: "SIM_SENTIMENT",
  QUANT: "SIM_QUANT",
  COMBINED: "SIM_COMBINED",
  SENTIMENT_RM: "SIM_SENTIMENT_RM",
  QUANT_RM: "SIM_QUANT_RM",
  COMBINED_RM: "SIM_COMBINED_RM",
};

/** Which raw estimate score each strategy reads (pure and _RM share a source). */
export const STRATEGY_SOURCE: Record<Strategy, "SENTIMENT" | "QUANT" | "COMBINED"> = {
  SENTIMENT: "SENTIMENT",
  QUANT: "QUANT",
  COMBINED: "COMBINED",
  SENTIMENT_RM: "SENTIMENT",
  QUANT_RM: "QUANT",
  COMBINED_RM: "COMBINED",
};

/** True for the risk-managed variants (price-aware exit ladder + entry deadband). */
export const STRATEGY_IS_RM: Record<Strategy, boolean> = {
  SENTIMENT: false,
  QUANT: false,
  COMBINED: false,
  SENTIMENT_RM: true,
  QUANT_RM: true,
  COMBINED_RM: true,
};

// Base position size before the confidence weighting, and the notional bankroll the
// sim books are measured against. Both env-tunable without a redeploy.
const BASE_NOTIONAL = Number(process.env.PAPER_BASE_NOTIONAL) || 1000;
export const SIM_STARTING_EQUITY = Number(process.env.PAPER_SIM_STARTING_EQUITY) || 100_000;

const clampNum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Env reader that respects an explicit 0 (so a "disabled" knob like timeStopRuns=0
// isn't silently swapped for its default the way `Number(x) || def` would).
function numEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

// The price-aware overlay applied to the _RM books. All percentages are *fractions*
// (0.08 = 8%); "runs" are counted in UTC days (the stage acts once per UTC day).
export type RiskConfig = {
  stopLossPct: number; // hard stop distance below entry (fallback when ATR is absent)
  trailPct: number; // trailing distance below peak (fallback when ATR is absent)
  trailActivatePct: number; // gain above entry that arms the trailing stop
  atrStopMult: number; // ATR multiple for stop/trail distance (0 disables ATR scaling)
  atrStopFloorPct: number; // floor for the ATR-scaled distance
  atrStopCapPct: number; // cap for the ATR-scaled distance
  signalConfirmRuns: number; // consecutive bearish (SELL/STRONG_SELL) runs before exiting
  minHoldRuns: number; // runs to suppress trail+signal exits (hard stop stays live)
  timeStopRuns: number; // runs of dead money before a time stop (0 disables)
  timeStopBandPct: number; // ± band around entry that counts as "dead money"
  entryScoreMin: number; // raw score must exceed this to open (deadband above BUY)
  minConfidence: number; // confidence floor for an entry (skips dust positions)
};

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  stopLossPct: 0.08,
  trailPct: 0.12,
  trailActivatePct: 0.08,
  atrStopMult: 2.5,
  atrStopFloorPct: 0.06,
  atrStopCapPct: 0.15,
  signalConfirmRuns: 2,
  minHoldRuns: 3,
  timeStopRuns: 20,
  timeStopBandPct: 0.03,
  entryScoreMin: 0.25,
  minConfidence: 0.3,
};

/** The active risk overlay, with each field overridable by its PAPER_* env var. */
export function riskConfig(): RiskConfig {
  return {
    stopLossPct: numEnv("PAPER_STOP_LOSS_PCT", DEFAULT_RISK_CONFIG.stopLossPct),
    trailPct: numEnv("PAPER_TRAIL_PCT", DEFAULT_RISK_CONFIG.trailPct),
    trailActivatePct: numEnv("PAPER_TRAIL_ACTIVATE_PCT", DEFAULT_RISK_CONFIG.trailActivatePct),
    atrStopMult: numEnv("PAPER_ATR_STOP_MULT", DEFAULT_RISK_CONFIG.atrStopMult),
    atrStopFloorPct: numEnv("PAPER_ATR_STOP_FLOOR_PCT", DEFAULT_RISK_CONFIG.atrStopFloorPct),
    atrStopCapPct: numEnv("PAPER_ATR_STOP_CAP_PCT", DEFAULT_RISK_CONFIG.atrStopCapPct),
    signalConfirmRuns: numEnv("PAPER_SIGNAL_CONFIRM_RUNS", DEFAULT_RISK_CONFIG.signalConfirmRuns),
    minHoldRuns: numEnv("PAPER_MIN_HOLD_RUNS", DEFAULT_RISK_CONFIG.minHoldRuns),
    timeStopRuns: numEnv("PAPER_TIME_STOP_RUNS", DEFAULT_RISK_CONFIG.timeStopRuns),
    timeStopBandPct: numEnv("PAPER_TIME_STOP_BAND_PCT", DEFAULT_RISK_CONFIG.timeStopBandPct),
    entryScoreMin: numEnv("PAPER_ENTRY_SCORE_MIN", DEFAULT_RISK_CONFIG.entryScoreMin),
    minConfidence: numEnv("PAPER_MIN_CONFIDENCE", DEFAULT_RISK_CONFIG.minConfidence),
  };
}

/** Gate for the risk-managed books + the risk overlay on the live Alpaca book. */
export function isRiskBooksEnabled(): boolean {
  return process.env.PAPER_RISK_BOOKS === "1";
}

// US exchanges in the app's market taxonomy (see market-utils). Paper trading is
// US-equity only — same coverage gate as the congress feature.
const US_MARKETS = new Set(["NYSE", "NASDAQ"]);

/** Long-only entry: open/stay long on BUY or STRONG_BUY. */
export function isEntrySignal(signal: string): boolean {
  return signal === "BUY" || signal === "STRONG_BUY";
}

/** Exit: close on anything that isn't a buy (NEUTRAL | SELL | STRONG_SELL). */
export function isExitSignal(signal: string): boolean {
  return !isEntrySignal(signal);
}

/**
 * Per-strategy signal for one estimate, derived through the same `scoreToSignal`
 * the estimate stage uses. QUANT has no signal when the quant score is absent
 * (sentiment-only stock) — the caller skips that strategy for that stock.
 */
export function deriveSignals(estimate: {
  sentimentScore: number;
  quantScore: number | null;
  combinedScore: number;
}): Record<"SENTIMENT" | "QUANT" | "COMBINED", string | null> {
  return {
    SENTIMENT: scoreToSignal(estimate.sentimentScore),
    QUANT: estimate.quantScore == null ? null : scoreToSignal(estimate.quantScore),
    COMBINED: scoreToSignal(estimate.combinedScore),
  };
}

/** Confidence-weighted notional ($). confidence is clamped to [0, 1] defensively. */
export function confidenceNotional(confidence: number, base = BASE_NOTIONAL): number {
  return base * Math.max(0, Math.min(1, confidence));
}

/** Share quantity for a confidence-weighted notional at `price`. 0 if price ≤ 0. */
export function sizePosition(confidence: number, price: number, base = BASE_NOTIONAL): number {
  if (price <= 0) return 0;
  return confidenceNotional(confidence, base) / price;
}

/** Realized P&L of a long position closed at `exitPrice`. */
export function realizedPnl(qty: number, entryPrice: number, exitPrice: number): number {
  return qty * (exitPrice - entryPrice);
}

/** Unrealized P&L of an open long marked at `markPrice`. */
export function unrealizedPnl(qty: number, entryPrice: number, markPrice: number): number {
  return qty * (markPrice - entryPrice);
}

/** True for US-listed equities (NYSE/NASDAQ); foreign listings and crypto are out. */
export function isPaperTradeEligible(ticker: string): boolean {
  return marketNamesForTicker(ticker).some((m) => US_MARKETS.has(m));
}

/** Why a risk-managed position closed (pure books leave this unset). */
export type ExitReason = "STOP" | "TRAIL" | "SIGNAL" | "TIME";

export type PositionAction =
  | { type: "OPEN"; qty: number; price: number }
  | { type: "CLOSE"; price: number; realizedPnl: number; reason?: ExitReason }
  // _RM marks carry the running peak (for the trailing stop) and the bearish-signal
  // streak (for the confirmed-signal exit) so the stage can persist them.
  | { type: "MARK"; price: number; peakPrice?: number; bearishStreak?: number }
  | { type: "NONE" };

/**
 * Decide what to do with a (stock, strategy) book given today's signal and price.
 * Long-only: open on a buy signal when flat, close on a non-buy when long, otherwise
 * mark-to-market an open position. Pure so the stage stays a thin persistence layer.
 */
export function reconcilePosition(
  signal: string,
  price: number,
  confidence: number,
  open: { qty: number; entryPrice: number } | null,
  base = BASE_NOTIONAL
): PositionAction {
  if (open) {
    if (isExitSignal(signal)) {
      return { type: "CLOSE", price, realizedPnl: realizedPnl(open.qty, open.entryPrice, price) };
    }
    return { type: "MARK", price };
  }
  if (isEntrySignal(signal)) {
    const qty = sizePosition(confidence, price, base);
    return qty > 0 ? { type: "OPEN", qty, price } : { type: "NONE" };
  }
  return { type: "NONE" };
}

/**
 * A true bearish read — SELL or STRONG_SELL (raw score ≤ -0.2). NEUTRAL is "no
 * conviction", not "get out", so it does NOT count: the _RM signal exit fires only
 * on a confirmed bearish view, which is what stops one bad-news day from selling a
 * still-healthy position.
 */
export function isBearishSignal(signal: string): boolean {
  return signal === "SELL" || signal === "STRONG_SELL";
}

/** Whole UTC days from `from` to `to` (negative if `to` precedes `from`). */
export function utcDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.floor((b - a) / 86_400_000);
}

// atrPct is stored as a percent (atr14/price × 100); the overlay works in fractions.
function atrFraction(atrPct: number | null | undefined): number | null {
  return atrPct != null && atrPct > 0 ? atrPct / 100 : null;
}

// Stop / trail distance: ATR-scaled (k × ATR%, clamped) when ATR is available and
// scaling is enabled, else the fixed fallback. Same regime-aware distance for both.
function riskDistancePct(cfg: RiskConfig, atrPct: number | null | undefined, fallback: number): number {
  const f = atrFraction(atrPct);
  if (cfg.atrStopMult > 0 && f != null) {
    return clampNum(cfg.atrStopMult * f, cfg.atrStopFloorPct, cfg.atrStopCapPct);
  }
  return fallback;
}

/**
 * Risk-managed reconciliation for the _RM books. Same long-only frame as
 * `reconcilePosition`, but exits run through a price-aware ladder (first match wins):
 *
 *   1. Hard stop-loss — price ≤ entry × (1 − stop). ALWAYS live, even in min-hold.
 *   2. Trailing stop — once peak ≥ entry × (1 + activate), exit on price ≤ peak ×
 *      (1 − trail). Suppressed during min-hold.
 *   3. Confirmed-signal exit — bearish (SELL/STRONG_SELL) for ≥ signalConfirmRuns
 *      consecutive runs. Suppressed during min-hold.
 *   4. Time stop — flat within ±band after timeStopRuns runs (0 disables).
 *
 * Entry is gated by a score deadband (above the BUY line) and a confidence floor.
 *
 * Pure (no DB): the caller supplies the prior peak/streak and whether this is the
 * first action today (`isNewRun`); the streak only advances on a new run so a
 * same-day retry can't double-count. MARK returns the updated peak + streak to
 * persist; peak uses max() so it's idempotent on its own.
 */
export function reconcileRiskManaged(args: {
  score: number;
  signal: string;
  price: number;
  confidence: number;
  atrPct: number | null;
  runsSinceEntry: number;
  isNewRun: boolean;
  open: { qty: number; entryPrice: number; peakPrice: number; bearishStreak: number } | null;
  cfg?: RiskConfig;
  base?: number;
}): PositionAction {
  const cfg = args.cfg ?? DEFAULT_RISK_CONFIG;
  const base = args.base ?? BASE_NOTIONAL;
  const { score, signal, price, confidence, atrPct, runsSinceEntry, isNewRun, open } = args;

  if (open) {
    const { qty, entryPrice } = open;
    const peakPrice = Math.max(open.peakPrice, price);
    const bearish = isBearishSignal(signal);
    // Reset to 0 on any non-bearish read (idempotent); only advance on a new run.
    const bearishStreak = bearish ? (isNewRun ? open.bearishStreak + 1 : open.bearishStreak) : 0;
    const close = (reason: ExitReason): PositionAction => ({
      type: "CLOSE",
      price,
      realizedPnl: realizedPnl(qty, entryPrice, price),
      reason,
    });

    // 1. Hard stop-loss — never suppressed (capital protection comes first).
    const stopPct = riskDistancePct(cfg, atrPct, cfg.stopLossPct);
    if (price <= entryPrice * (1 - stopPct)) return close("STOP");

    const pastMinHold = runsSinceEntry >= cfg.minHoldRuns;

    // 2. Trailing stop — only once armed by a gain, and not during min-hold.
    if (pastMinHold && peakPrice >= entryPrice * (1 + cfg.trailActivatePct)) {
      const trailPct = riskDistancePct(cfg, atrPct, cfg.trailPct);
      if (price <= peakPrice * (1 - trailPct)) return close("TRAIL");
    }

    // 3. Confirmed-signal exit — bearish for N runs, and not during min-hold.
    if (pastMinHold && bearishStreak >= cfg.signalConfirmRuns) return close("SIGNAL");

    // 4. Time stop — dead money near entry after a long hold.
    if (cfg.timeStopRuns > 0 && runsSinceEntry >= cfg.timeStopRuns) {
      const lo = entryPrice * (1 - cfg.timeStopBandPct);
      const hi = entryPrice * (1 + cfg.timeStopBandPct);
      if (price >= lo && price <= hi) return close("TIME");
    }

    return { type: "MARK", price, peakPrice, bearishStreak };
  }

  // Flat → enter only on real conviction (deadband) at a meaningful size.
  if (score > cfg.entryScoreMin && confidence >= cfg.minConfidence) {
    const qty = sizePosition(confidence, price, base);
    if (qty > 0) return { type: "OPEN", qty, price };
  }
  return { type: "NONE" };
}

export type BookSummary = {
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openPositions: number;
  closedCount: number;
  wins: number;
  hitRate: number | null; // fraction of closed positions that were profitable; null if none closed
};

/**
 * Roll closed + open positions of one sim book into its equity and hit-rate.
 * Equity = starting + Σrealized + Σunrealized — unconstrained by cash, because the
 * sim books measure signal quality, not capital allocation. An open position with no
 * mark yet falls back to its entry price (zero unrealized).
 */
export function summarizeBook(
  closed: { realizedPnl: number | null }[],
  open: { qty: number; entryPrice: number; lastMarkPrice: number | null }[],
  startingEquity = SIM_STARTING_EQUITY
): BookSummary {
  const realized = closed.reduce((s, p) => s + (p.realizedPnl ?? 0), 0);
  const unrealized = open.reduce(
    (s, p) => s + unrealizedPnl(p.qty, p.entryPrice, p.lastMarkPrice ?? p.entryPrice),
    0
  );
  const wins = closed.filter((p) => (p.realizedPnl ?? 0) > 0).length;
  return {
    equity: startingEquity + realized + unrealized,
    realizedPnl: realized,
    unrealizedPnl: unrealized,
    openPositions: open.length,
    closedCount: closed.length,
    wins,
    hitRate: closed.length > 0 ? wins / closed.length : null,
  };
}
