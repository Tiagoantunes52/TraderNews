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
  | "COMBINED_RM"
  | "INSIDER";
export type SimBook =
  | "SIM_SENTIMENT"
  | "SIM_QUANT"
  | "SIM_COMBINED"
  | "SIM_SENTIMENT_RM"
  | "SIM_QUANT_RM"
  | "SIM_COMBINED_RM"
  | "SIM_INSIDER";
export type Book = "ALPACA" | SimBook;

/** The three pure (signal-only) strategies — the attribution baseline. */
export const STRATEGIES: Strategy[] = ["SENTIMENT", "QUANT", "COMBINED"];
/** The three risk-managed variants (only run when PAPER_RISK_BOOKS=1). */
export const RM_STRATEGIES: Strategy[] = ["SENTIMENT_RM", "QUANT_RM", "COMBINED_RM"];
/**
 * Event-driven books (issue #57): entered on discrete events (insider cluster /
 * C-suite buys), NOT on the daily estimate scores — different horizon, own
 * attribution book. Only run when PAPER_INSIDER_BOOK=1.
 */
export const EVENT_STRATEGIES: Strategy[] = ["INSIDER"];
/** Every strategy — used by views that render whatever books have data. */
export const ALL_STRATEGIES: Strategy[] = [...STRATEGIES, ...RM_STRATEGIES, ...EVENT_STRATEGIES];

/** Each internal strategy maps to its equity-curve book. */
export const STRATEGY_BOOK: Record<Strategy, SimBook> = {
  SENTIMENT: "SIM_SENTIMENT",
  QUANT: "SIM_QUANT",
  COMBINED: "SIM_COMBINED",
  SENTIMENT_RM: "SIM_SENTIMENT_RM",
  QUANT_RM: "SIM_QUANT_RM",
  COMBINED_RM: "SIM_COMBINED_RM",
  INSIDER: "SIM_INSIDER",
};

/** Which raw estimate score each strategy reads (pure and _RM share a source). */
export const STRATEGY_SOURCE: Record<Strategy, "SENTIMENT" | "QUANT" | "COMBINED"> = {
  SENTIMENT: "SENTIMENT",
  QUANT: "QUANT",
  COMBINED: "COMBINED",
  SENTIMENT_RM: "SENTIMENT",
  QUANT_RM: "QUANT",
  COMBINED_RM: "COMBINED",
  INSIDER: "COMBINED", // unused — the event book doesn't read estimate scores
};

/** True for the risk-managed variants (price-aware exit ladder + entry deadband). */
export const STRATEGY_IS_RM: Record<Strategy, boolean> = {
  SENTIMENT: false,
  QUANT: false,
  COMBINED: false,
  SENTIMENT_RM: true,
  QUANT_RM: true,
  COMBINED_RM: true,
  INSIDER: false,
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
  decayRuns: number; // consecutive no-conviction runs before a profitable exit (0 disables)
  trailRatchetActivatePct: number; // gain above entry that tightens the trail (0 disables)
  trailRatchetFrac: number; // fraction of the trail distance kept once ratcheted
  minHoldRuns: number; // runs to suppress trail+signal exits (hard stop stays live)
  timeStopRuns: number; // runs of dead money before a time stop (0 disables)
  timeStopBandPct: number; // ± band around entry that counts as "dead money"
  entryScoreMin: number; // raw score must exceed this to open (deadband above BUY)
  minConfidence: number; // confidence floor for an entry (skips dust positions)
  riskPerTrade: number; // $ lost if the stop fires at confidence 1 — drives sizing
  insiderHoldDays: number; // event-book fixed holding period (UTC days ≈ 40 trading days)
  insiderNotional: number; // $ per insider-event position (flat — no confidence weighting)
};

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  stopLossPct: 0.08,
  trailPct: 0.12,
  trailActivatePct: 0.08,
  atrStopMult: 2.5,
  atrStopFloorPct: 0.06,
  atrStopCapPct: 0.15,
  signalConfirmRuns: 2,
  decayRuns: 5,
  trailRatchetActivatePct: 0.15,
  trailRatchetFrac: 0.5,
  minHoldRuns: 3,
  timeStopRuns: 20,
  timeStopBandPct: 0.03,
  entryScoreMin: 0.25,
  minConfidence: 0.3,
  // 80 = old BASE_NOTIONAL × fixed 8% stop, so a fixed-stop name sizes exactly as
  // the legacy $1000 × confidence did; ATR-stopped names now equalize $ risk instead.
  riskPerTrade: 80,
  // Insider event book (issue #57): ~40 trading days ≈ 56 calendar days, mid-range
  // of the research-backed 20–60-day drift window for insider cluster buys.
  insiderHoldDays: 56,
  insiderNotional: 1000,
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
    decayRuns: numEnv("PAPER_DECAY_RUNS", DEFAULT_RISK_CONFIG.decayRuns),
    trailRatchetActivatePct: numEnv("PAPER_TRAIL_RATCHET_ACTIVATE_PCT", DEFAULT_RISK_CONFIG.trailRatchetActivatePct),
    trailRatchetFrac: numEnv("PAPER_TRAIL_RATCHET_FRAC", DEFAULT_RISK_CONFIG.trailRatchetFrac),
    minHoldRuns: numEnv("PAPER_MIN_HOLD_RUNS", DEFAULT_RISK_CONFIG.minHoldRuns),
    timeStopRuns: numEnv("PAPER_TIME_STOP_RUNS", DEFAULT_RISK_CONFIG.timeStopRuns),
    timeStopBandPct: numEnv("PAPER_TIME_STOP_BAND_PCT", DEFAULT_RISK_CONFIG.timeStopBandPct),
    entryScoreMin: numEnv("PAPER_ENTRY_SCORE_MIN", DEFAULT_RISK_CONFIG.entryScoreMin),
    minConfidence: numEnv("PAPER_MIN_CONFIDENCE", DEFAULT_RISK_CONFIG.minConfidence),
    riskPerTrade: numEnv("PAPER_RISK_PER_TRADE", DEFAULT_RISK_CONFIG.riskPerTrade),
    insiderHoldDays: numEnv("PAPER_INSIDER_HOLD_DAYS", DEFAULT_RISK_CONFIG.insiderHoldDays),
    insiderNotional: numEnv("PAPER_INSIDER_NOTIONAL", DEFAULT_RISK_CONFIG.insiderNotional),
  };
}

/** Gate for the risk-managed books + the risk overlay on the live Alpaca book. */
export function isRiskBooksEnabled(): boolean {
  return process.env.PAPER_RISK_BOOKS === "1";
}

/** Gate for the insider event book (issue #57). Sim-only; ship-dark. */
export function isInsiderBookEnabled(): boolean {
  return process.env.PAPER_INSIDER_BOOK === "1";
}

/**
 * Gate for pushing the live book's protective exits to the broker (native Alpaca
 * stop / trailing-stop orders, enforced continuously instead of once/day). Engages
 * only alongside the risk books — it's the live counterpart of the COMBINED_RM sim.
 */
export function isBrokerStopsEnabled(): boolean {
  return process.env.PAPER_BROKER_STOPS === "1";
}

// Marketable-limit buffer for broker entries: a limit priced this far through the
// spread fills like a market order but lets the order be GTC (so the attached stop
// persists). The cap, not the fill price — you still fill at the market price.
const ENTRY_LIMIT_BUFFER_PCT = numEnv("PAPER_ENTRY_LIMIT_BUFFER_PCT", 0.005);

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

/**
 * Risk-based notional ($) for the _RM books: size so a stop-out loses exactly
 * `riskPerTrade × confidence`, whatever the stop distance is. A wide-stopped
 * volatile name gets a smaller position, a tight-stopped calm name a larger one —
 * equal $ risk per trade, instead of the volatility-driven risk that a flat
 * "$1000 × confidence" gives. 0 if the stop distance is degenerate.
 */
export function riskSizedNotional(confidence: number, stopPct: number, riskPerTrade: number): number {
  if (stopPct <= 0) return 0;
  return (riskPerTrade * Math.max(0, Math.min(1, confidence))) / stopPct;
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
export type ExitReason = "STOP" | "TRAIL" | "SIGNAL" | "DECAY" | "TIME";

export type PositionAction =
  | { type: "OPEN"; qty: number; price: number }
  // _RM closes carry the streak that triggered SIGNAL/DECAY (or held steady for the
  // others) so the stage persists the value the decision actually fired on, not the
  // prior run's — otherwise an audit reading the closed row sees a stale streak.
  | { type: "CLOSE"; price: number; realizedPnl: number; reason?: ExitReason; bearishStreak?: number; staleStreak?: number }
  // _RM marks carry the running peak (for the trailing stop) plus the bearish-signal
  // and stale-signal streaks (confirmed-signal / decay exits) so the stage can persist them.
  | { type: "MARK"; price: number; peakPrice?: number; bearishStreak?: number; staleStreak?: number }
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
 * Event-book reconciliation (issue #57): a position opened on a discrete event
 * (insider cluster / C-suite buy) is held for a FIXED period and then closed —
 * time is the only exit. Deliberately no stops or signal exits: like the pure
 * books, this measures the event's raw multi-week drift so its edge can be judged
 * before any risk overlay is layered on. Pure; the caller supplies days held.
 */
export function reconcileEventPosition(
  price: number,
  daysHeld: number,
  holdDays: number,
  open: { qty: number; entryPrice: number }
): PositionAction {
  if (daysHeld >= holdDays) {
    return { type: "CLOSE", price, realizedPnl: realizedPnl(open.qty, open.entryPrice, price) };
  }
  return { type: "MARK", price };
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
export function riskDistancePct(cfg: RiskConfig, atrPct: number | null | undefined, fallback: number): number {
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
 *      (1 − trail). Once peak ≥ entry × (1 + ratchetActivate) the trail distance
 *      tightens to trail × ratchetFrac, so a big winner gives back less from its
 *      peak. Suppressed during min-hold.
 *   3. Confirmed-signal exit — bearish (SELL/STRONG_SELL) for ≥ signalConfirmRuns
 *      consecutive runs. Suppressed during min-hold.
 *   4. Signal-decay exit — score below the entry deadband (no conviction either
 *      way) for ≥ decayRuns consecutive runs while the position is profitable:
 *      the thesis has played out, so take the profit rather than drift. Loss-side
 *      staleness is left to the stop/time exits. Suppressed during min-hold;
 *      0 disables.
 *   5. Time stop — flat within ±band after timeStopRuns runs (0 disables).
 *
 * Entry is gated by a score deadband (above the BUY line) and a confidence floor,
 * and sized so a stop-out loses `riskPerTrade × confidence` regardless of the stop
 * distance (see `riskSizedNotional`).
 *
 * Stop/trail distances are FROZEN at entry: exits use the position's entry-day ATR
 * (`open.entryAtrPct`), not today's — otherwise a volatility spike would *widen*
 * the stop mid-drawdown, exactly when it must hold (and diverge from the broker's
 * stop, which is fixed at entry). Today's `atrPct` is only used to size a new entry.
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
  atrPct: number | null; // today's ATR% — entry sizing only
  runsSinceEntry: number;
  isNewRun: boolean;
  open: {
    qty: number;
    entryPrice: number;
    peakPrice: number;
    bearishStreak: number;
    staleStreak: number;
    entryAtrPct: number | null; // ATR% captured at entry — drives all exit distances
  } | null;
  cfg?: RiskConfig;
}): PositionAction {
  const cfg = args.cfg ?? DEFAULT_RISK_CONFIG;
  const { score, signal, price, confidence, atrPct, runsSinceEntry, isNewRun, open } = args;

  if (open) {
    const { qty, entryPrice } = open;
    const peakPrice = Math.max(open.peakPrice, price);
    const bearish = isBearishSignal(signal);
    // Reset to 0 on any non-bearish read (idempotent); only advance on a new run.
    const bearishStreak = bearish ? (isNewRun ? open.bearishStreak + 1 : open.bearishStreak) : 0;
    // Stale = no entry-grade conviction (score at/below the deadband) — the mirror
    // of the entry gate. Same advance/reset discipline as the bearish streak.
    const stale = score <= cfg.entryScoreMin;
    const staleStreak = stale ? (isNewRun ? open.staleStreak + 1 : open.staleStreak) : 0;
    const close = (reason: ExitReason): PositionAction => ({
      type: "CLOSE",
      price,
      realizedPnl: realizedPnl(qty, entryPrice, price),
      reason,
      bearishStreak,
      staleStreak,
    });

    // 1. Hard stop-loss — never suppressed (capital protection comes first).
    // Gapping fill: we close at `price` (the next available close), NOT the stop
    // level, so a name that gaps straight through its stop realizes the worse,
    // gapped price — keeping realized P&L and the equity-curve drawdown honest
    // rather than pretending we always got out exactly at the stop (issue #56).
    const stopPct = riskDistancePct(cfg, open.entryAtrPct, cfg.stopLossPct);
    if (price <= entryPrice * (1 - stopPct)) return close("STOP");

    const pastMinHold = runsSinceEntry >= cfg.minHoldRuns;

    // 2. Trailing stop — only once armed by a gain, and not during min-hold. A big
    // winner (peak past the ratchet threshold) trails tighter so it gives back
    // ratchetFrac of the normal distance instead of the full trail.
    if (pastMinHold && peakPrice >= entryPrice * (1 + cfg.trailActivatePct)) {
      let trailPct = riskDistancePct(cfg, open.entryAtrPct, cfg.trailPct);
      if (cfg.trailRatchetActivatePct > 0 && peakPrice >= entryPrice * (1 + cfg.trailRatchetActivatePct)) {
        trailPct *= cfg.trailRatchetFrac;
      }
      if (price <= peakPrice * (1 - trailPct)) return close("TRAIL");
    }

    // 3. Confirmed-signal exit — bearish for N runs, and not during min-hold.
    if (pastMinHold && bearishStreak >= cfg.signalConfirmRuns) return close("SIGNAL");

    // 4. Signal-decay exit — the conviction that justified the entry has been gone
    // for N runs and the position is in profit: the thesis played out, take it.
    if (cfg.decayRuns > 0 && pastMinHold && staleStreak >= cfg.decayRuns && price > entryPrice) {
      return close("DECAY");
    }

    // 5. Time stop — dead money near entry after a long hold.
    if (cfg.timeStopRuns > 0 && runsSinceEntry >= cfg.timeStopRuns) {
      const lo = entryPrice * (1 - cfg.timeStopBandPct);
      const hi = entryPrice * (1 + cfg.timeStopBandPct);
      if (price >= lo && price <= hi) return close("TIME");
    }

    return { type: "MARK", price, peakPrice, bearishStreak, staleStreak };
  }

  // Flat → enter only on real conviction (deadband) at a meaningful size, sized
  // off the entry-day stop distance so every stop-out costs the same $.
  if (score > cfg.entryScoreMin && confidence >= cfg.minConfidence && price > 0) {
    const stopPct = riskDistancePct(cfg, atrPct, cfg.stopLossPct);
    const qty = riskSizedNotional(confidence, stopPct, cfg.riskPerTrade) / price;
    if (qty > 0) return { type: "OPEN", qty, price };
  }
  return { type: "NONE" };
}

// ── Live Alpaca book with broker-enforced stops (PAPER_BROKER_STOPS) ──────────
//
// When enabled, the live book mirrors the COMBINED_RM *decision* but hands the
// *protective* exits to the broker: entries go in as whole-share marketable-limit
// buys with an attached GTC stop, and the fixed stop is replaced by a native
// trailing stop once the position is up enough. The broker enforces those exits
// continuously (intraday, gap-aware) for free — the once/day stage can't. Only the
// exits a broker can't make (signal flip, time stop) stay app-side. `planBrokerAction`
// is the pure decision; the stage executes it via the alpaca-trading client.

/** Cents-rounded price for Alpaca limit/stop fields. */
export function cents(v: number): number {
  return Math.round(v * 100) / 100;
}

export type BrokerAction =
  | { type: "ENTER"; qty: number; limitPrice: number; stopPrice: number }
  | { type: "EXIT"; reason: string } // signal/time exit: cancel the resting stop + market-sell
  | { type: "ARM_TRAILING"; trailPercent: number } // replace the fixed stop with a trailing stop
  | { type: "REPAIR_STOP"; stopPrice: number } // held but no protective order: re-place a GTC stop
  | { type: "NONE" };

/**
 * Decide the live broker book's action for one stock from the COMBINED_RM sim
 * transitions + the live broker state. Pure (no network/DB) so it's unit-testable.
 *
 * - EXIT only on an *info* exit (SIGNAL/DECAY/TIME) — price exits (STOP/TRAIL) are
 *   enforced broker-side, so we never double-handle them here.
 * - ENTER on a *fresh* sim OPEN when flat, or *catch up* an entry the broker never
 *   placed this episode (`everAttempted` false) — e.g. the risk caps gated the buy
 *   when the sim opened, or a sub-share position has since grown to a whole share.
 *   A name the broker DID enter and then stopped out has `everAttempted` true and is
 *   left flat until the sim also exits — never re-bought (the re-entry guard).
 * - While held & still-long: arm the trailing stop once up `trailActivatePct` (a fixed
 *   stop is resting), tighten a resting trailing stop once up `trailRatchetActivatePct`
 *   (only when strictly tighter, so it never churns), or repair a missing protective
 *   order.
 */
export function planBrokerAction(input: {
  opened: boolean; // COMBINED_RM made a fresh OPEN this run
  stillLong: boolean; // COMBINED_RM is long after this run
  exitReason: string | null; // COMBINED_RM close reason this run (STOP|TRAIL|SIGNAL|DECAY|TIME)
  held: boolean; // live Alpaca position exists
  everAttempted?: boolean; // broker already placed an entry order this episode (default true = re-entry guard on)
  avgEntryPrice: number | null;
  currentPrice: number | null;
  restingProtectiveType: "stop" | "trailing_stop" | null; // resting protective order, if any
  restingTrailPercent?: number | null; // trail % of a resting trailing stop (ratchet compare)
  price: number; // reference price (latest quant close) for sizing + stop/limit
  atrPct: number | null; // entry-day ATR% when held (frozen distances), today's when entering
  confidence: number;
  cfg?: RiskConfig;
  entryLimitBufferPct?: number;
}): BrokerAction {
  const cfg = input.cfg ?? DEFAULT_RISK_CONFIG;
  const buffer = input.entryLimitBufferPct ?? ENTRY_LIMIT_BUFFER_PCT;
  const { opened, stillLong, exitReason, held, avgEntryPrice, currentPrice, restingProtectiveType, restingTrailPercent, price, atrPct, confidence } = input;
  // Unknown history ⇒ assume the broker already acted, so we never catch-up-buy a name
  // that was actually stopped out. Only an explicit `false` unlocks a catch-up entry.
  const everAttempted = input.everAttempted ?? true;

  const infoExit = exitReason === "SIGNAL" || exitReason === "DECAY" || exitReason === "TIME";
  if (held && infoExit) return { type: "EXIT", reason: exitReason! };

  if (!held) {
    // Fresh open, or a catch-up for an entry that never took hold (gated / sub-share
    // that grew). Never a name the broker entered then stopped out — that keeps
    // `everAttempted` true and stays flat until the sim exits (the re-entry guard).
    const catchUp = stillLong && !everAttempted;
    if ((opened || catchUp) && price > 0) {
      const stopPct = riskDistancePct(cfg, atrPct, cfg.stopLossPct);
      const qty = Math.floor(riskSizedNotional(confidence, stopPct, cfg.riskPerTrade) / price);
      if (qty >= 1) {
        return { type: "ENTER", qty, limitPrice: cents(price * (1 + buffer)), stopPrice: cents(price * (1 - stopPct)) };
      }
    }
    return { type: "NONE" };
  }

  // Held and still wanted → keep the protective order correct.
  if (stillLong) {
    if (restingProtectiveType == null) {
      const anchor = avgEntryPrice ?? price;
      return { type: "REPAIR_STOP", stopPrice: cents(anchor * (1 - riskDistancePct(cfg, atrPct, cfg.stopLossPct))) };
    }
    if (avgEntryPrice != null && currentPrice != null && avgEntryPrice > 0) {
      const gain = (currentPrice - avgEntryPrice) / avgEntryPrice;
      const ratcheted = cfg.trailRatchetActivatePct > 0 && gain >= cfg.trailRatchetActivatePct;
      const trailPercent = cents(
        riskDistancePct(cfg, atrPct, cfg.trailPct) * (ratcheted ? cfg.trailRatchetFrac : 1) * 100
      );
      if (restingProtectiveType === "stop" && gain >= cfg.trailActivatePct) {
        return { type: "ARM_TRAILING", trailPercent };
      }
      // Ratchet a resting trailing stop tighter once up big — but only when strictly
      // tighter than what's resting, so the daily stage never cancel/replaces in place.
      if (restingProtectiveType === "trailing_stop" && ratcheted && restingTrailPercent != null && trailPercent < restingTrailPercent) {
        return { type: "ARM_TRAILING", trailPercent };
      }
    }
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

// ── Realized P&L for the live Alpaca book ────────────────────────────────────
// Alpaca exposes open positions (with unrealized P&L) and a flat order/fill history,
// but no "closed position with realized P&L". So reconstruct realized P&L by
// FIFO-matching each sell fill against the prior buy fills for that symbol. Pure +
// unit-tested; the page feeds it /v2/account/activities (see getAccountActivities).
export type Fill = { symbol: string; side: "buy" | "sell"; qty: number; price: number; time: string };
export type ClosedTrade = {
  symbol: string;
  qty: number;
  entryPrice: number; // weighted-average buy price of the matched lots
  exitPrice: number;
  realizedPnl: number;
  closedAt: string;
};

export function realizedFromFills(fills: Fill[]): { trades: ClosedTrade[]; totalRealized: number } {
  const bySymbol = new Map<string, Fill[]>();
  for (const f of fills) {
    const arr = bySymbol.get(f.symbol);
    if (arr) arr.push(f);
    else bySymbol.set(f.symbol, [f]);
  }

  const trades: ClosedTrade[] = [];
  let totalRealized = 0;
  for (const [symbol, arr] of bySymbol) {
    const chrono = [...arr].sort((a, b) => a.time.localeCompare(b.time));
    const lots: { qty: number; price: number }[] = []; // open buy lots, FIFO
    for (const f of chrono) {
      if (f.side === "buy") {
        lots.push({ qty: f.qty, price: f.price });
        continue;
      }
      // Sell → consume buy lots front-to-back, accumulating cost basis.
      let remaining = f.qty;
      let matchedQty = 0;
      let costBasis = 0;
      while (remaining > 1e-9 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(remaining, lot.qty);
        costBasis += take * lot.price;
        matchedQty += take;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-9) lots.shift();
      }
      if (matchedQty > 1e-9) {
        const realizedPnl = matchedQty * f.price - costBasis;
        trades.push({ symbol, qty: matchedQty, entryPrice: costBasis / matchedQty, exitPrice: f.price, realizedPnl, closedAt: f.time });
        totalRealized += realizedPnl;
      }
      // A sell with no matching buy (its entry predates the fetched window) is left
      // unmatched — its realized P&L just isn't shown.
    }
  }
  trades.sort((a, b) => b.closedAt.localeCompare(a.closedAt)); // newest first
  return { trades, totalRealized };
}
