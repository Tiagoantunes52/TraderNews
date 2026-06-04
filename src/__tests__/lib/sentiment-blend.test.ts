import { describe, it, expect } from "vitest";
import { blendSentiment, FNG_PRIOR_WEIGHT, type BlendInput } from "@/lib/sentiment-blend";

const base: BlendInput = {
  llmScore: 0,
  llmConfidence: 1,
  articleCount: 5,
  avScore: null,
  avRelevanceTotal: 0,
  avCount: 0,
  fngScore: null,
};

describe("blendSentiment", () => {
  it("returns the LLM score when it is the only signal", () => {
    expect(blendSentiment({ ...base, llmScore: 0.7 })).toBeCloseTo(0.7, 10);
  });

  it("falls back to the raw LLM score when every weight is zero", () => {
    // confidence 0 and no other signals → total weight 0
    expect(blendSentiment({ ...base, llmScore: 0.5, llmConfidence: 0, articleCount: 0 })).toBeCloseTo(0.5, 10);
  });

  it("clamps the result into [-1, 1]", () => {
    expect(blendSentiment({ ...base, llmScore: 5 })).toBe(1);
    expect(blendSentiment({ ...base, llmScore: -5 })).toBe(-1);
  });

  it("weights Alpha Vantage by total relevance", () => {
    // LLM bullish but low confidence/few articles; AV bearish with high relevance
    // should pull the blend negative.
    const score = blendSentiment({
      ...base,
      llmScore: 0.8,
      llmConfidence: 0.3,
      articleCount: 2,
      avScore: -0.6,
      avRelevanceTotal: 4,
      avCount: 5,
    });
    expect(score).toBeLessThan(0);
  });

  it("uses a low fallback weight for AV when relevance is unknown (0)", () => {
    const withRelevance = blendSentiment({
      ...base, llmScore: 0.5, avScore: -1, avRelevanceTotal: 5, avCount: 3,
    });
    const withoutRelevance = blendSentiment({
      ...base, llmScore: 0.5, avScore: -1, avRelevanceTotal: 0, avCount: 3,
    });
    // Unknown relevance ⇒ smaller AV weight ⇒ blend stays closer to the LLM score.
    expect(withoutRelevance).toBeGreaterThan(withRelevance);
  });

  it("treats crypto Fear & Greed as a weak prior, not a co-equal vote", () => {
    // Strong, confident, well-sourced bullish LLM signal vs. a fearful market gauge.
    const score = blendSentiment({
      ...base,
      llmScore: 0.9,
      llmConfidence: 0.9,
      articleCount: 10,
      fngScore: -1,
    });
    // The coin-specific signal should dominate the market-wide prior.
    expect(score).toBeGreaterThan(0.6);
  });

  it("lets the FnG prior move a thin/low-confidence signal", () => {
    const withFng = blendSentiment({
      ...base, llmScore: 0.2, llmConfidence: 0.2, articleCount: 1, fngScore: -1,
    });
    const withoutFng = blendSentiment({
      ...base, llmScore: 0.2, llmConfidence: 0.2, articleCount: 1, fngScore: null,
    });
    expect(withFng).toBeLessThan(withoutFng);
  });

  it("scales LLM weight by confidence and article volume", () => {
    // Two competing signals (LLM bullish, AV bearish). Higher LLM confidence and
    // more articles should tilt the blend more bullish.
    const lowEvidence = blendSentiment({
      ...base, llmScore: 1, llmConfidence: 0.2, articleCount: 1, avScore: -1, avRelevanceTotal: 2, avCount: 2,
    });
    const highEvidence = blendSentiment({
      ...base, llmScore: 1, llmConfidence: 0.95, articleCount: 10, avScore: -1, avRelevanceTotal: 2, avCount: 2,
    });
    expect(highEvidence).toBeGreaterThan(lowEvidence);
  });

  it("exposes the FnG prior weight as a small constant", () => {
    expect(FNG_PRIOR_WEIGHT).toBeGreaterThan(0);
    expect(FNG_PRIOR_WEIGHT).toBeLessThan(0.5);
  });
});
