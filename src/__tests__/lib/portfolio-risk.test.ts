import { describe, it, expect } from "vitest";
import {
  DEFAULT_RISK_LIMITS,
  riskLimits,
  isRiskLimitsEnabled,
  isCryptoTicker,
  CRYPTO_CLUSTER,
  pairCorrelation,
  correlationClusters,
  clusterKeyFor,
  currentDrawdown,
  deriskMultiplier,
  evaluateBuy,
  rankEntryCandidates,
  maxAllowedNotional,
  regimeMultiplier,
  type BookExposure,
  type RiskLimits,
} from "@/lib/portfolio-risk";

describe("riskLimits() env reader", () => {
  it("returns the defaults when no env is set", () => {
    expect(riskLimits()).toEqual(DEFAULT_RISK_LIMITS);
  });
  it("respects an explicit 0 override (not silently defaulted)", () => {
    process.env.PAPER_MAX_CLUSTER_POSITIONS = "0";
    expect(riskLimits().maxClusterPositions).toBe(0);
    delete process.env.PAPER_MAX_CLUSTER_POSITIONS;
  });
  it("is disabled by default and enabled by PAPER_RISK_LIMITS=1", () => {
    expect(isRiskLimitsEnabled()).toBe(false);
    process.env.PAPER_RISK_LIMITS = "1";
    expect(isRiskLimitsEnabled()).toBe(true);
    delete process.env.PAPER_RISK_LIMITS;
  });
});

describe("isCryptoTicker", () => {
  it("detects the -USD convention", () => {
    expect(isCryptoTicker("BTC-USD")).toBe(true);
    expect(isCryptoTicker("AAPL")).toBe(false);
  });
});

describe("pairCorrelation", () => {
  it("aligns two series on shared dates and returns Pearson r", () => {
    const a = new Map([
      ["d1", 0.01],
      ["d2", 0.02],
      ["d3", -0.01],
      ["d4", 0.03],
      ["d5", 0.0],
    ]);
    const b = new Map([
      ["d1", 0.02],
      ["d2", 0.04],
      ["d3", -0.02],
      ["d4", 0.06],
      ["d5", 0.0],
    ]);
    expect(pairCorrelation(a, b)!).toBeCloseTo(1, 5); // perfectly proportional
  });
  it("returns null when the shared overlap is below minPairs", () => {
    const a = new Map([
      ["d1", 0.01],
      ["d2", 0.02],
    ]);
    const b = new Map([
      ["d1", 0.01],
      ["d9", 0.02],
    ]);
    expect(pairCorrelation(a, b, 5)).toBeNull();
  });
});

describe("correlationClusters", () => {
  // Two perfectly-correlated equities + one anti/independent + crypto.
  const dates = ["d1", "d2", "d3", "d4", "d5", "d6"];
  const series = (vals: number[]) => new Map(dates.map((d, i) => [d, vals[i]]));

  it("groups correlated equities, isolates the uncorrelated, buckets crypto", () => {
    const returns = new Map<string, Map<string, number>>([
      ["AAA", series([0.01, 0.02, -0.01, 0.03, 0.0, 0.015])],
      ["BBB", series([0.02, 0.04, -0.02, 0.06, 0.0, 0.03])], // 2× AAA → r=1
      ["ZZZ", series([-0.03, 0.05, 0.01, -0.04, 0.02, -0.01])], // unrelated
      ["BTC-USD", series([0.1, -0.2, 0.05, 0.0, 0.07, -0.03])],
      ["ETH-USD", series([0.09, -0.18, 0.04, 0.01, 0.06, -0.02])],
    ]);
    const clusters = correlationClusters(returns, { threshold: 0.7 });

    // AAA + BBB share a cluster; ZZZ is its own.
    expect(clusters.get("AAA")).toBe(clusters.get("BBB"));
    expect(clusters.get("ZZZ")).not.toBe(clusters.get("AAA"));
    // Deterministic id = lexicographically smallest member.
    expect(clusters.get("AAA")).toBe("AAA");
    // All crypto collapses into the single CRYPTO bucket regardless of correlation.
    expect(clusters.get("BTC-USD")).toBe(CRYPTO_CLUSTER);
    expect(clusters.get("ETH-USD")).toBe(CRYPTO_CLUSTER);
  });

  it("clusterKeyFor falls back to the crypto bucket / own ticker when unknown", () => {
    const clusters = new Map<string, string>([["AAA", "AAA"]]);
    expect(clusterKeyFor("AAA", clusters)).toBe("AAA");
    expect(clusterKeyFor("DOGE-USD", clusters)).toBe(CRYPTO_CLUSTER);
    expect(clusterKeyFor("MSFT", clusters)).toBe("MSFT"); // singleton fallback
  });
});

describe("currentDrawdown", () => {
  it("is 0 at a fresh high and positive after a dip", () => {
    expect(currentDrawdown([100, 110, 120])).toBe(0);
    expect(currentDrawdown([100, 120, 90])).toBeCloseTo(0.25, 5); // (120-90)/120
  });
  it("handles empty / degenerate curves", () => {
    expect(currentDrawdown([])).toBe(0);
    expect(currentDrawdown([0, 0])).toBe(0);
  });
});

describe("deriskMultiplier", () => {
  const limits: RiskLimits = { ...DEFAULT_RISK_LIMITS, deriskStartDrawdownPct: 0.1, killSwitchDrawdownPct: 0.2 };
  it("is full below the start, ramps linearly, and 0 at/above the kill-switch", () => {
    expect(deriskMultiplier(0.05, limits)).toBe(1);
    expect(deriskMultiplier(0.1, limits)).toBe(1);
    expect(deriskMultiplier(0.15, limits)).toBeCloseTo(0.5, 5); // halfway
    expect(deriskMultiplier(0.2, limits)).toBe(0);
    expect(deriskMultiplier(0.3, limits)).toBe(0);
  });
});

describe("maxAllowedNotional", () => {
  const limits = DEFAULT_RISK_LIMITS;
  const book = (over: Partial<BookExposure> = {}): BookExposure => ({
    equity: 100_000,
    peakEquity: 100_000,
    positions: [],
    ...over,
  });

  it("passes a request that already fits, unchanged", () => {
    expect(maxAllowedNotional(book(), { cluster: "AAA", notional: 1000 }, limits)).toBe(1000);
  });

  it("clamps to gross headroom instead of refusing", () => {
    // 95% of 100k = 95k cap; 94.5k deployed leaves 500 of the 1000 asked.
    const b = book({ positions: [{ cluster: "ZZZ", notional: 94_500 }] });
    expect(maxAllowedNotional(b, { cluster: "AAA", notional: 1000 }, limits)).toBe(500);
  });

  it("clamps to the per-name cap", () => {
    // maxPositionPct 0.15 → 15k ceiling on any single name.
    expect(maxAllowedNotional(book(), { cluster: "AAA", notional: 20_000 }, limits)).toBe(15_000);
  });

  it("clamps to cluster headroom", () => {
    // maxClusterPct 0.4 → 40k per cluster; 38k already there leaves 2k.
    const b = book({ positions: [{ cluster: "AAA", notional: 38_000 }] });
    expect(maxAllowedNotional(b, { cluster: "AAA", notional: 10_000 }, limits)).toBe(2000);
  });

  it("refuses outright on the kill-switch — no size is acceptable", () => {
    const b = book({ equity: 70_000, peakEquity: 100_000 }); // 30% dd vs 20% limit
    expect(maxAllowedNotional(b, { cluster: "AAA", notional: 100 }, limits)).toBe(0);
  });

  it("refuses outright at the position cap", () => {
    const b = book({ positions: Array.from({ length: limits.maxPositions }, (_, i) => ({ cluster: `C${i}`, notional: 10 })) });
    expect(maxAllowedNotional(b, { cluster: "AAA", notional: 100 }, limits)).toBe(0);
  });

  it("refuses outright at the per-cluster name cap", () => {
    const b = book({
      positions: Array.from({ length: limits.maxClusterPositions }, () => ({ cluster: "AAA", notional: 10 })),
    });
    expect(maxAllowedNotional(b, { cluster: "AAA", notional: 100 }, limits)).toBe(0);
  });

  it("never exceeds what was asked for", () => {
    expect(maxAllowedNotional(book(), { cluster: "AAA", notional: 5 }, limits)).toBe(5);
  });

  it("agrees with evaluateBuy on whether anything is allowed at all", () => {
    // The clamp must not admit a trade the binary gate would refuse outright.
    const cases: BookExposure[] = [
      book(),
      book({ equity: 70_000, peakEquity: 100_000 }),
      book({ positions: Array.from({ length: limits.maxPositions }, (_, i) => ({ cluster: `C${i}`, notional: 10 })) }),
    ];
    for (const b of cases) {
      const candidate = { cluster: "AAA", notional: 1000 };
      const binary = evaluateBuy(b, candidate, limits).allowed;
      expect(maxAllowedNotional(b, candidate, limits) > 0).toBe(binary);
    }
  });
});

describe("evaluateBuy gate", () => {
  const limits = DEFAULT_RISK_LIMITS;
  const base = (over: Partial<BookExposure> = {}): BookExposure => ({
    equity: 100_000,
    peakEquity: 100_000,
    positions: [],
    ...over,
  });

  it("allows a normal first buy", () => {
    expect(evaluateBuy(base(), { cluster: "AAA", notional: 1000 }, limits)).toEqual({ allowed: true, reason: null });
  });

  it("blocks all buys when the drawdown kill-switch has tripped", () => {
    const book = base({ equity: 79_000, peakEquity: 100_000 }); // 21% drawdown > 20%
    expect(evaluateBuy(book, { cluster: "AAA", notional: 100 }, limits)).toEqual({
      allowed: false,
      reason: "KILL_SWITCH",
    });
  });

  it("blocks once gross exposure would exceed the cap", () => {
    const book = base({ positions: [{ cluster: "X", notional: 94_000 }] }); // 94% deployed
    expect(evaluateBuy(book, { cluster: "Y", notional: 2_000 }, limits).reason).toBe("GROSS_CAP");
  });

  it("de-risks the gross cap as drawdown deepens (blocks below the static cap)", () => {
    // 12% drawdown → derisk multiplier ~0.67 of the 95% cap ≈ 63% allowed.
    const book = base({ equity: 88_000, peakEquity: 100_000, positions: [{ cluster: "X", notional: 60_000 }] });
    expect(evaluateBuy(book, { cluster: "Y", notional: 5_000 }, limits).reason).toBe("GROSS_CAP");
  });

  it("blocks at the position-count cap", () => {
    const positions = Array.from({ length: 12 }, (_, i) => ({ cluster: `C${i}`, notional: 10 }));
    expect(evaluateBuy(base({ positions }), { cluster: "NEW", notional: 10 }, limits).reason).toBe("MAX_POSITIONS");
  });

  it("blocks a single name that is too large", () => {
    expect(evaluateBuy(base(), { cluster: "AAA", notional: 20_000 }, limits).reason).toBe("PER_NAME_CAP"); // 20% > 15%
  });

  it("blocks when a correlation cluster would exceed its notional cap", () => {
    // Cluster already at 38% of equity; +5% would breach the 40% cluster cap.
    const book = base({ positions: [{ cluster: "TECH", notional: 38_000 }] });
    expect(evaluateBuy(book, { cluster: "TECH", notional: 5_000 }, limits).reason).toBe("CLUSTER_CAP");
  });

  it("treats the crypto sleeve as one cluster bucket", () => {
    const book = base({
      positions: [
        { cluster: CRYPTO_CLUSTER, notional: 20_000 },
        { cluster: CRYPTO_CLUSTER, notional: 18_000 },
      ],
    });
    expect(evaluateBuy(book, { cluster: CRYPTO_CLUSTER, notional: 5_000 }, limits).reason).toBe("CLUSTER_CAP");
  });

  it("blocks at the per-cluster name-count cap", () => {
    const positions = Array.from({ length: 5 }, (_, i) => ({ cluster: "TECH", notional: 1_000 + i }));
    expect(evaluateBuy(base({ positions }), { cluster: "TECH", notional: 100 }, limits).reason).toBe(
      "MAX_CLUSTER_POSITIONS"
    );
  });

  it("rejects non-positive equity / notional defensively", () => {
    expect(evaluateBuy(base({ equity: 0 }), { cluster: "A", notional: 10 }, limits).allowed).toBe(false);
    expect(evaluateBuy(base(), { cluster: "A", notional: 0 }, limits).allowed).toBe(false);
  });
});

describe("regimeMultiplier() — SPY regime filter (issue #58)", () => {
  it("is risk-on (1) while SPY holds at or above its MA", () => {
    expect(regimeMultiplier(500, 480, 0.5)).toBe(1);
    expect(regimeMultiplier(480, 480, 0.5)).toBe(1);
  });

  it("scales to the risk-off fraction below the MA", () => {
    expect(regimeMultiplier(450, 480, 0.5)).toBe(0.5);
    expect(regimeMultiplier(450, 480, 0)).toBe(0); // full halt variant
  });

  it("never tightens on missing data (no price / no MA / degenerate MA)", () => {
    expect(regimeMultiplier(null, 480, 0.5)).toBe(1);
    expect(regimeMultiplier(500, null, 0.5)).toBe(1);
    expect(regimeMultiplier(500, 0, 0.5)).toBe(1);
  });

  it("scales the gross cap inside evaluateBuy", () => {
    // Equity 100k, cap 95%. Deployed 40k + 10k candidate = 50k: fine risk-on,
    // but risk-off at 0.5 the cap is 47.5k → blocked on GROSS_CAP.
    const book = { equity: 100_000, peakEquity: 100_000, positions: [{ cluster: "A", notional: 40_000 }] };
    const candidate = { cluster: "B", notional: 10_000 };
    expect(evaluateBuy(book, candidate, DEFAULT_RISK_LIMITS, 1).allowed).toBe(true);
    expect(evaluateBuy(book, candidate, DEFAULT_RISK_LIMITS, 0.5)).toEqual({ allowed: false, reason: "GROSS_CAP" });
  });
});

describe("rankEntryCandidates() — who gets the scarce slots", () => {
  const c = (ticker: string, score: number, confidence = 0.5) => ({ ticker, score, confidence });

  it("orders by score, strongest first", () => {
    const ranked = rankEntryCandidates([c("LOW", 0.21), c("HIGH", 0.88), c("MID", 0.55)]);
    expect(ranked.map((r) => r.ticker)).toEqual(["HIGH", "MID", "LOW"]);
  });

  it("breaks score ties on confidence, then ticker", () => {
    const ranked = rankEntryCandidates([
      c("ZZZ", 0.5, 0.4),
      c("BBB", 0.5, 0.9),
      c("AAA", 0.5, 0.4),
    ]);
    expect(ranked.map((r) => r.ticker)).toEqual(["BBB", "AAA", "ZZZ"]);
  });

  it("is deterministic — same input, same order, whatever the arrival sequence", () => {
    const rows = [c("A", 0.3, 0.5), c("B", 0.3, 0.5), c("C", 0.9, 0.1), c("D", 0.3, 0.7)];
    const forward = rankEntryCandidates(rows).map((r) => r.ticker);
    const reversed = rankEntryCandidates([...rows].reverse()).map((r) => r.ticker);
    expect(forward).toEqual(["C", "D", "A", "B"]);
    expect(reversed).toEqual(forward);
  });

  it("stays a total order when a score isn't finite", () => {
    // A NaN score makes `b - a` return NaN; a NaN comparator result makes the sort
    // order implementation-defined, which would break run-log replay determinism.
    const rows = [
      { ticker: "NAN", score: Number.NaN, confidence: 0.9 },
      { ticker: "GOOD", score: 0.4, confidence: 0.5 },
      { ticker: "INF", score: Number.POSITIVE_INFINITY, confidence: 0.5 },
      { ticker: "BEST", score: 0.8, confidence: 0.5 },
    ];
    const ranked = rankEntryCandidates(rows).map((r) => r.ticker);
    expect(ranked.slice(0, 2)).toEqual(["BEST", "GOOD"]); // finite scores rank first, in order
    expect(ranked.slice(2).sort()).toEqual(["INF", "NAN"]); // non-finite sink, never win a slot
    expect(rankEntryCandidates([...rows].reverse()).map((r) => r.ticker).slice(0, 2)).toEqual(["BEST", "GOOD"]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [c("LOW", 0.1), c("HIGH", 0.9)];
    rankEntryCandidates(rows);
    expect(rows.map((r) => r.ticker)).toEqual(["LOW", "HIGH"]);
  });

  it("keeps each book's candidates ordered when several books share a list", () => {
    // Scores only compare within a book; the gate is per-book, so all that matters is
    // that a book's own candidates stay in descending order after a single global sort.
    const mixed = [
      { ticker: "Q1", score: 0.2, confidence: 0.5, book: "QUANT_RM" },
      { ticker: "S1", score: 0.9, confidence: 0.5, book: "SENTIMENT_RM" },
      { ticker: "Q2", score: 0.7, confidence: 0.5, book: "QUANT_RM" },
      { ticker: "S2", score: 0.4, confidence: 0.5, book: "SENTIMENT_RM" },
    ];
    const ranked = rankEntryCandidates(mixed);
    const perBook = (b: string) => ranked.filter((r) => r.book === b).map((r) => r.ticker);
    expect(perBook("QUANT_RM")).toEqual(["Q2", "Q1"]);
    expect(perBook("SENTIMENT_RM")).toEqual(["S1", "S2"]);
  });

  it("hands the last slot to the best candidate, not the first to arrive", () => {
    // One slot left (11 of 12 taken). Arrival order would have given it to WEAK.
    const book: BookExposure = {
      equity: 100_000,
      peakEquity: 100_000,
      positions: Array.from({ length: 11 }, (_, i) => ({ cluster: `C${i}`, notional: 1_000 })),
    };
    const candidates = [c("WEAK", 0.12), c("STRONG", 0.91)];
    const admitted: string[] = [];
    for (const cand of rankEntryCandidates(candidates)) {
      const entry = { cluster: cand.ticker, notional: 1_000 };
      if (evaluateBuy(book, entry, DEFAULT_RISK_LIMITS).allowed) {
        book.positions.push(entry);
        admitted.push(cand.ticker);
      }
    }
    expect(admitted).toEqual(["STRONG"]);
  });
});
