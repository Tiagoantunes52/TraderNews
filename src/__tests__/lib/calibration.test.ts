import { describe, it, expect } from "vitest";
import {
  selectGatedBook,
  roundTripCost,
  computeForwardReturns,
  nonOverlapping,
  effectiveSampleSize,
  bucketStats,
  isMonotonic,
  informationCoefficient,
  entrySignalEdge,
  effectiveBets,
  costBpsForStock,
  reliabilityDiagram,
  equityCurveReturns,
  portfolioMetrics,
  alphaBeta,
  evaluateGate,
  type EstimatePoint,
  type PricePoint,
  type Observation,
  type GateInput,
} from "@/lib/calibration";

function est(date: string, combinedScore: number, signal: string, extra: Partial<EstimatePoint> = {}): EstimatePoint {
  return {
    date,
    sentimentScore: extra.sentimentScore ?? combinedScore,
    quantScore: extra.quantScore ?? combinedScore,
    combinedScore,
    signal,
    confidence: extra.confidence ?? 0.5,
  };
}

const prices = (rows: [string, number][]): PricePoint[] => rows.map(([date, price]) => ({ date, price }));

describe("roundTripCost", () => {
  it("is a no-op at zero cost", () => {
    expect(roundTripCost(0.1, 0)).toBeCloseTo(0.1, 12);
  });
  it("subtracts roughly twice the per-side cost", () => {
    // 50 bps/side → a 0% gross trade loses ~1%
    expect(roundTripCost(0, 50)).toBeCloseTo(-0.00995, 4);
  });
  it("turns a thin positive edge negative", () => {
    expect(roundTripCost(0.005, 50)).toBeLessThan(0);
  });
});

describe("computeForwardReturns — T+1 anchoring", () => {
  const series = prices([
    ["2026-01-01", 100], // decision-day bar — must NOT be the entry
    ["2026-01-02", 110], // T+1 entry
    ["2026-01-03", 121], // exit at horizon 1
  ]);

  it("enters at the NEXT bar, never the signal's own bar", () => {
    const obs = computeForwardReturns("s1", [est("2026-01-01", 0.5, "BUY")], series, { horizonDays: 1 });
    expect(obs).toHaveLength(1);
    expect(obs[0].entryDate).toBe("2026-01-02");
    expect(obs[0].exitDate).toBe("2026-01-03");
    // 110 → 121 = +10%, not 100 → 110 (which would be the look-ahead bug)
    expect(obs[0].rawReturn).toBeCloseTo(0.1, 10);
  });

  it("drops estimates without enough forward bars to reach the exit", () => {
    const obs = computeForwardReturns("s1", [est("2026-01-02", 0.5, "BUY")], series, { horizonDays: 1 });
    // entry would be 2026-01-03 (last bar); no exit bar exists → dropped
    expect(obs).toHaveLength(0);
  });

  it("drops estimates with no future bar at all", () => {
    const obs = computeForwardReturns("s1", [est("2026-01-03", 0.5, "BUY")], series, { horizonDays: 1 });
    expect(obs).toHaveLength(0);
  });

  it("reports returns net of round-trip cost", () => {
    const gross = computeForwardReturns("s1", [est("2026-01-01", 0.5, "BUY")], series, { horizonDays: 1 });
    const net = computeForwardReturns("s1", [est("2026-01-01", 0.5, "BUY")], series, {
      horizonDays: 1,
      costBpsPerSide: 50,
    });
    expect(net[0].netReturn).toBeLessThan(gross[0].netReturn);
    expect(net[0].rawReturn).toBeCloseTo(gross[0].rawReturn, 12); // raw unchanged
  });
});

describe("nonOverlapping / effectiveSampleSize", () => {
  // 5 consecutive daily entries on one stock, horizon 3 → entries 3 bars apart.
  const series = prices(
    Array.from({ length: 10 }, (_, i) => [`2026-02-${String(i + 1).padStart(2, "0")}`, 100 + i] as [string, number])
  );
  const ests = [1, 2, 3, 4, 5].map((d) => est(`2026-02-0${d}`, 0.5, "BUY"));
  const obs = computeForwardReturns("s1", ests, series, { horizonDays: 3 });

  it("keeps only entries ≥ horizon apart", () => {
    const kept = nonOverlapping(obs, 3);
    // entryIndexes are consecutive; keep every 3rd → fewer than the overlapping set
    expect(kept.length).toBeLessThan(obs.length);
    const idx = kept.map((o) => o.entryIndex).sort((a, b) => a - b);
    for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBeGreaterThanOrEqual(3);
  });

  it("de-overlaps per stock independently", () => {
    const obs2 = computeForwardReturns("s2", ests, series, { horizonDays: 3 });
    const both = [...obs, ...obs2];
    expect(effectiveSampleSize(both, 3)).toBe(effectiveSampleSize(obs, 3) * 2);
  });
});

describe("bucketStats / isMonotonic", () => {
  // Hand-built observations: higher buckets → higher net returns.
  const mk = (signal: string, netReturn: number): Observation => ({
    stockId: "s",
    decisionDate: "2026-03-01",
    entryDate: "2026-03-02",
    exitDate: "2026-03-03",
    entryIndex: 0,
    rawReturn: netReturn,
    netReturn,
    signal,
    sentimentScore: 0,
    quantScore: 0,
    combinedScore: 0,
    confidence: 0.5,
  });

  it("computes per-bucket mean return and Wilson-bounded win-rate", () => {
    const obs = [mk("BUY", 0.05), mk("BUY", -0.01), mk("STRONG_SELL", -0.04)];
    const stats = bucketStats(obs);
    const buy = stats.find((s) => s.bucket === "BUY")!;
    expect(buy.count).toBe(2);
    expect(buy.meanReturn).toBeCloseTo(0.02, 10);
    expect(buy.winRate).toBeCloseTo(0.5, 10);
    expect(buy.winRateLo!).toBeLessThan(0.5);
    expect(buy.winRateHi!).toBeGreaterThan(0.5);
  });

  it("detects a monotone bullish gradient", () => {
    const obs = [
      mk("STRONG_SELL", -0.05),
      mk("SELL", -0.02),
      mk("NEUTRAL", 0.0),
      mk("BUY", 0.03),
      mk("STRONG_BUY", 0.06),
    ];
    expect(isMonotonic(bucketStats(obs))).toBe(true);
  });

  it("rejects a non-monotone gradient", () => {
    const obs = [mk("SELL", 0.05), mk("BUY", -0.02)]; // inverted
    expect(isMonotonic(bucketStats(obs))).toBe(false);
  });
});

describe("informationCoefficient", () => {
  const mk = (combined: number, quant: number | null, netReturn: number): Observation => ({
    stockId: "s",
    decisionDate: "2026-03-01",
    entryDate: "2026-03-02",
    exitDate: "2026-03-03",
    entryIndex: 0,
    rawReturn: netReturn,
    netReturn,
    signal: "BUY",
    sentimentScore: combined,
    quantScore: quant,
    combinedScore: combined,
    confidence: 0.5,
  });

  it("is +1 when higher score perfectly ranks higher return", () => {
    const obs = [mk(0.1, 0.1, 0.01), mk(0.2, 0.2, 0.02), mk(0.3, 0.3, 0.03), mk(0.4, 0.4, 0.04), mk(0.5, 0.5, 0.05)];
    expect(informationCoefficient(obs, "combinedScore")).toBeCloseTo(1, 10);
  });

  it("drops null scores before ranking", () => {
    const obs = [mk(0.1, null, 0.01), mk(0.2, 0.2, 0.02), mk(0.3, 0.3, 0.03), mk(0.4, 0.4, 0.04), mk(0.5, 0.5, 0.05), mk(0.6, 0.6, 0.06)];
    // quant has only 5 non-null rows, still ≥ minPairs → defined and positive
    expect(informationCoefficient(obs, "quantScore")).toBeCloseTo(1, 10);
  });

  it("returns null below minPairs", () => {
    expect(informationCoefficient([mk(0.1, 0.1, 0.01)], "combinedScore")).toBeNull();
  });
});

describe("entrySignalEdge", () => {
  const mk = (signal: string, netReturn: number): Observation => ({
    stockId: "s",
    decisionDate: "2026-03-01",
    entryDate: "2026-03-02",
    exitDate: "2026-03-03",
    entryIndex: 0,
    rawReturn: netReturn,
    netReturn,
    signal,
    sentimentScore: 0,
    quantScore: 0,
    combinedScore: 0,
    confidence: 0.5,
  });

  it("averages only the entry-signal (BUY/STRONG_BUY) trades", () => {
    const obs = [mk("BUY", 0.04), mk("STRONG_BUY", 0.06), mk("SELL", -0.99), mk("NEUTRAL", 0.5)];
    const e = entrySignalEdge(obs);
    expect(e.n).toBe(2);
    expect(e.meanNet).toBeCloseTo(0.05, 10);
    expect(e.tStat).not.toBeNull();
  });

  it("returns nulls when there are no entry signals", () => {
    const e = entrySignalEdge([mk("SELL", -0.02)]);
    expect(e.n).toBe(0);
    expect(e.meanNet).toBeNull();
    expect(e.tStat).toBeNull();
  });
});

describe("effectiveBets", () => {
  it("equals N when uncorrelated and 1 when perfectly correlated", () => {
    expect(effectiveBets(5, 0)).toBe(5);
    expect(effectiveBets(5, 1)).toBe(1);
  });
  it("shrinks with partial correlation", () => {
    expect(effectiveBets(4, 0.5)).toBeCloseTo(1.6, 10);
  });
  it("passes through trivial sizes", () => {
    expect(effectiveBets(1, 0.9)).toBe(1);
    expect(effectiveBets(0, 0.5)).toBe(0);
  });
});

describe("costBpsForStock", () => {
  it("uses the mid equity tier by default", () => {
    expect(costBpsForStock({})).toBe(20);
  });
  it("uses the liquid tier when flagged and the crypto tier for crypto", () => {
    expect(costBpsForStock({ isLiquid: true })).toBe(5);
    expect(costBpsForStock({ isCrypto: true })).toBe(40);
  });
  it("scales by ATR within [0.5×, 3×]", () => {
    expect(costBpsForStock({ atrPct: 4 })).toBe(20 * 2); // 4/2 = 2×
    expect(costBpsForStock({ atrPct: 0.1 })).toBe(20 * 0.5); // floored
    expect(costBpsForStock({ atrPct: 100 })).toBe(20 * 3); // capped
  });
});

describe("reliabilityDiagram", () => {
  const mk = (signal: string, confidence: number, netReturn: number): Observation => ({
    stockId: "s",
    decisionDate: "2026-03-01",
    entryDate: "2026-03-02",
    exitDate: "2026-03-03",
    entryIndex: 0,
    rawReturn: netReturn,
    netReturn,
    signal,
    sentimentScore: 0,
    quantScore: 0,
    combinedScore: 0,
    confidence,
  });

  it("excludes NEUTRAL and scores direction correctly", () => {
    const obs = [
      mk("BUY", 0.9, 0.05), // correct (up)
      mk("STRONG_SELL", 0.9, -0.05), // correct (down)
      mk("NEUTRAL", 0.9, 0.05), // excluded
    ];
    const r = reliabilityDiagram(obs);
    expect(r.n).toBe(2);
  });

  it("a perfectly-calibrated confident predictor beats the base rate", () => {
    // all high-confidence and all correct → low Brier, base rate also degenerate
    const obs = [
      mk("BUY", 0.9, 0.05),
      mk("BUY", 0.9, 0.04),
      mk("SELL", 0.9, -0.03),
      mk("SELL", 0.9, -0.02),
    ];
    const r = reliabilityDiagram(obs);
    expect(r.brier!).toBeLessThan(0.25);
  });

  it("places observations in the right bins", () => {
    const obs = [mk("BUY", 0.95, 0.01), mk("BUY", 1.0, 0.01)];
    const r = reliabilityDiagram(obs, 5);
    expect(r.bins[4].count).toBe(2); // top bin [0.8,1.0] inclusive of 1.0
  });
});

describe("equityCurveReturns / portfolioMetrics", () => {
  it("derives period returns", () => {
    expect(equityCurveReturns([100, 110, 99])).toEqual([
      expect.closeTo(0.1, 10),
      expect.closeTo(-0.1, 10),
    ]);
  });
  it("rolls up total return and drawdown", () => {
    const m = portfolioMetrics([100, 110, 99]);
    expect(m.totalReturn).toBeCloseTo(-0.01, 10);
    expect(m.maxDrawdown).toBeCloseTo(0.1, 10); // 110 → 99
    expect(m.days).toBe(3);
  });
});

describe("alphaBeta", () => {
  it("recovers beta and per-period alpha", () => {
    const bench = [0.01, -0.02, 0.03, 0.0, 0.015];
    const book = bench.map((b) => 2 * b + 0.001); // beta 2, alpha 0.1%/period
    const ab = alphaBeta(book, bench, 252)!;
    expect(ab.beta).toBeCloseTo(2, 8);
    expect(ab.alpha).toBeCloseTo(0.001, 8);
    expect(ab.alphaAnnualized).toBeCloseTo(0.001 * 252, 6);
  });
});

describe("evaluateGate", () => {
  const passing: GateInput = {
    monthsCoverage: 8,
    effectiveTrades: 40,
    hadSpyDrawdown: true,
    edgeMean: 0.02,
    edgeTStat: 2.5,
    alphaTStat: 2.5,
    maxDrawdown: 0.15,
    spyMaxDrawdown: 0.12,
    monotone: true,
    brier: 0.18,
    baseRateBrier: 0.25,
    survivesCostStress: true,
  };

  it("returns INSUFFICIENT_DATA below the coverage/trade floor regardless of metrics", () => {
    const r = evaluateGate({ ...passing, monthsCoverage: 2 });
    expect(r.status).toBe("INSUFFICIENT_DATA");
  });

  it("returns GO when every condition passes", () => {
    expect(evaluateGate(passing).status).toBe("GO");
  });

  it("returns NO_GO when a single condition fails", () => {
    expect(evaluateGate({ ...passing, monotone: false }).status).toBe("NO_GO");
  });

  it("treats an uncomputed (null) metric as not-yet-confirmed → NO_GO", () => {
    const r = evaluateGate({ ...passing, alphaTStat: null });
    expect(r.status).toBe("NO_GO");
  });
});

describe("selectGatedBook() — what the go-live gate certifies", () => {
  it("certifies the broker's book whenever there is one", () => {
    expect(selectGatedBook({ liveSnapshots: 24, rmSnapshots: 21 })).toEqual({ book: "ALPACA", isLive: true });
  });

  it("does NOT fall back to the flattering sim book on a short live history", () => {
    // Judged as the short live record it is, and failed on coverage — the sim never
    // paid a spread or missed a fill, so it cannot stand in for real execution.
    expect(selectGatedBook({ liveSnapshots: 2, rmSnapshots: 500 }).isLive).toBe(true);
  });

  it("uses a sim book only before any broker history exists", () => {
    expect(selectGatedBook({ liveSnapshots: 1, rmSnapshots: 21 })).toEqual({
      book: "SIM_COMBINED_RM",
      isLive: false,
    });
    expect(selectGatedBook({ liveSnapshots: 0, rmSnapshots: 0 })).toEqual({
      book: "SIM_COMBINED",
      isLive: false,
    });
  });
});
