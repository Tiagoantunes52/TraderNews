import { describe, it, expect } from "vitest";
import { buildResearchBrief, marginalCost } from "@/lib/research-brief";
import { EMPTY_LEDGER, recordRuns, noiseFloorFor, type RunRecord } from "@/lib/research-ledger";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  kind: "candidate",
  id: "h1",
  control: false,
  horizon: 5,
  frame: "close",
  split: "2025-01-01",
  verdict: "FAILS",
  ...over,
});

const registered = [
  { id: "h1", hypothesis: "Momentum over 30 days beats 7." },
  { id: "oracle", hypothesis: "The forward return itself.", control: true },
];

const brief = (ledger = EMPTY_LEDGER) => buildResearchBrief({ ledger, registered, today: "2026-08-31" });

describe("marginalCost()", () => {
  it("prices what one more specification does to the bar", () => {
    const cost = marginalCost(21);
    expect(cost.current).toBeCloseTo(noiseFloorFor(21), 10);
    expect(cost.next).toBeCloseTo(noiseFloorFor(22), 10);
    expect(cost.next).toBeGreaterThan(cost.current);
  });

  it("never drops below the conventional floor at small k", () => {
    expect(marginalCost(0).current).toBe(2);
    expect(marginalCost(1).current).toBe(2);
  });
});

describe("buildResearchBrief()", () => {
  it("states the bar the proposer has to clear", () => {
    const l = recordRuns(EMPTY_LEDGER, [run(), run({ horizon: 10 }), run({ frame: "fill" })], "2026-08-31");
    const text = brief(l);
    expect(text).toContain("3 candidate specifications");
    expect(text).toContain(noiseFloorFor(3).toFixed(2));
    expect(text).toContain(noiseFloorFor(4).toFixed(2));
  });

  it("lists what has been tried, with the hypothesis and last verdict", () => {
    const text = brief(recordRuns(EMPTY_LEDGER, [run()], "2026-08-31"));
    expect(text).toContain("`h1`");
    expect(text).toContain("FAILS");
    expect(text).toContain("Momentum over 30 days beats 7.");
  });

  it("marks controls so they are not mistaken for hypotheses", () => {
    const text = brief(recordRuns(EMPTY_LEDGER, [run({ id: "oracle", control: true })], "2026-08-31"));
    expect(text).toContain("(control)");
  });

  it("names a ledger id that is no longer in the variants file", () => {
    // A candidate deleted from the code still counts toward k, so the proposer has to be
    // told it existed — otherwise it re-proposes something already spent.
    const text = brief(recordRuns(EMPTY_LEDGER, [run({ id: "deleted-one" })], "2026-08-31"));
    expect(text).toContain("not in the current variants file");
  });

  it("says so plainly when nothing has been tried", () => {
    expect(brief()).toContain("first specification against this corpus");
  });

  it("offers abstention first and calls it correct by default", () => {
    const text = brief();
    expect(text).toContain("ABSTAIN");
    expect(text.indexOf("Abstain")).toBeLessThan(text.indexOf("Propose one candidate"));
  });

  it("states the constraints that keep a candidate from reading the answer", () => {
    const text = brief();
    expect(text).toContain("oracle");
    expect(text).toContain("forwardExec");
    expect(text).toContain("pure");
  });

  it("forbids touching what the app trades on", () => {
    expect(brief()).toContain("src/lib/pipeline/");
  });
});
