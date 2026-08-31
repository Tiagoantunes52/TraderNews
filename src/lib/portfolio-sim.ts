// Slot-constrained portfolio simulation over the research corpus.
//
// `signal-research.ts` judges a SCORE: its headline is cross-sectional IC, the rank
// correlation between score and forward return within a session. That statistic is
// invariant to selection policy — threshold-and-hold and rank-with-replacement consume
// the identical ranking and produce the identical IC — so it cannot answer "should the
// book replace its worst holding with a better candidate?". Neither can
// `PeriodStats.entry`, which averages the BUY rows with no slot cap, no holding period
// and no replacement decision.
//
// This module adds the missing layer. Same corpus, same features, same frames; a
// different unit of observation: SESSIONS OF PORTFOLIO EXCESS rather than names. The
// policies live in `portfolio-sim-policies.ts`, pre-registered the way candidates are.
//
// Pure, like `signal-research.ts` — `scripts/policy-compare.ts` does the I/O. Nothing
// here reads or writes the database and nothing changes how anything trades.
//
// ── The return model ─────────────────────────────────────────────────────────
//
// Decisions are made at the close of session t from features at or before t; the return
// lands over t → t+1. A name's return that session depends on whether it was already
// held or is being entered, which is exactly where a high-turnover policy pays:
//
//   carried  →  close(t) → close(t+1)                    `holdReturn`
//   entered  →  frame entry price → close(t+1)           `entryReturn`
//
// In the `close` frame the two are identical and every swap is free — which is the
// assumption under test, so a verdict must never be read off that frame. In `exec` the
// entry pays the overnight gap; in `fill` an unfilled buffered limit means the name
// CANNOT be entered at all, which is the adverse-selection channel the execution audit
// found the edge leaking through.
//
// ── What this deliberately does not model ────────────────────────────────────
//
// Equal weight per slot (no confidence sizing), no cluster/gross caps, no drawdown
// derisk, no whole-share rounding, no exit slippage — and no PRICE stops, because
// `FeatureRow` carries no next-session low to test a breach against. Every one of those
// only ever reduces a policy's freedom, so what this measures is the ceiling.
//
// Three of those omissions bias in the SAME direction as the hypothesis, and a reader
// must have all three in front of them before believing a positive result:
//   1. Survivorship — the corpus is today's `Stock` rows projected back to 2021
//      (`UniverseSnapshot` only starts 2026-08-24), and a policy that concentrates into
//      top-ranked survivors inherits that bias in proportion to how hard it concentrates.
//   2. No price stops — the baseline's ladder loses its two cheapest rungs, so P0 rides
//      losers longer here than the live book does.
//   3. No exit slippage — replacement policies exit more often, and pay nothing for it.

import { mean, neweyWestTStatOfMean } from "@/lib/stats";
import { noiseThreshold, frameReturn, type Candidate, type FeatureRow, type ReturnFrame } from "@/lib/signal-research";

/**
 * One (name, session) the simulator can act on.
 *
 * `score` is null for a name the candidate could not score — it stays in the universe
 * benchmark (dropping it would quietly rebase the thing every policy is measured
 * against) but can never be ranked or entered.
 */
export type SimRow = {
  session: string;
  ticker: string;
  score: number | null;
  holdReturn: number;
  entryReturn: number | null;
};

/** A live position's state, as the policy sees it when it decides. */
export type Holding = {
  ticker: string;
  /** Sessions since entry: 0 on the session it was entered. */
  sessionsHeld: number;
  /** Compounded return since entry, through the close the decision is made at. */
  cumReturn: number;
  /** Consecutive sessions the score has read bearish / neutral, through today. */
  bearishRuns: number;
  neutralRuns: number;
};

/** This session's cross-section, ranked best-first, with holding state attached. */
export type RankedName = {
  ticker: string;
  score: number;
  /** False when the frame says this entry could not have been filled today. */
  enterable: boolean;
  held: Holding | null;
};

export type Rebalance = { drop: string[]; add: string[] };

export type Policy = {
  id: string;
  /** One sentence, pre-registered. See portfolio-sim-policies.ts. */
  hypothesis: string;
  slots: number;
  /**
   * A CONTROL, not a hypothesis: its job is to fail loudly if the simulator is broken,
   * so it is reported separately rather than judged, and excluded from `k`.
   */
  control?: true;
  /**
   * The whole policy. Pure: given the session's ranking and the current book, which
   * names to drop and which to add. The engine enforces the slot cap, so a policy
   * asking for more than fits simply has its tail ignored.
   */
  rebalance: (ranked: RankedName[], held: Holding[], slots: number) => Rebalance;
};

export type SessionResult = {
  session: string;
  /** Equal-weighted portfolio return over this session. */
  ret: number;
  /** Portfolio return minus the equal-weight universe on the same session. */
  excess: number;
  held: number;
  added: number;
  dropped: number;
};

export type SimResult = {
  policyId: string;
  sessions: SessionResult[];
  /** Mean names added per session. */
  turnover: number;
  /** Mean sessions a position was held, closed positions only. */
  avgHold: number;
  /** Mean slots filled ÷ slots. A policy that cannot fill the book is not comparable. */
  slotUse: number;
};

/**
 * Build the simulator's rows from the harness corpus.
 *
 * Mirrors `evaluate`'s oracle short-circuit: a candidate flagged `oracle` scores FROM
 * the return it is supposed to be predicting, which `ScoreInput` otherwise makes
 * unreachable. It exists so the plumbing control can exist at all — never set that flag
 * on a hypothesis, and `grep oracle` finds every score that reads the answer.
 */
export function buildSimRows(features: FeatureRow[], candidate: Candidate, frame: ReturnFrame): SimRow[] {
  const out: SimRow[] = [];
  for (const f of features) {
    const holdReturn = f.forward.h1;
    if (!Number.isFinite(holdReturn)) continue;
    const entryReturn = frameReturn(f, 1, frame);
    // The oracle ranks by the return a decision made now could actually capture, which
    // is the entry return in this frame — not the close-frame return no one can trade.
    const score = candidate.oracle ? entryReturn : candidate.score(f);
    out.push({
      session: f.session,
      ticker: f.ticker,
      score: score != null && Number.isFinite(score) ? score : null,
      holdReturn,
      entryReturn: entryReturn != null && Number.isFinite(entryReturn) ? entryReturn : null,
    });
  }
  return out;
}

const isBearishRead = (score: number) => score <= -0.2;
const isNeutralRead = (score: number) => score > -0.2 && score <= 0.2;

/**
 * Run one policy over the corpus.
 *
 * Order within a session matters and is fixed here rather than left to the policy:
 * holding state is advanced on TODAY's score first (so a ladder rule reads a fresh run
 * count), then names the corpus no longer carries are force-dropped, then the policy
 * decides, and only then are returns realized over t → t+1. Nothing a policy sees is
 * computed from a bar after the close it is deciding at.
 */
export function simulate(rows: SimRow[], policy: Policy): SimResult {
  const bySession = new Map<string, SimRow[]>();
  for (const r of rows) {
    const list = bySession.get(r.session);
    if (list) list.push(r);
    else bySession.set(r.session, [r]);
  }
  const sessions = [...bySession.keys()].sort();

  const book = new Map<string, Holding>();
  const results: SessionResult[] = [];
  const closedHolds: number[] = [];
  let totalAdded = 0;
  let slotUseSum = 0;

  for (const session of sessions) {
    const dayRows = bySession.get(session)!;
    const rowByTicker = new Map(dayRows.map((r) => [r.ticker, r]));

    // 1. Advance holding state on today's score, before anyone decides on it.
    for (const h of book.values()) {
      const score = rowByTicker.get(h.ticker)?.score ?? null;
      if (score == null) continue;
      h.bearishRuns = isBearishRead(score) ? h.bearishRuns + 1 : 0;
      h.neutralRuns = isNeutralRead(score) ? h.neutralRuns + 1 : 0;
    }

    // 2. A held name the corpus no longer carries has no price and no return — it is
    //    gone, not held. Force-dropping it here keeps it out of the policy's hands and
    //    out of the return average, rather than silently held forever at zero.
    let dropped = 0;
    for (const ticker of [...book.keys()]) {
      if (rowByTicker.has(ticker)) continue;
      closedHolds.push(book.get(ticker)!.sessionsHeld);
      book.delete(ticker);
      dropped++;
    }

    // 3. The policy decides.
    const ranked: RankedName[] = dayRows
      .filter((r): r is SimRow & { score: number } => r.score != null)
      .sort((a, b) => b.score - a.score)
      .map((r) => ({
        ticker: r.ticker,
        score: r.score,
        enterable: r.entryReturn != null,
        held: book.get(r.ticker) ?? null,
      }));
    const decision = policy.rebalance(ranked, [...book.values()], policy.slots);

    for (const ticker of decision.drop) {
      const h = book.get(ticker);
      if (!h) continue;
      // Dropped before this session is realized, so it was held for exactly the
      // sessions it earned — the drop session is not one of them.
      closedHolds.push(h.sessionsHeld);
      book.delete(ticker);
      dropped++;
    }

    const entered = new Set<string>();
    for (const ticker of decision.add) {
      if (book.size >= policy.slots) break;
      if (book.has(ticker)) continue;
      const row = rowByTicker.get(ticker);
      if (!row || row.entryReturn == null || row.score == null) continue;
      book.set(ticker, { ticker, sessionsHeld: 0, cumReturn: 0, bearishRuns: 0, neutralRuns: 0 });
      entered.add(ticker);
    }
    totalAdded += entered.size;
    slotUseSum += book.size / policy.slots;

    // 4. Realize t → t+1. An entered name pays the frame's entry price; a carried one
    //    rides close to close. That difference IS the cost of turnover.
    const rets: number[] = [];
    for (const h of book.values()) {
      const row = rowByTicker.get(h.ticker)!;
      const ret = entered.has(h.ticker) ? row.entryReturn! : row.holdReturn;
      rets.push(ret);
      h.cumReturn = (1 + h.cumReturn) * (1 + ret) - 1;
      h.sessionsHeld++;
    }

    // An empty book earns nothing — flat, not absent. Dropping the session instead
    // would quietly measure the policy only on the days it chose to be invested.
    const ret = rets.length ? mean(rets)! : 0;
    const universe = mean(dayRows.map((r) => r.holdReturn))!;
    results.push({ session, ret, excess: ret - universe, held: book.size, added: entered.size, dropped });
  }

  for (const h of book.values()) closedHolds.push(h.sessionsHeld);

  return {
    policyId: policy.id,
    sessions: results,
    turnover: results.length ? totalAdded / results.length : 0,
    avgHold: closedHolds.length ? mean(closedHolds)! : 0,
    slotUse: results.length ? slotUseSum / results.length : 0,
  };
}

/**
 * Serial-correlation lag for the paired t-stat.
 *
 * The session returns themselves are non-overlapping, but positions persist across
 * sessions, so the DIFFERENCE series is autocorrelated even though the returns are not.
 * Five sessions is one trading week — long enough to cover the typical hold, short
 * enough that the estimator stays stable.
 */
export const PAIRED_LAG = 5;

export type PairedStat = {
  label: string;
  sessions: number;
  /** Mean of excess(a) − excess(b) per session, in basis points. */
  meanDiffBps: number;
  tStat: number | null;
  /** Share of sessions where the policy beat its pair. */
  winRate: number;
};

/**
 * Paired per-session difference — the headline statistic, and not IC.
 *
 * Both policies read the same ranking on the same session, so subtracting them removes
 * the market AND removes the score. What survives is the policy and nothing else, which
 * is why this is paired rather than two independent means compared to each other.
 */
export function pairedDifference(a: SimResult, b: SimResult, label: string, lag = PAIRED_LAG): PairedStat {
  const bBySession = new Map(b.sessions.map((s) => [s.session, s.excess]));
  const diffs: number[] = [];
  let wins = 0;
  for (const s of a.sessions) {
    const other = bBySession.get(s.session);
    if (other == null) continue;
    const d = s.excess - other;
    diffs.push(d);
    if (d > 0) wins++;
  }
  return {
    label,
    sessions: diffs.length,
    meanDiffBps: diffs.length ? mean(diffs)! * 10_000 : 0,
    tStat: diffs.length > 1 ? neweyWestTStatOfMean(diffs, lag) : null,
    winRate: diffs.length ? wins / diffs.length : 0,
  };
}

export type PolicyVerdict = "CONTROL" | "PASSES" | "WEAK" | "FAILS" | "INSUFFICIENT";

/** Sessions a period needs before its paired difference is worth reading. */
export const MIN_PAIRED_SESSIONS = 60;

/**
 * The §07 decision rule, applied rather than described.
 *
 * PASSES needs the difference positive in train AND holdout AND at least three quarters
 * of the folds, with |t| clearing both the conventional 2.0 and the best-of-k noise
 * floor. Everything else is WEAK or FAILS — and neither is a reason to change the book.
 */
export function policyVerdict(train: PairedStat, holdout: PairedStat, folds: PairedStat[], k: number): PolicyVerdict {
  if (train.sessions < MIN_PAIRED_SESSIONS || holdout.sessions < MIN_PAIRED_SESSIONS) return "INSUFFICIENT";
  const floor = Math.max(2, noiseThreshold(k));
  const positive = train.meanDiffBps > 0 && holdout.meanDiffBps > 0;
  const foldsPositive = folds.filter((f) => f.meanDiffBps > 0).length;
  const enoughFolds = folds.length === 0 || foldsPositive >= Math.ceil(folds.length * 0.75);
  const strong = holdout.tStat != null && Math.abs(holdout.tStat) > floor;
  if (positive && enoughFolds && strong) return "PASSES";
  if (positive && enoughFolds) return "WEAK";
  return "FAILS";
}

export type PolicyReport = {
  policyId: string;
  hypothesis: string;
  control: boolean;
  sim: SimResult;
  /** Paired against the baseline policy over each period. Empty for the baseline itself. */
  train: PairedStat | null;
  holdout: PairedStat | null;
  folds: PairedStat[];
  verdict: PolicyVerdict | null;
};

const bps = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
const t = (v: number | null) => (v == null ? "  n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

/**
 * The control assertion. The simulator must be able to detect a policy improvement that
 * is KNOWN to exist before any other number in the run means anything: the same policy
 * fed a perfect score has to beat the same policy fed the incumbent, by a margin no one
 * has to squint at. A weak result here is a build failure, not a finding.
 */
export function controlOk(oracleExcessBps: number, baselineExcessBps: number): { ok: boolean; detail: string } {
  const gap = oracleExcessBps - baselineExcessBps;
  return {
    ok: gap > 100,
    detail: `oracle ${bps(oracleExcessBps)} bps vs baseline ${bps(baselineExcessBps)} bps per session (gap ${bps(gap)} bps; needs > +100)`,
  };
}

export function formatPolicyReport(
  reports: PolicyReport[],
  opts: { frame: ReturnFrame; candidateId: string; k: number; splitDate: string; control?: { ok: boolean; detail: string } }
): string {
  const L: string[] = [];
  const floor = Math.max(2, noiseThreshold(opts.k));

  L.push(`═══ policy comparison — candidate ${opts.candidateId}, frame ${opts.frame}, split ${opts.splitDate} ═══`);
  L.push(`paired vs P0 per session, Newey-West lag ${PAIRED_LAG}; k=${opts.k} → |t| floor ${floor.toFixed(2)}`);
  if (opts.frame === "close") {
    L.push("!!! CLOSE FRAME — every swap is free here. Turnover is unpriced; do NOT read a verdict off this.");
  }
  L.push("");

  if (opts.control && !opts.control.ok) {
    L.push("!!! CONTROL BROKEN — every number below is void until this is fixed:");
    L.push(`    ${opts.control.detail}`);
    L.push("");
  } else if (opts.control) {
    L.push(`control ok: ${opts.control.detail}`);
    L.push("");
  }

  L.push("BOOK BEHAVIOUR");
  L.push(`${pad("policy", 20)}${padL("excess/sess", 12)}${padL("turnover", 10)}${padL("avg hold", 10)}${padL("slot use", 10)}`);
  for (const r of reports) {
    const ex = mean(r.sim.sessions.map((s) => s.excess));
    L.push(
      pad(r.policyId, 20) +
        padL(`${bps((ex ?? 0) * 10_000)} bps`, 12) +
        padL(`${r.sim.turnover.toFixed(2)}/sess`, 10) +
        padL(`${r.sim.avgHold.toFixed(1)}`, 10) +
        padL(`${(r.sim.slotUse * 100).toFixed(0)}%`, 10)
    );
  }
  L.push("");

  L.push("PAIRED DIFFERENCE vs P0 (bps per session, t across sessions)");
  L.push(`${pad("policy", 20)}${padL("TRAIN", 18)}${padL("HOLDOUT", 18)}${padL("folds+", 8)}  verdict`);
  for (const r of reports) {
    if (!r.train || !r.holdout) continue;
    const foldsPos = r.folds.filter((f) => f.meanDiffBps > 0).length;
    L.push(
      pad(r.policyId, 20) +
        padL(`${bps(r.train.meanDiffBps)} (t ${t(r.train.tStat)})`, 18) +
        padL(`${bps(r.holdout.meanDiffBps)} (t ${t(r.holdout.tStat)})`, 18) +
        padL(`${foldsPos}/${r.folds.length}`, 8) +
        `  ${r.control ? "CONTROL" : r.verdict}`
    );
  }
  L.push("");

  for (const r of reports) {
    L.push(`${r.policyId}: ${r.hypothesis}`);
  }
  L.push("");
  L.push("Biases that all point the same way as a positive result — read them before believing one:");
  L.push("  survivorship (today's universe projected back), no price stops in P0's ladder, no exit slippage.");
  return L.join("\n");
}
