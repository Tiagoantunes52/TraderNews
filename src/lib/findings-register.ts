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
  /**
   * Raw `value` of the `tradingConfig` AppSetting row, null when absent. Raw rather
   * than a boolean so the assertion can check the row's CONTENT: since 2026-08-24 a
   * row is supposed to exist, holding exactly the deliberate ratchet override.
   */
  tradingConfigRaw: string | null;
  /** OPEN positions whose last mark is older than `staleMarkDays` — unmanaged in practice. */
  staleMarkedPositions: number;
  staleMarkDays: number;
  /** `_RM` entries in the trailing window — the entry freeze draining. */
  rmEntriesInWindow: number;
  entryWindowDays: number;
  /** Today's paper-stage errors naming the `insufficient qty available` rejection. */
  insufficientQtyErrors: number;
  /** `_RM` entries opened above the band cap since it shipped — must stay 0. */
  entriesAboveBand: number;
  /** The cap in force, so the finding can name the number it is checking. */
  entryScoreMax: number;
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
 * The "revisit the exit ladder" trigger (`exit-labels-too-few`, threshold 60 labelled
 * exits) lived here until 2026-08-24, when it fired at 62 and produced the attribution
 * study it existed to prompt — see OPEN-FINDINGS.md, "Exit-ladder attribution".
 */

/** The `.slice(0, 10)` in `sentiment.ts` that caps `articleCount`. */
export const ARTICLE_COUNT_SLICE = 10;

export const REGISTER_ASSERTIONS: RegisterAssertion[] = [
  {
    // Replaced `knobs-at-defaults` on 2026-08-24 when the ratchet disable created the
    // first deliberate override; `exit-labels-too-few` retired the same day — it fired
    // at 62 labelled exits and produced the attribution study it existed to trigger.
    id: "knobs-single-ratchet-override",
    section: "Strategy thread",
    claim: "The only DB override is `trailRatchetFrac: 1` (the 2026-08-24 ratchet disable); every other knob is at code defaults.",
    check: (f) => {
      let parsed: unknown = null;
      if (f.tradingConfigRaw != null) {
        try {
          parsed = JSON.parse(f.tradingConfigRaw);
        } catch {
          /* unparseable is just "not the expected row" */
        }
      }
      const holds =
        parsed != null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length === 1 &&
        (parsed as Record<string, unknown>).trailRatchetFrac === 1;
      return {
        holds,
        detail: holds
          ? "row holds exactly { trailRatchetFrac: 1 }."
          : f.tradingConfigRaw == null
            ? "The tradingConfig row is GONE — the ratchet disable was reverted (or never applied), and the 2026-08-24 change plus its evaluation window no longer describe the live books."
            : `The tradingConfig row is no longer exactly { trailRatchetFrac: 1 } (found: ${f.tradingConfigRaw.slice(0, 120)}). A second knob moved — every claim derived from "only the ratchet changed" needs re-reading.`,
      };
    },
  },
  {
    id: "entry-band-in-force",
    section: "Entry bands",
    claim:
      "Since 2026-08-31 the _RM books do not open above `entryScoreMax` (0.6, the STRONG_BUY line) — the bucket measured at -79.5 bps against the universe.",
    check: (f) => ({
      holds: f.entriesAboveBand === 0,
      detail:
        f.entriesAboveBand === 0
          ? `no _RM entry above ${f.entryScoreMax} since the cap shipped.`
          : `${f.entriesAboveBand} _RM entr${f.entriesAboveBand === 1 ? "y" : "ies"} opened with a score above ${f.entryScoreMax} since the cap shipped. ` +
            `Either the knob was reverted, or the gate is not reading the score it is supposed to — the change is not doing anything.`,
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
