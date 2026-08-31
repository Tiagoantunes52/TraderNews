import { describe, it, expect } from "vitest";
import {
  EMPTY_LEDGER,
  specOf,
  recordRuns,
  effectiveK,
  splitDrift,
  reportK,
  parseLedger,
  serializeLedger,
  formatLedgerNote,
  LEDGER_VERSION,
  type RunRecord,
} from "@/lib/research-ledger";

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

const DAY1 = "2026-08-31";
const DAY2 = "2026-09-07";

describe("specOf()", () => {
  it("scopes a candidate by horizon and frame", () => {
    expect(specOf(run())).toBe("h1@h5/close");
  });

  it("scopes a policy by frame only — policies are not horizon-scoped", () => {
    expect(specOf(run({ kind: "policy", id: "P1-replace", horizon: undefined, frame: "fill" }))).toBe("P1-replace@fill");
  });
});

describe("recordRuns()", () => {
  it("counts a new specification once", () => {
    const l = recordRuns(EMPTY_LEDGER, [run()], DAY1);
    expect(l.entries).toHaveLength(1);
    expect(l.entries[0]).toMatchObject({ spec: "h1@h5/close", runs: 1, firstRun: DAY1, lastRun: DAY1 });
    expect(effectiveK(l, "candidate")).toBe(1);
  });

  it("does not widen the search when the same spec is re-run", () => {
    // Re-running after a bug fix is the same hypothesis asked twice, not a second
    // chance at a false positive.
    const once = recordRuns(EMPTY_LEDGER, [run()], DAY1);
    const twice = recordRuns(once, [run({ verdict: "WEAK" })], DAY2);
    expect(effectiveK(twice, "candidate")).toBe(1);
    expect(twice.entries[0]).toMatchObject({ runs: 2, firstRun: DAY1, lastRun: DAY2, lastVerdict: "WEAK" });
  });

  it("counts the same candidate at a different horizon as a second look", () => {
    const l = recordRuns(EMPTY_LEDGER, [run(), run({ horizon: 10 })], DAY1);
    expect(effectiveK(l, "candidate")).toBe(2);
  });

  it("counts the same candidate in a different frame as a second look", () => {
    const l = recordRuns(EMPTY_LEDGER, [run(), run({ frame: "fill" })], DAY1);
    expect(effectiveK(l, "candidate")).toBe(2);
  });

  it("records controls but never counts them toward k", () => {
    const l = recordRuns(EMPTY_LEDGER, [run(), run({ id: "oracle", control: true })], DAY1);
    expect(l.entries).toHaveLength(2);
    expect(effectiveK(l, "candidate")).toBe(1);
  });

  it("keeps k per family, so policies and scores do not inflate each other", () => {
    const l = recordRuns(EMPTY_LEDGER, [run(), run({ kind: "policy", id: "P1", horizon: undefined })], DAY1);
    expect(effectiveK(l, "candidate")).toBe(1);
    expect(effectiveK(l, "policy")).toBe(1);
  });

  it("accumulates the split dates a spec has been judged under", () => {
    const l = recordRuns(recordRuns(EMPTY_LEDGER, [run()], DAY1), [run({ split: "2024-06-01" })], DAY2);
    expect(l.entries[0].splits).toEqual(["2025-01-01", "2024-06-01"]);
    expect(l.entries[0].runs).toBe(2);
  });

  it("sorts entries so the committed file has a stable diff", () => {
    const a = recordRuns(EMPTY_LEDGER, [run({ id: "zeta" }), run({ id: "alpha" })], DAY1);
    const b = recordRuns(EMPTY_LEDGER, [run({ id: "alpha" }), run({ id: "zeta" })], DAY1);
    expect(serializeLedger(a)).toBe(serializeLedger(b));
  });

  it("does not mutate the ledger it was handed", () => {
    const before = recordRuns(EMPTY_LEDGER, [run()], DAY1);
    const snapshot = serializeLedger(before);
    recordRuns(before, [run({ split: "2024-01-01" })], DAY2);
    expect(serializeLedger(before)).toBe(snapshot);
  });
});

describe("splitDrift()", () => {
  it("is silent while a candidate is judged under one split", () => {
    expect(splitDrift(recordRuns(EMPTY_LEDGER, [run()], DAY1), "candidate")).toEqual([]);
  });

  it("names a candidate judged under more than one split, across specs", () => {
    // Moving the split until the answer changes is searching by another name, and k
    // cannot see it — so it gets surfaced for a human instead.
    const l = recordRuns(EMPTY_LEDGER, [run(), run({ horizon: 10, split: "2024-06-01" })], DAY1);
    expect(splitDrift(l, "candidate")).toEqual([{ id: "h1", splits: ["2024-06-01", "2025-01-01"] }]);
  });

  it("ignores controls", () => {
    const l = recordRuns(EMPTY_LEDGER, [
      run({ id: "oracle", control: true }),
      run({ id: "oracle", control: true, split: "2024-06-01" }),
    ], DAY1);
    expect(splitDrift(l, "candidate")).toEqual([]);
  });
});

describe("reportK()", () => {
  it("uses the ledger once it exceeds this run", () => {
    const l = recordRuns(EMPTY_LEDGER, [run(), run({ horizon: 10 }), run({ frame: "fill" })], DAY1);
    expect(reportK(l, "candidate", 1)).toBe(3);
  });

  it("never reports a threshold lower than this run alone justifies", () => {
    // A deleted or unwritten ledger must under-count, not lie: the reader is looking at
    // six candidates, so the floor cannot claim they only had one chance.
    expect(reportK(EMPTY_LEDGER, "candidate", 6)).toBe(6);
  });
});

describe("parseLedger()", () => {
  it("round-trips", () => {
    const l = recordRuns(EMPTY_LEDGER, [run(), run({ id: "h2" })], DAY1);
    expect(parseLedger(serializeLedger(l))).toEqual(l);
  });

  it("refuses a ledger from a different version rather than silently miscounting", () => {
    expect(() => parseLedger(JSON.stringify({ version: LEDGER_VERSION + 1, entries: [] }))).toThrow(/version/);
  });

  it("refuses a malformed file", () => {
    expect(() => parseLedger(JSON.stringify({ version: LEDGER_VERSION }))).toThrow(/malformed/);
  });
});

describe("formatLedgerNote()", () => {
  it("reports the lifetime count", () => {
    const l = recordRuns(EMPTY_LEDGER, [run(), run({ id: "oracle", control: true })], DAY1);
    const note = formatLedgerNote(l, "candidate", 1).join("\n");
    expect(note).toContain("k=1");
    expect(note).toContain("including controls");
  });

  it("shouts about split drift", () => {
    const l = recordRuns(EMPTY_LEDGER, [run(), run({ horizon: 10, split: "2024-06-01" })], DAY1);
    expect(formatLedgerNote(l, "candidate", 2).join("\n")).toContain("split drift");
  });
});
