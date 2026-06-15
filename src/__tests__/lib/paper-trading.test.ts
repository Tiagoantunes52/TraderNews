import { describe, it, expect } from "vitest";
import {
  isEntrySignal,
  isExitSignal,
  deriveSignals,
  confidenceNotional,
  sizePosition,
  realizedPnl,
  unrealizedPnl,
  isPaperTradeEligible,
  reconcilePosition,
  summarizeBook,
  STRATEGY_BOOK,
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
