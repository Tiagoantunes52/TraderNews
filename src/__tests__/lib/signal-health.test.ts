import { describe, it, expect } from "vitest";
import {
  buildObservations,
  signalHealth,
  auditSignalHealth,
  MIN_ENTRY_OBSERVATIONS,
  MIN_SESSIONS,
  DEFAULT_HORIZON,
  type EstimateRow,
  type BarClose,
  type Observation,
} from "@/lib/signal-health";
import { tStatOneSample } from "@/lib/stats";

const session = (i: number) => `2026-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, "0")}`;

function bars(stockId: string, closes: number[], offset = 0): BarClose[] {
  return closes.map((close, i) => ({ stockId, session: session(i + offset), close }));
}

describe("buildObservations()", () => {
  const est = (stockId: string, s: string, quant: number): EstimateRow => ({
    stockId, session: s, sentimentScore: 0.1, quantScore: quant, combinedScore: 0.2,
  });

  it("returns the close-to-close return over `horizon` SESSIONS", () => {
    const obs = buildObservations([est("s1", session(0), 0.5)], bars("s1", [100, 1, 1, 1, 1, 110]), 5);
    expect(obs).toHaveLength(1);
    expect(obs[0].forwardReturn).toBeCloseTo(0.1, 10);
  });

  it("counts SESSIONS, not calendar days — a holiday must not shorten the horizon", () => {
    // Sessions deliberately skip a day; position in the series is what counts.
    const sparse: BarClose[] = [
      { stockId: "s1", session: "2026-03-02", close: 100 },
      { stockId: "s1", session: "2026-03-03", close: 101 },
      { stockId: "s1", session: "2026-03-06", close: 200 }, // 4→6, a gap
    ];
    const obs = buildObservations([est("s1", "2026-03-02", 0.5)], sparse, 2);
    expect(obs[0].forwardReturn).toBeCloseTo(1.0, 10);
  });

  it("drops a row whose horizon has not elapsed rather than shortening it", () => {
    expect(buildObservations([est("s1", session(3), 0.5)], bars("s1", [1, 2, 3, 4, 5]), 5)).toEqual([]);
  });

  it("drops a row whose declared session has no bar", () => {
    expect(buildObservations([est("s1", "1999-01-01", 0.5)], bars("s1", [1, 2, 3, 4, 5, 6]), 5)).toEqual([]);
  });

  it("keeps each stock on its own series", () => {
    const obs = buildObservations(
      [est("s1", session(0), 0.5), est("s2", session(0), 0.5)],
      [...bars("s1", [100, 0, 0, 0, 0, 110]), ...bars("s2", [50, 0, 0, 0, 0, 45])],
      5
    );
    expect(obs.map((o) => o.forwardReturn.toFixed(2)).sort()).toEqual(["-0.10", "0.10"]);
  });
});

// ── health statistics ────────────────────────────────────────────────────────

/** n observations on one session, all with the same score, and a chosen return. */
function obsFor(n: number, quant: number, ret: number, sess: string): Observation[] {
  return Array.from({ length: n }, (_, i) => ({
    session: sess,
    stockId: `s${i}`,
    scores: { SENTIMENT: null, QUANT: quant, COMBINED: null },
    forwardReturn: ret,
  }));
}

/** A book whose BUY names beat/trail the rest, spread over enough sessions to count. */
function book(entryRet: number, otherRet: number, sessions = MIN_SESSIONS + 5, perSession = 20): Observation[] {
  const out: Observation[] = [];
  for (let s = 0; s < sessions; s++) {
    // half BUY (score 0.4), half NEUTRAL (score 0.0), with a little jitter so sd > 0
    for (let i = 0; i < perSession / 2; i++) {
      const j = (i % 5) * 0.0001;
      out.push({ session: session(s), stockId: `b${i}`, scores: { SENTIMENT: null, QUANT: 0.4, COMBINED: null }, forwardReturn: entryRet + j });
      out.push({ session: session(s), stockId: `n${i}`, scores: { SENTIMENT: null, QUANT: 0.0, COMBINED: null }, forwardReturn: otherRet + j });
    }
  }
  return out;
}

/**
 * A book whose entry excess is IDENTICAL for every name on a session but varies
 * between sessions — i.e. the names move together, which is how a real session
 * behaves. BUY returns +x, NEUTRAL returns -x, so the universe mean is 0 and the
 * entry excess is exactly x for that session.
 */
function correlatedBook(perSessionExcess: number[], namesPerSide = 25): Observation[] {
  const out: Observation[] = [];
  perSessionExcess.forEach((x, s) => {
    for (let i = 0; i < namesPerSide; i++) {
      out.push({ session: session(s), stockId: `b${i}`, scores: { SENTIMENT: null, QUANT: 0.4, COMBINED: null }, forwardReturn: x });
      out.push({ session: session(s), stockId: `n${i}`, scores: { SENTIMENT: null, QUANT: 0.0, COMBINED: null }, forwardReturn: -x });
    }
  });
  return out;
}

/** Five-session blocks: persistent, like a regime, rather than alternating. */
const BLOCKY_EXCESS = [
  ...Array(5).fill(-0.03), ...Array(5).fill(0.02),
  ...Array(5).fill(-0.03), ...Array(5).fill(0.02),
  ...Array(5).fill(-0.015),
];

describe("entry significance is judged per session, not per observation", () => {
  // The defect this pins: pooling every name into one t-test multiplies the apparent
  // sample by the number of names scored that day, and SIGNAL_INVERTED gates on that
  // number. Measured on live data 2026-08-22, COMBINED read t=-3.96 pooled and
  // t=-0.85 per session — the alert fired on a result indistinguishable from zero.
  const obs = correlatedBook(BLOCKY_EXCESS);
  const q = () => signalHealth(obs).find((h) => h.source === "QUANT")!;

  it("does not call a noisy negative mean significant", () => {
    const h = q();
    expect(h.entry.meanExcess).toBeLessThan(0); // the mean really is negative...
    expect(h.entry.tStat!).toBeGreaterThan(-2); // ...but it is not distinguishable from 0
  });

  it("the same rows pooled WOULD have cleared the gate — so the fixture is a real repro", () => {
    // The universe mean is 0 by construction (+x against -x), so a BUY name's excess
    // IS its return — the pooled sample the old implementation tested.
    const pooled = obs.filter((o) => o.scores.QUANT === 0.4).map((o) => o.forwardReturn);
    expect(tStatOneSample(pooled)!).toBeLessThan(-2);
  });

  it("raises no SIGNAL_INVERTED on it", () => {
    expect(auditSignalHealth(signalHealth(obs)).map((f) => f.code)).toEqual(["SIGNAL_HEALTH"]);
  });

  it("counts ENTRY sessions, not every session the source was scored on", () => {
    // Scored on 30 sessions, but only reaches BUY on 6 of them. The t-stat can only be
    // computed over those 6, so the 20-session bar must be judged on them too.
    const scoredEverywhere: Observation[] = [];
    for (let s = 0; s < 30; s++) {
      const entering = s < 6;
      for (let i = 0; i < 40; i++) {
        scoredEverywhere.push({
          session: session(s),
          stockId: `x${i}`,
          scores: { SENTIMENT: null, QUANT: entering ? 0.4 : 0.0, COMBINED: null },
          forwardReturn: entering ? -0.02 : 0.01,
        });
      }
    }
    const h = signalHealth(scoredEverywhere).find((x) => x.source === "QUANT")!;
    expect(h.sessions).toBe(30); // scored on all of them...
    expect(h.entry.sessions).toBe(6); // ...but only 6 carry an entry
    expect(h.entry.n).toBeGreaterThanOrEqual(MIN_ENTRY_OBSERVATIONS);
    expect(auditSignalHealth(signalHealth(scoredEverywhere)).map((f) => f.code)).toEqual(["SIGNAL_HEALTH"]);
  });

  it("still fires when the excess is negative in nearly every session", () => {
    // Same machinery, a signal that really is inverted: persistent, not noisy.
    const persistent = correlatedBook(Array.from({ length: 25 }, (_, i) => -0.02 + (i % 5) * 0.001));
    const h = signalHealth(persistent).find((x) => x.source === "QUANT")!;
    expect(h.entry.tStat!).toBeLessThan(-2);
    expect(auditSignalHealth(signalHealth(persistent)).map((f) => f.code)).toContain("SIGNAL_INVERTED");
  });
});

describe("signalHealth()", () => {
  it("measures the entry bucket as EXCESS over the universe on the same session", () => {
    // BUY +2%, NEUTRAL 0% → universe mean 1% → entry excess +1%.
    const q = signalHealth(book(0.02, 0.0)).find((h) => h.source === "QUANT")!;
    expect(q.entry.meanExcess).toBeCloseTo(0.01, 3);
    expect(q.entry.tStat!).toBeGreaterThan(2);
  });

  it("shows a losing entry signal as negative excess even when returns are positive", () => {
    // Both buckets make money, but BUY makes less — the case a raw return hides.
    const q = signalHealth(book(0.01, 0.05)).find((h) => h.source === "QUANT")!;
    expect(q.entry.meanExcess).toBeLessThan(0);
    expect(q.entry.tStat!).toBeLessThan(-2);
  });

  it("scores every source against the same universe benchmark", () => {
    const h = signalHealth(book(0.02, 0.0));
    expect(h.map((x) => x.source)).toEqual(["SENTIMENT", "QUANT", "COMBINED"]);
    expect(h.find((x) => x.source === "SENTIMENT")!.entry.n).toBe(0); // no sentiment scores present
  });

  it("buckets by scoreToSignal and counts sessions", () => {
    const q = signalHealth(book(0.02, 0.0)).find((h) => h.source === "QUANT")!;
    expect(q.buckets.map((b) => b.label)).toEqual(["BUY", "NEUTRAL"]);
    expect(q.sessions).toBe(MIN_SESSIONS + 5);
  });
});

describe("auditSignalHealth()", () => {
  const codes = (obs: Observation[]) => auditSignalHealth(signalHealth(obs)).map((f) => f.code);

  it("warns when entries select against return", () => {
    const findings = auditSignalHealth(signalHealth(book(0.01, 0.05)));
    const f = findings.find((x) => x.code === "SIGNAL_INVERTED")!;
    expect(f.severity).toBe("warn");
    expect(f.refs?.source).toBe("QUANT");
    expect(f.detail).toContain("NOT to flip a weight");
  });

  it("stays quiet when entries out-perform", () => {
    expect(codes(book(0.02, 0.0))).toEqual(["SIGNAL_HEALTH"]);
  });

  it("never fails the review — a signal losing its edge is not an outage", () => {
    expect(auditSignalHealth(signalHealth(book(0.01, 0.05))).every((f) => f.severity !== "fail")).toBe(true);
  });

  it("refuses to judge on too few observations", () => {
    const tiny = book(0.01, 0.05, MIN_SESSIONS + 5, 4); // sessions fine, ~100 obs
    const q = signalHealth(tiny).find((h) => h.source === "QUANT")!;
    expect(q.entry.n).toBeLessThan(MIN_ENTRY_OBSERVATIONS);
    expect(codes(tiny)).toEqual(["SIGNAL_HEALTH"]);
  });

  it("refuses to judge many observations crammed into few sessions", () => {
    // 400 entry observations, but all on 3 days — one market move, not a measurement.
    const crammed = [0, 1, 2].flatMap((s) => [
      ...obsFor(200, 0.4, 0.01, session(s)),
      ...obsFor(200, 0.0, 0.05, session(s)),
    ]);
    const q = signalHealth(crammed).find((h) => h.source === "QUANT")!;
    expect(q.entry.n).toBeGreaterThanOrEqual(MIN_ENTRY_OBSERVATIONS);
    expect(q.sessions).toBeLessThan(MIN_SESSIONS);
    expect(codes(crammed)).toEqual(["SIGNAL_HEALTH"]);
  });

  it("says so plainly when there is not enough history yet", () => {
    const f = auditSignalHealth(signalHealth([]))[0];
    expect(f.code).toBe("SIGNAL_HEALTH");
    expect(f.title).toContain("Not enough history");
    expect(f.detail).toContain(String(DEFAULT_HORIZON));
  });
});
