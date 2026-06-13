import { describe, it, expect } from "vitest";
import {
  THRESHOLDS,
  SIGNAL_HINTS,
  classifySentiment,
  classifyRsi,
  classifyMacd,
  classifyMomentum,
  isBollingerSqueeze,
} from "@/lib/signals";

describe("classifySentiment()", () => {
  it("returns null for null/undefined", () => {
    expect(classifySentiment(null)).toBeNull();
    expect(classifySentiment(undefined)).toBeNull();
  });

  it("flips at ±sentimentBull, neutral on the boundary", () => {
    const t = THRESHOLDS.sentimentBull;
    expect(classifySentiment(t + 0.01)).toBe("bullish");
    expect(classifySentiment(t)).toBe("neutral");
    expect(classifySentiment(-t)).toBe("neutral");
    expect(classifySentiment(-t - 0.01)).toBe("bearish");
  });
});

describe("classifyRsi()", () => {
  it("returns null for null/undefined", () => {
    expect(classifyRsi(null)).toBeNull();
    expect(classifyRsi(undefined)).toBeNull();
  });

  it("oversold reads bullish, overbought reads bearish", () => {
    expect(classifyRsi(THRESHOLDS.rsiOversold - 1)).toBe("bullish");
    expect(classifyRsi(50)).toBe("neutral");
    expect(classifyRsi(THRESHOLDS.rsiOverbought + 1)).toBe("bearish");
  });

  it("is neutral exactly on the bands", () => {
    expect(classifyRsi(THRESHOLDS.rsiOversold)).toBe("neutral");
    expect(classifyRsi(THRESHOLDS.rsiOverbought)).toBe("neutral");
  });
});

describe("classifyMacd()", () => {
  it("returns null without a usable price", () => {
    expect(classifyMacd(1, null)).toBeNull();
    expect(classifyMacd(1, 0)).toBeNull();
    expect(classifyMacd(null, 100)).toBeNull();
  });

  it("normalizes the histogram by price before thresholding", () => {
    // 0.2% of a $100 stock clears the 0.1% dead-zone → bullish
    expect(classifyMacd(0.2, 100)).toBe("bullish");
    expect(classifyMacd(-0.2, 100)).toBe("bearish");
    // 0.05% sits inside the dead-zone → neutral
    expect(classifyMacd(0.05, 100)).toBe("neutral");
    // Same absolute histogram on a $1000 stock is only 0.02% → neutral
    expect(classifyMacd(0.2, 1000)).toBe("neutral");
  });
});

describe("classifyMomentum()", () => {
  it("ignores sub-threshold weekly moves", () => {
    expect(classifyMomentum(THRESHOLDS.momentumNeutralPct + 0.1)).toBe("bullish");
    expect(classifyMomentum(1)).toBe("neutral");
    expect(classifyMomentum(-(THRESHOLDS.momentumNeutralPct + 0.1))).toBe("bearish");
    expect(classifyMomentum(null)).toBeNull();
  });
});

describe("isBollingerSqueeze()", () => {
  it("is true only below the squeeze width", () => {
    expect(isBollingerSqueeze(THRESHOLDS.bollingerSqueeze - 0.01)).toBe(true);
    expect(isBollingerSqueeze(THRESHOLDS.bollingerSqueeze)).toBe(false);
    expect(isBollingerSqueeze(null)).toBe(false);
    expect(isBollingerSqueeze(undefined)).toBe(false);
  });
});

describe("SIGNAL_HINTS", () => {
  it("derive their numbers from THRESHOLDS so copy can't drift from logic", () => {
    expect(SIGNAL_HINTS.sentiment).toContain(`+${THRESHOLDS.sentimentBull}`);
    expect(SIGNAL_HINTS.rsi).toContain(`${THRESHOLDS.rsiOversold}`);
    expect(SIGNAL_HINTS.rsi).toContain(`${THRESHOLDS.rsiOverbought}`);
    expect(SIGNAL_HINTS.macd).toContain(`${THRESHOLDS.macdDeadzonePct}%`);
    expect(SIGNAL_HINTS.momentum).toContain(`${THRESHOLDS.momentumNeutralPct}%`);
  });
});
