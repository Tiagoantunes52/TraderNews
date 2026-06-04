// Evidence-weighted blending of the available sentiment signals into one score.
//
// Replaces a plain arithmetic mean (which gave a market-wide crypto gauge the
// same say as ticker-specific analysis) with weights proportional to how much
// evidence backs each signal:
//   - LLM signal: model confidence × volume of articles it read
//   - Alpha Vantage: total per-article relevance it reported for this ticker
//   - Crypto Fear & Greed: a small fixed PRIOR — it knows nothing about the
//     specific coin, so ticker-specific signals should be able to override it.

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Weight the market-wide crypto Fear & Greed index as a weak prior only.
export const FNG_PRIOR_WEIGHT = 0.15;

export type BlendInput = {
  llmScore: number;
  llmConfidence: number; // 0..1
  articleCount: number;  // headlines the LLM actually scored
  avScore: number | null;        // relevance-weighted Alpha Vantage score
  avRelevanceTotal: number;      // Σ relevance across AV entries (0 if none/unknown)
  avCount: number;               // number of AV entries
  fngScore: number | null;       // pass only for crypto; null otherwise
};

/**
 * Combine the signals into a single score in [-1, 1].
 * Falls back to the raw LLM score if every weight is zero.
 */
export function blendSentiment(i: BlendInput): number {
  const parts: { score: number; weight: number }[] = [];

  // LLM: confidence scaled by how many articles informed it (diminishing returns).
  const llmWeight = clamp(i.llmConfidence, 0, 1) * Math.log1p(Math.max(0, i.articleCount));
  if (llmWeight > 0) parts.push({ score: i.llmScore, weight: llmWeight });

  // Alpha Vantage: weight by reported relevance; if relevance is unknown (0),
  // fall back to a low per-entry weight so it still counts a little.
  if (i.avScore != null && i.avCount > 0) {
    const avWeight = i.avRelevanceTotal > 0 ? i.avRelevanceTotal : i.avCount * 0.2;
    parts.push({ score: i.avScore, weight: avWeight });
  }

  // Crypto Fear & Greed: small fixed prior.
  if (i.fngScore != null) parts.push({ score: i.fngScore, weight: FNG_PRIOR_WEIGHT });

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) return clamp(i.llmScore, -1, 1);

  const weighted = parts.reduce((s, p) => s + p.score * p.weight, 0) / totalWeight;
  return clamp(weighted, -1, 1);
}
