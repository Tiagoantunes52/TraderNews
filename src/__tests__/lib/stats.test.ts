import { describe, it, expect } from "vitest";
import { pearson } from "@/lib/stats";

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
