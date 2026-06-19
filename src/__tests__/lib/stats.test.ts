import { describe, it, expect } from "vitest";
import {
  pearson,
  mean,
  sampleStdev,
  ranks,
  spearman,
  wilsonInterval,
  brierScore,
  baseRateBrier,
  sharpe,
  sortino,
  maxDrawdown,
  linearRegression,
} from "@/lib/stats";

describe("pearson", () => {
  it("returns 1 for a perfect positive linear relationship", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [2, 4, 6, 8, 10];
    expect(pearson(xs, ys)).toBeCloseTo(1, 10);
  });

  it("returns -1 for a perfect negative linear relationship", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [10, 8, 6, 4, 2];
    expect(pearson(xs, ys)).toBeCloseTo(-1, 10);
  });

  it("returns near 0 for uncorrelated series", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [3, 1, 4, 1, 5];
    const r = pearson(xs, ys)!;
    expect(Math.abs(r)).toBeLessThan(0.5);
  });

  it("returns null below the minimum pair count", () => {
    expect(pearson([1, 2, 3], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 6)).toBeNull();
  });

  it("returns null when a series has zero variance", () => {
    expect(pearson([1, 1, 1, 1, 1], [1, 2, 3, 4, 5])).toBeNull();
  });

  it("uses the shorter length when series differ", () => {
    // extra trailing value on ys is ignored; first 5 are a perfect line
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10, 99])).toBeCloseTo(1, 10);
  });

  it("respects a custom minPairs", () => {
    expect(pearson([1, 2], [2, 4], 2)).toBeCloseTo(1, 10);
  });
});

describe("mean / sampleStdev", () => {
  it("computes the mean", () => {
    expect(mean([2, 4, 6])).toBeCloseTo(4, 10);
  });
  it("returns null for an empty mean", () => {
    expect(mean([])).toBeNull();
  });
  it("computes sample (n−1) standard deviation", () => {
    // var = (1+0+1)/2 = 1 → sd = 1
    expect(sampleStdev([1, 2, 3])).toBeCloseTo(1, 10);
  });
  it("returns null for sampleStdev below 2 points", () => {
    expect(sampleStdev([5])).toBeNull();
  });
});

describe("ranks", () => {
  it("ranks distinct values 1-based", () => {
    expect(ranks([10, 30, 20])).toEqual([1, 3, 2]);
  });
  it("averages tied ranks", () => {
    expect(ranks([1, 2, 2, 3])).toEqual([1, 2.5, 2.5, 4]);
  });
});

describe("spearman", () => {
  it("returns 1 for a monotonic but non-linear relationship", () => {
    // squares are monotonic → perfect rank correlation even though Pearson < 1
    expect(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25])).toBeCloseTo(1, 10);
  });
  it("returns -1 for a strictly decreasing relationship", () => {
    expect(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });
  it("handles ties via average ranks", () => {
    expect(spearman([1, 2, 2, 3, 4], [10, 20, 20, 30, 40])).toBeCloseTo(1, 10);
  });
  it("returns null below minPairs", () => {
    expect(spearman([1, 2, 3], [3, 2, 1])).toBeNull();
  });
});

describe("wilsonInterval", () => {
  it("matches the known 95% interval for 8/10", () => {
    const w = wilsonInterval(8, 10)!;
    expect(w.p).toBeCloseTo(0.8, 10);
    expect(w.lo).toBeCloseTo(0.49, 2);
    expect(w.hi).toBeCloseTo(0.943, 2);
  });
  it("stays within [0,1] at the 100% extreme", () => {
    const w = wilsonInterval(10, 10)!;
    expect(w.lo).toBeGreaterThan(0);
    expect(w.hi).toBeLessThanOrEqual(1);
  });
  it("returns null for n ≤ 0 or out-of-range successes", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(11, 10)).toBeNull();
  });
});

describe("brierScore / baseRateBrier", () => {
  it("is 0 for a perfect predictor", () => {
    expect(brierScore([1, 0, 1, 0], [1, 0, 1, 0])).toBe(0);
  });
  it("computes the mean squared error", () => {
    // errors: 0, 1, 1, 0 → 0.5
    expect(brierScore([1, 1, 0, 0], [1, 0, 1, 0])).toBeCloseTo(0.5, 10);
  });
  it("accepts boolean outcomes", () => {
    expect(brierScore([0.5, 0.5], [true, false])).toBeCloseTo(0.25, 10);
  });
  it("base-rate Brier equals p̄(1−p̄)", () => {
    expect(baseRateBrier([1, 0, 1, 0])).toBeCloseTo(0.25, 10);
    expect(baseRateBrier([1, 1, 1, 0])).toBeCloseTo(0.1875, 10);
  });
  it("returns null on empty input", () => {
    expect(brierScore([], [])).toBeNull();
    expect(baseRateBrier([])).toBeNull();
  });
});

describe("sharpe", () => {
  it("annualizes mean/stdev", () => {
    // mean 0.02, sample sd 0.01 → 2 × √252
    expect(sharpe([0.02, 0.01, 0.03])).toBeCloseTo(2 * Math.sqrt(252), 6);
  });
  it("is 0 when mean return is 0", () => {
    expect(sharpe([0.01, -0.01, 0.01, -0.01])).toBeCloseTo(0, 10);
  });
  it("returns null with zero volatility or too few points", () => {
    expect(sharpe([0.01, 0.01, 0.01])).toBeNull();
    expect(sharpe([0.01])).toBeNull();
  });
});

describe("sortino", () => {
  it("penalizes only downside deviation", () => {
    const returns = [0.02, -0.01, 0.03, -0.02];
    const mean = 0.005;
    const dd = Math.sqrt((0.01 * 0.01 + 0.02 * 0.02) / 4);
    expect(sortino(returns)).toBeCloseTo((mean / dd) * Math.sqrt(252), 6);
  });
  it("returns null when there is no downside", () => {
    expect(sortino([0.01, 0.02, 0.03])).toBeNull();
  });
});

describe("maxDrawdown", () => {
  it("finds the largest peak-to-trough decline", () => {
    expect(maxDrawdown([100, 120, 90, 130, 110])).toBeCloseTo(0.25, 10);
  });
  it("is 0 for a monotonically rising curve", () => {
    expect(maxDrawdown([100, 110, 120])).toBe(0);
  });
  it("returns null for an empty curve", () => {
    expect(maxDrawdown([])).toBeNull();
  });
});

describe("linearRegression", () => {
  it("recovers slope and intercept of a perfect line", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 2 * x + 1);
    const fit = linearRegression(xs, ys)!;
    expect(fit.beta).toBeCloseTo(2, 10);
    expect(fit.alpha).toBeCloseTo(1, 10);
  });
  it("returns null when x has zero variance or too few points", () => {
    expect(linearRegression([1, 1, 1, 1, 1], [1, 2, 3, 4, 5])).toBeNull();
    expect(linearRegression([1, 2], [1, 2])).toBeNull();
  });
});
