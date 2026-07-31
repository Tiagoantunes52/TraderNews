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
  brokerReentryRuns: number; // runs before the live book may re-enter a name it exited (0 = never)
  /**
   * 1 = COMBINED_RM enters on the combined score (legacy). 0 = it enters on the
   * SENTIMENT score, dropping the quant leg from the ENTRY decision only.
   *
   * The quant leg stays in the exit path either way. That split is the finding: over
   * 119k stock-days `calcQuantScore`'s holdout ranking IC is -0.0232 (t=-2.25), and in
   * the books the names quant *added* to COMBINED did worse than the ones it vetoed
   * (38.8% vs 44.5% win, -0.71% vs -0.00% per trade, n=134/146). But the harness only
   * ever measured RANKING — which name to buy — and never when to leave. Paired on the
   * same name and same entry day, COMBINED_RM beat SENTIMENT_RM on 4 trades and lost 0
   * (58 pairs, McNemar p≈0.125), and that difference can only come from the exit path.
   * So the evidence against quant is specific to entry, and it is dropped only there.
   */
  combinedEntryUsesQuant: number;
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
  // 0 = drop the quant leg from the COMBINED entry decision (it stays in the exit).
  // See the field comment on RiskConfig for the evidence behind the split.
  combinedEntryUsesQuant: 0,
  // Runs after a broker entry attempt before the live book may re-enter a name the
  // sim still holds. The re-entry guard exists so a stopped-out name isn't bought
  // straight back, but an unbounded guard leaves the live book flat for as long as
  // the sim keeps riding the position — which is how MA/SNOW/TMO/UNH (the sim's
  // best performers) ended up missing from the live book for weeks. 0 disables
  // re-entry entirely (the old unbounded behaviour).
  brokerReentryRuns: 10,
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
    brokerReentryRuns: numEnv("PAPER_BROKER_REENTRY_RUNS", DEFAULT_RISK_CONFIG.brokerReentryRuns),
    combinedEntryUsesQuant: numEnv("PAPER_COMBINED_ENTRY_QUANT", DEFAULT_RISK_CONFIG.combinedEntryUsesQuant),
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
//
// It is also, unavoidably, a filter on overnight gap direction: the order fills when a
// name gaps DOWN and fails when it gaps UP past the buffer. Gapping up is what winners
// do, so a tight buffer quietly selects against them — of nine entries that never filled
// at 0.5%, eight were winners averaging +6.3% in the sim against a book average of
// −0.35%. Widening trades a worse average entry price for an unbiased trade population,
// which is the right trade while the whole problem is that performance can't be measured.
//
// 2% not 5%: the miss rate falls roughly with the gap distribution (close-to-close, an
// upper bound since a GTC order rests all day) — 40.6% of stock-days close >0.5% up,
// 19.6% >2%, 4.4% >5% — but the buffer also inflates realised risk, because the OTO stop
// is priced off the same reference close and cannot know the fill (see the re-anchor in
// planBrokerAction). That correction shipped rejected — every re-place was submitted on
// top of the still-resting stop and 403'd on held shares, so no stop was ever re-anchored
// until the cancel-first fix (2026-07-29). Keep the band narrow enough that a top-of-band
// fill can't badly overshoot risk-per-trade before the next run fixes it.
const ENTRY_LIMIT_BUFFER_PCT = numEnv("PAPER_ENTRY_LIMIT_BUFFER_PCT", 0.02);

/**
 * How far a resting fixed stop may sit from where the actual fill price implies before
 * it is re-placed, as a fraction of entry. Wide enough that ordinary rounding and
 * sub-cent drift never trigger a cancel/replace; small relative to any real stop
 * distance (the ATR floor is 6%), so a genuine mis-anchoring is always caught.
 */
const STOP_REANCHOR_TOLERANCE_PCT = numEnv("PAPER_STOP_REANCHOR_TOLERANCE_PCT", 0.005);

/**
 * Cap on how many sessions of staleness the entry buffer will compensate for.
 *
 * Past about a week the reference close is not a stale price, it is a different price,
 * and widening further buys fills at the cost of entering wherever the name has drifted
 * to. At that point the honest move is to skip the name, not to chase it — but that is a
 * behaviour change on top of a behaviour change, so this only bounds the widening.
 */
const MAX_STALE_SESSIONS = 5;

/**
 * Trading sessions between the close a price came from and the run acting on it.
 *
 * Weekday count, so a Friday run on Wednesday's close returns 2. Holidays are NOT
 * modelled, which over-counts staleness by a session around them — that widens the entry
 * buffer slightly, which is the safe direction (a marginally worse fill price rather than
 * a miss). Returns at least 1: a same-day reference still has a full session of drift
 * between the close it came from and the order it prices.
 */
export function sessionsStale(sessionDate: Date | null | undefined, asOf: Date): number {
  if (sessionDate == null) return MAX_STALE_SESSIONS; // unknown staleness is not "fresh"
  const days = utcDaysBetween(sessionDate, asOf);
  if (!Number.isFinite(days) || days <= 0) return 1;
  let sessions = 0;
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.UTC(sessionDate.getUTCFullYear(), sessionDate.getUTCMonth(), sessionDate.getUTCDate() + i));
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) sessions++;
  }
  return clampNum(Math.max(1, sessions), 1, MAX_STALE_SESSIONS);
}

/**
 * Widen the entry limit buffer to cover the drift a stale reference price hides.
 *
 * The 2% buffer was sized against the ONE-day gap distribution. Over the corpus since
 * 2025-01-01 the fraction of moves clearing +2% is 16.7% at one session, **24.6% at two,
 * 29.6% at three** — staleness alone inflates the miss rate by half, and every one of
 * those misses is a name that RAN, which is exactly the adverse selection being fixed.
 *
 * sqrt(sessions) because dispersion grows with the square root of horizon. Measured, not
 * assumed: scaling this way puts the miss rate at 16.7% / 17.4% / 18.1% across one, two
 * and three sessions — flat, which is the whole point.
 *
 * WHEN THIS ACTUALLY BINDS: `PAPER_LIVE_QUOTES=1` is on in production and the overlay
 * prices estimate-carrying names off the tape, so those come through at 1 session and the
 * scaling is a no-op for them. It binds on the paths the overlay does not reach — the
 * convergence sweep (which prices from `lastQuant` and never consults the feed), names the
 * feed omits, and closed-market or failed-quote runs. A floor under the failure modes, not
 * the main entry path.
 */
export function stalenessScaledBuffer(buffer: number, sessions: number): number {
  return buffer * Math.sqrt(clampNum(sessions, 1, MAX_STALE_SESSIONS));
}

// A recorded intent that has NOT yet been confirmed at the broker. Written before the
// submission so a crash in between leaves something to recover from, and cleared to the
// real Alpaca status the moment the broker responds.
export const PENDING_SUBMIT_STATUS = "PENDING_SUBMIT";
// An intent the broker never received (looked up by client_order_id on a later run and
// not found). Terminal: there is nothing at the broker, so nothing to reconcile.
export const ABANDONED_STATUS = "ABANDONED";

// Terminal Alpaca order states — once an order reaches one, there's nothing left
// to reconcile, so it drops out of the pending-fill recheck. Anything NOT in here is
// still working at the broker, which `entryAttemptHistory` also depends on.
export const TERMINAL_ORDER_STATUS = new Set([
  "filled",
  "canceled",
  "cancelled",
  "expired",
  "rejected",
  "done_for_day",
  "replaced",
  ABANDONED_STATUS,
]);

/**
 * Days an unfilled BUY entry may rest at the broker before it's cancelled.
 *
 * Entries go in `gtc` (the attached stop leg needs it), and nothing used to cancel
 * them — `cancelOrder` was only ever called on protective legs. Nine entries were
 * found resting 28–33 days, still live: a signal from four weeks ago that could fill
 * at any moment, for a book that had long since re-evaluated the name. The re-entry
 * guard doesn't help — it governs new submissions, not orders already working.
 *
 * 1 = an order gets the next session to fill and is cancelled at the following run.
 * Anything longer is acting on a signal the strategy has already replaced. 0 disables.
 */
export const ENTRY_ORDER_TTL_DAYS = numEnv("PAPER_ENTRY_ORDER_TTL_DAYS", 1);

/**
 * Should this resting broker order be cancelled for age? Pure — the stage supplies
 * the order's side, whether the broker already considers it done, and its age.
 *
 * SELLs are deliberately exempt at any age. An unfilled exit still *wants* to happen:
 * cancelling one would strand a position the strategy has already decided to leave,
 * turning a measurement problem into an unwanted holding. Only entries go stale.
 */
export function shouldExpireEntryOrder(input: {
  side: string;
  terminal: boolean; // broker already reports a terminal state — nothing to cancel
  ageDays: number;
  ttlDays?: number;
}): boolean {
  const { side, terminal, ageDays, ttlDays = ENTRY_ORDER_TTL_DAYS } = input;
  if (side !== "BUY" || terminal) return false;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return false; // 0 / bad value disables
  return ageDays >= ttlDays;
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

/**
 * The score that gates a strategy's ENTRY, which is not always the score it exits on.
 *
 * Only COMBINED books can differ, and only when `combinedEntryUsesQuant` is 0: they then
 * enter on sentiment and keep exiting on the combined read. Every other strategy returns
 * its own source score unchanged, so this is a no-op for them.
 *
 * Returns null when the entry score is unavailable — the caller skips the strategy rather
 * than falling back to a score the operator asked not to enter on.
 */
export function entryScoreFor(
  strategy: Strategy,
  scores: { SENTIMENT: number; QUANT: number | null; COMBINED: number },
  cfg: RiskConfig
): number | null {
  const source = STRATEGY_SOURCE[strategy];
  if (source === "COMBINED" && STRATEGY_IS_RM[strategy] && cfg.combinedEntryUsesQuant === 0) {
    return scores.SENTIMENT;
  }
  return scores[source];
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
  /**
   * Score for the ENTRY gate and its decay mirror. Defaults to `score`.
   *
   * Split out so the COMBINED books can enter on sentiment alone while still exiting on
   * the combined read (`combinedEntryUsesQuant`). The decay exit follows this and not
   * `score` on purpose: it fires when "the conviction that justified the entry has been
   * gone for N runs", so it has to be measured on whatever justified the entry. The
   * confirmed-bearish exit deliberately does NOT follow it — that one keeps reading the
   * full combined signal, which is the leg the paired book evidence supported.
   */
  entryScore?: number;
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
  const entryScore = args.entryScore ?? score;

  if (open) {
    const { qty, entryPrice } = open;
    const peakPrice = Math.max(open.peakPrice, price);
    const bearish = isBearishSignal(signal);
    // Reset to 0 on any non-bearish read (idempotent); only advance on a new run.
    const bearishStreak = bearish ? (isNewRun ? open.bearishStreak + 1 : open.bearishStreak) : 0;
    // Stale = no entry-grade conviction (score at/below the deadband) — the mirror
    // of the entry gate, so it reads the SAME score the gate does. Same advance/reset
    // discipline as the bearish streak.
    const stale = entryScore <= cfg.entryScoreMin;
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
  if (entryScore > cfg.entryScoreMin && confidence >= cfg.minConfidence && price > 0) {
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
  /**
   * Place a GTC stop — either because nothing is protecting the position, or because
   * the resting stop is anchored to the wrong price and must be re-placed.
   *
   * `replacesResting` distinguishes the two, and the caller MUST cancel the resting
   * order first when it is set. Alpaca holds the position's shares against a resting
   * sell order, so submitting the replacement while the old stop is still working is
   * rejected (403, `available: "0"`) — the repair silently never happens and the stop
   * stays mis-anchored. The flag lives here, rather than being re-derived at the call
   * site, because this function is the only thing that knows which case it chose.
   */
  | { type: "REPAIR_STOP"; stopPrice: number; replacesResting: boolean }
  | { type: "NONE" };

/**
 * Reduce a stock's raw BUY order history to what the re-entry guard needs: has the
 * broker got an entry on this name for the CURRENT COMBINED_RM episode, and how long
 * ago it went in.
 *
 * An order counts as an attempt when EITHER of two things is true, and the distinction
 * matters in opposite directions:
 *
 *  • It filled (`filledQty > 0`) — shares were acquired, so a flat broker means the
 *    position was exited or stopped out, which is exactly what the guard exists for.
 *
 *  • It is not terminal yet (PENDING_SUBMIT, new, accepted, partially_filled…) — the
 *    order is still WORKING at the broker. `filledQty` is null here simply because it
 *    is backfilled by the reconcile sweep on a later run, not because nothing happened.
 *    Treating that as "never attempted" would let the stage submit a SECOND entry (and
 *    a second attached stop) over a live one it can't see in `getPositions()`, since
 *    nothing else de-duplicates resting buys — up to 2x the sized risk on one name.
 *
 * Only a BUY that reached a terminal state with NO fill — rejected, cancelled,
 * expired, abandoned — is discounted. That order never held a position, so there is
 * nothing to have been stopped out of; counting it stranded the name flat for the full
 * `brokerReentryRuns` cooldown instead of retrying the entry on the next run.
 */
export function entryAttemptHistory(
  buys: { submittedAt: Date; filledQty: number | null; status: string }[],
  entryDate: Date,
  today: Date
): { everAttempted: boolean; runsSinceAttempt: number | null } {
  let lastAttempt: Date | null = null;
  for (const b of buys) {
    const acquired = (b.filledQty ?? 0) > 0;
    if (!acquired && TERMINAL_ORDER_STATUS.has(b.status)) continue;
    if (lastAttempt == null || b.submittedAt > lastAttempt) lastAttempt = b.submittedAt;
  }
  const everAttempted = lastAttempt != null && lastAttempt >= entryDate;
  return { everAttempted, runsSinceAttempt: everAttempted ? utcDaysBetween(lastAttempt!, today) : null };
}

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
 *   left flat (the re-entry guard) until either the sim exits, or `brokerReentryRuns`
 *   runs pass — the bound that stops the guard stranding the sim's winners forever.
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
  runsSinceAttempt?: number | null; // UTC days since that entry attempt; null/undefined = unknown (guard never expires)
  avgEntryPrice: number | null;
  currentPrice: number | null;
  restingProtectiveType: "stop" | "trailing_stop" | null; // resting protective order, if any
  restingTrailPercent?: number | null; // trail % of a resting trailing stop (ratchet compare)
  restingStopPrice?: number | null; // price of a resting FIXED stop (re-anchor compare)
  price: number; // reference price (latest quant close) for sizing + stop/limit
  atrPct: number | null; // entry-day ATR% when held (frozen distances), today's when entering
  confidence: number;
  cfg?: RiskConfig;
  entryLimitBufferPct?: number;
  /**
   * Trading sessions between the close `price` came from and now (see `sessionsStale`).
   * Widens the entry buffer to cover the drift a stale reference hides. Defaults to 1,
   * which is the old behaviour exactly.
   */
  referenceSessions?: number;
}): BrokerAction {
  const cfg = input.cfg ?? DEFAULT_RISK_CONFIG;
  const buffer = stalenessScaledBuffer(
    input.entryLimitBufferPct ?? ENTRY_LIMIT_BUFFER_PCT,
    input.referenceSessions ?? 1
  );
  const { opened, stillLong, exitReason, held, avgEntryPrice, currentPrice, restingProtectiveType, restingTrailPercent, restingStopPrice, price, atrPct, confidence } = input;
  // Unknown history ⇒ assume the broker already acted, so we never catch-up-buy a name
  // that was actually stopped out. Only an explicit `false` unlocks a catch-up entry.
  const everAttempted = input.everAttempted ?? true;
  // Unknown age ⇒ the guard cannot expire, so a caller that doesn't track attempt
  // dates keeps exactly the old behaviour.
  const runsSinceAttempt = input.runsSinceAttempt ?? null;

  const infoExit = exitReason === "SIGNAL" || exitReason === "DECAY" || exitReason === "TIME";
  if (held && infoExit) return { type: "EXIT", reason: exitReason! };

  if (!held) {
    // Fresh open, or a catch-up for an entry that never took hold (gated / sub-share
    // that grew), or a name whose re-entry guard has since expired.
    //
    // The guard stops the live book buying straight back into a name it just stopped
    // out of. Unbounded, though, it also strands every name the broker exited while
    // the sim kept holding — the live book then tracks the sim's *losers* (which the
    // sim exits, resetting the episode) and misses its *winners* (which the sim keeps
    // riding). `brokerReentryRuns` bounds it: after that many runs the live book is
    // allowed to converge back onto the sim. 0 keeps the old unbounded behaviour.
    const guardExpired =
      cfg.brokerReentryRuns > 0 &&
      runsSinceAttempt != null &&
      runsSinceAttempt >= cfg.brokerReentryRuns;
    const catchUp = stillLong && (!everAttempted || guardExpired);
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
      return {
        type: "REPAIR_STOP",
        stopPrice: cents(anchor * (1 - riskDistancePct(cfg, atrPct, cfg.stopLossPct))),
        replacesResting: false,
      };
    }
    // Re-anchor a fixed stop that was priced off the wrong reference.
    //
    // The OTO entry has to name its stop_price at SUBMISSION, before the fill price is
    // known, so both legs are derived from the same stale reference close: the limit at
    // `price × (1 + buffer)`, the stop at `price × (1 − stopPct)`. Fill anywhere other
    // than exactly `price` and the real distance from the fill isn't `stopPct` — fill at
    // the top of the band and it's `(buffer + stopPct)`, which at a wide buffer is most
    // of a second stop's worth of risk on a position sized for the first. Sizing assumes
    // stopPct holds, so the overshoot lands straight on risk-per-trade.
    //
    // Once filled we know the real entry, so re-price off it. Only fixed stops: a
    // trailing stop is a distance from the peak and never had this problem. Tolerance
    // keeps the daily stage from cancel/replacing over rounding.
    if (restingProtectiveType === "stop" && restingStopPrice != null && avgEntryPrice != null && avgEntryPrice > 0) {
      const want = cents(avgEntryPrice * (1 - riskDistancePct(cfg, atrPct, cfg.stopLossPct)));
      if (Math.abs(want - restingStopPrice) / avgEntryPrice > STOP_REANCHOR_TOLERANCE_PCT) {
        return { type: "REPAIR_STOP", stopPrice: want, replacesResting: true };
      }
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
