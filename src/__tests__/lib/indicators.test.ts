import { describe, it, expect } from "vitest";
import { calcSMA, calcRSI, calcVolatility, calcMomentum, calcQuantScore, scoreToSignal } from "@/lib/indicators";

// ── calcSMA ──────────────────────────────────────────────────────────────────

describe("calcSMA()", () => {
  it("returns the correct average", () => {
    expect(calcSMA([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(calcSMA([10, 20, 30], 3)).toBe(20);
  });

  it("uses only the last `period` values", () => {
    expect(calcSMA([100, 1, 2, 3], 3)).toBeCloseTo(2);
  });

  it("returns null when fewer values than period", () => {
    expect(calcSMA([1, 2], 5)).toBeNull();
    expect(calcSMA([], 1)).toBeNull();
  });
});

// ── calcRSI ──────────────────────────────────────────────────────────────────

describe("calcRSI()", () => {
  it("returns null when fewer than period+1 prices", () => {
    expect(calcRSI(Array(14).fill(100))).toBeNull(); // exactly 14 — needs 15
  });

  it("returns 100 when all moves are gains", () => {
    const closes = Array.from({ length: 16 }, (_, i) => 100 + i);
    expect(calcRSI(closes)).toBe(100);
  });

  it("returns 0 when all moves are losses", () => {
    const closes = Array.from({ length: 16 }, (_, i) => 100 - i);
    expect(calcRSI(closes)).toBe(0);
  });

  it("returns 50 when there are no changes at all", () => {
    expect(calcRSI(Array(16).fill(100))).toBe(50);
  });

  it("returns a value in [0, 100] for mixed data", () => {
    const closes = [100, 101, 99, 102, 98, 103, 97, 104, 96, 105, 95, 106, 94, 107, 93, 108];
    const rsi = calcRSI(closes)!;
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });
});

// ── calcVolatility ───────────────────────────────────────────────────────────

describe("calcVolatility()", () => {
  it("returns null for fewer than 2 prices", () => {
    expect(calcVolatility([100])).toBeNull();
    expect(calcVolatility([])).toBeNull();
  });

  it("returns 0 for a flat price series", () => {
    expect(calcVolatility(Array(10).fill(100))).toBe(0);
  });

  it("returns a positive value for a varying series", () => {
    const closes = [100, 101, 99, 102, 98, 103, 97, 104, 96, 105];
    expect(calcVolatility(closes)!).toBeGreaterThan(0);
  });
});

// ── calcMomentum ─────────────────────────────────────────────────────────────

describe("calcMomentum()", () => {
  it("returns correct % change", () => {
    expect(calcMomentum([100, 110], 1)).toBeCloseTo(10);
    expect(calcMomentum([100, 90], 1)).toBeCloseTo(-10);
  });

  it("uses the correct period offset", () => {
    // [100, 200, 300] — 2 periods ago was 100, current is 300 → +200%
    expect(calcMomentum([100, 200, 300], 2)).toBeCloseTo(200);
  });

  it("returns null when period exceeds available data", () => {
    expect(calcMomentum([100, 110], 5)).toBeNull();
    expect(calcMomentum([100], 1)).toBeNull();
  });
});

// ── calcQuantScore ───────────────────────────────────────────────────────────

describe("calcQuantScore()", () => {
  it("returns 0 when all inputs are null", () => {
    expect(calcQuantScore({})).toBe(0);
  });

  it("oversold RSI (< 30) contributes a positive score", () => {
    const score = calcQuantScore({ rsi14: 25 });
    expect(score).toBeGreaterThan(0);
  });

  it("overbought RSI (> 70) contributes a negative score", () => {
    const score = calcQuantScore({ rsi14: 75 });
    expect(score).toBeLessThan(0);
  });

  it("positive 7-day momentum contributes a positive score", () => {
    expect(calcQuantScore({ change7d: 10 })).toBeGreaterThan(0);
  });

  it("price above SMA20 contributes a positive score", () => {
    expect(calcQuantScore({ sma20: 100, price: 110 })).toBeGreaterThan(0);
    expect(calcQuantScore({ sma20: 100, price: 90 })).toBeLessThan(0);
  });

  it("result is always in [−1, 1]", () => {
    const score = calcQuantScore({ rsi14: 0, change7d: 100, sma20: 100, price: 1000 });
    expect(score).toBeGreaterThanOrEqual(-1);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("rescales correctly when only one component is available", () => {
    // RSI=50 → rsi signal = 0; rescaled result should still be 0
    expect(calcQuantScore({ rsi14: 50 })).toBeCloseTo(0);
  });
});

// ── scoreToSignal ─────────────────────────────────────────────────────────────

describe("scoreToSignal()", () => {
  it("maps score boundaries correctly", () => {
    expect(scoreToSignal(0.7)).toBe("STRONG_BUY");
    expect(scoreToSignal(0.6)).toBe("BUY");
    expect(scoreToSignal(0.3)).toBe("BUY");
    expect(scoreToSignal(0.2)).toBe("NEUTRAL");
    expect(scoreToSignal(0)).toBe("NEUTRAL");
    expect(scoreToSignal(-0.19)).toBe("NEUTRAL");
    expect(scoreToSignal(-0.2)).toBe("SELL"); // strict > boundary — exactly -0.2 is SELL
    expect(scoreToSignal(-0.21)).toBe("SELL");
    expect(scoreToSignal(-0.6)).toBe("STRONG_SELL");
    expect(scoreToSignal(-1)).toBe("STRONG_SELL");
  });
});
