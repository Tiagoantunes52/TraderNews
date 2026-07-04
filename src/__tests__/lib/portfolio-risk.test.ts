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
