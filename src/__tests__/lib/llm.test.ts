import { describe, it, expect } from "vitest";
import {
  parseSentimentResponse,
  isRetriableLlmError,
  LlmHttpError,
  LlmResponseError,
  LEGACY_FALLBACK_SUMMARIES,
} from "@/lib/llm";

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

  // A failed reply is the absence of a reading, never a NEUTRAL one. These used to
  // return score 0 / confidence 0.1, which every classifier read as NEUTRAL — firing
  // DECAY/SIGNAL exits on names the model had said nothing about (2026-10-21).
  const rejects = (content: string, reason: string) => {
    let thrown: unknown;
    try {
      parseSentimentResponse(content);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LlmResponseError);
    expect((thrown as LlmResponseError).reason).toBe(reason);
  };

  it("throws, rather than inventing a neutral read, on unparseable content", () => {
    rejects("the model refused to answer", "Could not parse model response.");
  });

  it("throws on empty or whitespace-only content", () => {
    rejects("", "Empty model response.");
    rejects("   \n ", "Empty model response.");
  });

  it("throws when the JSON has no numeric score", () => {
    rejects('{"summary": "no score here", "confidence": 0.7}', "Model response missing a numeric score.");
  });

  it("throws on JSON that is not an object", () => {
    rejects("null", "Could not parse model response.");
  });

  it("still accepts a genuine zero score — neutral is a valid opinion, just not a default", () => {
    const r = parseSentimentResponse('{"overall_score": 0, "confidence": 0.8, "summary": "Mixed news."}');
    expect(r.score).toBe(0);
    expect(r.confidence).toBeCloseTo(0.8);
  });

  it("keeps the legacy fallback summaries recognisable for the backfill", () => {
    // The migration that marks old rows `failed` matches these exact strings.
    expect(LEGACY_FALLBACK_SUMMARIES).toEqual([
      "Empty model response.",
      "Could not parse model response.",
      "Model response missing a numeric score.",
    ]);
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

describe("isRetriableLlmError", () => {
  it("does not retry an aborted request", () => {
    // The 30s client-side timeout: retrying doubles a timeout's wall-clock cost
    // for a call that is unlikely to succeed. This is the regression that
    // stretched News Pipeline #861 to 99 minutes.
    const abort = new DOMException("This operation was aborted", "AbortError");
    expect(isRetriableLlmError(abort)).toBe(false);
  });

  it("does not retry an AbortSignal.timeout-style TimeoutError", () => {
    expect(isRetriableLlmError(new DOMException("timed out", "TimeoutError"))).toBe(false);
  });

  it("retries a 5xx", () => {
    expect(isRetriableLlmError(new LlmHttpError(503))).toBe(true);
  });

  it("retries a 429", () => {
    expect(isRetriableLlmError(new LlmHttpError(429))).toBe(true);
  });

  it("does not retry a permanent 4xx", () => {
    expect(isRetriableLlmError(new LlmHttpError(401))).toBe(false);
    expect(isRetriableLlmError(new LlmHttpError(400))).toBe(false);
  });

  it("retries a transport error", () => {
    expect(isRetriableLlmError(new TypeError("fetch failed"))).toBe(true);
  });

  it("keeps the legacy error message so logs stay greppable", () => {
    expect(new LlmHttpError(503).message).toBe("LLM error: 503");
  });
});

describe("legacy fallback backfill", () => {
  it("marks exactly the strings the old fallback wrote", async () => {
    // If a summary is added to or dropped from LEGACY_FALLBACK_SUMMARIES without the
    // migration (or vice versa), old fake-NEUTRAL rows would silently stay readable.
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = readdirSync("prisma/migrations").find((d) => d.endsWith("_sentiment_failed"));
    expect(dir).toBeDefined();
    const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8");
    const quoted = [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(quoted)).toEqual(new Set(LEGACY_FALLBACK_SUMMARIES));
  });
});
