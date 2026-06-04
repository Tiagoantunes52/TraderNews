import { describe, it, expect } from "vitest";
import { parseSentimentResponse } from "@/lib/llm";

describe("parseSentimentResponse", () => {
  it("parses a well-formed structured response", () => {
    const r = parseSentimentResponse(
      JSON.stringify({
        overall_score: 0.6,
        confidence: 0.8,
        time_horizon: "near_term",
        key_driver: "Q2 earnings beat",
        summary: "Strong quarter drives bullish tone.",
        aspects: {
          earnings_results: { score: 0.9, weight: 0.7 },
          analyst_actions: { score: 0.4, weight: 0.3 },
        },
      })
    );
    expect(r.score).toBeCloseTo(0.6);
    expect(r.confidence).toBeCloseTo(0.8);
    expect(r.timeHorizon).toBe("near_term");
    expect(r.keyDriver).toBe("Q2 earnings beat");
    expect(r.aspects.earnings_results).toEqual({ score: 0.9, weight: 0.7 });
  });

  it("strips ```json markdown fences", () => {
    const r = parseSentimentResponse('```json\n{"overall_score": -0.5, "confidence": 0.4}\n```');
    expect(r.score).toBeCloseTo(-0.5);
    expect(r.confidence).toBeCloseTo(0.4);
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const r = parseSentimentResponse('Here is the analysis: {"score": 0.3, "confidence": 0.6} — hope that helps!');
    expect(r.score).toBeCloseTo(0.3);
    expect(r.confidence).toBeCloseTo(0.6);
  });

  it("accepts the legacy `score` key as a fallback for `overall_score`", () => {
    const r = parseSentimentResponse('{"score": 0.25, "summary": "ok"}');
    expect(r.score).toBeCloseTo(0.25);
  });

  it("clamps out-of-range score and confidence", () => {
    const r = parseSentimentResponse('{"overall_score": 4, "confidence": 9}');
    expect(r.score).toBe(1);
    expect(r.confidence).toBe(1);
    const r2 = parseSentimentResponse('{"overall_score": -4, "confidence": -1}');
    expect(r2.score).toBe(-1);
    expect(r2.confidence).toBe(0);
  });

  it("coerces numeric strings", () => {
    const r = parseSentimentResponse('{"overall_score": "0.42", "confidence": "0.5"}');
    expect(r.score).toBeCloseTo(0.42);
    expect(r.confidence).toBeCloseTo(0.5);
  });

  it("defaults confidence to 0.3 when missing", () => {
    const r = parseSentimentResponse('{"overall_score": 0.1}');
    expect(r.confidence).toBeCloseTo(0.3);
  });

  it("falls back to neutral/low-confidence on unparseable content", () => {
    const r = parseSentimentResponse("the model refused to answer");
    expect(r.score).toBe(0);
    expect(r.confidence).toBe(0.1);
    expect(r.aspects).toEqual({});
  });

  it("falls back to neutral on empty content", () => {
    const r = parseSentimentResponse("");
    expect(r.score).toBe(0);
    expect(r.confidence).toBe(0.1);
  });

  it("falls back to neutral when JSON has no numeric score", () => {
    const r = parseSentimentResponse('{"summary": "no score here", "confidence": 0.7}');
    expect(r.score).toBe(0);
    expect(r.confidence).toBe(0.1);
  });

  it("ignores malformed aspect entries and clamps valid ones", () => {
    const r = parseSentimentResponse(
      JSON.stringify({
        overall_score: 0.2,
        aspects: {
          good: { score: 1.5, weight: 2 },
          missing_score: { weight: 0.5 },
          not_an_object: "nope",
        },
      })
    );
    expect(r.aspects.good).toEqual({ score: 1, weight: 1 });
    expect(r.aspects.missing_score).toBeUndefined();
    expect(r.aspects.not_an_object).toBeUndefined();
  });

  it("rejects an invalid time_horizon", () => {
    const r = parseSentimentResponse('{"overall_score": 0.1, "time_horizon": "someday"}');
    expect(r.timeHorizon).toBeNull();
  });

  it("uses key_driver as summary when summary is absent", () => {
    const r = parseSentimentResponse('{"overall_score": 0.1, "key_driver": "merger talks"}');
    expect(r.summary).toBe("merger talks");
  });
});
