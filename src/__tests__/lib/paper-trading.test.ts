import { describe, it, expect } from "vitest";
import {
  isEntrySignal,
  isExitSignal,
  isBearishSignal,
  deriveSignals,
  confidenceNotional,
  sizePosition,
  realizedPnl,
  unrealizedPnl,
  isPaperTradeEligible,
  reconcilePosition,
  reconcileRiskManaged,
  planBrokerAction,
  isBrokerStopsEnabled,
  realizedFromFills,
  utcDaysBetween,
  summarizeBook,
  STRATEGY_BOOK,
  STRATEGY_SOURCE,
  STRATEGY_IS_RM,
  STRATEGIES,
  RM_STRATEGIES,
  ALL_STRATEGIES,
  DEFAULT_RISK_CONFIG,
  riskConfig,
  isRiskBooksEnabled,
  type RiskConfig,
} from "@/lib/paper-trading";

describe("entry / exit predicates", () => {
  it("treats BUY and STRONG_BUY as entries", () => {
    expect(isEntrySignal("BUY")).toBe(true);
    expect(isEntrySignal("STRONG_BUY")).toBe(true);
    expect(isEntrySignal("NEUTRAL")).toBe(false);
    expect(isEntrySignal("SELL")).toBe(false);
    expect(isEntrySignal("STRONG_SELL")).toBe(false);
  });

  it("exit is the complement of entry (long-only)", () => {
    for (const s of ["BUY", "STRONG_BUY", "NEUTRAL", "SELL", "STRONG_SELL"]) {
      expect(isExitSignal(s)).toBe(!isEntrySignal(s));
    }
  });
});

describe("deriveSignals()", () => {
  it("classifies each source score through scoreToSignal", () => {
    const sig = deriveSignals({ sentimentScore: 0.7, quantScore: -0.7, combinedScore: 0.3 });
    expect(sig.SENTIMENT).toBe("STRONG_BUY"); // > 0.6
    expect(sig.QUANT).toBe("STRONG_SELL"); // < -0.6
    expect(sig.COMBINED).toBe("BUY"); // > 0.2
  });

  it("returns null for QUANT when the quant score is absent", () => {
    const sig = deriveSignals({ sentimentScore: 0.5, quantScore: null, combinedScore: 0.5 });
    expect(sig.QUANT).toBeNull();
    expect(sig.SENTIMENT).toBe("BUY");
  });

  it("maps each strategy to its book", () => {
    expect(STRATEGY_BOOK.SENTIMENT).toBe("SIM_SENTIMENT");
    expect(STRATEGY_BOOK.QUANT).toBe("SIM_QUANT");
    expect(STRATEGY_BOOK.COMBINED).toBe("SIM_COMBINED");
  });
});

describe("sizing", () => {
  it("scales notional by confidence and clamps to [0,1]", () => {
    expect(confidenceNotional(0.5, 1000)).toBe(500);
    expect(confidenceNotional(1.0, 1000)).toBe(1000);
    expect(confidenceNotional(1.5, 1000)).toBe(1000); // clamped
    expect(confidenceNotional(-0.2, 1000)).toBe(0); // clamped
  });

  it("derives share quantity from notional and price", () => {
    expect(sizePosition(0.5, 50, 1000)).toBe(10); // $500 / $50
  });

  it("returns 0 quantity for a non-positive price", () => {
    expect(sizePosition(0.5, 0, 1000)).toBe(0);
    expect(sizePosition(0.5, -5, 1000)).toBe(0);
  });
});

describe("P&L math", () => {
  it("realized P&L for a long is qty × (exit − entry)", () => {
    expect(realizedPnl(10, 50, 55)).toBe(50);
    expect(realizedPnl(10, 50, 45)).toBe(-50);
  });

  it("unrealized P&L marks at the current price", () => {
    expect(unrealizedPnl(10, 50, 60)).toBe(100);
  });
});

describe("isPaperTradeEligible()", () => {
  it("includes US equities (incl. class shares), excludes foreign + crypto", () => {
    expect(isPaperTradeEligible("AAPL")).toBe(true);
    expect(isPaperTradeEligible("BRK.B")).toBe(true); // resolves to NYSE/NASDAQ
    expect(isPaperTradeEligible("EGL.LS")).toBe(false); // Lisbon
    expect(isPaperTradeEligible("VOD.L")).toBe(false); // London
    expect(isPaperTradeEligible("BTC-USD")).toBe(false); // crypto
  });
});

describe("reconcilePosition()", () => {
  it("opens a sized long when flat and the signal is a buy", () => {
    const action = reconcilePosition("BUY", 50, 0.5, null, 1000);
    expect(action).toEqual({ type: "OPEN", qty: 10, price: 50 });
  });

  it("does nothing when flat and the signal is not a buy", () => {
    expect(reconcilePosition("NEUTRAL", 50, 0.5, null, 1000)).toEqual({ type: "NONE" });
    expect(reconcilePosition("SELL", 50, 0.5, null, 1000)).toEqual({ type: "NONE" });
  });

  it("does not open when sizing rounds to zero (no price)", () => {
    expect(reconcilePosition("BUY", 0, 0.5, null, 1000)).toEqual({ type: "NONE" });
  });

  it("closes an open long on an exit signal, realizing P&L at the mark", () => {
    const action = reconcilePosition("NEUTRAL", 55, 0.5, { qty: 10, entryPrice: 50 }, 1000);
    expect(action).toEqual({ type: "CLOSE", price: 55, realizedPnl: 50 });
  });

  it("marks an open long that still reads as a buy", () => {
    const action = reconcilePosition("STRONG_BUY", 60, 0.5, { qty: 10, entryPrice: 50 }, 1000);
    expect(action).toEqual({ type: "MARK", price: 60 });
  });
});

describe("summarizeBook()", () => {
  it("computes equity, realized, unrealized, and hit-rate", () => {
    const closed = [{ realizedPnl: 100 }, { realizedPnl: -40 }, { realizedPnl: 30 }];
    const open = [{ qty: 10, entryPrice: 50, lastMarkPrice: 55 }]; // +50 unrealized
    const s = summarizeBook(closed, open, 100_000);
    expect(s.realizedPnl).toBe(90);
    expect(s.unrealizedPnl).toBe(50);
    expect(s.equity).toBe(100_140);
    expect(s.openPositions).toBe(1);
    expect(s.closedCount).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.hitRate).toBeCloseTo(2 / 3);
  });

  it("falls back to entry price when an open position has no mark yet", () => {
    const s = summarizeBook([], [{ qty: 10, entryPrice: 50, lastMarkPrice: null }], 100_000);
    expect(s.unrealizedPnl).toBe(0);
    expect(s.equity).toBe(100_000);
  });

  it("reports a null hit-rate when nothing has closed", () => {
    const s = summarizeBook([], [], 100_000);
    expect(s.hitRate).toBeNull();
    expect(s.equity).toBe(100_000);
  });
});

// ── Risk-managed (_RM) books ───────────────────────────────────────────────────

describe("strategy maps", () => {
  it("pairs each pure strategy with a risk-managed variant on the same source", () => {
    expect(STRATEGIES).toEqual(["SENTIMENT", "QUANT", "COMBINED"]);
    expect(RM_STRATEGIES).toEqual(["SENTIMENT_RM", "QUANT_RM", "COMBINED_RM"]);
    expect(ALL_STRATEGIES).toEqual([...STRATEGIES, ...RM_STRATEGIES]);
    for (const s of STRATEGIES) {
      expect(STRATEGY_IS_RM[s]).toBe(false);
      expect(STRATEGY_IS_RM[`${s}_RM` as (typeof RM_STRATEGIES)[number]]).toBe(true);
      // pure and _RM read the same raw source score
      expect(STRATEGY_SOURCE[`${s}_RM` as (typeof RM_STRATEGIES)[number]]).toBe(STRATEGY_SOURCE[s]);
    }
  });
});

describe("isBearishSignal()", () => {
  it("is true only for SELL / STRONG_SELL (NEUTRAL does not count)", () => {
    expect(isBearishSignal("SELL")).toBe(true);
    expect(isBearishSignal("STRONG_SELL")).toBe(true);
    expect(isBearishSignal("NEUTRAL")).toBe(false);
    expect(isBearishSignal("BUY")).toBe(false);
    expect(isBearishSignal("STRONG_BUY")).toBe(false);
  });
});

describe("utcDaysBetween()", () => {
  it("counts whole UTC days, signed", () => {
    expect(utcDaysBetween(new Date("2026-06-10T23:00:00Z"), new Date("2026-06-10T01:00:00Z"))).toBe(0);
    expect(utcDaysBetween(new Date("2026-06-10T23:00:00Z"), new Date("2026-06-11T01:00:00Z"))).toBe(1);
    expect(utcDaysBetween(new Date("2026-06-30T12:00:00Z"), new Date("2026-07-03T12:00:00Z"))).toBe(3);
    expect(utcDaysBetween(new Date("2026-06-11T00:00:00Z"), new Date("2026-06-09T00:00:00Z"))).toBe(-2);
  });
});

describe("riskConfig()", () => {
  it("returns the documented defaults when no PAPER_* envs are set", () => {
    expect(riskConfig()).toEqual(DEFAULT_RISK_CONFIG);
    expect(DEFAULT_RISK_CONFIG.stopLossPct).toBe(0.08);
    expect(DEFAULT_RISK_CONFIG.signalConfirmRuns).toBe(2);
    expect(DEFAULT_RISK_CONFIG.minHoldRuns).toBe(3);
  });

  it("isRiskBooksEnabled() is gated on PAPER_RISK_BOOKS=1", () => {
    const prev = process.env.PAPER_RISK_BOOKS;
    try {
      delete process.env.PAPER_RISK_BOOKS;
      expect(isRiskBooksEnabled()).toBe(false);
      process.env.PAPER_RISK_BOOKS = "1";
      expect(isRiskBooksEnabled()).toBe(true);
      process.env.PAPER_RISK_BOOKS = "true";
      expect(isRiskBooksEnabled()).toBe(false); // strictly "1"
    } finally {
      if (prev === undefined) delete process.env.PAPER_RISK_BOOKS;
      else process.env.PAPER_RISK_BOOKS = prev;
    }
  });
});

describe("reconcileRiskManaged()", () => {
  const cfg: RiskConfig = DEFAULT_RISK_CONFIG;
  const base = {
    score: 0.5,
    signal: "BUY",
    price: 100,
    confidence: 0.5,
    atrPct: null as number | null,
    runsSinceEntry: 5,
    isNewRun: true,
    open: null as null | { qty: number; entryPrice: number; peakPrice: number; bearishStreak: number },
    cfg,
    base: 1000,
  };
  const rm = (o: Partial<typeof base>) => reconcileRiskManaged({ ...base, ...o });
  const long = (over: Partial<{ qty: number; entryPrice: number; peakPrice: number; bearishStreak: number }> = {}) => ({
    qty: 10,
    entryPrice: 100,
    peakPrice: 100,
    bearishStreak: 0,
    ...over,
  });

  describe("entry (deadband + confidence floor)", () => {
    it("opens a confidence-sized long above the entry deadband", () => {
      expect(rm({ score: 0.3, confidence: 0.5, price: 50, open: null })).toEqual({
        type: "OPEN",
        qty: 10, // 1000 × 0.5 / 50
        price: 50,
      });
    });

    it("does not open inside the deadband even though the signal reads BUY", () => {
      // 0.22 → scoreToSignal = BUY, but below the 0.25 entry floor → no entry.
      expect(rm({ score: 0.22, signal: "BUY", open: null })).toEqual({ type: "NONE" });
    });

    it("does not open below the confidence floor", () => {
      expect(rm({ score: 0.5, confidence: 0.2, open: null })).toEqual({ type: "NONE" });
    });
  });

  describe("hard stop-loss (always live)", () => {
    it("closes when price breaches the fixed stop, even during min-hold", () => {
      expect(rm({ price: 92, runsSinceEntry: 0, signal: "BUY", open: long() })).toEqual({
        type: "CLOSE",
        price: 92,
        realizedPnl: -80,
        reason: "STOP",
      });
    });

    it("holds just above the stop", () => {
      expect(rm({ price: 93, signal: "NEUTRAL", open: long() })).toEqual({
        type: "MARK",
        price: 93,
        peakPrice: 100,
        bearishStreak: 0,
      });
    });
  });

  describe("trailing stop", () => {
    it("closes once armed and price falls a trail's width below the peak", () => {
      // peak 120 ≥ 100×1.08 armed; trail 12% → 120×0.88 = 105.6; price 105 ≤ that.
      expect(rm({ price: 105, signal: "BUY", open: long({ peakPrice: 120 }) })).toEqual({
        type: "CLOSE",
        price: 105,
        realizedPnl: 50,
        reason: "TRAIL",
      });
    });

    it("is suppressed during the minimum holding period", () => {
      expect(rm({ price: 105, runsSinceEntry: 1, signal: "BUY", open: long({ peakPrice: 120 }) })).toEqual({
        type: "MARK",
        price: 105,
        peakPrice: 120,
        bearishStreak: 0,
      });
    });

    it("does not trigger before activation", () => {
      // peak 105 < activation 108 → not armed.
      expect(rm({ price: 100, signal: "BUY", open: long({ peakPrice: 105 }) })).toEqual({
        type: "MARK",
        price: 100,
        peakPrice: 105,
        bearishStreak: 0,
      });
    });
  });

  describe("confirmed-signal exit", () => {
    it("exits only after N consecutive bearish runs", () => {
      // streak 1 + this bearish run = 2 ≥ confirm(2) → exit.
      expect(rm({ price: 98, signal: "SELL", open: long({ bearishStreak: 1 }) })).toEqual({
        type: "CLOSE",
        price: 98,
        realizedPnl: -20,
        reason: "SIGNAL",
      });
    });

    it("marks (no exit) while the bearish streak is still building", () => {
      expect(rm({ price: 98, signal: "SELL", open: long({ bearishStreak: 0 }) })).toEqual({
        type: "MARK",
        price: 98,
        peakPrice: 100,
        bearishStreak: 1,
      });
    });

    it("does not advance the streak on a same-day re-run (idempotent)", () => {
      expect(rm({ price: 99, signal: "SELL", isNewRun: false, runsSinceEntry: 1, open: long({ bearishStreak: 1 }) })).toEqual({
        type: "MARK",
        price: 99,
        peakPrice: 100,
        bearishStreak: 1, // unchanged
      });
    });

    it("resets the streak on any non-bearish read", () => {
      expect(rm({ price: 100, signal: "NEUTRAL", open: long({ bearishStreak: 5 }) })).toEqual({
        type: "MARK",
        price: 100,
        peakPrice: 100,
        bearishStreak: 0,
      });
    });

    it("is suppressed during the minimum holding period", () => {
      const action = rm({ price: 98, signal: "SELL", runsSinceEntry: 1, open: long({ bearishStreak: 1 }) });
      expect(action).toEqual({ type: "MARK", price: 98, peakPrice: 100, bearishStreak: 2 });
    });
  });

  describe("time stop", () => {
    it("closes dead money near entry after the hold window", () => {
      expect(rm({ price: 101, signal: "BUY", runsSinceEntry: 20, open: long() })).toEqual({
        type: "CLOSE",
        price: 101,
        realizedPnl: 10,
        reason: "TIME",
      });
    });

    it("leaves a winner running outside the band", () => {
      // 110 is outside ±3% of entry; peak 110 is armed but 110 > 110×0.88 → no trail.
      expect(rm({ price: 110, signal: "BUY", runsSinceEntry: 20, open: long({ peakPrice: 110 }) })).toEqual({
        type: "MARK",
        price: 110,
        peakPrice: 110,
        bearishStreak: 0,
      });
    });
  });

  describe("ATR-scaled stops", () => {
    it("widens the stop for a volatile name (vs the fixed fallback)", () => {
      // Fixed 8% stop → triggers at ≤ 92; price 91 stops out.
      expect(rm({ price: 91, signal: "NEUTRAL", open: long() })).toMatchObject({ type: "CLOSE", reason: "STOP" });
      // atrPct 4% × 2.5 = 10% stop → triggers at ≤ 90; price 91 survives.
      expect(rm({ price: 91, signal: "NEUTRAL", atrPct: 4, open: long() })).toEqual({
        type: "MARK",
        price: 91,
        peakPrice: 100,
        bearishStreak: 0,
      });
    });

    it("clamps the ATR-scaled distance to the floor", () => {
      // atrPct 1% × 2.5 = 2.5% < 6% floor → stop at 6% → triggers at ≤ 94.
      expect(rm({ price: 94, signal: "NEUTRAL", atrPct: 1, open: long() })).toMatchObject({
        type: "CLOSE",
        reason: "STOP",
      });
      expect(rm({ price: 95, signal: "NEUTRAL", atrPct: 1, open: long() })).toMatchObject({ type: "MARK" });
    });
  });

  it("tracks the running peak with max()", () => {
    // 120 is a pullback from the 130 peak but above both the stop (92) and the
    // trailing trigger (130×0.88 = 114.4), so it just marks.
    expect(rm({ price: 120, signal: "BUY", open: long({ peakPrice: 130 }) })).toMatchObject({
      type: "MARK",
      peakPrice: 130, // a pullback doesn't lower the peak
    });
  });
});

describe("planBrokerAction()", () => {
  const base = {
    opened: false,
    stillLong: true,
    exitReason: null as string | null,
    held: false,
    avgEntryPrice: null as number | null,
    currentPrice: null as number | null,
    restingProtectiveType: null as "stop" | "trailing_stop" | null,
    price: 100,
    atrPct: null as number | null,
    confidence: 0.6,
    cfg: DEFAULT_RISK_CONFIG,
    base: 1000,
    entryLimitBufferPct: 0.005,
  };
  const plan = (o: Partial<typeof base>) => planBrokerAction({ ...base, ...o });

  describe("entry (whole-share, marketable-limit + ATR stop)", () => {
    it("enters on a fresh sim OPEN when flat, flooring to whole shares", () => {
      // notional 1000×0.6 = $600; floor(600/100) = 6 shares; stop 100×0.92 = 92.
      expect(plan({ opened: true })).toEqual({ type: "ENTER", qty: 6, limitPrice: 100.5, stopPrice: 92 });
    });

    it("skips a name when the confidence-weighted budget is under one share", () => {
      // $600 budget, $700 price → floor = 0 → no live order (sim book still covers it).
      expect(plan({ opened: true, price: 700 })).toEqual({ type: "NONE" });
    });

    it("widens the stop with ATR when available", () => {
      // atrPct 4% × 2.5 = 10% → stop 100×0.90 = 90.
      expect(plan({ opened: true, atrPct: 4 })).toMatchObject({ type: "ENTER", stopPrice: 90 });
    });

    it("does NOT re-enter a name the broker stopped out while the sim is still long", () => {
      // flat (broker stop fired) + sim still long but NOT a fresh open → re-entry guard.
      expect(plan({ opened: false, stillLong: true, held: false })).toEqual({ type: "NONE" });
    });
  });

  describe("exits", () => {
    it("exits on an info exit (signal flip / time stop)", () => {
      expect(plan({ held: true, exitReason: "SIGNAL" })).toEqual({ type: "EXIT", reason: "SIGNAL" });
      expect(plan({ held: true, exitReason: "TIME" })).toEqual({ type: "EXIT", reason: "TIME" });
    });

    it("does NOT app-exit on a price exit — the broker already enforces STOP/TRAIL", () => {
      expect(plan({ held: true, stillLong: false, exitReason: "STOP" })).toEqual({ type: "NONE" });
      expect(plan({ held: true, stillLong: false, exitReason: "TRAIL" })).toEqual({ type: "NONE" });
    });
  });

  describe("managing the resting protective order", () => {
    it("arms the trailing stop once up the activation threshold", () => {
      // gain (110−100)/100 = 10% ≥ 8% activate, resting fixed stop → trail 12%.
      expect(
        plan({ held: true, restingProtectiveType: "stop", avgEntryPrice: 100, currentPrice: 110 })
      ).toEqual({ type: "ARM_TRAILING", trailPercent: 12 });
    });

    it("does not arm before the activation gain", () => {
      expect(
        plan({ held: true, restingProtectiveType: "stop", avgEntryPrice: 100, currentPrice: 105 })
      ).toEqual({ type: "NONE" });
    });

    it("does not re-arm a position already on a trailing stop", () => {
      expect(
        plan({ held: true, restingProtectiveType: "trailing_stop", avgEntryPrice: 100, currentPrice: 130 })
      ).toEqual({ type: "NONE" });
    });

    it("repairs a missing protective order off the avg entry price", () => {
      expect(plan({ held: true, restingProtectiveType: null, avgEntryPrice: 100 })).toEqual({
        type: "REPAIR_STOP",
        stopPrice: 92,
      });
    });

    it("falls back to the reference price when there is no avg entry yet", () => {
      expect(plan({ held: true, restingProtectiveType: null, avgEntryPrice: null, price: 50 })).toEqual({
        type: "REPAIR_STOP",
        stopPrice: 46,
      });
    });
  });

  it("isBrokerStopsEnabled() is gated on PAPER_BROKER_STOPS=1", () => {
    const prev = process.env.PAPER_BROKER_STOPS;
    try {
      delete process.env.PAPER_BROKER_STOPS;
      expect(isBrokerStopsEnabled()).toBe(false);
      process.env.PAPER_BROKER_STOPS = "1";
      expect(isBrokerStopsEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PAPER_BROKER_STOPS;
      else process.env.PAPER_BROKER_STOPS = prev;
    }
  });
});

describe("realizedFromFills()", () => {
  const buy = (symbol: string, qty: number, price: number, time: string) => ({ symbol, side: "buy" as const, qty, price, time });
  const sell = (symbol: string, qty: number, price: number, time: string) => ({ symbol, side: "sell" as const, qty, price, time });

  it("realizes a simple round-trip", () => {
    const { trades, totalRealized } = realizedFromFills([buy("AAPL", 10, 50, "2026-06-10T14:00:00Z"), sell("AAPL", 10, 55, "2026-06-12T14:00:00Z")]);
    expect(trades).toEqual([
      { symbol: "AAPL", qty: 10, entryPrice: 50, exitPrice: 55, realizedPnl: 50, closedAt: "2026-06-12T14:00:00Z" },
    ]);
    expect(totalRealized).toBe(50);
  });

  it("handles a partial close, leaving the rest open", () => {
    const { trades } = realizedFromFills([buy("AAPL", 10, 50, "t1"), sell("AAPL", 4, 55, "t2")]);
    expect(trades).toEqual([{ symbol: "AAPL", qty: 4, entryPrice: 50, exitPrice: 55, realizedPnl: 20, closedAt: "t2" }]);
  });

  it("FIFO-matches a sell across multiple buy lots (weighted entry)", () => {
    // buy 5@50, buy 5@60, sell 8@70 → cost basis 5×50 + 3×60 = 430; realized 8×70 − 430 = 130.
    const { trades, totalRealized } = realizedFromFills([buy("MSFT", 5, 50, "t1"), buy("MSFT", 5, 60, "t2"), sell("MSFT", 8, 70, "t3")]);
    expect(trades).toEqual([{ symbol: "MSFT", qty: 8, entryPrice: 53.75, exitPrice: 70, realizedPnl: 130, closedAt: "t3" }]);
    expect(totalRealized).toBe(130);
  });

  it("ignores a sell with no matching buy (entry predates the window)", () => {
    const { trades, totalRealized } = realizedFromFills([sell("NVDA", 5, 40, "t1")]);
    expect(trades).toEqual([]);
    expect(totalRealized).toBe(0);
  });

  it("sums across symbols and returns trades newest-first", () => {
    const { trades, totalRealized } = realizedFromFills([
      buy("AAPL", 10, 50, "2026-06-10T00:00:00Z"),
      sell("AAPL", 10, 45, "2026-06-11T00:00:00Z"), // −50
      buy("MSFT", 2, 100, "2026-06-12T00:00:00Z"),
      sell("MSFT", 2, 130, "2026-06-13T00:00:00Z"), // +60
    ]);
    expect(trades.map((t) => t.symbol)).toEqual(["MSFT", "AAPL"]); // newest first
    expect(totalRealized).toBe(10);
  });

  it("handles fractional quantities", () => {
    const { totalRealized } = realizedFromFills([buy("F", 1.5, 10, "t1"), sell("F", 1.5, 12, "t2")]);
    expect(totalRealized).toBeCloseTo(3);
  });
});
