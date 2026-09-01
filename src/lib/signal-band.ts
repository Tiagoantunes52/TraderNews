// Which slice of a signal's range should actually open a position?
//
// `signal-health.ts` reports one entry number per source: BUY + STRONG_BUY pooled,
// because that is the band the books trade. It also prints a per-bucket breakdown — and
// that breakdown is where the current lead came from, sentiment's STRONG_BUY bucket
// sitting far below the rest. But those bucket t-stats are `tStatOneSample` **pooled
// across observations**, which the module's own comment marks as descriptive and
// overstated: a hundred names on one good session look like a hundred independent
// pieces of evidence when they are one.
//
// So a bucket cannot be promoted to a trading rule off that table. This module re-asks
// the question the honest way: treat an arbitrary BAND of buckets as the entry set and
// compute its excess with the same across-session Newey-West statistic `entryTStat`
// gives the current band — then split it, so the answer has to survive out of sample.
//
// ── The bar ──────────────────────────────────────────────────────────────────
//
// Excess is measured against the universe on the same session, so **0 is the universe**.
// A band that reaches 0 has stopped losing to the names it picks from; it has not beaten
// them. The verdict below is graded accordingly: MATCHES is not a pass, because a
// concentrated 12-name book that merely matches the universe is strictly worse than
// holding the universe — same return, far more variance. Only BEATS is a result.
//
// ── The multiple-comparison problem this creates ─────────────────────────────
//
// Scanning bands is a search: five buckets across three sources is a lot of chances to
// find something. Every band evaluated here is recorded in `research-ledger.json` under
// the `band` kind, and the noise floor rises with the count, exactly as it does for score
// candidates and selection policies. The bands are pre-registered in `ENTRY_BANDS` for
// the same reason candidates are.

import { mean, neweyWestTStatOfMean } from "@/lib/stats";
import { scoreToSignal } from "@/lib/indicators";
import {
  DEFAULT_HORIZON,
  MIN_ENTRY_OBSERVATIONS,
  MIN_SESSIONS,
  type Observation,
  type SignalSource,
} from "@/lib/signal-health";
import { noiseFloorFor } from "@/lib/research-ledger";

/** Bucket labels an entry band may include, worst-to-best in the current inversion. */
export const BUCKETS = ["STRONG_SELL", "SELL", "NEUTRAL", "BUY", "STRONG_BUY"] as const;
export type Bucket = (typeof BUCKETS)[number];

export type EntryBand = {
  id: string;
  /** One sentence, pre-registered. */
  hypothesis: string;
  buckets: readonly Bucket[];
  /** The incumbent — reported, never judged, and the pair every other band is read against. */
  incumbent?: true;
};

/**
 * Pre-registered bands. Adding one is a new `k` for every band that comes after it, so
 * add deliberately — and never trim this list to make a survivor look better.
 *
 * `band-neutral-only` is here because the bucket table says NEUTRAL is the best slice in
 * every source, which is the single most tempting reading available and the one
 * OPEN-FINDINGS explicitly warns about: the obvious inversion already died in a holdout
 * once. Including it means the temptation gets tested rather than argued about.
 */
export const ENTRY_BANDS: EntryBand[] = [
  {
    id: "band-current",
    hypothesis: "What ships today: BUY and STRONG_BUY both open positions. The pair for every comparison.",
    buckets: ["BUY", "STRONG_BUY"],
    incumbent: true,
  },
  {
    id: "band-no-strong",
    hypothesis:
      "Drop the top bucket: STRONG_BUY follows news the price has already moved on, so the most confident signal buys the top of a move that reverts. BUY alone should beat the band that includes it.",
    buckets: ["BUY"],
  },
  {
    id: "band-strong-only",
    hypothesis:
      "The mirror of band-no-strong, and its control: if the top bucket is the problem, trading only it must be markedly worse than trading only BUY.",
    buckets: ["STRONG_BUY"],
  },
  {
    id: "band-neutral-up",
    hypothesis:
      "Widen downward: if conviction is anti-predictive, the band that adds NEUTRAL to BUY should beat the one that adds STRONG_BUY to it.",
    buckets: ["NEUTRAL", "BUY"],
  },
];

export type BandStat = {
  label: string;
  /** Scored observations in the band — the sample size, not the significance sample. */
  n: number;
  /** Sessions contributing at least one entry — what the t-stat is actually computed over. */
  sessions: number;
  meanExcessBps: number;
  /** Across SESSIONS, Newey-West. Never pooled across names within a day. */
  tStat: number | null;
};

/**
 * Excess of one band against the universe on the same session.
 *
 * The session mean is taken over EVERY observation, not just the band's — the benchmark
 * is the universe the signal picked from, so narrowing the band must not narrow the thing
 * it is measured against. That is the whole point of the metric.
 */
export function bandExcess(
  obs: Observation[],
  source: SignalSource,
  buckets: readonly Bucket[],
  label: string,
  horizon = DEFAULT_HORIZON
): BandStat {
  const sessionMean = new Map<string, number>();
  const bySession = new Map<string, number[]>();
  for (const o of obs) {
    const l = bySession.get(o.session);
    if (l) l.push(o.forwardReturn);
    else bySession.set(o.session, [o.forwardReturn]);
  }
  for (const [s, rets] of bySession) sessionMean.set(s, mean(rets) ?? 0);

  const wanted = new Set<string>(buckets);
  const excessBySession = new Map<string, number[]>();
  const all: number[] = [];
  for (const o of obs) {
    const score = o.scores[source];
    if (score == null || !wanted.has(scoreToSignal(score))) continue;
    const ex = o.forwardReturn - (sessionMean.get(o.session) ?? 0);
    all.push(ex);
    const e = excessBySession.get(o.session);
    if (e) e.push(ex);
    else excessBySession.set(o.session, [ex]);
  }

  const sessions = [...excessBySession.keys()].sort();
  const perSession = sessions.map((s) => mean(excessBySession.get(s)!) ?? 0);
  return {
    label,
    n: all.length,
    sessions: sessions.length,
    meanExcessBps: all.length ? (mean(all) ?? 0) * 10_000 : 0,
    // Same estimator the monitor uses for the current band, so a number here means what
    // the same number means in the daily review.
    tStat: perSession.length > 1 ? neweyWestTStatOfMean(perSession, horizon - 1) : null,
  };
}

/**
 * BEATS the universe, MATCHES it, or LAGS it.
 *
 * MATCHES is deliberately not a pass. Reaching zero excess means a concentrated book has
 * stopped destroying value relative to the names it picks from — which is worth knowing,
 * and is not a reason to run a concentrated book. Holding the universe achieves the same
 * return at a fraction of the variance.
 */
export type BandVerdict = "INCUMBENT" | "BEATS" | "MATCHES" | "LAGS" | "INSUFFICIENT";

export function bandVerdict(train: BandStat, holdout: BandStat, folds: BandStat[], k: number): BandVerdict {
  const thin = (s: BandStat) => s.n < MIN_ENTRY_OBSERVATIONS || s.sessions < MIN_SESSIONS;
  if (thin(train) || thin(holdout)) return "INSUFFICIENT";
  if (holdout.meanExcessBps < 0) return "LAGS";
  const foldsPositive = folds.filter((f) => f.meanExcessBps > 0).length;
  const enoughFolds = folds.length === 0 || foldsPositive >= Math.ceil(folds.length * 0.75);
  const strong = holdout.tStat != null && holdout.tStat > noiseFloorFor(k);
  return train.meanExcessBps > 0 && enoughFolds && strong ? "BEATS" : "MATCHES";
}

export type BandReport = {
  id: string;
  source: SignalSource;
  hypothesis: string;
  incumbent: boolean;
  all: BandStat;
  train: BandStat;
  holdout: BandStat;
  folds: BandStat[];
  verdict: BandVerdict;
};

export function evaluateBand(args: {
  band: EntryBand;
  source: SignalSource;
  all: Observation[];
  train: Observation[];
  holdout: Observation[];
  folds: { label: string; rows: Observation[] }[];
  horizon?: number;
  k: number;
}): BandReport {
  const { band, source, horizon = DEFAULT_HORIZON, k } = args;
  const stat = (rows: Observation[], label: string) => bandExcess(rows, source, band.buckets, label, horizon);
  const train = stat(args.train, "train");
  const holdout = stat(args.holdout, "holdout");
  const folds = args.folds.map((f) => stat(f.rows, f.label));
  return {
    id: band.id,
    source,
    hypothesis: band.hypothesis,
    incumbent: !!band.incumbent,
    all: stat(args.all, "all"),
    train,
    holdout,
    folds,
    verdict: band.incumbent ? "INCUMBENT" : bandVerdict(train, holdout, folds, k),
  };
}

const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
const t = (v: number | null) => (v == null ? "    —" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

export function formatBandReport(reports: BandReport[], source: SignalSource, k: number): string {
  const L: string[] = [];
  L.push(`── entry bands — ${source} (excess vs the universe on the same session; 0 IS the universe) ──`);
  L.push(`k=${k} bands judged → holdout t must clear +${noiseFloorFor(k).toFixed(2)} to count as BEATS`);
  L.push(
    `${pad("band", 20)}${padL("ALL", 20)}${padL("TRAIN", 20)}${padL("HOLDOUT", 20)}${padL("folds+", 8)}  verdict`
  );
  for (const r of reports.filter((x) => x.source === source)) {
    const cell = (s: BandStat) => padL(`${fmt(s.meanExcessBps)} (t ${t(s.tStat)})`, 20);
    const foldsPos = r.folds.filter((f) => f.meanExcessBps > 0).length;
    L.push(
      pad(r.id, 20) + cell(r.all) + cell(r.train) + cell(r.holdout) + padL(`${foldsPos}/${r.folds.length}`, 8) + `  ${r.verdict}`
    );
  }
  L.push("");
  for (const r of reports.filter((x) => x.source === source)) {
    L.push(`  ${r.id} (n=${r.all.n}, ${r.all.sessions} entry sessions): ${r.hypothesis}`);
  }
  return L.join("\n");
}
