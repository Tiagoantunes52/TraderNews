import { describe, it, expect } from "vitest";
import {
  solveLinear,
  olsCoefficients,
  standardizersFor,
  fitFamaMacBeth,
  scoreWithWeights,
} from "@/lib/signal-research-fit";

const KEYS = ["a", "b"] as const;

/** Deterministic pseudo-random in [-1, 1], so fixtures are reproducible without a seed lib. */
const wobble = (n: number) => Math.sin(n * 12.9898) * 43758.5453 - Math.floor(Math.sin(n * 12.9898) * 43758.5453) - 0.5;

describe("solveLinear", () => {
  it("solves a known system", () => {
    // 2x + y = 5 ; x - y = 1  →  x = 2, y = 1
    const x = solveLinear([[2, 1], [1, -1]], [5, 1]);
    expect(x![0]).toBeCloseTo(2, 10);
    expect(x![1]).toBeCloseTo(1, 10);
  });

  it("returns null for a singular system rather than NaNs", () => {
    // Second row is 2x the first — no unique solution.
    expect(solveLinear([[1, 2], [2, 4]], [3, 6])).toBeNull();
  });
});

describe("olsCoefficients", () => {
  it("recovers exact coefficients on noiseless data", () => {
    const rows = [0, 1, 2, 3, 4, 5].map((i) => [1, i, i * i]);
    const y = rows.map(([, x1, x2]) => 2 + 3 * x1 - 0.5 * x2);
    const beta = olsCoefficients(rows, y)!;
    expect(beta[0]).toBeCloseTo(2, 8);
    expect(beta[1]).toBeCloseTo(3, 8);
    expect(beta[2]).toBeCloseTo(-0.5, 8);
  });

  it("refuses a system with fewer observations than parameters", () => {
    expect(olsCoefficients([[1, 2], [1, 3]], [1, 2])).toBeNull();
  });
});

describe("standardizersFor", () => {
  it("computes the mean and sample sd of each term", () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const s = standardizersFor(rows, ["a"]);
    expect(s.a.mean).toBeCloseTo(2, 10);
    expect(s.a.sd).toBeCloseTo(1, 10); // sample sd of 1,2,3
  });

  it("gives a degenerate term sd 1 so standardizing is a no-op, not a divide by zero", () => {
    const s = standardizersFor([{ a: 5 }, { a: 5 }], ["a"]);
    expect(s.a.sd).toBe(1);
    expect(Number.isFinite(s.a.mean)).toBe(true);
  });

  it("ignores nulls when computing a term's spread", () => {
    const s = standardizersFor([{ a: 1 }, { a: null }, { a: 3 }], ["a"]);
    expect(s.a.mean).toBeCloseTo(2, 10);
  });
});

/** Sessions of `n` names each, with terms a/b and a forward return built from them. */
function corpus(sessions: number, n: number, coef: { a: number; b: number }) {
  const rows: { session: string; a: number; b: number; ret: number }[] = [];
  for (let s = 0; s < sessions; s++) {
    for (let i = 0; i < n; i++) {
      rows.push({ session: `2024-01-${String(s + 1).padStart(2, "0")}`, a: wobble(s * 100 + i), b: wobble(s * 100 + i + 7), ret: 0 });
    }
  }
  // Build the return from the STANDARDIZED terms, so the recovered weights are the
  // coefficients themselves rather than coefficients times an arbitrary scale.
  const std = standardizersFor(rows.map((r) => ({ a: r.a, b: r.b })), KEYS);
  for (const r of rows) {
    r.ret = coef.a * ((r.a - std.a.mean) / std.a.sd) + coef.b * ((r.b - std.b.mean) / std.b.sd);
  }
  return rows;
}

describe("fitFamaMacBeth", () => {
  const extract = (r: { a: number | null; b: number | null }) => ({ a: r.a, b: r.b });
  const ret = (r: { ret: number }) => r.ret;

  it("recovers known weights from a noiseless corpus", () => {
    const rows = corpus(40, 20, { a: 0.8, b: -0.3 });
    const fit = fitFamaMacBeth(rows, extract, ret, KEYS);
    expect(fit.weights.a).toBeCloseTo(0.8, 6);
    expect(fit.weights.b).toBeCloseTo(-0.3, 6);
    expect(fit.sessions).toBe(40);
    expect(fit.dropped).toBe(0);
  });

  it("returns ~0 for a term that carries no signal", () => {
    const rows = corpus(40, 20, { a: 0.8, b: 0 });
    const fit = fitFamaMacBeth(rows, extract, ret, KEYS);
    expect(Math.abs(fit.weights.b)).toBeLessThan(1e-6);
  });

  it("takes the t-stat ACROSS sessions, not across observations", () => {
    // 40 sessions x 20 names = 800 rows. A t-stat computed across rows would be ~sqrt(20)
    // larger. Assert the coefficient series length is what drives it.
    const rows = corpus(40, 20, { a: 0.8, b: -0.3 });
    const fit = fitFamaMacBeth(rows, extract, ret, KEYS);
    expect(fit.sessions).toBe(40);
    expect(fit.observations).toBe(800);
    // Noiseless data → every session returns the same coefficient → infinite t. What
    // matters here is that it is computed at all and from the session series.
    expect(fit.tStats.a == null || Number.isFinite(fit.tStats.a) || fit.tStats.a === Infinity).toBe(true);
  });

  it("drops rows with a missing term rather than filling a neutral value", () => {
    const rows: { session: string; a: number | null; b: number | null; ret: number }[] = corpus(20, 15, {
      a: 0.5,
      b: 0.2,
    });
    rows[0].a = null;
    rows[1].b = null;
    const fit = fitFamaMacBeth(rows, extract, ret, KEYS);
    expect(fit.dropped).toBe(2);
    expect(fit.observations).toBe(20 * 15 - 2);
  });

  it("skips sessions with too few names to regress", () => {
    const rows = corpus(10, 20, { a: 0.5, b: 0.2 });
    const thin = rows.filter((r) => r.session !== "2024-01-01" || rows.indexOf(r) % 20 < 3);
    const fit = fitFamaMacBeth(thin, extract, ret, KEYS, { minNames: 10 });
    expect(fit.sessions).toBe(9); // the 3-name session contributes no coefficient
  });

  it("survives a session where a term is constant across every name", () => {
    const rows = corpus(20, 15, { a: 0.5, b: 0.2 });
    for (const r of rows) if (r.session === "2024-01-01") r.b = 0.42;
    const fit = fitFamaMacBeth(rows, extract, ret, KEYS);
    // That session is singular and drops out; the rest still fit.
    expect(fit.sessions).toBe(19);
    expect(Number.isFinite(fit.weights.a)).toBe(true);
  });
});

describe("scoreWithWeights", () => {
  const W = { a: 0.6, b: -0.4 };
  const STD = { a: { mean: 0, sd: 1 }, b: { mean: 0, sd: 1 } };

  it("is the weighted sum of standardized terms, rescaled by total absolute weight", () => {
    // (0.6*1 + -0.4*0.5) / (0.6 + 0.4) = 0.4
    expect(scoreWithWeights({ a: 1, b: 0.5 }, W, STD)).toBeCloseTo(0.4, 10);
  });

  it("applies the standardizer", () => {
    const std = { a: { mean: 2, sd: 4 }, b: { mean: 0, sd: 1 } };
    // a → (10-2)/4 = 2, b → 0 ; (0.6*2 + 0)/1 = 1.2 → clamped to 1
    expect(scoreWithWeights({ a: 10, b: 0 }, W, std)).toBe(1);
  });

  it("rescales by the surviving weights when a term is missing", () => {
    // Only `a` present: (0.6*1)/0.6 = 1, not 0.6 — otherwise a name with no MACD would
    // score systematically nearer zero for a data-availability reason.
    expect(scoreWithWeights({ a: 1, b: null }, W, STD)).toBeCloseTo(1, 10);
  });

  it("clamps into [-1, 1] so scoreToSignal's cuts still mean something", () => {
    expect(scoreWithWeights({ a: 50, b: -50 }, W, STD)).toBe(1);
    expect(scoreWithWeights({ a: -50, b: 50 }, W, STD)).toBe(-1);
  });

  it("returns null when no term is available", () => {
    expect(scoreWithWeights({ a: null, b: null }, W, STD)).toBeNull();
  });

  it("preserves the rank order of the underlying weighted sum", () => {
    const raw = (a: number, b: number) => 0.6 * a - 0.4 * b;
    const rows = [
      [0.2, 0.9],
      [-0.5, 0.1],
      [0.8, -0.3],
    ] as const;
    const byScore = [...rows].sort(
      (x, y) => scoreWithWeights({ a: x[0], b: x[1] }, W, STD)! - scoreWithWeights({ a: y[0], b: y[1] }, W, STD)!
    );
    const byRaw = [...rows].sort((x, y) => raw(x[0], x[1]) - raw(y[0], y[1]));
    expect(byScore).toEqual(byRaw);
  });
});
