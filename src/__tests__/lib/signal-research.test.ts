import { describe, it, expect } from "vitest";
import {
  buildFeatures,
  classifyMarketRegime,
  regimeOf,
  DEFAULT_REGIME_BOUNDARIES,
  excessBySession,
  noiseThreshold,
  evaluatePeriod,
  splitFixed,
  splitRolling,
  verdictFor,
  controlsOk,
  frameReturn,
  WARMUP_BARS,
  HORIZONS,
  type Bar,
  type Candidate,
  type FeatureRow,
  type PeriodStats,
  type FoldStat,
  type CandidateReport,
} from "@/lib/signal-research";
import { ALL_CANDIDATES, CANDIDATES, ORACLE, quantTerms, blend } from "@/lib/signal-research-variants";
import { signalHealth, type Observation as HealthObservation } from "@/lib/signal-health";
import { spearman } from "@/lib/stats";

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Sessions as a dense sortable sequence; the values need only be ordered keys. */
const session = (i: number) => `2020-01-01+${String(i).padStart(4, "0")}`;

function makeBars(
  stockId: string,
  ticker: string,
  closes: number[],
  opts: { range?: number; volume?: number } = {}
): Bar[] {
  const range = opts.range ?? 2;
  return closes.map((close, i) => ({
    stockId,
    ticker,
    session: session(i),
    open: close,
    high: close + range,
    low: close - range,
    close,
    volume: opts.volume ?? 1_000,
  }));
}

/** A bare FeatureRow for tests that exercise the statistics rather than the indicators. */
function mkRow(sess: string, stockId: string, close: number, h5: number): FeatureRow {
  return {
    stockId, ticker: stockId, session: sess, close,
    sma20: null, rsi14: null, atr14: null, adx14: null, macdHist: null, bollPctB: null,
    vol30: null, volRatio10: null, change7d: null, change30d: null, relStr7d: null,
    marketRegime: "UNCLASSIFIED",
    benchClose: null, benchSma20: null, benchRsi14: null, benchAdx14: null,
    forward: { h1: h5, h5, h10: h5 },
    forwardExec: { h1: h5, h5, h10: h5 }, fillPrice: close,
  };
}

/** Long enough that WARMUP_BARS + maxHorizon leaves real rows behind. */
const LEN = WARMUP_BARS + Math.max(...HORIZONS) + 40;

/** A universe of `n` names plus SPY, each on its own deterministic price path. */
function universe(n = 4, len = LEN): Bar[] {
  const out: Bar[] = [];
  for (let s = 0; s < n; s++) {
    const closes = Array.from({ length: len }, (_, i) => 100 + s * 10 + Math.sin((i + s) / 4) * 5 + i * (0.2 + s * 0.1));
    out.push(...makeBars(`s${s}`, `T${s}`, closes, { volume: 1000 + s * 100 }));
  }
  out.push(...makeBars("spy", "SPY", Array.from({ length: len }, (_, i) => 400 + i * 0.5)));
  return out;
}

// ── buildFeatures ────────────────────────────────────────────────────────────

describe("buildFeatures()", () => {
  it("excludes the benchmark from the candidate universe", () => {
    expect(buildFeatures(universe()).some((f) => f.ticker === "SPY")).toBe(false);
  });

  it("emits nothing until the warm-up has passed", () => {
    const rows = buildFeatures(universe());
    const earliest = rows.map((f) => f.session).sort()[0];
    expect(earliest).toBe(session(WARMUP_BARS));
    // And every emitted row has a usable ADX — that is what WARMUP_BARS is sized for.
    expect(rows.every((f) => f.adx14 != null)).toBe(true);
  });

  it("drops sessions whose longest horizon has not fully elapsed", () => {
    const rows = buildFeatures(universe());
    const latest = rows.map((f) => f.session).sort().reverse()[0];
    expect(latest).toBe(session(LEN - 1 - Math.max(...HORIZONS)));
    expect(rows.every((f) => HORIZONS.every((h) => Number.isFinite(f.forward[`h${h}`])))).toBe(true);
  });

  it("indexes forward returns by SESSION POSITION, not calendar arithmetic", () => {
    // A stock whose sessions skip days: position i+5 is what matters, not date + 5.
    const closes = Array.from({ length: LEN }, (_, i) => (i === WARMUP_BARS + 5 ? 200 : 100));
    const bars = makeBars("s1", "T1", closes).map((b, i) => ({
      ...b,
      session: `2020-${String(Math.floor(i / 20) + 1).padStart(2, "0")}-${String((i % 20) + 1).padStart(2, "0")}`,
    }));
    const spy = makeBars("spy", "SPY", Array(LEN).fill(400)).map((b, i) => ({
      ...b,
      session: `2020-${String(Math.floor(i / 20) + 1).padStart(2, "0")}-${String((i % 20) + 1).padStart(2, "0")}`,
    }));
    const row = buildFeatures([...bars, ...spy]).find((f) => f.session === bars[WARMUP_BARS].session)!;
    expect(row.forward.h5).toBeCloseTo(1.0, 10); // 100 → 200, five POSITIONS later
  });

  it("computes relStr7d against the benchmark, and leaves it null without one", () => {
    const withSpy = buildFeatures(universe());
    expect(withSpy.every((f) => f.relStr7d != null)).toBe(true);

    const noSpy = buildFeatures(universe().filter((b) => b.ticker !== "SPY"));
    expect(noSpy.length).toBeGreaterThan(0);
    expect(noSpy.every((f) => f.relStr7d == null)).toBe(true);
    // change7d still resolves — only the benchmark-relative leg is unknown.
    expect(noSpy.every((f) => f.change7d != null)).toBe(true);
  });

  it("labels every row with the market regime taken from the benchmark", () => {
    const rows = buildFeatures(universe());
    const bySession = new Map<string, Set<string>>();
    for (const f of rows) {
      const s = bySession.get(f.session) ?? new Set();
      s.add(f.marketRegime);
      bySession.set(f.session, s);
    }
    // Market-wide means one regime per session, whatever the individual names did.
    expect([...bySession.values()].every((s) => s.size === 1)).toBe(true);
  });

  // ── the two structural tests ───────────────────────────────────────────────

  it("is deterministic — identical input yields byte-identical output", () => {
    const bars = universe();
    expect(JSON.stringify(buildFeatures(bars))).toBe(JSON.stringify(buildFeatures(bars)));
  });

  it("is deterministic regardless of input row order", () => {
    const bars = universe();
    const shuffled = [...bars].reverse();
    expect(JSON.stringify(buildFeatures(shuffled))).toBe(JSON.stringify(buildFeatures(bars)));
  });

  it("NO LOOK-AHEAD: truncating the future cannot change the past", () => {
    // The highest-value test here. Run the full calendar, then cut every stock's bars
    // after D and re-run; every row up to D must be byte-identical. Mechanically proves
    // nothing leaks backwards through ADX warm-up, the regime series or the SPY join —
    // no amount of reading the code proves that as well as this does.
    const bars = universe();
    const cut = session(WARMUP_BARS + 20);

    const full = buildFeatures(bars).filter((f) => f.session <= cut);
    const truncated = buildFeatures(bars.filter((b) => b.session <= addSessions(cut, Math.max(...HORIZONS))));

    expect(truncated.length).toBeGreaterThan(0);
    expect(JSON.stringify(truncated)).toBe(JSON.stringify(full));
  });
});

/** Advance a `session(i)` key by n positions — fixture helper, mirrors `session()`. */
function addSessions(s: string, n: number): string {
  return session(Number(s.split("+")[1]) + n);
}

// ── classifyMarketRegime ─────────────────────────────────────────────────────

describe("classifyMarketRegime()", () => {
  it("splits a strong trend by which side of the MA price sits", () => {
    expect(classifyMarketRegime(30, 110, 100, 55)).toBe("TREND_BULL");
    expect(classifyMarketRegime(30, 90, 100, 45)).toBe("TREND_BEAR");
  });

  it("calls a quiet, un-extended tape mean-reverting", () => {
    expect(classifyMarketRegime(15, 100, 100, 50)).toBe("MEAN_REVERTING");
  });

  it("leaves the 20-25 gap UNCLASSIFIED rather than inventing a rule", () => {
    expect(classifyMarketRegime(22, 110, 100, 55)).toBe("UNCLASSIFIED");
  });

  it("does not call a quiet tape mean-reverting when RSI is at an extreme", () => {
    expect(classifyMarketRegime(15, 100, 100, 80)).toBe("UNCLASSIFIED");
    expect(classifyMarketRegime(15, 100, 100, 20)).toBe("UNCLASSIFIED");
  });

  it("is UNCLASSIFIED when any input is missing — never a default regime", () => {
    expect(classifyMarketRegime(null, 110, 100, 55)).toBe("UNCLASSIFIED");
    expect(classifyMarketRegime(30, 110, null, 55)).toBe("UNCLASSIFIED");
    expect(classifyMarketRegime(30, 110, 100, null)).toBe("UNCLASSIFIED");
  });

  it("honours fitted boundaries instead of the textbook ones", () => {
    // ADX 22 is UNCLASSIFIED under the shipped 25 cut and a trend under a fitted 20 cut.
    expect(classifyMarketRegime(22, 110, 100, 55)).toBe("UNCLASSIFIED");
    expect(classifyMarketRegime(22, 110, 100, 55, { adxTrend: 20, adxCalm: 20, rsiLo: 40, rsiHi: 60 })).toBe("TREND_BULL");
  });

  it("defaults to DEFAULT_REGIME_BOUNDARIES when none are passed", () => {
    expect(classifyMarketRegime(30, 110, 100, 55)).toBe(
      classifyMarketRegime(30, 110, 100, 55, DEFAULT_REGIME_BOUNDARIES)
    );
  });
});

// ── regimeOf ─────────────────────────────────────────────────────────────────

describe("regimeOf()", () => {
  const row = { benchAdx14: 22, benchClose: 110, benchSma20: 100, benchRsi14: 55 };

  it("re-classifies a built row under different boundaries", () => {
    expect(regimeOf(row, DEFAULT_REGIME_BOUNDARIES)).toBe("UNCLASSIFIED");
    expect(regimeOf(row, { adxTrend: 20, adxCalm: 20, rsiLo: 40, rsiHi: 60 })).toBe("TREND_BULL");
  });

  it("is UNCLASSIFIED for a row with no benchmark reading", () => {
    expect(regimeOf({ benchAdx14: null, benchClose: null, benchSma20: null, benchRsi14: null }, DEFAULT_REGIME_BOUNDARIES)).toBe(
      "UNCLASSIFIED"
    );
  });

  it("agrees with the label buildFeatures stored, on the default boundaries", () => {
    const rows = buildFeatures(universe(12));
    expect(rows.every((f) => regimeOf(f, DEFAULT_REGIME_BOUNDARIES) === f.marketRegime)).toBe(true);
  });
});

// ── excessBySession ──────────────────────────────────────────────────────────

describe("excessBySession()", () => {
  it("subtracts the universe mean of the same session", () => {
    const rows = [
      { session: "d1", r: 0.02 },
      { session: "d1", r: 0.0 },
      { session: "d2", r: 0.1 },
    ];
    const ex = excessBySession(rows, (x) => x.r);
    expect(ex.get(rows[0])).toBeCloseTo(0.01, 10);
    expect(ex.get(rows[1])).toBeCloseTo(-0.01, 10);
    expect(ex.get(rows[2])).toBeCloseTo(0, 10); // alone on its session
  });

  it("shows a losing signal as negative excess even when the raw return is positive", () => {
    const rows = [
      { session: "d1", r: 0.01 }, // the "entry"
      { session: "d1", r: 0.05 },
      { session: "d1", r: 0.05 },
    ];
    expect(excessBySession(rows, (x) => x.r).get(rows[0])!).toBeLessThan(0);
  });

  // Guards against the two implementations drifting — see the note in signal-research.ts.
  it("agrees with signal-health's excess on a shared fixture", () => {
    const obs: HealthObservation[] = [
      { session: "d1", stockId: "a", scores: { SENTIMENT: null, QUANT: 0.4, COMBINED: null }, forwardReturn: 0.02 },
      { session: "d1", stockId: "b", scores: { SENTIMENT: null, QUANT: 0.0, COMBINED: null }, forwardReturn: 0.0 },
      { session: "d2", stockId: "a", scores: { SENTIMENT: null, QUANT: 0.4, COMBINED: null }, forwardReturn: 0.06 },
      { session: "d2", stockId: "b", scores: { SENTIMENT: null, QUANT: 0.0, COMBINED: null }, forwardReturn: 0.0 },
    ];
    const health = signalHealth(obs).find((h) => h.source === "QUANT")!;

    const ex = excessBySession(obs, (o) => o.forwardReturn);
    const entries = obs.filter((o) => o.scores.QUANT === 0.4).map((o) => ex.get(o)!);
    const mine = entries.reduce((a, b) => a + b, 0) / entries.length;

    expect(mine).toBeCloseTo(health.entry.meanExcess, 12);
  });
});

// ── evaluate / splits / verdicts ─────────────────────────────────────────────

describe("evaluatePeriod()", () => {
  // 12 names so every session clears MIN_NAMES_PER_SESSION.
  const features = buildFeatures(universe(12));

  it("the oracle control returns IC exactly 1.0000", () => {
    // The self-check that makes a null result believable: if the plumbing that joins
    // scores to forward returns is wrong, this is the number that says so.
    const s = evaluatePeriod("all", features, ORACLE, 5);
    expect(s.crossSectional.mean!).toBeCloseTo(1, 12);
  });

  it("a constant score yields no IC — nothing to rank", () => {
    const flat: Candidate = { id: "flat", hypothesis: "x", score: () => 0.5 };
    expect(evaluatePeriod("all", features, flat, 5).crossSectional.mean).toBeNull();
  });

  it("drops rows whose score is null rather than treating them as zero", () => {
    // Half the names score null; a harness that coerced them to 0 would keep all rows
    // AND silently rank them mid-pack, which is the quiet way to poison a result.
    const half: Candidate = {
      id: "half", hypothesis: "x",
      score: (f) => (Number(f.stockId.slice(1)) % 2 === 0 ? f.close : null),
    };
    const s = evaluatePeriod("all", features, half, 5);
    expect(s.observations).toBeCloseTo(features.length / 2, -1);
    expect(s.observations).toBeLessThan(features.length);
    expect(s.observations).toBeGreaterThan(0);
  });

  it("computes cross-sectional and time-series IC over different groupings", () => {
    const s = evaluatePeriod("all", features, ORACLE, 5);
    expect(s.crossSectional.groups).toBe(s.sessions);
    expect(s.timeSeries.groups).toBeLessThanOrEqual(12);
    expect(s.timeSeries.groups).toBeGreaterThan(0);
  });

  it("DAILY IC DIFFERS FROM POOLED IC — the methodological fix is actually applied", () => {
    // Two sessions of 10 names. WITHIN each session the score ranks returns perfectly,
    // so the daily IC is +1. POOLED, the session-level offset dominates: the higher
    // scores all sit on the day the whole market fell, so the pooled rank correlation
    // is strongly NEGATIVE. Anyone who "simplifies" this to one pooled spearman — the
    // exact thing calibration.ts's informationCoefficient does — fails this test.
    const rows: FeatureRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(mkRow("d1", `n${i}`, 1 + i, 0.001 * i));
      rows.push(mkRow("d2", `n${i}`, 11 + i, -0.05 + 0.001 * i));
    }
    const cand: Candidate = { id: "c", hypothesis: "x", score: (f) => f.close };
    const s = evaluatePeriod("t", rows, cand, 5);
    const pooled = spearman(rows.map((r) => r.close), rows.map((r) => r.forward.h5))!;

    expect(s.crossSectional.mean!).toBeCloseTo(1, 10);
    expect(pooled).toBeLessThan(0);
  });
});

describe("splitFixed() / splitRolling()", () => {
  const features = buildFeatures(universe(4));

  it("splits strictly before the date into train", () => {
    const cut = features[Math.floor(features.length / 2)].session;
    const { train, holdout } = splitFixed(features, cut);
    expect(train.every((f) => f.session < cut)).toBe(true);
    expect(holdout.every((f) => f.session >= cut)).toBe(true);
    expect(train.length + holdout.length).toBe(features.length);
  });

  it("makes contiguous, ordered folds — a time series must not be shuffled", () => {
    const folds = splitRolling(features, 4);
    expect(folds).toHaveLength(4);
    for (let i = 1; i < folds.length; i++) {
      const prevMax = Math.max(...folds[i - 1].rows.map((f) => f.session.localeCompare(folds[i].rows[0].session)));
      expect(prevMax).toBeLessThan(0); // every prior-fold session precedes this fold's first
    }
    expect(folds.reduce((n, f) => n + f.rows.length, 0)).toBe(features.length);
  });

  it("splits on sessions, not rows, so folds span equal calendar", () => {
    const folds = splitRolling(features, 4);
    const counts = folds.map((f) => new Set(f.rows.map((r) => r.session)).size);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("returns nothing when there are fewer sessions than folds", () => {
    expect(splitRolling(features.slice(0, 2), 10)).toEqual([]);
  });
});

describe("verdictFor()", () => {
  const period = (mean: number | null, tStat: number | null, groups = 100): PeriodStats =>
    ({
      label: "x", sessions: groups, observations: groups * 10,
      crossSectional: { mean, tStat, groups },
      timeSeries: { mean: null, tStat: null, groups: 0 },
      entry: { n: 0, meanExcess: 0, tStat: null },
      buckets: [], monotonic: false, entryFillRate: null, byRegime: [],
    }) as PeriodStats;
  const fold = (mean: number): FoldStat => ({ label: "f", ic: { mean, tStat: 1, groups: 10 } });

  it("FAILS on a sign flip — actively wrong is worse than no edge", () => {
    expect(verdictFor(period(0.01, 2), period(-0.02, -2.3), [])).toBe("FAILS");
  });

  it("PASSES when the holdout is significant, same-signed, and folds agree", () => {
    expect(verdictFor(period(0.02, 2.5), period(0.018, 2.4), [fold(0.01), fold(0.02), fold(0.01), fold(-0.001)])).toBe("PASSES");
  });

  it("is WEAK when the sign holds but the holdout is not significant", () => {
    expect(verdictFor(period(0.02, 2.5), period(0.004, 0.4), [])).toBe("WEAK");
  });

  it("is WEAK when the holdout is significant but the folds disagree", () => {
    expect(verdictFor(period(0.02, 2.5), period(0.018, 2.4), [fold(-0.01), fold(-0.02), fold(0.01), fold(-0.001)])).toBe("WEAK");
  });

  it("is INSUFFICIENT when a period could not be scored", () => {
    expect(verdictFor(period(null, null, 0), period(0.01, 2), [])).toBe("INSUFFICIENT");
  });
});

describe("controlsOk()", () => {
  const rep = (id: string, trainIc: number, trainT: number, holdIc: number): CandidateReport =>
    ({
      id, hypothesis: "x", horizon: 5,
      train: { crossSectional: { mean: trainIc, tStat: trainT, groups: 100 } },
      holdout: { crossSectional: { mean: holdIc, tStat: 1, groups: 100 } },
      folds: [], verdict: "WEAK",
    }) as unknown as CandidateReport;

  it("passes when the oracle is exactly 1 and mom30 detects its known effect", () => {
    expect(controlsOk([rep("oracle", 1, 99, 1), rep("mom30", 0.022, 2.6, 0.019)]).ok).toBe(true);
  });

  it("fails loudly when the oracle is not exactly 1", () => {
    const r = controlsOk([rep("oracle", 0.98, 99, 1)]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("≠ 1.000000");
  });

  it("fails when mom30 stops detecting a known effect", () => {
    const r = controlsOk([rep("oracle", 1, 99, 1), rep("mom30", 0.001, 0.2, 0.0)]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("known effect is not being detected");
  });
});

describe("pre-registered variants", () => {
  it("reconstructs calcQuantScore exactly — proving quantTerms has not drifted", () => {
    // `quantTerms` duplicates the shipped composite so a variant can swap one leg.
    // Rebuilding the baseline from it must reproduce calcQuantScore to the last bit,
    // or every hypothesis built on it is measuring something else.
    const features = buildFeatures(universe(12));
    const baseline = CANDIDATES.find((c) => c.id === "baseline")!;
    let compared = 0;
    for (const f of features) {
      const t = quantTerms(f);
      const rebuilt = blend(t, t.damp);
      const shipped = baseline.score(f);
      if (rebuilt == null || shipped == null) continue;
      expect(rebuilt).toBeCloseTo(shipped, 12);
      compared++;
    }
    expect(compared).toBeGreaterThan(100);
  });

  it("keeps candidate ids unique and every hypothesis non-empty", () => {
    const ids = ALL_CANDIDATES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ALL_CANDIDATES.every((c) => c.hypothesis.trim().length > 20)).toBe(true);
  });

  it("marks exactly one candidate as able to read the forward return", () => {
    expect(ALL_CANDIDATES.filter((c) => c.oracle).map((c) => c.id)).toEqual(["oracle"]);
  });
});

// ── noiseThreshold ───────────────────────────────────────────────────────────

describe("noiseThreshold()", () => {
  it("is zero for a single candidate — nothing was selected over anything", () => {
    expect(noiseThreshold(1)).toBe(0);
  });

  it("grows with the number of candidates tried", () => {
    expect(noiseThreshold(6)).toBeGreaterThan(noiseThreshold(2));
    expect(noiseThreshold(30)).toBeGreaterThan(noiseThreshold(6));
  });

  it("puts a best-of-six |t| of 2.0 barely above noise", () => {
    expect(noiseThreshold(6)).toBeCloseTo(1.8930, 3);
  });
});

describe("executable frame", () => {
  const flat = () => Array(75).fill(100);

  it("computes frameReturn per frame, with the fill endpoint on the close frame's answer", () => {
    const row = mkRow(session(0), "A", 100, 0.1); // close 100, forward 10%, fillPrice 100
    row.forwardExec = { h1: 0.05, h5: 0.05, h10: 0.05 };
    row.fillPrice = 102;
    expect(frameReturn(row, 5, "close")).toBeCloseTo(0.1, 10);
    expect(frameReturn(row, 5, "exec")).toBeCloseTo(0.05, 10);
    // endpoint = 100 × 1.1 = 110; fill at 102 → (110-102)/102
    expect(frameReturn(row, 5, "fill")).toBeCloseTo((110 - 102) / 102, 10);
    row.fillPrice = null;
    expect(frameReturn(row, 5, "fill")).toBeNull();
    row.forwardExec = null;
    expect(frameReturn(row, 5, "exec")).toBeNull();
  });

  it("buildFeatures fills at the open when it opens inside the buffer", () => {
    const bars = makeBars("A", "A", flat(), { range: 0.5 });
    bars[WARMUP_BARS + 1].open = 101; // limit = 102
    const rows = buildFeatures(bars);
    const first = rows.find((r) => r.session === session(WARMUP_BARS))!;
    expect(first.fillPrice).toBe(101);
    expect(first.forwardExec!.h5).toBeCloseTo((100 - 101) / 101, 10);
  });

  it("fills at the limit when the low trades through it intraday", () => {
    const bars = makeBars("B", "B", flat(), { range: 0.5 });
    bars[WARMUP_BARS + 1].open = 105;
    bars[WARMUP_BARS + 1].low = 101.5;
    const rows = buildFeatures(bars);
    const first = rows.find((r) => r.session === session(WARMUP_BARS))!;
    expect(first.fillPrice).toBeCloseTo(102, 10);
  });

  it("records a miss when the name gaps past the buffer and never comes back", () => {
    const bars = makeBars("C", "C", flat(), { range: 0.5 });
    bars[WARMUP_BARS + 1].open = 106;
    bars[WARMUP_BARS + 1].low = 103;
    const rows = buildFeatures(bars);
    const first = rows.find((r) => r.session === session(WARMUP_BARS))!;
    expect(first.fillPrice).toBeNull();
    // The executable frame still exists — a market order at the open always fills.
    expect(first.forwardExec!.h5).toBeCloseTo((100 - 106) / 106, 10);
  });

  it("evaluatePeriod's fill frame drops misses and reports the entry fill rate", () => {
    const rows = [
      mkRow(session(0), "A", 100, 0.02),
      mkRow(session(0), "B", 100, 0.02),
      mkRow(session(0), "C", 100, 0.02),
      mkRow(session(0), "D", 100, 0.02),
    ];
    rows[0].fillPrice = null; // one miss among four BUY-scored names
    const candidate: Candidate = { id: "c", hypothesis: "t", score: () => 0.5 };
    const stats = evaluatePeriod("x", rows, candidate, 5, "fill");
    expect(stats.observations).toBe(3);
    expect(stats.entryFillRate).toBeCloseTo(0.75, 10);
    const close = evaluatePeriod("x", rows, candidate, 5, "close");
    expect(close.observations).toBe(4);
    expect(close.entryFillRate).toBeNull();
  });
});
