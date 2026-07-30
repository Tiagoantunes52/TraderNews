import { describe, it, expect } from "vitest";
import {
  shouldExpireEntryOrder,
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
  entryAttemptHistory,
  isBrokerStopsEnabled,
  realizedFromFills,
  utcDaysBetween,
  summarizeBook,
  STRATEGY_BOOK,
  STRATEGY_SOURCE,
  STRATEGY_IS_RM,
  STRATEGIES,
  RM_STRATEGIES,
  EVENT_STRATEGIES,
  reconcileEventPosition,
  isInsiderBookEnabled,
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
    expect(EVENT_STRATEGIES).toEqual(["INSIDER"]);
    expect(ALL_STRATEGIES).toEqual([...STRATEGIES, ...RM_STRATEGIES, ...EVENT_STRATEGIES]);
    expect(STRATEGY_BOOK.INSIDER).toBe("SIM_INSIDER");
    expect(STRATEGY_IS_RM.INSIDER).toBe(false);
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

describe("reconcileEventPosition() — insider event book", () => {
  const open = { qty: 10, entryPrice: 100 };

  it("marks while inside the fixed holding period", () => {
    expect(reconcileEventPosition(110, 30, 56, open)).toEqual({ type: "MARK", price: 110 });
  });

  it("closes at expiry regardless of price direction (time is the only exit)", () => {
    expect(reconcileEventPosition(110, 56, 56, open)).toEqual({ type: "CLOSE", price: 110, realizedPnl: 100 });
    expect(reconcileEventPosition(90, 60, 56, open)).toEqual({ type: "CLOSE", price: 90, realizedPnl: -100 });
  });

  it("isInsiderBookEnabled() is gated on PAPER_INSIDER_BOOK=1", () => {
    const prev = process.env.PAPER_INSIDER_BOOK;
    try {
      delete process.env.PAPER_INSIDER_BOOK;
      expect(isInsiderBookEnabled()).toBe(false);
      process.env.PAPER_INSIDER_BOOK = "1";
      expect(isInsiderBookEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PAPER_INSIDER_BOOK;
      else process.env.PAPER_INSIDER_BOOK = prev;
    }
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
    open: null as null | {
      qty: number;
      entryPrice: number;
      peakPrice: number;
      bearishStreak: number;
      staleStreak: number;
      entryAtrPct: number | null;
    },
    cfg,
  };
  const rm = (o: Partial<typeof base>) => reconcileRiskManaged({ ...base, ...o });
  const long = (
    over: Partial<{
      qty: number;
      entryPrice: number;
      peakPrice: number;
      bearishStreak: number;
      staleStreak: number;
      entryAtrPct: number | null;
    }> = {}
  ) => ({
    qty: 10,
    entryPrice: 100,
    peakPrice: 100,
    bearishStreak: 0,
    staleStreak: 0,
    entryAtrPct: null as number | null,
    ...over,
  });

  describe("entry (deadband + confidence floor + risk-based sizing)", () => {
    it("opens a risk-sized long above the entry deadband", () => {
      // riskPerTrade $80 × conf 0.5 = $40 at risk; fixed 8% stop → $500 notional
      // → 10 shares at $50. (Same as the legacy $1000 × conf at the default stop.)
      expect(rm({ score: 0.3, confidence: 0.5, price: 50, open: null })).toEqual({
        type: "OPEN",
        qty: 10,
        price: 50,
      });
    });

    it("sizes a wide-stopped volatile name down so every stop-out risks the same $", () => {
      // ATR 4% → stop 10% → notional 80×0.5/0.10 = $400 → 4 shares at $100.
      // Stop-out check: 4 shares × ($100 − $90) = $40 = riskPerTrade × confidence.
      expect(rm({ score: 0.3, confidence: 0.5, price: 100, atrPct: 4, open: null })).toEqual({
        type: "OPEN",
        qty: 4,
        price: 100,
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
        bearishStreak: 0,
        staleStreak: 0,
      });
    });

    it("holds just above the stop", () => {
      expect(rm({ price: 93, signal: "NEUTRAL", open: long() })).toEqual({
        type: "MARK",
        price: 93,
        peakPrice: 100,
        bearishStreak: 0,
        staleStreak: 0,
      });
    });

    it("fills a gap-down at the gapped price, NOT the stop level (issue #56)", () => {
      // Stop sits at 92 (entry 100, 8% fixed). The name gaps to 80 — the close is
      // well below the stop. We must realize the gapped 80, not pretend we got 92,
      // so the equity-curve drawdown isn't understated.
      const action = rm({ price: 80, runsSinceEntry: 0, signal: "BUY", open: long() });
      expect(action).toEqual({ type: "CLOSE", price: 80, realizedPnl: -200, reason: "STOP", bearishStreak: 0, staleStreak: 0 });
      // The gapped loss (−200) is strictly worse than a fill-at-the-stop (−80).
      expect((action as { realizedPnl: number }).realizedPnl).toBeLessThan(-80);
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
        bearishStreak: 0,
        staleStreak: 0,
      });
    });

    it("is suppressed during the minimum holding period", () => {
      expect(rm({ price: 105, runsSinceEntry: 1, signal: "BUY", open: long({ peakPrice: 120 }) })).toEqual({
        type: "MARK",
        price: 105,
        peakPrice: 120,
        bearishStreak: 0,
        staleStreak: 0,
      });
    });

    it("does not trigger before activation", () => {
      // peak 105 < activation 108 → not armed.
      expect(rm({ price: 100, signal: "BUY", open: long({ peakPrice: 105 }) })).toEqual({
        type: "MARK",
        price: 100,
        peakPrice: 105,
        bearishStreak: 0,
        staleStreak: 0,
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
        // The streak that actually cleared confirmation, not the prior run's value
        // — the audit reads this off the closed row (regression: was left unset).
        bearishStreak: 2,
        staleStreak: 0,
      });
    });

    it("marks (no exit) while the bearish streak is still building", () => {
      expect(rm({ price: 98, signal: "SELL", open: long({ bearishStreak: 0 }) })).toEqual({
        type: "MARK",
        price: 98,
        peakPrice: 100,
        bearishStreak: 1,
        staleStreak: 0,
      });
    });

    it("does not advance the streak on a same-day re-run (idempotent)", () => {
      expect(rm({ price: 99, signal: "SELL", isNewRun: false, runsSinceEntry: 1, open: long({ bearishStreak: 1 }) })).toEqual({
        type: "MARK",
        price: 99,
        peakPrice: 100,
        bearishStreak: 1, // unchanged
        staleStreak: 0,
      });
    });

    it("resets the streak on any non-bearish read", () => {
      expect(rm({ price: 100, signal: "NEUTRAL", open: long({ bearishStreak: 5 }) })).toEqual({
        type: "MARK",
        price: 100,
        peakPrice: 100,
        bearishStreak: 0,
        staleStreak: 0,
      });
    });

    it("is suppressed during the minimum holding period", () => {
      const action = rm({ price: 98, signal: "SELL", runsSinceEntry: 1, open: long({ bearishStreak: 1 }) });
      expect(action).toEqual({ type: "MARK", price: 98, peakPrice: 100, bearishStreak: 2, staleStreak: 0 });
    });
  });

  describe("time stop", () => {
    it("closes dead money near entry after the hold window", () => {
      expect(rm({ price: 101, signal: "BUY", runsSinceEntry: 20, open: long() })).toEqual({
        type: "CLOSE",
        price: 101,
        realizedPnl: 10,
        reason: "TIME",
        bearishStreak: 0,
        staleStreak: 0,
      });
    });

    it("leaves a winner running outside the band", () => {
      // 110 is outside ±3% of entry; peak 110 is armed but 110 > 110×0.88 → no trail.
      expect(rm({ price: 110, signal: "BUY", runsSinceEntry: 20, open: long({ peakPrice: 110 }) })).toEqual({
        type: "MARK",
        price: 110,
        peakPrice: 110,
        bearishStreak: 0,
        staleStreak: 0,
      });
    });
  });

  describe("ATR-scaled stops (frozen at entry)", () => {
    it("widens the stop for a name that was volatile at entry (vs the fixed fallback)", () => {
      // Fixed 8% stop → triggers at ≤ 92; price 91 stops out.
      expect(rm({ price: 91, signal: "NEUTRAL", open: long() })).toMatchObject({ type: "CLOSE", reason: "STOP" });
      // entry ATR 4% × 2.5 = 10% stop → triggers at ≤ 90; price 91 survives.
      expect(rm({ price: 91, signal: "NEUTRAL", open: long({ entryAtrPct: 4 }) })).toEqual({
        type: "MARK",
        price: 91,
        peakPrice: 100,
        bearishStreak: 0,
        staleStreak: 0,
      });
    });

    it("clamps the ATR-scaled distance to the floor", () => {
      // entry ATR 1% × 2.5 = 2.5% < 6% floor → stop at 6% → triggers at ≤ 94.
      expect(rm({ price: 94, signal: "NEUTRAL", open: long({ entryAtrPct: 1 }) })).toMatchObject({
        type: "CLOSE",
        reason: "STOP",
      });
      expect(rm({ price: 95, signal: "NEUTRAL", open: long({ entryAtrPct: 1 }) })).toMatchObject({ type: "MARK" });
    });

    it("ignores today's ATR for exits — a volatility crash cannot tighten the stop", () => {
      // Entry ATR 4% froze a 10% stop (≤ 90). Today's ATR collapsed to 1% (a 6%
      // floating stop would fire at ≤ 94) — price 93 must still be a hold.
      expect(rm({ price: 93, signal: "NEUTRAL", atrPct: 1, open: long({ entryAtrPct: 4 }) })).toMatchObject({
        type: "MARK",
      });
    });

    it("ignores today's ATR for exits — a volatility spike cannot widen the stop", () => {
      // No ATR at entry → frozen fixed 8% stop (≤ 92). Today's ATR spiked to 4%
      // (a floating stop would widen to 10%, holding at 92) — price 92 must sell.
      expect(rm({ price: 92, signal: "NEUTRAL", atrPct: 4, open: long() })).toMatchObject({
        type: "CLOSE",
        reason: "STOP",
      });
    });
  });

  describe("trail ratchet (big winners give back less)", () => {
    it("tightens the trail once the peak clears the ratchet threshold", () => {
      // peak 130 ≥ 100×1.15 → trail 12%×0.5 = 6% → trigger 130×0.94 = 122.2;
      // price 120 ≤ that → a pullback the un-ratcheted 12% trail (114.4) would ride.
      expect(rm({ price: 120, signal: "BUY", open: long({ peakPrice: 130 }) })).toEqual({
        type: "CLOSE",
        price: 120,
        realizedPnl: 200,
        reason: "TRAIL",
        bearishStreak: 0,
        staleStreak: 0,
      });
    });

    it("keeps the full trail below the ratchet threshold", () => {
      // peak 112 armed (≥108) but under the 115 ratchet → trail 12% → 112×0.88 = 98.56.
      expect(rm({ price: 99, signal: "BUY", open: long({ peakPrice: 112 }) })).toMatchObject({
        type: "MARK",
        peakPrice: 112,
      });
    });

    it("is disabled when trailRatchetActivatePct is 0", () => {
      const noRatchet = { ...cfg, trailRatchetActivatePct: 0 };
      // Same 120-off-a-130-peak pullback as above: full 12% trail (114.4) holds it.
      expect(rm({ price: 120, signal: "BUY", cfg: noRatchet, open: long({ peakPrice: 130 }) })).toMatchObject({
        type: "MARK",
        peakPrice: 130,
      });
    });
  });

  describe("signal-decay exit (thesis played out)", () => {
    // Stale = score at/below the 0.25 entry deadband; NEUTRAL keeps bearishStreak at 0.
    it("closes a profitable position once conviction has been gone for decayRuns", () => {
      // streak 4 + this stale run = 5 ≥ decayRuns(5), price 106 > entry → take the profit.
      expect(rm({ score: 0.1, signal: "NEUTRAL", price: 106, open: long({ staleStreak: 4 }) })).toEqual({
        type: "CLOSE",
        price: 106,
        realizedPnl: 60,
        reason: "DECAY",
        // The matured streak (5), not the prior run's (4) — the daily-review audit
        // reads this off the closed row and flags it as unconfirmed if it's stale.
        bearishStreak: 0,
        staleStreak: 5,
      });
    });

    it("keeps building the streak but does NOT exit at a loss (stop/time own that side)", () => {
      expect(rm({ score: 0.1, signal: "NEUTRAL", price: 95, open: long({ staleStreak: 4 }) })).toEqual({
        type: "MARK",
        price: 95,
        peakPrice: 100,
        bearishStreak: 0,
        staleStreak: 5,
      });
    });

    it("resets the streak when conviction returns above the deadband", () => {
      expect(rm({ score: 0.4, signal: "BUY", price: 106, open: long({ staleStreak: 4 }) })).toMatchObject({
        type: "MARK",
        staleStreak: 0,
      });
    });

    it("does not advance the streak on a same-day re-run (idempotent)", () => {
      expect(rm({ score: 0.1, signal: "NEUTRAL", price: 106, isNewRun: false, open: long({ staleStreak: 4 }) })).toMatchObject({
        type: "MARK",
        staleStreak: 4, // unchanged → no exit either
      });
    });

    it("is suppressed during the minimum holding period", () => {
      expect(rm({ score: 0.1, signal: "NEUTRAL", price: 106, runsSinceEntry: 1, open: long({ staleStreak: 10 }) })).toMatchObject({
        type: "MARK",
        staleStreak: 11,
      });
    });

    it("is disabled when decayRuns is 0", () => {
      const noDecay = { ...cfg, decayRuns: 0 };
      expect(rm({ score: 0.1, signal: "NEUTRAL", price: 106, cfg: noDecay, open: long({ staleStreak: 40 }) })).toMatchObject({
        type: "MARK",
      });
    });
  });

  it("tracks the running peak with max()", () => {
    // 125 is a pullback from the 130 peak but above the stop (92) and the ratcheted
    // trailing trigger (130×0.94 = 122.2), so it just marks.
    expect(rm({ price: 125, signal: "BUY", open: long({ peakPrice: 130 }) })).toMatchObject({
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
    everAttempted: true,
    avgEntryPrice: null as number | null,
    currentPrice: null as number | null,
    restingProtectiveType: null as "stop" | "trailing_stop" | null,
    restingTrailPercent: null as number | null,
    price: 100,
    atrPct: null as number | null,
    confidence: 0.6,
    cfg: DEFAULT_RISK_CONFIG,
    entryLimitBufferPct: 0.005,
  };
  const plan = (o: Partial<typeof base> & { runsSinceAttempt?: number | null }) =>
    planBrokerAction({ ...base, ...o });

  describe("re-entry guard expiry", () => {
    // The guard leaves a stopped-out name flat so it isn't bought straight back.
    // Unbounded it also strands the sim's winners, which the live book then never
    // holds — bounded, it converges back once brokerReentryRuns have passed.
    it("stays flat while the guard is young", () => {
      const cfg = { ...DEFAULT_RISK_CONFIG, brokerReentryRuns: 10 };
      expect(plan({ cfg, everAttempted: true, runsSinceAttempt: 9 }).type).toBe("NONE");
    });

    it("re-enters once the guard has expired", () => {
      const cfg = { ...DEFAULT_RISK_CONFIG, brokerReentryRuns: 10 };
      expect(plan({ cfg, everAttempted: true, runsSinceAttempt: 10 }).type).toBe("ENTER");
    });

    it("never expires when brokerReentryRuns is 0 (old unbounded behaviour)", () => {
      const cfg = { ...DEFAULT_RISK_CONFIG, brokerReentryRuns: 0 };
      expect(plan({ cfg, everAttempted: true, runsSinceAttempt: 999 }).type).toBe("NONE");
    });

    it("never expires when the attempt age is unknown", () => {
      const cfg = { ...DEFAULT_RISK_CONFIG, brokerReentryRuns: 10 };
      expect(plan({ cfg, everAttempted: true, runsSinceAttempt: null }).type).toBe("NONE");
    });

    it("does not re-enter a name the sim has exited, however old the attempt", () => {
      const cfg = { ...DEFAULT_RISK_CONFIG, brokerReentryRuns: 10 };
      expect(plan({ cfg, stillLong: false, everAttempted: true, runsSinceAttempt: 99 }).type).toBe("NONE");
    });
  });

  describe("entry (whole-share, marketable-limit + ATR stop)", () => {
    it("enters on a fresh sim OPEN when flat, flooring to whole shares", () => {
      // risk $80×0.6 = $48 at the fixed 8% stop → $600 notional; floor(600/100) = 6
      // shares; stop 100×0.92 = 92.
      expect(plan({ opened: true })).toEqual({ type: "ENTER", qty: 6, limitPrice: 100.5, stopPrice: 92 });
    });

    it("skips a name when the risk-sized budget is under one share", () => {
      // $600 budget, $700 price → floor = 0 → no live order (sim book still covers it).
      expect(plan({ opened: true, price: 700 })).toEqual({ type: "NONE" });
    });

    it("widens the stop AND shrinks the size with ATR (equal $ risk)", () => {
      // atrPct 4% × 2.5 = 10% → stop 100×0.90 = 90; notional 80×0.6/0.10 = $480 → 4 shares.
      expect(plan({ opened: true, atrPct: 4 })).toEqual({ type: "ENTER", qty: 4, limitPrice: 100.5, stopPrice: 90 });
    });

    it("does NOT re-enter a name the broker stopped out while the sim is still long", () => {
      // flat (broker stop fired) + sim still long, NOT a fresh open, broker already
      // entered this episode (everAttempted) → re-entry guard leaves it flat.
      expect(plan({ opened: false, stillLong: true, held: false, everAttempted: true })).toEqual({ type: "NONE" });
    });

    it("catches up an entry the broker never placed (gated / grown sub-share)", () => {
      // flat + sim still long, not a fresh open, but the broker never attempted this
      // episode → enter now (same whole-share sizing as a fresh open).
      expect(plan({ opened: false, stillLong: true, held: false, everAttempted: false })).toEqual({
        type: "ENTER",
        qty: 6,
        limitPrice: 100.5,
        stopPrice: 92,
      });
    });

    it("does not catch up a name the sim is no longer long", () => {
      expect(plan({ opened: false, stillLong: false, held: false, everAttempted: false })).toEqual({ type: "NONE" });
    });

    it("catch-up still respects whole-share sizing (under one share → no order)", () => {
      expect(plan({ opened: false, stillLong: true, held: false, everAttempted: false, price: 700 })).toEqual({
        type: "NONE",
      });
    });
  });

  describe("exits", () => {
    it("exits on an info exit (signal flip / decay / time stop)", () => {
      expect(plan({ held: true, exitReason: "SIGNAL" })).toEqual({ type: "EXIT", reason: "SIGNAL" });
      expect(plan({ held: true, exitReason: "DECAY" })).toEqual({ type: "EXIT", reason: "DECAY" });
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

    it("does not touch a resting trailing stop when its trail percent is unknown", () => {
      expect(
        plan({ held: true, restingProtectiveType: "trailing_stop", avgEntryPrice: 100, currentPrice: 130 })
      ).toEqual({ type: "NONE" });
    });

    it("ratchets a resting trailing stop tighter once up the ratchet threshold", () => {
      // gain 16% ≥ 15% ratchet → target trail 12%×0.5 = 6% < resting 12% → replace.
      expect(
        plan({ held: true, restingProtectiveType: "trailing_stop", restingTrailPercent: 12, avgEntryPrice: 100, currentPrice: 116 })
      ).toEqual({ type: "ARM_TRAILING", trailPercent: 6 });
    });

    it("does not churn an already-ratcheted trailing stop", () => {
      expect(
        plan({ held: true, restingProtectiveType: "trailing_stop", restingTrailPercent: 6, avgEntryPrice: 100, currentPrice: 130 })
      ).toEqual({ type: "NONE" });
    });

    it("does not ratchet before the ratchet threshold", () => {
      // gain 10% arms the plain trail, but a trailing stop is already resting.
      expect(
        plan({ held: true, restingProtectiveType: "trailing_stop", restingTrailPercent: 12, avgEntryPrice: 100, currentPrice: 110 })
      ).toEqual({ type: "NONE" });
    });

    it("repairs a missing protective order off the avg entry price", () => {
      expect(plan({ held: true, restingProtectiveType: null, avgEntryPrice: 100 })).toEqual({
        type: "REPAIR_STOP",
        stopPrice: 92,
        replacesResting: false,
      });
    });

    it("falls back to the reference price when there is no avg entry yet", () => {
      expect(plan({ held: true, restingProtectiveType: null, avgEntryPrice: null, price: 50 })).toEqual({
        type: "REPAIR_STOP",
        stopPrice: 46,
        replacesResting: false,
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

describe("entryAttemptHistory()", () => {
  const entryDate = new Date("2026-07-01T00:00:00Z");
  const today = new Date("2026-07-05T00:00:00Z");
  const buy = (submittedAt: string, filledQty: number | null, status: string) => ({
    submittedAt: new Date(submittedAt),
    filledQty,
    status,
  });

  it("is unattempted with no buy history at all", () => {
    expect(entryAttemptHistory([], entryDate, today)).toEqual({ everAttempted: false, runsSinceAttempt: null });
  });

  it("counts a filled buy at/after the entry as an attempt", () => {
    expect(entryAttemptHistory([buy("2026-07-02T00:00:00Z", 6, "filled")], entryDate, today)).toEqual({
      everAttempted: true,
      runsSinceAttempt: 3,
    });
  });

  it("ignores a rejected order — it never held a position, so it must not trip the guard", () => {
    // Only order on file for this episode is a reject (filledQty null); the broker
    // never actually acquired shares, so this must catch up like a fresh entry, not
    // be mistaken for a stop-out.
    expect(entryAttemptHistory([buy("2026-07-02T00:00:00Z", null, "rejected")], entryDate, today)).toEqual({
      everAttempted: false,
      runsSinceAttempt: null,
    });
  });

  it("ignores a cancelled/abandoned order (filledQty 0) the same way", () => {
    expect(entryAttemptHistory([buy("2026-07-02T00:00:00Z", 0, "canceled")], entryDate, today)).toEqual({
      everAttempted: false,
      runsSinceAttempt: null,
    });
  });

  it("counts an unfilled order that is STILL WORKING at the broker as an attempt", () => {
    // `accepted` with no fill yet: filledQty is null only because the reconcile sweep
    // backfills it on a later run. The order is live and holds buying power, so a
    // catch-up entry here would stack a second position on the same name.
    expect(entryAttemptHistory([buy("2026-07-02T00:00:00Z", null, "accepted")], entryDate, today)).toEqual({
      everAttempted: true,
      runsSinceAttempt: 3,
    });
  });

  it("counts an unconfirmed PENDING_SUBMIT intent as an attempt", () => {
    // The intent row is written BEFORE submission, and recovery deliberately leaves it
    // PENDING_SUBMIT on a transport error rather than guessing ABANDONED — the order
    // may well be live at the broker, so the guard must stay on.
    expect(entryAttemptHistory([buy("2026-07-02T00:00:00Z", null, "PENDING_SUBMIT")], entryDate, today)).toEqual({
      everAttempted: true,
      runsSinceAttempt: 3,
    });
  });

  it("falls back to an earlier filled buy when the latest order rejected", () => {
    // A genuine fill on day 2, then an unrelated reject on day 4 (e.g. a same-day
    // repair attempt) — the reject must not erase the real attempt or its age.
    expect(
      entryAttemptHistory(
        [buy("2026-07-04T00:00:00Z", null, "rejected"), buy("2026-07-02T00:00:00Z", 6, "filled")],
        entryDate,
        today
      )
    ).toEqual({ everAttempted: true, runsSinceAttempt: 3 });
  });

  it("counts a partial fill as an attempt", () => {
    expect(entryAttemptHistory([buy("2026-07-02T00:00:00Z", 2, "partially_filled")], entryDate, today)).toEqual({
      everAttempted: true,
      runsSinceAttempt: 3,
    });
  });

  it("does not count a fill from a prior episode, before the current entry date", () => {
    expect(entryAttemptHistory([buy("2026-06-20T00:00:00Z", 6, "filled")], entryDate, today)).toEqual({
      everAttempted: false,
      runsSinceAttempt: null,
    });
  });

  it("does not count a still-working order from a prior episode either", () => {
    expect(entryAttemptHistory([buy("2026-06-20T00:00:00Z", null, "accepted")], entryDate, today)).toEqual({
      everAttempted: false,
      runsSinceAttempt: null,
    });
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

describe("shouldExpireEntryOrder() — stale broker entries", () => {
  const base = { side: "BUY", terminal: false, ageDays: 5, ttlDays: 1 };

  it("expires an unfilled BUY once it has had its session", () => {
    expect(shouldExpireEntryOrder({ ...base, ageDays: 1 })).toBe(true);
    expect(shouldExpireEntryOrder({ ...base, ageDays: 33 })).toBe(true);
  });

  it("leaves a BUY submitted this run alone — it has not had a session yet", () => {
    expect(shouldExpireEntryOrder({ ...base, ageDays: 0 })).toBe(false);
  });

  it("never expires a SELL — an unfilled exit still wants to happen", () => {
    // Cancelling one would strand a position the strategy already decided to leave.
    expect(shouldExpireEntryOrder({ ...base, side: "SELL", ageDays: 33 })).toBe(false);
  });

  it("does nothing when the broker already considers the order done", () => {
    expect(shouldExpireEntryOrder({ ...base, terminal: true, ageDays: 33 })).toBe(false);
  });

  it("is disabled by a zero or nonsensical TTL rather than cancelling everything", () => {
    expect(shouldExpireEntryOrder({ ...base, ttlDays: 0, ageDays: 33 })).toBe(false);
    expect(shouldExpireEntryOrder({ ...base, ttlDays: -1, ageDays: 33 })).toBe(false);
    expect(shouldExpireEntryOrder({ ...base, ttlDays: Number.NaN, ageDays: 33 })).toBe(false);
  });
});

describe("planBrokerAction() — stop re-anchoring after the fill", () => {
  const base = {
    opened: false,
    stillLong: true,
    exitReason: null,
    held: true,
    avgEntryPrice: 102,
    currentPrice: 102,
    restingProtectiveType: "stop" as const,
    price: 100,
    atrPct: null,
    confidence: 0.5,
  };
  // Fixed-stop distance with no ATR = cfg.stopLossPct (8%). Priced off the reference
  // close (100) the OTO stop rests at 92; off the real 102 fill it should be 93.84.

  it("re-places a stop that was anchored to the reference close, not the fill", () => {
    const action = planBrokerAction({ ...base, restingStopPrice: 92 });
    expect(action.type).toBe("REPAIR_STOP");
    if (action.type === "REPAIR_STOP") expect(action.stopPrice).toBeCloseTo(93.84, 2);
  });

  it("leaves a correctly anchored stop alone — no daily cancel/replace churn", () => {
    expect(planBrokerAction({ ...base, restingStopPrice: 93.84 }).type).toBe("NONE");
  });

  it("tolerates sub-cent drift without churning", () => {
    expect(planBrokerAction({ ...base, restingStopPrice: 93.9 }).type).toBe("NONE");
  });

  it("never re-anchors a trailing stop — it trails the peak, not the entry", () => {
    const action = planBrokerAction({
      ...base,
      restingProtectiveType: "trailing_stop",
      restingStopPrice: 1,
      currentPrice: 102,
    });
    expect(action.type).not.toBe("REPAIR_STOP");
  });

  it("does nothing without a known fill price", () => {
    expect(planBrokerAction({ ...base, avgEntryPrice: null, restingStopPrice: 92 }).type).toBe("NONE");
  });

  it("still repairs a missing protective order (unchanged behaviour)", () => {
    expect(planBrokerAction({ ...base, restingProtectiveType: null }).type).toBe("REPAIR_STOP");
  });

  // The stage cancels the resting order iff `replacesResting` is set. Getting this
  // wrong is silent: Alpaca holds the shares against the working stop and rejects the
  // replacement (403, `available: "0"`), so the stop keeps its wrong anchor — which is
  // exactly what production did until 2026-07-29, on every held name, every run.
  it("flags a re-anchor as replacing the resting stop, so the caller cancels first", () => {
    const action = planBrokerAction({ ...base, restingStopPrice: 92 });
    expect(action).toMatchObject({ type: "REPAIR_STOP", replacesResting: true });
  });

  it("does not flag a repair with nothing resting — there is no order to cancel", () => {
    const action = planBrokerAction({ ...base, restingProtectiveType: null });
    expect(action).toMatchObject({ type: "REPAIR_STOP", replacesResting: false });
  });
});
