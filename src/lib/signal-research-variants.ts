// PRE-REGISTERED candidate scores.
//
// This list is the anti-overfitting control, and it only works if it stays honest.
// Every candidate carries a hypothesis written BEFORE the run. Adding one after seeing
// results — or quietly dropping one that embarrassed its author — makes the reported
// `k` a lie and the noise threshold meaningless. Pre-registering in a diff costs nothing
// and is the strongest control available here.
//
// `oracle` and `mom30` are CONTROLS, not hypotheses. They run every time and their job
// is to fail loudly if the harness itself is broken. A null result is only believable
// from an instrument that just demonstrated it can detect something.

import { calcQuantScore, TREND_REGIME_MIN } from "@/lib/indicators";
import { regimeOf, type Candidate, type MarketRegime, type RegimeBoundaries, type ScoreInput } from "@/lib/signal-research";
import { scoreWithWeights } from "@/lib/signal-research-fit";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The exact argument shape `calcQuantScore` takes, from a feature row. */
const quantArgs = (f: ScoreInput) => ({
  rsi14: f.rsi14,
  change7d: f.change7d,
  sma20: f.sma20,
  price: f.close,
  volatility30d: f.vol30,
  volumeRatio10d: f.volRatio10,
  macdHistogram: f.macdHist,
  relativeStr7d: f.relStr7d,
  bollingerPctB: f.bollPctB,
});

/**
 * The score's terms, formed exactly as `calcQuantScore` adds them.
 *
 * Duplicated from `indicators.ts` on purpose: a variant needs to rebuild the composite
 * with ONE leg changed, and the shipped function offers no seam for that. The
 * `baseline` candidate calls the real `calcQuantScore`, and a test asserts this
 * reconstruction reproduces it exactly — so drift is caught rather than assumed away.
 */
export function quantTerms(f: ScoreInput, opts: { momentum?: number | null } = {}) {
  const momValue = opts.momentum !== undefined ? opts.momentum : f.relStr7d != null ? f.relStr7d : f.change7d;
  const momNorm = momValue != null ? clamp(momValue / 20, -1, 1) : null;
  const trending = momNorm != null && Math.abs(momNorm) >= TREND_REGIME_MIN;

  const rsi =
    f.rsi14 != null ? clamp(trending ? (f.rsi14 - 50) / 50 : (50 - f.rsi14) / 50, -1, 1) : null;
  const boll =
    f.bollPctB != null
      ? clamp((f.bollPctB - 0.5) * 2, -1, 1)
      : f.sma20 != null && f.sma20 > 0
        ? clamp(((f.close - f.sma20) / f.sma20) * 10, -1, 1)
        : null;
  const direction = f.bollPctB != null ? (f.bollPctB > 0.5 ? 1 : -1) : f.sma20 != null && f.close > f.sma20 ? 1 : -1;
  const volume = f.volRatio10 != null && boll != null ? clamp((f.volRatio10 - 1) / 2, 0, 1) * direction : null;
  const macd = f.macdHist != null && f.close > 0 ? clamp((f.macdHist / f.close) * 100, -1, 1) : null;
  const damp = f.vol30 != null ? clamp(1 - (f.vol30 - 0.2) / 0.6, 0.3, 1) : 1;

  return { momentum: momNorm, rsi, boll, volume, macd, damp };
}

export const WEIGHTS = { momentum: 0.3, rsi: 0.3, boll: 0.1, volume: 0.1, macd: 0.2 } as const;

/**
 * The five additive terms, in a fixed order, for the refit.
 *
 * `damp` is excluded deliberately: it is a MULTIPLIER, not a term, so it has no place as
 * an OLS coefficient. `h2-no-vol-damper` already tested dropping it and it changed
 * nothing that mattered (holdout -0.0230 vs baseline's -0.0232), so the refit spends its
 * degrees of freedom on the weights that are actually in dispute.
 */
export const TERM_KEYS = ["momentum", "rsi", "boll", "volume", "macd"] as const;

/** Weighted blend with missing legs excluded and the remaining weights rescaled. */
export function blend(
  terms: Partial<Record<keyof typeof WEIGHTS, number | null>>,
  damp = 1
): number | null {
  let score = 0;
  let total = 0;
  for (const [key, weight] of Object.entries(WEIGHTS) as [keyof typeof WEIGHTS, number][]) {
    const v = terms[key];
    if (v == null) continue;
    score += v * weight;
    total += weight;
  }
  if (total === 0) return null;
  return clamp((score / total) * damp, -1, 1);
}

export const CANDIDATES: Candidate[] = [
  // ── controls ───────────────────────────────────────────────────────────────
  {
    id: "mom30",
    control: true,
    hypothesis:
      "CONTROL — 30-day momentum alone. A known effect of realistic size; must print t ≈ 3.1 in train, or the harness cannot detect anything.",
    score: (f) => f.change30d,
  },

  // ── the thing under test ───────────────────────────────────────────────────
  {
    id: "baseline",
    hypothesis: "calcQuantScore exactly as shipped — the incumbent every hypothesis must beat.",
    score: (f) => calcQuantScore(quantArgs(f)),
  },

  // ── pre-registered hypotheses ──────────────────────────────────────────────
  {
    id: "h1-momentum-horizon",
    hypothesis:
      "Swapping the 7-day momentum leg for 30-day survives out of sample: change7d went +0.0116 train → -0.0136 holdout, while change30d stayed positive in BOTH (+0.0227 / +0.0194). The only component result that replicated.",
    score: (f) => {
      const t = quantTerms(f, { momentum: f.change30d });
      return blend(t, t.damp);
    },
  },
  {
    id: "h2-no-vol-damper",
    hypothesis:
      "The volatility dampener multiplies by a STOCK-SPECIFIC factor, so it reorders the cross-section rather than merely scaling confidence — and on its own it scored t = -2.15. Removing it helps.",
    score: (f) => blend(quantTerms(f), 1),
  },
  {
    id: "h3-spread-normalised",
    hypothesis:
      "Normalising each term by its own spread makes the nominal 30/30/10/10/20 weights real. They currently behave like macd 33% / momentum 26% / rsi 20% / bollinger 16% / volume 5%, so MACD drives a score it was never meant to dominate.",
    score: (f) => {
      const t = quantTerms(f);
      // Divisors are each term's observed sd over the holdout corpus (see
      // OPEN-FINDINGS.md); dividing equalises influence so the declared weights bind.
      const SD = { momentum: 0.327, rsi: 0.250, boll: 0.623, volume: 0.190, macd: 0.628 };
      return blend(
        {
          momentum: t.momentum == null ? null : clamp(t.momentum / SD.momentum, -1, 1),
          rsi: t.rsi == null ? null : clamp(t.rsi / SD.rsi, -1, 1),
          boll: t.boll == null ? null : clamp(t.boll / SD.boll, -1, 1),
          volume: t.volume == null ? null : clamp(t.volume / SD.volume, -1, 1),
          macd: t.macd == null ? null : clamp(t.macd / SD.macd, -1, 1),
        },
        t.damp
      );
    },
  },

  // ── pre-registered refits (weights fitted on TRAIN only, frozen above) ─────
  {
    id: "f1-refit-global",
    hypothesis:
      "Weights estimated from train instead of declared beat declared ones. h1/h2/h3 each changed ONE thing about a blend nobody ever fitted; this replaces the 30/30/10/10/20 outright with the train Fama-MacBeth answer, on standardised terms so a weight of 0.3 really does buy 30% of the influence. The fit says momentum is the only significant leg (t=+3.51) and that rsi (+0.65) and macd (-0.60) are being paid 50% of the weight for nothing.",
    score: (f) => scoreWithWeights(quantTerms(f), REFIT_W, REFIT_STD),
  },
  {
    id: "f2-refit-by-regime",
    hypothesis:
      "One weight vector cannot fit a score whose terms reverse by regime. MACD fits at t=-4.27 in TREND_BULL and +3.03 in MEAN_REVERTING — two significant effects with opposite signs that cancel to -0.60 globally, the same cancellation that hid the score's regime split. Fitting per regime should recover both. The risk is stated up front: 4x the parameters on a quarter of the sessions each, and the regime label itself comes from a rule nobody fitted.",
    score: (f) => {
      const r = REFIT_BY_REGIME[f.marketRegime];
      return scoreWithWeights(quantTerms(f), r.w, r.std);
    },
  },
  {
    id: "f3-fitted-regimes",
    hypothesis:
      "The regime cut-points are unfitted constants too, and fitting them beats fitting only the weights on top of them. ADX 25 / ADX 20 / RSI 30-70 are textbook numbers that rank 52nd of 73 on inner validation (+0.0020, t=0.16); a nested search wants adx>20 with no dead band, and the whole top ten agrees on 20-22.5. If f2 recovered something real, moving the boundary to where the data puts it should recover more of it.",
    score: (f) => {
      const r = REFIT2[regimeOf(f, REFIT2_BOUNDARIES)];
      return scoreWithWeights(quantTerms(f), r.w, r.std);
    },
  },
];

// ── Fitted weights ───────────────────────────────────────────────────────────
//
// Produced by `npm run signal-research-fit`, which reads TRAIN SESSIONS ONLY (< 2025-01-01)
// and prints these blocks for pasting. They are frozen here so the candidate stays a pure
// per-row function that cannot reach the data it was fitted on. Regenerating them against
// a different split, horizon or corpus REQUIRES re-running the holdout afterwards — the
// numbers below are only out-of-sample because nothing refitted them since.
//
// Fitted 2026-07-31: split 2025-01-01, horizon 5, 797 usable sessions / 79,464 obs, 0 rows
// dropped for a missing term.

/** Global fit. Fama-MacBeth t: momentum +3.51, volume +1.75, rsi +0.65, macd -0.60, boll -0.88. */
export const REFIT_W = { momentum: 0.002853, rsi: 0.000214, boll: -0.000703, volume: 0.001724, macd: -0.000482 };
export const REFIT_STD = {
  momentum: { mean: 0.009241, sd: 0.288284 },
  rsi: { mean: -0.026801, sd: 0.256548 },
  boll: { mean: 0.070585, sd: 0.631431 },
  volume: { mean: 0.002268, sd: 0.192289 },
  macd: { mean: 0.009122, sd: 0.616557 },
};

/** Per-regime fits. t: TREND_BULL macd -4.27 / momentum +3.42; MEAN_REVERTING macd +3.03 / boll -1.98. */
export const REFIT_BY_REGIME: Record<
  MarketRegime,
  { w: Record<string, number>; std: Record<string, { mean: number; sd: number }> }
> = {
  TREND_BULL: {
    w: { momentum: 0.004779, rsi: 0.000067, boll: 0.001036, volume: 0.003135, macd: -0.005072 },
    std: {
      momentum: { mean: 0.027296, sd: 0.282822 },
      rsi: { mean: -0.082439, sd: 0.267567 },
      boll: { mean: 0.293895, sd: 0.557315 },
      volume: { mean: 0.029753, sd: 0.192007 },
      macd: { mean: 0.137504, sd: 0.556452 },
    },
  },
  TREND_BEAR: {
    w: { momentum: 0.003645, rsi: -0.000567, boll: -0.001717, volume: -0.001463, macd: -0.001464 },
    std: {
      momentum: { mean: -0.015904, sd: 0.309493 },
      rsi: { mean: 0.047664, sd: 0.246867 },
      boll: { mean: -0.258199, sd: 0.575995 },
      volume: { mean: -0.032672, sd: 0.183548 },
      macd: { mean: -0.224789, sd: 0.615327 },
    },
  },
  MEAN_REVERTING: {
    w: { momentum: 0.001587, rsi: 0.000842, boll: -0.003157, volume: 0.002830, macd: 0.004943 },
    std: {
      momentum: { mean: 0.008547, sd: 0.287390 },
      rsi: { mean: -0.016279, sd: 0.241699 },
      boll: { mean: 0.049191, sd: 0.647032 },
      volume: { mean: -0.001687, sd: 0.196704 },
      macd: { mean: 0.000038, sd: 0.625189 },
    },
  },
  UNCLASSIFIED: {
    w: { momentum: 0.001575, rsi: 0.000165, boll: 0.000328, volume: 0.001039, macd: 0.000304 },
    std: {
      momentum: { mean: 0.004888, sd: 0.281089 },
      rsi: { mean: -0.019808, sd: 0.250940 },
      boll: { mean: 0.039300, sd: 0.628868 },
      volume: { mean: -0.003444, sd: 0.189063 },
      macd: { mean: 0.013591, sd: 0.630299 },
    },
  },
};

/**
 * Fitted regime cut-points, chosen by NESTED selection inside train.
 *
 * Weights were fitted on sessions < 2024-01-01; the 116-set grid was ranked on the year
 * after that, which those weights never saw; then the weights were refitted on all of
 * train under the winner. The holdout saw none of it.
 *
 * Selection result: the textbook cuts (adx>25 / adx<20 / rsi 30-70) ranked **52nd of 73
 * usable sets** at +0.0020 (0.16), while the top ten all wanted `adxTrend` at 20-22.5.
 * The ADX trend threshold is what the data cares about; the RSI band and the calm cut
 * barely move it (ranks 1-10 span +0.0283 to +0.0318).
 *
 * Read the winner against the GRID's noise threshold (|t| ~ 3.08 for 116 trials), not
 * against zero: at validation t = 2.61 the winning cell is NOT distinguishable from what
 * searching 116 partitions produces by itself. What is more than a lucky cell is the
 * clustering — 20 beats 25 across the whole top of the table.
 */
export const REFIT2_BOUNDARIES: RegimeBoundaries = { adxTrend: 20, adxCalm: 20, rsiLo: 40, rsiHi: 60 };

/** Per-regime weights under `REFIT2_BOUNDARIES`, refitted on all 801 train sessions. */
export const REFIT2: Record<MarketRegime, { w: Record<string, number>; std: Record<string, { mean: number; sd: number }> }> = {
  TREND_BULL: {
    w: { momentum: 0.003945, rsi: -0.000168, boll: 0.000809, volume: 0.002312, macd: -0.003138 },
    std: { momentum: { mean: 0.022567, sd: 0.283762 }, rsi: { mean: -0.075726, sd: 0.260644 }, boll: { mean: 0.277022, sd: 0.559390 }, volume: { mean: 0.026897, sd: 0.185797 }, macd: { mean: 0.164518, sd: 0.565120 } },
  },
  TREND_BEAR: {
    w: { momentum: 0.002268, rsi: 0.000140, boll: -0.000924, volume: -0.000850, macd: -0.000870 },
    std: { momentum: { mean: -0.015031, sd: 0.296087 }, rsi: { mean: 0.054790, sd: 0.241501 }, boll: { mean: -0.298475, sd: 0.567062 }, volume: { mean: -0.040458, sd: 0.191866 }, macd: { mean: -0.276516, sd: 0.596943 } },
  },
  MEAN_REVERTING: {
    w: { momentum: 0.004970, rsi: 0.000044, boll: -0.004311, volume: 0.001716, macd: 0.002807 },
    std: { momentum: { mean: 0.012004, sd: 0.291721 }, rsi: { mean: -0.009584, sd: 0.233851 }, boll: { mean: 0.028243, sd: 0.633842 }, volume: { mean: -0.004165, sd: 0.200316 }, macd: { mean: -0.028370, sd: 0.618370 } },
  },
  // Fitted on 65 sessions — by far the thinnest bucket, and its weights look it (momentum
  // comes back NEGATIVE here and nowhere else). Under these boundaries UNCLASSIFIED is
  // only 8.1% of rows, so it does little damage, but it is the least trustworthy row here.
  UNCLASSIFIED: {
    w: { momentum: -0.006402, rsi: 0.003043, boll: -0.000528, volume: 0.005938, macd: 0.010305 },
    std: { momentum: { mean: 0.000102, sd: 0.276501 }, rsi: { mean: -0.034207, sd: 0.259595 }, boll: { mean: 0.107819, sd: 0.675030 }, volume: { mean: 0.005901, sd: 0.187447 }, macd: { mean: 0.074802, sd: 0.634457 } },
  },
};

export const ORACLE_ID = "oracle";

/**
 * The plumbing control — the forward return scoring itself, so IC must come back at
 * exactly 1.0000. It is the only candidate carrying the `oracle` flag, which is what
 * lets it see the answer; a hypothesis that needs that flag is not a hypothesis.
 */
export const ORACLE: Candidate = {
  id: ORACLE_ID,
  hypothesis:
    "CONTROL — the forward return itself. Must return IC exactly 1.0000; anything else means the harness is wired wrong and every other number in the run is void.",
  oracle: true,
  control: true,
  score: () => null, // unreachable: `oracle` short-circuits to the forward return
};

/** Everything a normal sweep runs: the oracle first, so a broken harness fails fast. */
export const ALL_CANDIDATES: Candidate[] = [ORACLE, ...CANDIDATES];
