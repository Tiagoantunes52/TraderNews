// The pre-registered policy set. This list is the anti-overfitting control, and like
// `signal-research-variants.ts` it only works if it stays honest: every policy ever run
// against this corpus counts toward `k`, not the ones that survived. A policy added
// after seeing a result is a new `k`, not a free hypothesis.
//
// Every constant below — thresholds, margins, minimum holds — is fixed HERE, before the
// first run, for the same reason. Tuning one after reading the output turns the whole
// comparison into a search, and the noise floor stops covering it.

import { DEFAULT_RISK_CONFIG } from "@/lib/paper-trading";
import type { Holding, Policy, RankedName, Rebalance } from "@/lib/portfolio-sim";

const cfg = DEFAULT_RISK_CONFIG;

/** Slots, matching `DEFAULT_RISK_LIMITS.maxPositions` — the cap this whole question is about. */
export const SLOTS = 12;

/**
 * Score gap a candidate must beat the worst holding by before a swap is worth it.
 *
 * In the incumbent's score units, which run [-1, 1]. Without a band the book churns on
 * rank noise every session and pays the entry frame for the privilege; with too wide a
 * band replacement never fires and P1 collapses into the incumbent.
 */
export const REPLACE_MARGIN = 0.1;
/** P3's wider band, and the minimum sessions before a name may be replaced at all. */
export const SLOW_MARGIN = 0.3;
export const SLOW_MIN_HOLD = 5;
/** Swaps per session. Replacement is a correction, not a rebuild — and turnover is the cost. */
export const MAX_SWAPS_PER_SESSION = 1;

/**
 * The incumbent's exit ladder, minus the rungs this corpus cannot express.
 *
 * SIGNAL, DECAY and TIME are computable from the score series and the position's own
 * P&L, and are reproduced at the live constants. STOP and TRAIL are NOT — `FeatureRow`
 * carries no next-session low to test a breach against — so the incumbent rides losers longer here
 * than the live book does. That omission flatters every policy that replaces holdings,
 * which is the direction of the hypothesis: treat a narrow P1 win as no win at all.
 */
function ladderExit(h: Holding): boolean {
  const matured = h.sessionsHeld >= cfg.minHoldRuns;
  if (matured && h.bearishRuns >= cfg.signalConfirmRuns) return true;
  if (matured && cfg.decayRuns > 0 && h.neutralRuns >= cfg.decayRuns && h.cumReturn > 0) return true;
  if (cfg.timeStopRuns > 0 && h.sessionsHeld >= cfg.timeStopRuns && Math.abs(h.cumReturn) <= cfg.timeStopBandPct) {
    return true;
  }
  return false;
}

/**
 * Names that clear the live entry deadband, best-first, excluding what is already held.
 *
 * Deliberately does NOT apply `cfg.entryScoreMax` (the 2026-08-31 STRONG_BUY cap). That
 * cap rests on evidence about the SENTIMENT score's top bucket, and this harness scores
 * candidates derived from price bars — importing a finding about one signal into the
 * ranking of another would be reasoning by name rather than by evidence. If a band ever
 * needs testing here, it needs its own measurement on this corpus.
 */
const eligible = (ranked: RankedName[]) =>
  ranked.filter((r) => !r.held && r.enterable && r.score > cfg.entryScoreMin);

/**
 * THE INCUMBENT, and the pair every hypothesis is measured against.
 *
 * Free slots go to the best-scoring candidates — which is what the live book already
 * does: `rankEntryCandidates` (portfolio-risk.ts), wired into the entry loop at
 * paper.ts, shipped in `a3a720c` and recorded under "Shipped" in OPEN-FINDINGS.md. What
 * the live book does NOT do is reconsider a name once it is held, and that — not fill
 * order — is the open question.
 */
export const P0_INCUMBENT: Policy = {
  id: "P0-incumbent",
  hypothesis:
    "What ships today: best-scoring candidates take the free slots, and a holding is only ever released by the exit ladder. The pair for every comparison.",
  slots: SLOTS,
  rebalance(ranked, held, slots): Rebalance {
    const drop = held.filter(ladderExit).map((h) => h.ticker);
    const room = slots - (held.length - drop.length);
    const add = room > 0 ? eligible(ranked).slice(0, room).map((r) => r.ticker) : [];
    return { drop, add };
  },
};

/** Alphabetical: deterministic, and independent of the score — a stand-in for arrival order. */
const byTicker = (a: RankedName, b: RankedName) => a.ticker.localeCompare(b.ticker);

/**
 * The book as it stood BEFORE ranked allocation shipped: slots went to whichever
 * candidates the estimate loop reached first, which is arbitrary with respect to the
 * signal. Kept as a backward-looking counterfactual — it prices what `a3a720c` bought,
 * and it is the floor any ranking policy has to clear to have been worth shipping.
 *
 * A seeded shuffle would be the more faithful stand-in for arrival order than
 * alphabetical, and is the obvious refinement if this number ever matters.
 */
export const PA_ARRIVAL: Policy = {
  id: "PA-arrival",
  hypothesis:
    "The pre-a3a720c book: free slots go to whichever eligible names arrive first, not the best. Measures what ranked entry allocation already bought.",
  slots: SLOTS,
  rebalance(ranked, held, slots): Rebalance {
    const drop = held.filter(ladderExit).map((h) => h.ticker);
    const room = slots - (held.length - drop.length);
    const add = room > 0 ? eligible(ranked).sort(byTicker).slice(0, room).map((r) => r.ticker) : [];
    return { drop, add };
  },
};

/**
 * Shared body for the two replacement policies: the ladder still runs, free slots are
 * filled best-first, and then — only then — the worst holding is swapped for the best
 * candidate if the gap justifies it. Ladder first is what makes this the MARGINAL effect
 * of replacement rather than a second change bundled in.
 */
function replacementPolicy(opts: { id: string; hypothesis: string; margin: number; minHold: number }): Policy {
  return {
    id: opts.id,
    hypothesis: opts.hypothesis,
    slots: SLOTS,
    rebalance(ranked, held, slots): Rebalance {
      const drop = held.filter(ladderExit).map((h) => h.ticker);
      const dropped = new Set(drop);
      const survivors = held.filter((h) => !dropped.has(h.ticker));
      const candidates = eligible(ranked);

      const room = slots - survivors.length;
      const add = candidates.slice(0, Math.max(0, room)).map((r) => r.ticker);

      // Swap only once the book is full: with a free slot the better name can simply be
      // bought, and evicting a holding to make room for it would pay the entry frame twice.
      if (room <= 0) {
        const scoreOf = new Map(ranked.map((r) => [r.ticker, r.score]));
        const replaceable = survivors
          .filter((h) => h.sessionsHeld >= opts.minHold && scoreOf.has(h.ticker))
          .sort((a, b) => scoreOf.get(a.ticker)! - scoreOf.get(b.ticker)!);
        const incoming = candidates.filter((c) => !add.includes(c.ticker));
        for (let i = 0; i < MAX_SWAPS_PER_SESSION && i < replaceable.length && i < incoming.length; i++) {
          const worst = replaceable[i];
          const best = incoming[i];
          if (best.score - scoreOf.get(worst.ticker)! < opts.margin) break;
          drop.push(worst.ticker);
          add.push(best.ticker);
        }
      }
      return { drop, add };
    },
  };
}

export const P1_REPLACE = replacementPolicy({
  id: "P1-replace",
  hypothesis:
    "The proposal: ladder plus best-first fill plus one swap per session — evict the worst holding for the best candidate when it out-ranks by at least the margin. Everything except the eviction matches the incumbent, so the pair isolates it.",
  margin: REPLACE_MARGIN,
  minHold: 0,
});

export const P3_REPLACE_SLOW = replacementPolicy({
  id: "P3-replace-slow",
  hypothesis:
    "P1 with a wider margin and a minimum hold, to separate the gain from better selection from the cost of turning the book over to get it.",
  margin: SLOW_MARGIN,
  minHold: SLOW_MIN_HOLD,
});

/**
 * The turnover ceiling: no deadband, no ladder, just the top of the ranking every
 * session. Says how much the ladder itself costs in pure selection terms, and bounds
 * what any replacement rule could possibly achieve on this score.
 */
export const P2_TOPN: Policy = {
  id: "P2-topN",
  hypothesis:
    "Pure top-12 rebalance every session, ladder and deadband removed — the turnover ceiling, and the upper bound on what replacement can buy.",
  slots: SLOTS,
  rebalance(ranked, held, slots): Rebalance {
    const want = ranked.filter((r) => r.enterable || r.held).slice(0, slots);
    const wanted = new Set(want.map((r) => r.ticker));
    return {
      drop: held.filter((h) => !wanted.has(h.ticker)).map((h) => h.ticker),
      add: want.filter((r) => !r.held).map((r) => r.ticker),
    };
  },
};

/** Judged policies, in report order. The incumbent is first because everything pairs against it. */
export const POLICIES: Policy[] = [P0_INCUMBENT, PA_ARRIVAL, P1_REPLACE, P3_REPLACE_SLOW, P2_TOPN];

/**
 * `k` for the noise floor: the hypotheses, excluding the incumbent they are measured
 * against. Raise this by hand when a policy is added — including one that was tried and
 * abandoned, which is exactly the count people forget.
 */
export const POLICY_K = POLICIES.filter((p) => p.id !== P0_INCUMBENT.id && !p.control).length;
