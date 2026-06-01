import { describe, it, expect } from "vitest";
import { calcSMA, calcRSI, calcVolatility, calcMomentum, calcVolumeRatio, calcQuantScore, scoreToSignal } from "@/lib/indicators";

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

// ── calcVolumeRatio ───────────────────────────────────────────────────────────

describe("calcVolumeRatio()", () => {
  it("returns null when fewer than period+1 volumes", () => {
    expect(calcVolumeRatio(Array(10).fill(1000))).toBeNull(); // exactly 10 — needs 11
  });

  it("returns 1.0 when today's volume equals the 10-day average", () => {
    const volumes = Array(11).fill(1000);
    expect(calcVolumeRatio(volumes)).toBeCloseTo(1.0);
  });

  it("returns > 1 when today's volume is elevated", () => {
    const volumes = [...Array(10).fill(1000), 3000];
    expect(calcVolumeRatio(volumes)!).toBeGreaterThan(1);
  });

  it("returns < 1 when today's volume is below average", () => {
    const volumes = [...Array(10).fill(1000), 200];
    expect(calcVolumeRatio(volumes)!).toBeLessThan(1);
  });

  it("returns null when prior average volume is zero", () => {
    const volumes = [...Array(10).fill(0), 500];
    expect(calcVolumeRatio(volumes)).toBeNull();
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

  it("uses ÷40 normalisation for crypto 7d momentum instead of ÷20", () => {
    // For equities: change7d=20 → clamp(20/20)=1 → strong signal
    // For crypto:   change7d=20 → clamp(20/40)=0.5 → moderate signal
    const equityScore = calcQuantScore({ change7d: 20 });
    const cryptoScore = calcQuantScore({ change7d: 20, isCrypto: true });
    expect(cryptoScore).toBeLessThan(equityScore);
  });

  it("applies volatility dampener — high vol reduces score magnitude", () => {
    const base = calcQuantScore({ rsi14: 20 }); // strongly oversold
    const dampened = calcQuantScore({ rsi14: 20, volatility30d: 0.80 }); // very high vol
    expect(Math.abs(dampened)).toBeLessThan(Math.abs(base));
  });

  it("low volatility does not reduce score below full magnitude", () => {
    const base = calcQuantScore({ rsi14: 20 });
    const lowVol = calcQuantScore({ rsi14: 20, volatility30d: 0.10 });
    expect(Math.abs(lowVol)).toBeCloseTo(Math.abs(base));
  });

  it("elevated volume above SMA adds a positive contribution", () => {
    // price=105 is moderately above sma20=100 — SMA component is 0.5, not clamped
    const withoutVol = calcQuantScore({ sma20: 100, price: 105 });
    const withHighVol = calcQuantScore({ sma20: 100, price: 105, volumeRatio10d: 3.0 });
    expect(withHighVol).toBeGreaterThan(withoutVol);
  });

  it("below-average volume does not change the score direction", () => {
    const withoutVol = calcQuantScore({ sma20: 100, price: 110 });
    const withLowVol = calcQuantScore({ sma20: 100, price: 110, volumeRatio10d: 0.5 });
    // Low volume contributes 0 — the score may differ slightly due to weight rescaling
    // but should not reverse direction
    expect(Math.sign(withLowVol)).toBe(Math.sign(withoutVol));
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
