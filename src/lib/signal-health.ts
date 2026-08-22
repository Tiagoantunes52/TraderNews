// Is the signal still pointing the right way?
//
// Written after a 5-year study found that `calcQuantScore`'s entry signal INVERTED
// between periods: over 2021-10 → 2025-01 the BUY bucket beat the universe by +0.50pp
// per 5 days (t = 6.54), and over 2025-01 → 2026-07 it TRAILED by 0.38pp (t = -3.42),
// with NEUTRAL becoming the best bucket. Nothing in the app noticed, because nothing
// was watching: the daily review audits whether the rules were FOLLOWED, and the
// calibration report scores signals without ever asking whether a BUY still means buy.
//
// So this measures one thing and measures it plainly — do the names this system calls
// entries out-perform the ones it doesn't? Everything is expressed as EXCESS over the
// universe on the same session, because the raw number mostly tracks the market and a
// falling signal in a rising market is invisible without the subtraction.
//
// A monitor, not a decision rule. One reading is one period; the whole point of the
// finding above is that a sign which holds for three years can reverse. Treat a
// negative print as a prompt to investigate with a proper train/test split, never as
// licence to flip a weight — that shortcut has already been tried here and failed out
// of sample.
//
// Pure. `pipeline/review.ts` loads the rows.

import { scoreToSignal } from "@/lib/indicators";
import { isEntrySignal } from "@/lib/paper-trading";
import { tStatOneSample, neweyWestTStatOfMean } from "@/lib/stats";
import type { Finding } from "@/lib/daily-review";

/** The three source scores the books actually trade on (see STRATEGY_SOURCE). */
export const SIGNAL_SOURCES = ["SENTIMENT", "QUANT", "COMBINED"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export type EstimateRow = {
  stockId: string;
  /** The SESSION the scores describe — from QuantAnalysis.sessionDate, never the run day. */
  session: string;
  sentimentScore: number | null;
  quantScore: number | null;
  combinedScore: number | null;
};

export type BarClose = { stockId: string; session: string; close: number };

export type Observation = {
  session: string;
  stockId: string;
  scores: Record<SignalSource, number | null>;
  /** Close-to-close return over `horizon` SESSIONS of that stock's own bar series. */
  forwardReturn: number;
};

export type BucketHealth = {
  label: string;
  n: number;
  /** Mean return minus the universe mean on the same session. */
  meanExcess: number;
  tStat: number | null;
};

export type EntryHealth = {
  /** Scored entry observations — the sample SIZE, not the significance sample. */
  n: number;
  meanExcess: number;
  /**
   * Sessions contributing at least one entry — the denominator `tStat` is actually
   * computed over. Distinct from `SourceHealth.sessions`, which counts every session
   * the source SCORED: a source can be scored daily but only reach BUY occasionally,
   * and it is the entry sessions that carry the significance.
   */
  sessions: number;
  /**
   * Significance of `meanExcess`, computed across SESSIONS with Newey-West errors.
   * Never across observations: see the note above `entryTStat`.
   */
  tStat: number | null;
};

export type SourceHealth = {
  source: SignalSource;
  buckets: BucketHealth[];
  /** BUY + STRONG_BUY pooled — the bucket that actually opens positions. */
  entry: EntryHealth;
  sessions: number;
};

/**
 * Sessions of forward return. 5 matches calibration's PRIMARY_HORIZON, so the two
 * read the same horizon and a disagreement between them means something.
 */
export const DEFAULT_HORIZON = 5;

/**
 * Minimum observations before the entry bucket is allowed to raise a finding. Below
 * this the t-stat is dominated by a handful of names and would cry wolf every quiet
 * week — and this check earns its place only if a warning from it means something.
 */
export const MIN_ENTRY_OBSERVATIONS = 200;

/** Minimum distinct sessions — 200 observations from three days is one market move. */
export const MIN_SESSIONS = 20;

/**
 * Join estimates to bars and compute forward returns.
 *
 * Indexing is by SESSION POSITION in each stock's own bar series, not by calendar
 * arithmetic: five trading days is not five days, and a holiday would otherwise
 * silently shorten the horizon for every name.
 */
export function buildObservations(
  estimates: EstimateRow[],
  bars: BarClose[],
  horizon = DEFAULT_HORIZON
): Observation[] {
  const series = new Map<string, BarClose[]>();
  for (const b of bars) {
    const list = series.get(b.stockId);
    if (list) list.push(b);
    else series.set(b.stockId, [b]);
  }
  const index = new Map<string, Map<string, number>>();
  for (const [stockId, list] of series) {
    list.sort((a, b) => a.session.localeCompare(b.session));
    const m = new Map<string, number>();
    list.forEach((b, i) => m.set(b.session, i));
    index.set(stockId, m);
  }

  const out: Observation[] = [];
  for (const e of estimates) {
    const list = series.get(e.stockId);
    const i = index.get(e.stockId)?.get(e.session);
    if (!list || i == null) continue; // no bar for the session this row describes
    const from = list[i], to = list[i + horizon];
    if (!to || from.close <= 0) continue; // horizon not yet elapsed
    out.push({
      session: e.session,
      stockId: e.stockId,
      scores: {
        SENTIMENT: e.sentimentScore,
        QUANT: e.quantScore,
        COMBINED: e.combinedScore,
      },
      forwardReturn: (to.close - from.close) / from.close,
    });
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Significance of a mean entry excess — the number `SIGNAL_INVERTED` gates on.
 *
 * Two corrections over a plain t-test of the pooled excesses, both of which this
 * originally got wrong and both of which inflate the t-stat several-fold:
 *
 *  1. **A session is the unit, not an observation.** The ~40 names scored on one day
 *     move together, so pooling them multiplies the apparent sample by ~40 without
 *     adding that much independent information. This is the same choice the 5-year
 *     quant study made — "pooling would inflate N ~100x, since names move together" —
 *     and the monitor written from that study should not use a weaker test than it.
 *  2. **Consecutive sessions overlap.** A `horizon`-session forward return shares
 *     `horizon - 1` of its days with the next session's, so even the session series is
 *     autocorrelated. Newey-West at that lag absorbs it.
 *
 * Measured on live data 2026-08-22, the difference decides whether the alert fires:
 * COMBINED's entry excess reads t = -3.96 pooled but t = -0.85 here, on the same rows.
 * The pooled number would have raised SIGNAL_INVERTED against the live book on a
 * result that is not distinguishable from zero.
 */
export function entryTStat(excessBySession: Map<string, number[]>): number | null {
  const sessions = [...excessBySession.keys()].sort();
  if (!sessions.length) return null;
  const perSession = sessions.map((s) => mean(excessBySession.get(s)!));
  return neweyWestTStatOfMean(perSession, DEFAULT_HORIZON - 1);
}

/** Per-source bucket statistics on excess-over-universe returns. */
export function signalHealth(obs: Observation[]): SourceHealth[] {
  // Universe mean per session — subtracting it is what makes a bad signal in a good
  // market visible. Computed once over ALL observations, so every source is scored
  // against the same benchmark regardless of which rows carry which score.
  const sessionMean = new Map<string, number>();
  const bySession = new Map<string, number[]>();
  for (const o of obs) {
    const l = bySession.get(o.session);
    if (l) l.push(o.forwardReturn);
    else bySession.set(o.session, [o.forwardReturn]);
  }
  for (const [s, rets] of bySession) sessionMean.set(s, mean(rets));

  return SIGNAL_SOURCES.map((source) => {
    const scored = obs.filter((o) => o.scores[source] != null);
    const excessOf = (o: Observation) => o.forwardReturn - (sessionMean.get(o.session) ?? 0);

    const byLabel = new Map<string, number[]>();
    const entryExcess: number[] = [];
    // Entry excess kept grouped by session as well as pooled: the mean is a pooled
    // average, but its significance has to be judged per session (see `entryTStat`).
    const entryBySession = new Map<string, number[]>();
    for (const o of scored) {
      const label = scoreToSignal(o.scores[source]!);
      const ex = excessOf(o);
      const l = byLabel.get(label);
      if (l) l.push(ex);
      else byLabel.set(label, [ex]);
      if (isEntrySignal(label)) {
        entryExcess.push(ex);
        const e = entryBySession.get(o.session);
        if (e) e.push(ex);
        else entryBySession.set(o.session, [ex]);
      }
    }

    const buckets: BucketHealth[] = ["STRONG_BUY", "BUY", "NEUTRAL", "SELL", "STRONG_SELL"]
      .filter((k) => byLabel.has(k))
      .map((label) => {
        const v = byLabel.get(label)!;
        // Descriptive only — pooled across names within a session, so it overstates
        // significance the way `entry.tStat` used to. Nothing gates on it and it is
        // not surfaced in a finding; read it as a spread indicator, not a test.
        return { label, n: v.length, meanExcess: mean(v), tStat: tStatOneSample(v) };
      });

    return {
      source,
      buckets,
      entry: {
        n: entryExcess.length,
        meanExcess: entryExcess.length ? mean(entryExcess) : 0,
        sessions: entryBySession.size,
        tStat: entryTStat(entryBySession),
      },
      sessions: new Set(scored.map((o) => o.session)).size,
    };
  });
}

const bps = (v: number) => `${v >= 0 ? "+" : ""}${(v * 10_000).toFixed(1)} bps`;

/**
 * Turn the statistics into findings.
 *
 * `warn`, never `fail`. A signal losing its edge is a strategy fact, not a system
 * fault — the pipeline is working exactly as designed, which is precisely why it went
 * unnoticed for a year and a half.
 */
export function auditSignalHealth(health: SourceHealth[]): Finding[] {
  const out: Finding[] = [];

  for (const h of health) {
    // Bar on the ENTRY sessions, not every scored session: those are what `tStat` is
    // computed over, so a source scored daily that only reaches BUY on a handful of
    // days must not clear a session bar it never actually met.
    if (h.entry.n < MIN_ENTRY_OBSERVATIONS || h.entry.sessions < MIN_SESSIONS) continue;
    const t = h.entry.tStat;
    if (h.entry.meanExcess < 0 && t != null && t <= -2) {
      out.push({
        severity: "warn",
        code: "SIGNAL_INVERTED",
        title: `${h.source} entries are underperforming the universe`,
        detail:
          `Names this book calls BUY/STRONG_BUY returned ${bps(h.entry.meanExcess)} vs the universe ` +
          `over ${DEFAULT_HORIZON} sessions (t=${t.toFixed(2)} across ${h.entry.sessions} entry sessions, ` +
          `Newey-West; ` +
          `n=${h.entry.n} entries). ` +
          `A ${h.source} entry currently selects against return. This is a prompt to investigate with a ` +
          `train/test split, NOT to flip a weight — one window is one period, and a sign that held for ` +
          `three years has already reversed once here.`,
        refs: { source: h.source, excessBps: Number((h.entry.meanExcess * 10_000).toFixed(1)), t: Number(t.toFixed(2)), n: h.entry.n },
      });
    }
  }

  const usable = health.filter((h) => h.entry.n >= MIN_ENTRY_OBSERVATIONS && h.entry.sessions >= MIN_SESSIONS);
  out.push({
    severity: "info",
    code: "SIGNAL_HEALTH",
    title: usable.length
      ? `Entry-signal excess: ${usable.map((h) => `${h.source} ${bps(h.entry.meanExcess)}`).join(", ")}`
      : "Not enough history to score entry-signal quality yet",
    detail: usable.length
      ? usable
          .map(
            (h) =>
              `${h.source}: entries ${bps(h.entry.meanExcess)} (t=${h.entry.tStat?.toFixed(2) ?? "—"}, n=${h.entry.n}); ` +
              `buckets ${h.buckets.map((b) => `${b.label} ${bps(b.meanExcess)}×${b.n}`).join(", ")}`
          )
          .join(" | ")
      : `Needs ${MIN_ENTRY_OBSERVATIONS}+ scored entries over ${MIN_SESSIONS}+ sessions with a full ${DEFAULT_HORIZON}-session forward window.`,
    refs: Object.fromEntries(health.map((h) => [h.source, Number((h.entry.meanExcess * 10_000).toFixed(1))])),
  });

  return out;
}
