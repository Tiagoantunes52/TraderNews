import { describe, it, expect } from "vitest";
import {
  simulate,
  pairedDifference,
  policyVerdict,
  controlOk,
  buildSimRows,
  MIN_PAIRED_SESSIONS,
  type Policy,
  type SimRow,
  type PairedStat,
} from "@/lib/portfolio-sim";
import { P0_INCUMBENT, P1_REPLACE, P2_TOPN, PA_ARRIVAL, SLOTS } from "@/lib/portfolio-sim-policies";
import { DEFAULT_RISK_CONFIG } from "@/lib/paper-trading";
import type { Candidate, FeatureRow } from "@/lib/signal-research";

const session = (n: number) => `2026-01-${String(n).padStart(2, "0")}`;

function row(over: Partial<SimRow> & { session: string; ticker: string }): SimRow {
  const base = { score: 0.5 as number | null, holdReturn: 0, ...over };
  // Unspecified entry return means the entry was free — the same return as holding.
  // Defaulting it to 0 would silently zero out the first session of every position.
  return { entryReturn: base.holdReturn, ...base };
}

/** N sessions of the same two names, so a policy's choice is the only moving part. */
function corpus(
  sessions: number,
  names: { ticker: string; score: number; holdReturn: number; entryReturn?: number | null }[]
): SimRow[] {
  const out: SimRow[] = [];
  for (let i = 1; i <= sessions; i++) {
    for (const n of names) {
      out.push(row({ session: session(i), ticker: n.ticker, score: n.score, holdReturn: n.holdReturn, entryReturn: n.entryReturn ?? n.holdReturn }));
    }
  }
  return out;
}

/** Takes the top `slots` by score every session — the simplest policy to reason about. */
const topN: Policy = { ...P2_TOPN, id: "test-topN", slots: 2 };

describe("simulate() — the return model", () => {
  it("earns nothing and holds nothing when no name clears the entry deadband", () => {
    const rows = corpus(3, [{ ticker: "AAA", score: -0.9, holdReturn: 0.05 }]);
    const res = simulate(rows, P0_INCUMBENT);
    expect(res.sessions.every((s) => s.held === 0)).toBe(true);
    expect(res.sessions.every((s) => s.ret === 0)).toBe(true);
    // Flat while the universe rose 5% a session: the excess is the full negative.
    expect(res.sessions[0].excess).toBeCloseTo(-0.05, 10);
  });

  it("prices an entry at the entry return and every session after at the hold return", () => {
    // Entry costs 1%, holding earns 3% — so session 1 must show the entry, not the hold.
    const rows = corpus(3, [{ ticker: "AAA", score: 0.9, holdReturn: 0.03, entryReturn: 0.01 }]);
    const res = simulate(rows, topN);
    expect(res.sessions[0].ret).toBeCloseTo(0.01, 10);
    expect(res.sessions[1].ret).toBeCloseTo(0.03, 10);
    expect(res.sessions[2].ret).toBeCloseTo(0.03, 10);
  });

  it("measures excess against the whole universe, including names it cannot score", () => {
    const rows = [
      row({ session: session(1), ticker: "AAA", score: 0.9, holdReturn: 0.1 }),
      row({ session: session(1), ticker: "BBB", score: null, holdReturn: 0.0 }),
    ];
    // Universe mean is 5% across both names; the book holds only the 10% one.
    const res = simulate(rows, topN);
    expect(res.sessions[0].ret).toBeCloseTo(0.1, 10);
    expect(res.sessions[0].excess).toBeCloseTo(0.05, 10);
  });

  it("cannot enter a name the frame says never filled, but can keep holding one", () => {
    const rows = [
      // Enterable on the first session, unfillable on the second while still held.
      row({ session: session(1), ticker: "AAA", score: 0.9, holdReturn: 0.02, entryReturn: 0.02 }),
      row({ session: session(2), ticker: "AAA", score: 0.9, holdReturn: 0.02, entryReturn: null }),
      row({ session: session(1), ticker: "BBB", score: 0.8, holdReturn: 0.01, entryReturn: null }),
      row({ session: session(2), ticker: "BBB", score: 0.8, holdReturn: 0.01, entryReturn: null }),
    ];
    const res = simulate(rows, topN);
    expect(res.sessions[0].held).toBe(1); // BBB never fillable → never entered
    expect(res.sessions[1].held).toBe(1); // AAA still held despite being unfillable now
  });

  it("force-drops a holding the corpus stops carrying rather than holding it at zero", () => {
    const rows = [
      row({ session: session(1), ticker: "AAA", score: 0.9, holdReturn: 0.02 }),
      row({ session: session(2), ticker: "BBB", score: 0.9, holdReturn: 0.04 }),
    ];
    const res = simulate(rows, topN);
    expect(res.sessions[0].held).toBe(1);
    expect(res.sessions[1].dropped).toBe(1);
    expect(res.sessions[1].ret).toBeCloseTo(0.04, 10); // BBB only — AAA is gone, not held flat
  });

  it("never exceeds its slot count", () => {
    const names = Array.from({ length: 30 }, (_, i) => ({
      ticker: `T${String(i).padStart(2, "0")}`,
      score: 0.9,
      holdReturn: 0.01,
    }));
    const res = simulate(corpus(5, names), P0_INCUMBENT);
    expect(Math.max(...res.sessions.map((s) => s.held))).toBe(SLOTS);
    expect(res.slotUse).toBeCloseTo(1, 6);
  });
});

describe("simulate() — the exit ladder P0 can express", () => {
  const cfg = DEFAULT_RISK_CONFIG;

  it("exits on confirmed bearish reads, but not before the minimum hold", () => {
    // Bullish once to enter, bearish forever after. minHoldRuns suppresses the early exit.
    const rows: SimRow[] = [row({ session: session(1), ticker: "AAA", score: 0.9, holdReturn: 0 })];
    for (let i = 2; i <= 10; i++) rows.push(row({ session: session(i), ticker: "AAA", score: -0.9, holdReturn: 0 }));
    const res = simulate(rows, P0_INCUMBENT);
    const exit = res.sessions.findIndex((s) => s.held === 0);
    expect(exit).toBeGreaterThanOrEqual(cfg.minHoldRuns);
    expect(res.sessions[exit - 1].held).toBe(1);
  });

  it("time-stops a position that goes nowhere", () => {
    const rows = corpus(cfg.timeStopRuns + 5, [{ ticker: "AAA", score: 0.9, holdReturn: 0 }]);
    const res = simulate(rows, P0_INCUMBENT);
    // Dead flat, so the time stop is the only rung that can fire — and it must.
    // Entered on session 1, it has been held timeStopRuns sessions when the session
    // after that opens — which is the session the stop fires on.
    const firstExit = res.sessions.findIndex((s) => s.held === 0);
    expect(firstExit).toBe(cfg.timeStopRuns);
    // Still bullish, so the next session buys it straight back: the ladder exits a
    // position, it does not blacklist a name.
    expect(res.sessions[firstExit + 1].held).toBe(1);
  });

  it("does not time-stop a position that is well clear of the dead band", () => {
    const rows = corpus(cfg.timeStopRuns + 5, [{ ticker: "AAA", score: 0.9, holdReturn: 0.01 }]);
    const res = simulate(rows, P0_INCUMBENT);
    expect(res.sessions.at(-1)!.held).toBe(1);
  });
});

describe("policy comparison — the thing under test", () => {
  const oneSlot = (p: Policy): Policy => ({ ...p, slots: 1 });

  // AAA is alphabetically first and worse, ZZZ is better, and there is one slot — so
  // somebody has to be left out. The whole hypothesis in miniature.
  const names = [
    { ticker: "AAA", score: 0.3, holdReturn: 0.0 },
    { ticker: "ZZZ", score: 0.9, holdReturn: 0.02 },
  ];

  it("fills arrival-order under the pre-ranking counterfactual", () => {
    const res = simulate(corpus(4, names), oneSlot(PA_ARRIVAL));
    expect(res.sessions[0].ret).toBeCloseTo(0.0, 10);
    expect(res.sessions[0].excess).toBeCloseTo(-0.01, 10);
  });

  it("fills best-first under the incumbent", () => {
    const res = simulate(corpus(4, names), oneSlot(P0_INCUMBENT));
    expect(res.sessions[0].ret).toBeCloseTo(0.02, 10);
    expect(res.turnover).toBeCloseTo(0.25, 10); // one entry across four sessions
  });

  /**
   * Force the worse name into the book — the better one is unfillable on session 1 — so
   * that what these tests measure afterwards is eviction alone, not fill order. Without
   * it the ranking policies simply buy the better name outright and never swap.
   */
  const forcedInto = (better: { score: number; holdReturn: number }): SimRow[] => {
    const rows: SimRow[] = [
      row({ session: session(1), ticker: "AAA", score: 0.9, holdReturn: 0.0 }),
      row({ session: session(1), ticker: "ZZZ", score: 0.8, holdReturn: better.holdReturn, entryReturn: null }),
    ];
    for (let i = 2; i <= 8; i++) {
      rows.push(row({ session: session(i), ticker: "AAA", score: 0.5, holdReturn: 0.0 }));
      rows.push(row({ session: session(i), ticker: "ZZZ", score: better.score, holdReturn: better.holdReturn }));
    }
    return rows;
  };

  it("evicts the worse holding once a candidate clears the margin", () => {
    // Held at 0.5 against an incoming 0.9: a 0.4 gap, comfortably over REPLACE_MARGIN.
    const res = simulate(forcedInto({ score: 0.9, holdReturn: 0.02 }), oneSlot(P1_REPLACE));
    expect(res.sessions[0].ret).toBeCloseTo(0.0, 10); // forced into AAA
    expect(res.sessions.at(-1)!.ret).toBeCloseTo(0.02, 10); // swapped into ZZZ
    expect(res.turnover).toBeGreaterThan(0.1);
  });

  it("holds the swap back when the gap is inside the margin", () => {
    // Held at 0.5 against an incoming 0.55: rank noise, not a reason to pay the spread.
    const res = simulate(forcedInto({ score: 0.55, holdReturn: 0.02 }), oneSlot(P1_REPLACE));
    expect(res.sessions.at(-1)!.ret).toBeCloseTo(0.0, 10);
  });

  it("never evicts under the incumbent, however wide the gap", () => {
    const res = simulate(forcedInto({ score: 0.9, holdReturn: 0.02 }), oneSlot(P0_INCUMBENT));
    expect(res.sessions.at(-1)!.ret).toBeCloseTo(0.0, 10);
  });
});

describe("pairedDifference()", () => {
  const sim = (id: string, excesses: number[]) => ({
    policyId: id,
    sessions: excesses.map((excess, i) => ({ session: session(i + 1), ret: excess, excess, held: 1, added: 0, dropped: 0 })),
    turnover: 0,
    avgHold: 0,
    slotUse: 1,
  });

  it("reports a flat difference as zero with no wins", () => {
    const stat = pairedDifference(sim("a", [0.01, 0.02, 0.03]), sim("b", [0.01, 0.02, 0.03]), "x");
    expect(stat.meanDiffBps).toBeCloseTo(0, 10);
    expect(stat.winRate).toBe(0);
    expect(stat.sessions).toBe(3);
  });

  it("measures the difference in basis points, not the levels", () => {
    // Both policies ride the same big market; only the 10 bps gap should survive.
    const stat = pairedDifference(sim("a", [0.101, 0.201]), sim("b", [0.1, 0.2]), "x");
    expect(stat.meanDiffBps).toBeCloseTo(10, 6);
    expect(stat.winRate).toBe(1);
  });

  it("pairs only on sessions both policies traded", () => {
    const a = sim("a", [0.01, 0.02, 0.03]);
    const b = sim("b", [0.01, 0.02]);
    expect(pairedDifference(a, b, "x").sessions).toBe(2);
  });
});

describe("policyVerdict() — the pre-registered decision rule", () => {
  const stat = (bps: number, tStat: number | null, sessions = 500): PairedStat => ({
    label: "p",
    sessions,
    meanDiffBps: bps,
    tStat,
    winRate: 0.5,
  });
  const folds = (positive: number, total = 4) =>
    Array.from({ length: total }, (_, i) => stat(i < positive ? 5 : -5, 1));

  it("passes only when train, holdout and the folds all agree and t clears the floor", () => {
    expect(policyVerdict(stat(8, 3), stat(6, 3), folds(4), 3)).toBe("PASSES");
  });

  it("is WEAK when the sign holds but the t-stat does not clear the noise floor", () => {
    expect(policyVerdict(stat(8, 3), stat(6, 1.4), folds(4), 3)).toBe("WEAK");
  });

  it("fails when the holdout disagrees with the train period", () => {
    expect(policyVerdict(stat(8, 3), stat(-6, -3), folds(4), 3)).toBe("FAILS");
  });

  it("fails when the folds do not corroborate", () => {
    expect(policyVerdict(stat(8, 3), stat(6, 3), folds(2), 3)).toBe("FAILS");
  });

  it("refuses to judge too few sessions", () => {
    expect(policyVerdict(stat(8, 3, MIN_PAIRED_SESSIONS - 1), stat(6, 3), folds(4), 3)).toBe("INSUFFICIENT");
  });

  it("raises the bar as more policies are tried", () => {
    // t = 2.4 clears the floor at k=3 and not at k=200: the same result, judged against
    // how many chances it had. sqrt(2 ln 200) ≈ 3.26.
    expect(policyVerdict(stat(8, 3), stat(6, 2.4), folds(4), 3)).toBe("PASSES");
    expect(policyVerdict(stat(8, 3), stat(6, 2.4), folds(4), 200)).toBe("WEAK");
  });
});

describe("controlOk() — the plumbing assertion", () => {
  it("passes when a perfect score beats the incumbent by a wide margin", () => {
    expect(controlOk(900, 5).ok).toBe(true);
  });

  it("fails when the simulator cannot tell a perfect score from the incumbent", () => {
    const res = controlOk(12, 5);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("needs");
  });
});

describe("buildSimRows()", () => {
  const feature = (over: Partial<FeatureRow> = {}): FeatureRow =>
    ({
      stockId: "s1",
      ticker: "AAA",
      session: session(1),
      close: 100,
      forward: { h1: 0.03, h5: 0.05, h10: 0.1 },
      forwardExec: { h1: 0.01, h5: 0.03, h10: 0.08 },
      fillPrice: null,
      ...over,
    }) as FeatureRow;

  const scoreOnly: Candidate = { id: "c", hypothesis: "h", score: () => 0.42 };

  it("takes the hold return from the close frame and the entry return from the chosen frame", () => {
    const [r] = buildSimRows([feature()], scoreOnly, "exec");
    expect(r.holdReturn).toBeCloseTo(0.03, 10);
    expect(r.entryReturn).toBeCloseTo(0.01, 10);
    expect(r.score).toBe(0.42);
  });

  it("marks a row unenterable when the frame has no fill for it", () => {
    const [r] = buildSimRows([feature()], scoreOnly, "fill");
    expect(r.entryReturn).toBeNull();
    expect(r.holdReturn).toBeCloseTo(0.03, 10); // still counts toward the universe
  });

  it("keeps an unscored row so the universe benchmark is not rebased", () => {
    const unscorable: Candidate = { id: "c", hypothesis: "h", score: () => null };
    const [r] = buildSimRows([feature()], unscorable, "exec");
    expect(r.score).toBeNull();
    expect(r.holdReturn).toBeCloseTo(0.03, 10);
  });

  it("lets the oracle read the return it is supposed to predict, in the frame being traded", () => {
    const oracle: Candidate = { id: "oracle", hypothesis: "h", oracle: true, control: true, score: () => null };
    const [r] = buildSimRows([feature()], oracle, "exec");
    expect(r.score).toBeCloseTo(0.01, 10);
  });
});
