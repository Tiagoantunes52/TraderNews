import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditFindingsRegister,
  REGISTER_ASSERTIONS,
  EXIT_LADDER_SAMPLE,
  ENTRY_SCORE_SAMPLE,
  type RegisterFacts,
} from "@/lib/findings-register";

/** Production as of 2026-07-30, when every claim in the register holds. */
const asWritten: RegisterFacts = {
  labelledRmExits: 27,
  closesWithEntryScore: 141,
  tradingConfigRowExists: false,
  staleMarkedPositions: 0,
  staleMarkDays: 4,
  rmEntriesInWindow: 34,
  entryWindowDays: 30,
  insufficientQtyErrors: 0,
};

const staleIds = (f: Partial<RegisterFacts>) =>
  auditFindingsRegister({ ...asWritten, ...f })
    .filter((x) => x.code === "REGISTER_STALE")
    .map((x) => x.refs?.id);

describe("auditFindingsRegister()", () => {
  it("reports nothing stale against the world the register describes", () => {
    const findings = auditFindingsRegister(asWritten);
    expect(findings.filter((f) => f.code === "REGISTER_STALE")).toEqual([]);
    expect(findings.map((f) => f.code)).toEqual(["REGISTER_CHECKED"]);
    expect(findings[0].detail).toContain("re-verified against production");
  });

  it("never fails the review — a stale document is an edit, not an outage", () => {
    const findings = auditFindingsRegister({ ...asWritten, tradingConfigRowExists: true });
    expect(findings.every((f) => f.severity !== "fail")).toBe(true);
  });

  it("notices knobs leaving their defaults", () => {
    expect(staleIds({ tradingConfigRowExists: true })).toEqual(["knobs-at-defaults"]);
  });

  it("fires the register's own revisit trigger once labelled exits accumulate", () => {
    expect(staleIds({ labelledRmExits: EXIT_LADDER_SAMPLE - 1 })).toEqual([]);
    expect(staleIds({ labelledRmExits: EXIT_LADDER_SAMPLE })).toEqual(["exit-labels-too-few"]);
  });

  it("fires once entry scores are numerous enough to bucket", () => {
    expect(staleIds({ closesWithEntryScore: ENTRY_SCORE_SAMPLE - 1 })).toEqual([]);
    expect(staleIds({ closesWithEntryScore: ENTRY_SCORE_SAMPLE })).toEqual(["entry-score-too-few"]);
  });

  it("escalates the deferred unmanaged-positions defect from latent to active", () => {
    const [f] = auditFindingsRegister({ ...asWritten, staleMarkedPositions: 3 });
    expect(f.refs?.id).toBe("unmanaged-positions-latent");
    expect(f.detail).toContain("ACTIVE, not latent");
  });

  it("notices an _RM book that has stopped taking entries again", () => {
    const [f] = auditFindingsRegister({ ...asWritten, rmEntriesInWindow: 0 });
    expect(f.refs?.id).toBe("entry-freeze-drained");
    expect(f.detail).toContain("looks healthy from every other angle");
  });

  it("notices the cancel-first stop fix regressing", () => {
    const [f] = auditFindingsRegister({ ...asWritten, insufficientQtyErrors: 8 });
    expect(f.refs?.id).toBe("reanchor-cancels-first");
  });

  it("lists every stale id in the summary, not just the first", () => {
    const findings = auditFindingsRegister({
      ...asWritten,
      tradingConfigRowExists: true,
      rmEntriesInWindow: 0,
    });
    const summary = findings.find((f) => f.code === "REGISTER_CHECKED")!;
    expect(summary.title).toBe(`${REGISTER_ASSERTIONS.length - 2}/${REGISTER_ASSERTIONS.length} register claims still hold`);
    expect(summary.detail).toContain("knobs-at-defaults");
    expect(summary.detail).toContain("entry-freeze-drained");
  });
});

describe("OPEN-FINDINGS.md markers", () => {
  const md = readFileSync(join(process.cwd(), "OPEN-FINDINGS.md"), "utf8");
  const marked = new Set([...md.matchAll(/<!--\s*check:\s*([a-z0-9-]+)\s*-->/g)].map((m) => m[1]));

  // The point of the whole mechanism is that an assertion and its bullet stay together.
  // Either half surviving alone is the failure mode: an orphan assertion reports on a
  // claim the document no longer makes, and an unmarked claim is back to being prose.
  it("has a marker for every assertion", () => {
    expect([...REGISTER_ASSERTIONS.map((a) => a.id)].filter((id) => !marked.has(id))).toEqual([]);
  });

  it("has an assertion for every marker", () => {
    const ids = new Set(REGISTER_ASSERTIONS.map((a) => a.id));
    expect([...marked].filter((id) => !ids.has(id))).toEqual([]);
  });

  it("keeps assertion ids unique", () => {
    const ids = REGISTER_ASSERTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
