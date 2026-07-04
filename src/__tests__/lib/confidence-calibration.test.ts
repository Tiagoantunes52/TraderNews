import { describe, it, expect } from "vitest";
import {
  buildConfidenceCalibrator,
  isConfCalibrationEnabled,
  CALIBRATION_MIN_N,
  CALIBRATION_MIN_BIN_N,
} from "@/lib/confidence-calibration";
import type { Reliability, ReliabilityBin } from "@/lib/calibration";

// A well-populated 5-bin diagram (mirrors reliabilityDiagram's layout). Overall
// hit rate = (40×0.5 + 40×0.6 + 40×0.4) / 120 = 0.5.
const bin = (lo: number, hi: number, count: number, hitRate: number | null): ReliabilityBin => ({
  lo,
  hi,
  count,
  meanConfidence: count > 0 ? (lo + hi) / 2 : null,
  hitRate,
  hitRateLo: hitRate,
  hitRateHi: hitRate,
});

const goodRel = (over: Partial<Reliability> = {}): Reliability => ({
  bins: [
    bin(0, 0.2, 0, null),
    bin(0.2, 0.4, 40, 0.5), // performs at par → factor 1
    bin(0.4, 0.6, 40, 0.6), // outperforms → factor 1.2
    bin(0.6, 0.8, 40, 0.4), // overconfident → factor 0.8
    bin(0.8, 1.0, 0, null),
  ],
  brier: 0.2,
  baseRateBrier: 0.25, // beats the base rate → confidence is informative
  n: 120,
  ...over,
});

describe("buildConfidenceCalibrator() trust gates", () => {
  it("is inactive (identity) with no reliability data", () => {
    const c = buildConfidenceCalibrator(null);
    expect(c.active).toBe(false);
    expect(c.calibrate(0.7)).toBe(0.7);
  });

  it("is inactive below the minimum sample size", () => {
    const c = buildConfidenceCalibrator(goodRel({ n: CALIBRATION_MIN_N - 1 }));
    expect(c.active).toBe(false);
    expect(c.reason).toContain("directional observations");
  });

  it("is inactive when Brier does not beat the base rate — confidence is noise", () => {
    expect(buildConfidenceCalibrator(goodRel({ brier: 0.25, baseRateBrier: 0.25 })).active).toBe(false);
    expect(buildConfidenceCalibrator(goodRel({ brier: null })).active).toBe(false);
  });

  it("identity map clamps stated confidence into [0, 1]", () => {
    expect(buildConfidenceCalibrator(null).calibrate(1.4)).toBe(1);
    expect(buildConfidenceCalibrator(null).calibrate(-0.2)).toBe(0);
  });
});

describe("buildConfidenceCalibrator() adjustment", () => {
  const c = buildConfidenceCalibrator(goodRel());

  it("activates on trustworthy data", () => {
    expect(c.active).toBe(true);
    expect(c.reason).toBeNull();
  });

  it("shrinks an overconfident bucket toward its measured accuracy", () => {
    // 0.7 lands in the 0.4-hit-rate bin: factor 0.4/0.5 = 0.8 → 0.56.
    expect(c.calibrate(0.7)).toBeCloseTo(0.56, 10);
  });

  it("boosts an underrated bucket", () => {
    // 0.5 lands in the 0.6-hit-rate bin: factor 0.6/0.5 = 1.2 → 0.6.
    expect(c.calibrate(0.5)).toBeCloseTo(0.6, 10);
  });

  it("leaves an at-par bucket unchanged", () => {
    expect(c.calibrate(0.3)).toBeCloseTo(0.3, 10);
  });

  it("passes a sparse bin through unadjusted", () => {
    const sparse = buildConfidenceCalibrator(
      goodRel({
        bins: [
          bin(0, 0.2, 0, null),
          bin(0.2, 0.4, 40, 0.5),
          bin(0.4, 0.6, 40, 0.6),
          bin(0.6, 0.8, CALIBRATION_MIN_BIN_N - 1, 0.1), // too few obs to trust
          bin(0.8, 1.0, 40, 0.5),
        ],
      })
    );
    expect(sparse.calibrate(0.7)).toBe(0.7);
  });

  it("clamps extreme factors to [0.5, 1.5]", () => {
    const extreme = buildConfidenceCalibrator(
      goodRel({
        bins: [
          bin(0, 0.2, 0, null),
          bin(0.2, 0.4, 40, 0.05), // 0.05/0.35 ≈ 0.14 → clamped to 0.5
          bin(0.4, 0.6, 40, 1.0), // 1.0/0.35 ≈ 2.86 → clamped to 1.5
          bin(0.6, 0.8, 0, null),
          bin(0.8, 1.0, 0, null),
        ],
      })
    );
    expect(extreme.calibrate(0.3)).toBeCloseTo(0.15, 10); // 0.3 × 0.5
    expect(extreme.calibrate(0.5)).toBeCloseTo(0.75, 10); // 0.5 × 1.5
  });

  it("confidence 1.0 lands in the last bin (inclusive upper edge)", () => {
    const top = buildConfidenceCalibrator(
      goodRel({
        bins: [
          bin(0, 0.2, 0, null),
          bin(0.2, 0.4, 60, 0.5),
          bin(0.4, 0.6, 0, null),
          bin(0.6, 0.8, 0, null),
          bin(0.8, 1.0, 60, 0.6), // overall 0.55 → factor 0.6/0.55
        ],
      })
    );
    expect(top.calibrate(1)).toBeCloseTo(Math.min(1, (1 * 0.6) / 0.55), 10);
  });
});

describe("isConfCalibrationEnabled()", () => {
  it("is gated on PAPER_CONF_CALIBRATION=1", () => {
    const prev = process.env.PAPER_CONF_CALIBRATION;
    try {
      delete process.env.PAPER_CONF_CALIBRATION;
      expect(isConfCalibrationEnabled()).toBe(false);
      process.env.PAPER_CONF_CALIBRATION = "1";
      expect(isConfCalibrationEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PAPER_CONF_CALIBRATION;
      else process.env.PAPER_CONF_CALIBRATION = prev;
    }
  });
});
