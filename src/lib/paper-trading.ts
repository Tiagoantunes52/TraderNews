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

export type Strategy = "SENTIMENT" | "QUANT" | "COMBINED";
export type SimBook = "SIM_SENTIMENT" | "SIM_QUANT" | "SIM_COMBINED";
export type Book = "ALPACA" | SimBook;

export const STRATEGIES: Strategy[] = ["SENTIMENT", "QUANT", "COMBINED"];

/** Each internal strategy maps to its equity-curve book. */
export const STRATEGY_BOOK: Record<Strategy, SimBook> = {
  SENTIMENT: "SIM_SENTIMENT",
  QUANT: "SIM_QUANT",
  COMBINED: "SIM_COMBINED",
};

// Base position size before the confidence weighting, and the notional bankroll the
// sim books are measured against. Both env-tunable without a redeploy.
const BASE_NOTIONAL = Number(process.env.PAPER_BASE_NOTIONAL) || 1000;
export const SIM_STARTING_EQUITY = Number(process.env.PAPER_SIM_STARTING_EQUITY) || 100_000;

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
}): Record<Strategy, string | null> {
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

export type PositionAction =
  | { type: "OPEN"; qty: number; price: number }
  | { type: "CLOSE"; price: number; realizedPnl: number }
  | { type: "MARK"; price: number }
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
