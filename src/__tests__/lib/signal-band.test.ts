import { describe, it, expect } from "vitest";
import { bandExcess, bandVerdict, evaluateBand, ENTRY_BANDS, type BandStat } from "@/lib/signal-band";
import { MIN_ENTRY_OBSERVATIONS, MIN_SESSIONS, type Observation } from "@/lib/signal-health";

const session = (n: number) => `2026-01-${String(n).padStart(2, "0")}`;

/** One observation with a chosen SENTIMENT score and forward return. */
function obs(sess: string, id: string, score: number, forwardReturn: number): Observation {
  return {
    session: sess,
    stockId: id,
    scores: { SENTIMENT: score, QUANT: null, COMBINED: null },
    forwardReturn,
  };
}

/** `sessions` sessions, each holding one name per (score, return) pair given. */
function corpus(sessions: number, names: { score: number; ret: number }[]): Observation[] {
  const out: Observation[] = [];
  for (let i = 1; i <= sessions; i++) {
    names.forEach((n, j) => out.push(obs(session(i), `s${j}`, n.score, n.ret)));
  }
  return out;
}

describe("bandExcess()", () => {
  it("measures against the whole universe, not just the band", () => {
    // Universe mean is 5%: the 10% name and the 0% name. A band holding only the good
    // one is +5% excess — and would look like 0 if the benchmark narrowed with the band.
    const rows = corpus(30, [
      { score: 0.9, ret: 0.1 }, // STRONG_BUY
      { score: 0.0, ret: 0.0 }, // NEUTRAL
    ]);
    const stat = bandExcess(rows, "SENTIMENT", ["STRONG_BUY"], "x");
    expect(stat.meanExcessBps).toBeCloseTo(500, 6);
    expect(stat.n).toBe(30);
    expect(stat.sessions).toBe(30);
  });

  it("keeps the benchmark fixed as the band narrows", () => {
    const rows = corpus(30, [
      { score: 0.9, ret: 0.1 },
      { score: 0.3, ret: 0.04 },
      { score: 0.0, ret: 0.01 },
    ]);
    const wide = bandExcess(rows, "SENTIMENT", ["BUY", "STRONG_BUY"], "wide");
    const narrow = bandExcess(rows, "SENTIMENT", ["STRONG_BUY"], "narrow");
    // Universe mean is 5%: wide averages 10% and 4% → +2pp; narrow is 10% → +5pp.
    expect(wide.meanExcessBps).toBeCloseTo(200, 6);
    expect(narrow.meanExcessBps).toBeCloseTo(500, 6);
  });

  it("reproduces the lead this tool exists to test: dropping a bad top bucket lifts the band", () => {
    // STRONG_BUY loses, BUY wins, and the pooled band lands between them.
    const rows = corpus(40, [
      { score: 0.9, ret: -0.02 },
      { score: 0.3, ret: 0.03 },
      { score: 0.0, ret: 0.005 },
    ]);
    const current = bandExcess(rows, "SENTIMENT", ["BUY", "STRONG_BUY"], "current");
    const dropped = bandExcess(rows, "SENTIMENT", ["BUY"], "dropped");
    expect(dropped.meanExcessBps).toBeGreaterThan(current.meanExcessBps);
    expect(current.meanExcessBps).toBeLessThan(0);
    expect(dropped.meanExcessBps).toBeGreaterThan(0);
  });

  it("counts sessions, not observations, for significance", () => {
    // 50 names on ONE session is one piece of evidence, not fifty. The t-stat is
    // computed across sessions, so a single session cannot produce one at all.
    const many = Array.from({ length: 50 }, (_, j) => obs(session(1), `s${j}`, 0.9, 0.05));
    const stat = bandExcess([...many, obs(session(1), "u", 0.0, 0.0)], "SENTIMENT", ["STRONG_BUY"], "x");
    expect(stat.n).toBe(50);
    expect(stat.sessions).toBe(1);
    expect(stat.tStat).toBeNull();
  });

  it("ignores a source the observation has no score for", () => {
    const rows = corpus(30, [{ score: 0.9, ret: 0.1 }]);
    expect(bandExcess(rows, "QUANT", ["STRONG_BUY"], "x").n).toBe(0);
  });
});

describe("bandVerdict() — the bar is beating the universe, not reaching it", () => {
  const stat = (bps: number, t: number | null): BandStat => ({
    label: "p",
    n: MIN_ENTRY_OBSERVATIONS,
    sessions: MIN_SESSIONS,
    meanExcessBps: bps,
    tStat: t,
  });
  const folds = (positive: number, total = 4) =>
    Array.from({ length: total }, (_, i) => stat(i < positive ? 5 : -5, 1));

  it("BEATS only when the holdout is positive and clears the noise floor", () => {
    expect(bandVerdict(stat(20, 3), stat(15, 3), folds(4), 4)).toBe("BEATS");
  });

  it("MATCHES a positive holdout that cannot clear the floor — not a pass", () => {
    // This is the band that reaches the universe and stops there. Reporting it as a win
    // is how a concentrated book gets justified on a return you could have had for free.
    expect(bandVerdict(stat(20, 3), stat(8, 0.9), folds(4), 4)).toBe("MATCHES");
  });

  it("LAGS whenever the holdout is negative, however good the train period looked", () => {
    expect(bandVerdict(stat(40, 4), stat(-1, -0.2), folds(4), 4)).toBe("LAGS");
  });

  it("MATCHES when the folds do not corroborate", () => {
    expect(bandVerdict(stat(20, 3), stat(15, 3), folds(1), 4)).toBe("MATCHES");
  });

  it("raises the bar as more bands are tried", () => {
    expect(bandVerdict(stat(20, 3), stat(15, 2.4), folds(4), 4)).toBe("BEATS");
    expect(bandVerdict(stat(20, 3), stat(15, 2.4), folds(4), 200)).toBe("MATCHES");
  });

  it("refuses to judge a thin sample", () => {
    const thin = { ...stat(20, 3), sessions: MIN_SESSIONS - 1 };
    expect(bandVerdict(stat(20, 3), thin, folds(4), 4)).toBe("INSUFFICIENT");
  });
});

describe("ENTRY_BANDS", () => {
  it("registers exactly one incumbent, which is never judged", () => {
    const incumbents = ENTRY_BANDS.filter((b) => b.incumbent);
    expect(incumbents).toHaveLength(1);
    expect(incumbents[0].buckets).toEqual(["BUY", "STRONG_BUY"]);
  });

  it("gives every band a distinct id and a hypothesis", () => {
    expect(new Set(ENTRY_BANDS.map((b) => b.id)).size).toBe(ENTRY_BANDS.length);
    for (const b of ENTRY_BANDS) expect(b.hypothesis.length).toBeGreaterThan(20);
  });

  it("reports the incumbent rather than grading it", () => {
    const rows = corpus(30, [{ score: 0.9, ret: 0.1 }, { score: 0.0, ret: 0.0 }]);
    const report = evaluateBand({
      band: ENTRY_BANDS.find((b) => b.incumbent)!,
      source: "SENTIMENT",
      all: rows,
      train: rows,
      holdout: rows,
      folds: [],
      k: 4,
    });
    expect(report.verdict).toBe("INCUMBENT");
  });
});
