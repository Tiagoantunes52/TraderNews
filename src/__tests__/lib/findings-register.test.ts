import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditFindingsRegister,
  REGISTER_ASSERTIONS,
  ARTICLE_COUNT_SLICE,
  type RegisterFacts,
} from "@/lib/findings-register";

/** Production as of 2026-08-24 (ratchet disabled), when every claim in the register holds. */
const asWritten: RegisterFacts = {
  maxArticleCount: 10,
  tradingConfigRaw: '{"trailRatchetFrac":1}',
  staleMarkedPositions: 0,
  staleMarkDays: 4,
  rmEntriesInWindow: 34,
  entryWindowDays: 30,
  insufficientQtyErrors: 0,
  entriesAboveBand: 0,
  entryScoreMax: 0.6,
  // Measured 2026-09-07: the capped articleCount drives most of the alert stream.
  velocitySpikeAlerts: 1791,
  alertsInWindow: 2785,
  velocityWindowDays: 30,
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
    const findings = auditFindingsRegister({ ...asWritten, tradingConfigRaw: null });
    expect(findings.every((f) => f.severity !== "fail")).toBe(true);
  });

  it("notices the ratchet disable being reverted (row gone)", () => {
    const stale = staleIds({ tradingConfigRaw: null });
    expect(stale).toEqual(["knobs-single-ratchet-override"]);
  });

  it("notices a second knob joining the override row", () => {
    expect(staleIds({ tradingConfigRaw: '{"trailRatchetFrac":1,"stopLossPct":0.1}' })).toEqual([
      "knobs-single-ratchet-override",
    ]);
  });

  it("notices the override changing value, and survives junk in the row", () => {
    expect(staleIds({ tradingConfigRaw: '{"trailRatchetFrac":0.5}' })).toEqual(["knobs-single-ratchet-override"]);
    expect(staleIds({ tradingConfigRaw: "not json" })).toEqual(["knobs-single-ratchet-override"]);
  });

  // Inverted relative to the sample-size assertions: this one HOLDS while the defect is
  // live, so it fires when the code is fixed. That is the prompt to delete the bullet.
  it("stays quiet while articleCount is still capped by the slice", () => {
    expect(staleIds({ maxArticleCount: ARTICLE_COUNT_SLICE })).toEqual([]);
    expect(staleIds({ maxArticleCount: ARTICLE_COUNT_SLICE - 4 })).toEqual([]);
  });

  it("fires once articleCount exceeds the slice — i.e. once someone fixes the ordering", () => {
    expect(staleIds({ maxArticleCount: ARTICLE_COUNT_SLICE + 1 })).toEqual(["sentweight-range-unreachable"]);
  });

  it("names what else moves when that fix lands", () => {
    const [f] = auditFindingsRegister({ ...asWritten, maxArticleCount: 45 });
    expect(f.detail).toContain("sentWeight");
    // combinedScore drives the exits — the reason this one is deferred at all.
    expect(f.detail).toContain("combinedScore");
  });

  // The bullet asserted in prose that `articleVelocityRatio` had "no reader"; by
  // 2026-09-07 it was raising 1,791 of 2,785 alerts. The claim itself never broke, so
  // nothing prompted an edit — the cost grew underneath a true sentence. Restating the
  // blast radius daily is what closes that gap.
  it("reports the alert share on the run where the claim still holds", () => {
    const checked = auditFindingsRegister(asWritten).find((f) => f.code === "REGISTER_CHECKED")!;
    expect(checked.detail).toContain("1791 of 2785 alerts in 30d (64%) are VELOCITY_SPIKE");
    // The claim holds, so it must NOT also be reported as stale.
    expect(staleIds({})).toEqual([]);
  });

  it("does not divide by zero on a day with no alerts at all", () => {
    const checked = auditFindingsRegister({ ...asWritten, velocitySpikeAlerts: 0, alertsInWindow: 0 }).find(
      (f) => f.code === "REGISTER_CHECKED"
    )!;
    expect(checked.detail).toContain("no alerts at all in 30d");
  });

  it("drops the note once the defect is fixed — the bullet is going away anyway", () => {
    const findings = auditFindingsRegister({ ...asWritten, maxArticleCount: 45 });
    const checked = findings.find((f) => f.code === "REGISTER_CHECKED")!;
    expect(checked.detail).not.toContain("VELOCITY_SPIKE");
    expect(checked.detail).toContain("Stale: sentweight-range-unreachable");
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

  // The quant-entry-excess sign bounces with the market and was never a durable fact to
  // assert (see OPEN-FINDINGS.md's "Confirmed 2026-07-30" correction, 2026-08-17): the
  // bullet went stale the moment the live window turned positive, with no significance
  // test to tell a real reversal from noise. `signal-health.ts`'s `SIGNAL_INVERTED`
  // (gated on t <= -2) is the durable ongoing monitor; this register no longer
  // duplicates it with a bare-sign assertion that cries wolf on every regime change.
  it("has retired the flip-flopping quant-signal-inverted check", () => {
    expect(REGISTER_ASSERTIONS.map((a) => a.id)).not.toContain("quant-signal-inverted");
  });

  it("lists every stale id in the summary, not just the first", () => {
    const findings = auditFindingsRegister({
      ...asWritten,
      tradingConfigRaw: null,
      rmEntriesInWindow: 0,
    });
    const summary = findings.find((f) => f.code === "REGISTER_CHECKED")!;
    expect(summary.title).toBe(`${REGISTER_ASSERTIONS.length - 2}/${REGISTER_ASSERTIONS.length} register claims still hold`);
    expect(summary.detail).toContain("knobs-single-ratchet-override");
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
