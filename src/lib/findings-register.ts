// Makes `OPEN-FINDINGS.md` check itself.
//
// The register is the best record of what is wrong with the execution path, and it has
// the failure mode every such document has: it is a snapshot asserted in prose, and
// prose does not notice when it stops being true. Several of its claims are empirical
// ("there is no tradingConfig row", "verified zero occurrences in prod", "13 labelled
// exits"), which means each one is really a query someone ran once. A reader months
// later cannot tell a claim that still holds from one that quietly expired, so the
// safe move is to re-derive everything — which is how a register meant to save work
// starts costing it.
//
// So the empirical claims are written here as assertions instead, re-checked by the
// daily review, and a broken one becomes a `REGISTER_STALE` finding naming the exact
// bullet to edit. Staleness is not failure: half of these go stale by being FIXED, and
// the finding is the prompt to delete the bullet.
//
// Deliberately only the mechanically checkable claims. "Exits fire on NEUTRAL" is a
// statement about code, not data, and encoding it here would be writing a second, worse
// copy of the source. Each assertion's `id` matches an `<!-- check: id -->` marker in
// the register.
//
// Pure. `pipeline/review.ts` gathers the facts.

import type { Finding } from "@/lib/daily-review";

export type RegisterFacts = {
  /** `_RM` closes carrying a real `exitReason` — the sample the exit ladder can be tuned on. */
  labelledRmExits: number;
  /** An `AppSetting` row keyed `tradingConfig` exists (knobs no longer at code defaults). */
  tradingConfigRowExists: boolean;
  /** OPEN positions whose last mark is older than `staleMarkDays` — unmanaged in practice. */
  staleMarkedPositions: number;
  staleMarkDays: number;
  /** `_RM` entries in the trailing window — the entry freeze draining. */
  rmEntriesInWindow: number;
  entryWindowDays: number;
  /** Today's paper-stage errors naming the `insufficient qty available` rejection. */
  insufficientQtyErrors: number;
  /**
   * Largest `articleCount` ever written by the sentiment stage. The `.slice(0, 10)` at
   * `sentiment.ts:57` runs BEFORE the count, so while the defect is live this cannot
   * exceed `ARTICLE_COUNT_SLICE`. The moment it does, the slice was moved and the
   * register's bullet is out of date.
   */
  maxArticleCount: number;
};

export type RegisterAssertion = {
  /** Matches `<!-- check: id -->` in OPEN-FINDINGS.md. */
  id: string;
  /** Where in the register the claim lives, so the finding points at a bullet. */
  section: string;
  /** The claim, close to verbatim — a finding is only actionable if it quotes what it broke. */
  claim: string;
  check: (f: RegisterFacts) => { holds: boolean; detail: string };
};

/**
 * Labelled `_RM` exits needed before the register's "revisit the exit ladder" trigger
 * fires. The register's own wording is "revisit after ~4-6 weeks of labelled exits";
 * 60 is that in trades, at the ~2/day the books closed over the period it was written.
 * A round number chosen once and written down beats one re-argued each time it is read —
 * and being early costs a prompt, while being late costs weeks of untuned exits.
 */
export const EXIT_LADDER_SAMPLE = 60;

/** The `.slice(0, 10)` in `sentiment.ts` that caps `articleCount`. */
export const ARTICLE_COUNT_SLICE = 10;

export const REGISTER_ASSERTIONS: RegisterAssertion[] = [
  {
    id: "knobs-at-defaults",
    section: "Strategy thread",
    claim: "There is no `tradingConfig` row; all knobs are at code defaults, and that is currently correct.",
    check: (f) => ({
      holds: !f.tradingConfigRowExists,
      detail: f.tradingConfigRowExists
        ? "A `tradingConfig` AppSetting row now exists, so the knobs are no longer at code defaults. Every claim in the register derived from default behaviour needs re-reading against the live config."
        : "no row; defaults still in force.",
    }),
  },
  {
    id: "exit-labels-too-few",
    section: "Strategy thread",
    claim: `Only 13 labelled exits exist; tuning the exit ladder against that is fitting noise. Revisit after ~4-6 weeks.`,
    check: (f) => ({
      holds: f.labelledRmExits < EXIT_LADDER_SAMPLE,
      detail:
        f.labelledRmExits >= EXIT_LADDER_SAMPLE
          ? `${f.labelledRmExits} labelled \`_RM\` exits have now accumulated (threshold ${EXIT_LADDER_SAMPLE}). The exit ladder can be attributed to a rung — this is the register's own revisit trigger firing.`
          : `${f.labelledRmExits}/${EXIT_LADDER_SAMPLE} labelled exits.`,
    }),
  },
  {
    id: "article-count-capped",
    section: "Confirmed but deliberately deferred",
    claim: "`articleCount` counts the LLM prompt, not the news — capped at 10 by a slice that runs before the count.",
    check: (f) => ({
      // Deliberately inverted relative to the "too few samples" assertions: this one
      // holds while the DEFECT is live, so it goes stale by being FIXED. That is the
      // point — the prompt to delete the bullet should arrive when the code changes,
      // not when someone happens to re-read the register.
      holds: f.maxArticleCount <= ARTICLE_COUNT_SLICE,
      detail:
        f.maxArticleCount > ARTICLE_COUNT_SLICE
          ? `articleCount now reaches ${f.maxArticleCount}, above the slice of ${ARTICLE_COUNT_SLICE} — the count/slice ordering was fixed. Delete this bullet, and re-read anything derived from sentWeight, the confidence bump or articleVelocityRatio, all of which now move.`
          : `max articleCount ${f.maxArticleCount} ≤ slice ${ARTICLE_COUNT_SLICE}; defect still live.`,
    }),
  },
  {
    id: "unmanaged-positions-latent",
    section: "Confirmed but deliberately deferred",
    claim:
      "Missing-fresh-estimate positions go unmanaged — verified zero occurrences in prod, so this is latent, not active.",
    check: (f) => ({
      holds: f.staleMarkedPositions === 0,
      detail:
        f.staleMarkedPositions > 0
          ? `${f.staleMarkedPositions} open position(s) have not been marked in ${f.staleMarkDays}+ days. The deferred defect is ACTIVE, not latent — the reason it lost prioritisation no longer applies.`
          : "no position is going unmarked.",
    }),
  },
  {
    // Deliberately inverted relative to the bullet's original wording. The freeze it
    // described has drained, so asserting it would be permanently stale — but "an `_RM`
    // book stops taking entries entirely" is exactly the silent failure the register
    // exists to catch, and watching for its RETURN is the durable version of the claim.
    id: "entry-freeze-drained",
    section: "Strategy thread",
    claim: "The 15-session `_RM` entry freeze has drained; the risk-managed books are taking entries again.",
    check: (f) => ({
      holds: f.rmEntriesInWindow > 0,
      detail:
        f.rmEntriesInWindow === 0
          ? `zero \`_RM\` entries in the last ${f.entryWindowDays} days. The freeze — or another one — is back, and a book that only ever shrinks looks healthy from every other angle.`
          : `${f.rmEntriesInWindow} entries in ${f.entryWindowDays} days.`,
    }),
  },
  {
    id: "reanchor-cancels-first",
    section: "Shipped → entry buffer correction",
    claim:
      "The stop re-anchor now cancels the resting order first, so it no longer fails `403 insufficient qty available`.",
    check: (f) => ({
      holds: f.insufficientQtyErrors === 0,
      detail:
        f.insufficientQtyErrors > 0
          ? `${f.insufficientQtyErrors} insufficient-qty rejection(s) again today. The cancel-first fix is not holding, and mis-anchored stops are once more staying where they are — the exact state the correction was written to end.`
          : "no rejections today.",
    }),
  },
];

/**
 * Re-check the register's empirical claims.
 *
 * `warn`, never `fail`: a stale claim is a document that needs an edit, not a system
 * that is broken. It outranks silence, though — an unmaintained register is worse than
 * no register, because it is trusted.
 */
export function auditFindingsRegister(facts: RegisterFacts): Finding[] {
  const out: Finding[] = [];
  const stale = REGISTER_ASSERTIONS.map((a) => ({ a, r: a.check(facts) })).filter(({ r }) => !r.holds);

  for (const { a, r } of stale) {
    out.push({
      severity: "warn",
      code: "REGISTER_STALE",
      title: `OPEN-FINDINGS.md is out of date: ${a.id}`,
      detail: `${a.section} claims: "${a.claim}" — ${r.detail}`,
      refs: { id: a.id, section: a.section },
    });
  }

  out.push({
    severity: "info",
    code: "REGISTER_CHECKED",
    title: `${REGISTER_ASSERTIONS.length - stale.length}/${REGISTER_ASSERTIONS.length} register claims still hold`,
    detail: stale.length
      ? `Stale: ${stale.map(({ a }) => a.id).join(", ")}. Each has its own finding above.`
      : "Every mechanically checkable claim in OPEN-FINDINGS.md was re-verified against production today.",
    refs: { checked: REGISTER_ASSERTIONS.length, stale: stale.length },
  });

  return out;
}
